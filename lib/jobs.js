/* The background transcription queue.

   Recording and transcribing used to happen in the same breath: you pressed
   stop and then waited, and if anything went wrong in that wait the lecture
   was gone. Here they are separate. Capture's only job is to get clean audio
   onto disk; transcription is a job that happens afterwards, one at a time, at
   low priority, and survives the app being closed and reopened.

   The queue is persisted to data/jobs.json after every state change, so a job
   that was running when the process died comes back as queued rather than
   silently disappearing. */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DATA_DIR, loadSettings, resolveTranscribeModel } from './config.js';
import { retranscribe, canRetranscribe } from './rescan.js';
import { readMeta, updateMeta, recordingDir } from './store.js';

const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const KEEP_FINISHED = 40;

export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(0);

/** @type {Map<string, object>} jobId -> job */
const jobs = new Map();
let running = null;
let pumping = false;
let abort = null;

const jobId = (sessionId, rid) => `${sessionId}/${rid}`;

/* ------------------------------------------------------------- persistence */

function save() {
  try {
    const rows = [...jobs.values()].map(({ ...j }) => j);
    fs.writeFileSync(JOBS_FILE, JSON.stringify({ version: 1, jobs: rows }, null, 2));
  } catch { /* the queue is a convenience; never let its bookkeeping throw */ }
}

function emit(job) {
  jobEvents.emit('job', { ...job });
  save();
}

export function listJobs() {
  return [...jobs.values()].sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0));
}

export function queueSummary() {
  const rows = listJobs();
  return {
    jobs: rows,
    running: rows.find((j) => j.status === 'running') || null,
    waiting: rows.filter((j) => j.status === 'queued').length,
  };
}

/* ------------------------------------------------------------------- queue */

/**
 * Put a recording in line to be transcribed. Re-queuing one that is already
 * queued or running is a no-op, so this is safe to call from anywhere.
 */
export function enqueue(sessionId, recordingId, { model = null, reason = 'recorded' } = {}) {
  const id = jobId(sessionId, recordingId);
  const existing = jobs.get(id);
  if (existing && (existing.status === 'queued' || existing.status === 'running')) return existing;

  const meta = readMeta(sessionId);
  const job = {
    id,
    sessionId,
    recordingId,
    sessionTitle: meta?.title || sessionId,
    model: model || resolveTranscribeModel(),
    reason,
    status: 'queued',
    progress: 0,
    doneMs: 0,
    totalMs: 0,
    segments: 0,
    error: null,
    queuedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
  };
  jobs.set(id, job);
  markRecording(sessionId, recordingId, { status: 'queued', error: null });
  emit(job);
  pump();
  return job;
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === 'running') {
    abort?.abort();
  } else if (job.status === 'queued') {
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    markRecording(job.sessionId, job.recordingId, { status: 'interrupted' });
    emit(job);
  }
  return job;
}

export function clearFinished() {
  for (const [id, job] of jobs) {
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') jobs.delete(id);
  }
  save();
  jobEvents.emit('queue', queueSummary());
}

/** Mirror a job's state onto the recording row the library reads. */
function markRecording(sessionId, recordingId, patch) {
  try {
    updateMeta(sessionId, (m) => {
      const row = (m.recordings || []).find((r) => r.id === recordingId);
      if (row) Object.assign(row, patch);
    });
  } catch { /* the session may have been deleted while queued */ }
}

/* ------------------------------------------------------------------ worker */

async function pump() {
  if (pumping || running) return;
  pumping = true;
  try {
    for (;;) {
      const next = listJobs().find((j) => j.status === 'queued');
      if (!next) break;
      await runJob(next);
    }
  } finally {
    pumping = false;
    jobEvents.emit('queue', queueSummary());
  }
}

async function runJob(job) {
  running = job;
  abort = new AbortController();
  job.status = 'running';
  job.startedAt = Date.now();
  job.progress = 0;
  job.error = null;
  markRecording(job.sessionId, job.recordingId, { status: 'transcribing', error: null });
  emit(job);

  try {
    if (!readMeta(job.sessionId)) throw new Error('That lecture was deleted.');
    if (!canRetranscribe(job.sessionId, job.recordingId)) {
      throw new Error('No audio survives for this recording.');
    }
    const out = await retranscribe(job.sessionId, job.recordingId, {
      model: job.model,
      signal: abort.signal,
      background: true,
      onProgress: (p) => {
        Object.assign(job, p);
        // Throttled by the tick the client renders on, not here: these are
        // cheap in-process events and one per 10-minute window is nothing.
        emit(job);
      },
    });
    job.status = 'done';
    job.segments = out.segments.length;
    job.progress = 1;
    job.finishedAt = Date.now();
    reclaimPcm(job);
  } catch (err) {
    const cancelled = err.aborted || abort.signal.aborted;
    job.status = cancelled ? 'cancelled' : 'error';
    job.error = cancelled ? null : err.message;
    job.finishedAt = Date.now();
    markRecording(job.sessionId, job.recordingId, {
      status: cancelled ? 'interrupted' : 'error',
      error: cancelled ? 'Transcription was cancelled — the audio is still here.' : err.message,
    });
  } finally {
    running = null;
    abort = null;
    trim();
    emit(job);
  }
}

/**
 * The raw PCM is kept until a transcript exists, precisely so a failed or
 * interrupted job can be retried from the best possible source. Once the job
 * has succeeded the compressed copy is enough.
 */
function reclaimPcm(job) {
  if (loadSettings().keepPcm) return;
  try {
    const dir = recordingDir(job.sessionId, job.recordingId);
    const m4a = path.join(dir, 'audio.m4a');
    if (fs.statSync(m4a).size > 2048) fs.rmSync(path.join(dir, 'audio.pcm'), { force: true });
  } catch { /* no m4a: keep the PCM, it is all there is */ }
}

function trim() {
  const finished = listJobs().filter((j) => j.status !== 'queued' && j.status !== 'running');
  for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) jobs.delete(j.id);
}

/* -------------------------------------------------------------------- boot */

/**
 * Reload the queue and put back anything the last run left half-done.
 * Call once at startup, after store.reconcileInterrupted().
 */
export function restoreQueue() {
  try {
    const raw = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    for (const j of raw.jobs || []) {
      // A job that was running when the process died did not finish, whatever
      // the file says — put it back in line.
      if (j.status === 'running') Object.assign(j, { status: 'queued', progress: 0, startedAt: null });
      jobs.set(j.id, j);
    }
  } catch { /* first run, or a corrupt file we are better off ignoring */ }

  // Drop jobs whose lecture or audio is gone, so the queue cannot spin on them.
  for (const [id, j] of jobs) {
    if (j.status !== 'queued') continue;
    if (!readMeta(j.sessionId) || !canRetranscribe(j.sessionId, j.recordingId)) jobs.delete(id);
  }
  save();
  pump();
  return queueSummary();
}
