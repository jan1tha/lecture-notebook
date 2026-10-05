import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SESSIONS_DIR } from './config.js';

const ID_RE = /^[\w-]{1,64}$/;

export function assertId(id, what = 'id') {
  if (!ID_RE.test(String(id || ''))) throw new Error(`Invalid ${what}`);
  return id;
}

export const sessionDir = (id) => path.join(SESSIONS_DIR, assertId(id, 'session id'));
export const recordingDir = (id, rid) => path.join(sessionDir(id), 'recordings', assertId(rid, 'recording id'));
export const assetsDir = (id) => path.join(sessionDir(id), 'assets');
export const deckDir = (id, did) => path.join(sessionDir(id), 'slides', assertId(did, 'deck id'));
export const exportDir = (id) => path.join(sessionDir(id), 'export');

const metaPath = (id) => path.join(sessionDir(id), 'meta.json');
const notebookPath = (id) => path.join(sessionDir(id), 'notebook.json');

export const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;

/* ------------------------------------------------------------------ meta */

export function createSession({ title, moduleId, module: mod, lecturer, assessments } = {}) {
  const id = newId('ln');
  const now = Date.now();
  fs.mkdirSync(path.join(sessionDir(id), 'recordings'), { recursive: true });
  fs.mkdirSync(assetsDir(id), { recursive: true });
  const meta = {
    id,
    title: (title || '').trim() || defaultTitle(now),
    // `moduleId` is the real link; `module` is the module's name, mirrored
    // here so the exporter and every older session keep working unchanged.
    moduleId: (moduleId || '') || null,
    module: (mod || '').trim(),
    lecturer: (lecturer || '').trim(),
    assessments: normaliseAssessments(assessments),
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    recordings: [],
    decks: [],
  };
  saveMeta(meta);
  saveNotebook(id, emptyDoc());
  return meta;
}

export function readMeta(id) {
  try { return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')); } catch { return null; }
}

export function saveMeta(meta) {
  meta.updatedAt = Date.now();
  fs.mkdirSync(sessionDir(meta.id), { recursive: true });
  writeAtomic(metaPath(meta.id), JSON.stringify(meta, null, 2));
  return meta;
}

/** Read-modify-write a session's meta under one call so callers can't interleave. */
export function updateMeta(id, mutate) {
  const meta = readMeta(id);
  if (!meta) throw new Error('No such session');
  mutate(meta);
  return saveMeta(meta);
}

export function listMeta() {
  let ids = [];
  try { ids = fs.readdirSync(SESSIONS_DIR); } catch { return []; }
  return ids
    .filter((d) => ID_RE.test(d))
    .map(readMeta)
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export function deleteSession(id) {
  fs.rmSync(sessionDir(id), { recursive: true, force: true });
}

/* -------------------------------------------------------------- notebook */

export const emptyDoc = () => ({ version: 1, rev: 0, blocks: [], savedAt: 0 });

/** Read a block document, tolerating a missing or half-written file. */
export function readDocAt(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...emptyDoc(), ...doc, blocks: Array.isArray(doc.blocks) ? doc.blocks : [] };
  } catch { return emptyDoc(); }
}

/**
 * Save a block document only if the client's `rev` is current, so a second
 * open tab cannot silently clobber the one being typed in.
 */
export function saveDocChecked(file, { rev, blocks }) {
  const current = readDocAt(file);
  if (Number.isFinite(rev) && rev < current.rev) {
    const err = new Error('These notes were changed somewhere else. Reload to continue.');
    err.status = 409;
    err.current = current;
    throw err;
  }
  const next = {
    version: 1,
    rev: (current.rev || 0) + 1,
    savedAt: Date.now(),
    blocks: Array.isArray(blocks) ? blocks : [],
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify(next, null, 2));
  return next;
}

export const readNotebook = (id) => readDocAt(notebookPath(id));

export function saveNotebook(id, doc) {
  fs.mkdirSync(sessionDir(id), { recursive: true });
  writeAtomic(notebookPath(id), JSON.stringify({ ...doc, savedAt: Date.now() }, null, 2));
  return doc;
}

export const saveNotebookChecked = (id, body) => saveDocChecked(notebookPath(id), body);

/* --------------------------------------------------------------- archive */

/**
 * Archiving is a filing decision, not a deletion: the lecture keeps every
 * recording, note, deck and transcript it had, and comes back intact. All that
 * changes is that the library stops showing it next to this week's work.
 */
export function setArchived(id, archived) {
  return updateMeta(id, (m) => { m.archivedAt = archived ? (m.archivedAt || Date.now()) : null; });
}

export const isArchived = (meta) => Boolean(meta?.archivedAt);

/** Bytes of audio a lecture is holding, and whether they are safe to release. */
export function audioFootprint(id) {
  const meta = readMeta(id);
  if (!meta) return { bytes: 0, releasable: 0, recordings: [] };
  const rows = (meta.recordings || []).map((r) => {
    const dir = recordingDir(id, r.id);
    const m4a = path.join(dir, 'audio.m4a');
    const pcm = path.join(dir, 'audio.pcm');
    const bytes = fileBytes(m4a) + fileBytes(pcm);
    // Audio is only ever releasable once its transcript exists — otherwise
    // "archiving" would quietly throw the lecture away.
    const transcribed = r.status === 'done' && readTranscript(id, r.id).length > 0;
    // The absolute path, so the app can tell you where its own files are
    // instead of leaving you to guess at the data directory.
    return {
      id: r.id,
      bytes,
      transcribed,
      dir,
      file: fileBytes(m4a) ? m4a : (fileBytes(pcm) ? pcm : null),
      format: fileBytes(m4a) ? 'AAC in .m4a · 16 kHz mono' : (fileBytes(pcm) ? 'raw 16-bit PCM' : null),
    };
  });
  return {
    bytes: rows.reduce((a, r) => a + r.bytes, 0),
    releasable: rows.filter((r) => r.transcribed).reduce((a, r) => a + r.bytes, 0),
    recordings: rows,
  };
}

/**
 * Delete the audio of recordings that already have a transcript.
 *
 * Deliberately never automatic and never silent: a term of lectures is several
 * gigabytes of m4a, but audio is the only thing in here that cannot be
 * regenerated, so this happens when the student asks and not before. A
 * recording with no transcript is left completely alone.
 */
export function releaseAudio(id) {
  const before = audioFootprint(id);
  const freed = [];
  const kept = [];
  for (const row of before.recordings) {
    if (!row.transcribed) { if (row.bytes) kept.push(row.id); continue; }
    const dir = recordingDir(id, row.id);
    for (const f of ['audio.m4a', 'audio.pcm']) fs.rmSync(path.join(dir, f), { force: true });
    if (row.bytes) freed.push(row.id);
  }
  updateMeta(id, (m) => {
    for (const r of m.recordings || []) {
      if (!freed.includes(r.id)) continue;
      r.hasAudio = false;
      r.hasPcm = false;
      r.audioReleasedAt = Date.now();
    }
  });
  return { freedBytes: before.releasable, freed, kept };
}

const fileBytes = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

/* ------------------------------------------------------------ transcript */

export function readTranscript(id, rid) {
  try { return JSON.parse(fs.readFileSync(path.join(recordingDir(id, rid), 'transcript.json'), 'utf8')); }
  catch { return []; }
}

/** Every recording's segments, each tagged with its recording id. */
export function allTranscripts(meta) {
  return (meta.recordings || []).map((r) => ({ recording: r, segments: readTranscript(meta.id, r.id) }));
}

/* ---------------------------------------------------------------- assets */

/** Content-hash asset names, so pasting the same screenshot twice stores it once. */
export function writeAssetIn(dir, buffer, { ext = 'png', prefix = 'img' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 10);
  const file = `${prefix}-${hash}.${ext}`;
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) fs.writeFileSync(full, buffer);
  return { file, bytes: buffer.length };
}

/** Named (not hashed) asset — sketches keep a stable name so they stay editable. */
export function writeNamedAssetIn(dir, name, buffer) {
  if (!ASSET_RE.test(name)) throw new Error('Invalid asset name');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buffer);
  return { file: name, bytes: buffer.length };
}

export function assetPathIn(dir, file) {
  if (!ASSET_RE.test(file) || file.includes('..')) throw new Error('Invalid asset name');
  return path.join(dir, file);
}

const ASSET_RE = /^[\w.-]{1,80}$/;

export const writeAsset = (id, buffer, opts) => writeAssetIn(assetsDir(id), buffer, opts);
export const writeNamedAsset = (id, name, buffer) => writeNamedAssetIn(assetsDir(id), name, buffer);
export const assetPath = (id, file) => assetPathIn(assetsDir(id), file);

/* --------------------------------------------------------------- helpers */

export function writeAtomic(file, contents) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

/**
 * Put right anything the last run left mid-flight.
 *
 * Recording state lives in memory, so a recording that was in progress when
 * the process died stays "recording" in its meta for ever — the library shows
 * a lecture that is still going and nothing ever transcribes it. Anything
 * unfinished is marked `interrupted`, which is the state the UI offers to
 * transcribe from the audio that is still sitting on disk.
 *
 * @returns {Array<{sessionId, recordingId}>} recordings worth re-queuing
 */
export function reconcileInterrupted() {
  const UNFINISHED = new Set(['recording', 'finishing', 'processing', 'transcribing']);
  const orphans = [];
  for (const meta of listMeta()) {
    let touched = false;
    for (const rec of meta.recordings || []) {
      if (UNFINISHED.has(rec.status)) {
        rec.status = 'interrupted';
        rec.error = 'The app stopped while this recording was still being processed.';
        touched = true;
      }
      // 'queued' survives a restart untouched: the job queue owns it and will
      // pick it back up. Both states are re-offered to the queue below.
      if (rec.status === 'interrupted' || rec.status === 'queued') {
        orphans.push({ sessionId: meta.id, recordingId: rec.id });
      }
    }
    if (touched) { try { saveMeta(meta); } catch { /* keep going */ } }
  }
  return orphans;
}

export function normaliseAssessments(input) {
  if (Array.isArray(input)) return input.map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
  return String(input || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 12);
}

function defaultTitle(ts) {
  const d = new Date(ts);
  return `Lecture — ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

/* ------------------------------------------------------- time formatting */

const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');

export const shortTime = (ms) => {
  const t = Math.max(0, ms);
  const h = Math.floor(t / 3600000);
  return h > 0
    ? `${h}:${pad((t % 3600000) / 60000)}:${pad((t % 60000) / 1000)}`
    : `${pad(t / 60000)}:${pad((t % 60000) / 1000)}`;
};

export const clockTime = (ms) =>
  `${pad(ms / 3600000)}:${pad((ms % 3600000) / 60000)}:${pad((ms % 60000) / 1000)}`;
