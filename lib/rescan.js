/* Re-transcribe a recording that already exists on disk.
   Two jobs, one mechanism:
     - recovery, when a recording was interrupted (the app was killed, capture
       died, the final pass never ran) and its audio is sitting there untouched;
     - a deliberate redo, when the student has since downloaded a better model
       and wants the lecture read again with it.
   Either way the audio is the source of truth and nothing else is needed. */

import fs from 'node:fs';
import path from 'node:path';
import { BYTES_PER_SEC, TMP_DIR, loadSettings, resolveTranscribeModel } from './config.js';
import { writeWavSlice, decodeToPcm } from './audio.js';
import { transcribeWav } from './whisper.js';
import { recordingDir, updateMeta } from './store.js';

const WINDOW_SEC = 600;
const CONTEXT_SEC = 4;

const secToBytes = (s) => Math.floor(s * BYTES_PER_SEC);
const bytesToMs = (b) => Math.floor((b / BYTES_PER_SEC) * 1000);
const fileBytes = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

/**
 * Find playable audio for a recording and hand back a PCM file to read.
 * `cleanup` removes the decode scratch file when it was us who made it.
 */
async function resolvePcm(dir, rid) {
  const pcm = path.join(dir, 'audio.pcm');
  if (fileBytes(pcm) > BYTES_PER_SEC) return { pcm, cleanup: () => {} };

  const m4a = path.join(dir, 'audio.m4a');
  if (fileBytes(m4a) > 2048) {
    const tmp = path.join(TMP_DIR, `rescan-${rid}-${Date.now()}.pcm`);
    await decodeToPcm(m4a, tmp);
    return { pcm: tmp, cleanup: () => fs.rm(tmp, { force: true }, () => {}) };
  }

  // A recording killed before stop() has raw PCM but no m4a, and a recording
  // killed after the reclaim has neither. Say which, rather than "failed".
  throw new Error(fs.existsSync(dir)
    ? 'No audio survives for this recording — there is nothing left to transcribe.'
    : 'That recording is no longer on disk.');
}

/**
 * Walk a recording's audio in bounded windows and rebuild its transcript.
 * @returns {{ segments: Array, durationMs: number, model: string }}
 */
export async function retranscribe(sessionId, rid, opts = {}) {
  const settings = loadSettings();
  const model = opts.model || resolveTranscribeModel(settings);
  const dir = recordingDir(sessionId, rid);
  const { pcm, cleanup } = await resolvePcm(dir, rid);
  const onProgress = opts.onProgress || (() => {});

  try {
    const total = fileBytes(pcm);
    if (total < secToBytes(0.4)) throw new Error('That recording holds less than half a second of audio.');

    const segments = [];
    let cursor = 0;
    let guard = 0;

    while (cursor < total - secToBytes(0.4) && guard++ < 5000) {
      if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
      const end = Math.min(total, cursor + secToBytes(WINDOW_SEC));
      const readFrom = Math.max(0, cursor - secToBytes(CONTEXT_SEC));
      const wav = path.join(TMP_DIR, `rescan-${rid}-${cursor}.wav`);

      try {
        await writeWavSlice(pcm, wav, readFrom, end);
        const out = await transcribeWav(wav, {
          model,
          language: settings.language,
          translate: settings.translate,
          threads: settings.threads,
          offsetMs: bytesToMs(readFrom),
          // No rolling prompt. Feeding whisper its own recent output is the
          // other half of the looping problem — the audio run-up above is
          // enough to keep the seams clean without handing it a phrase to
          // get stuck on.
          signal: opts.signal,
          background: opts.background !== false,
          lowPriority: settings.lowPriority !== false,
        });
        const cursorMs = bytesToMs(cursor);
        for (const seg of out.segments) {
          if ((seg.start + seg.end) / 2 <= cursorMs) continue;
          segments.push(seg);
        }
        // Written out every window, not just at the end: a two-hour lecture is
        // a long time to hold the only copy of a transcript in memory.
        fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify(segments, null, 2));
      } finally {
        fs.rm(wav, { force: true }, () => {});
      }

      cursor = end;
      onProgress({ progress: Math.min(1, cursor / total), doneMs: bytesToMs(cursor), totalMs: bytesToMs(total), segments: segments.length });
    }

    fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify(segments, null, 2));

    const durationMs = bytesToMs(total);
    // Both copies of a recording's meta have to agree or the library and the
    // exporter disagree about what happened.
    const recMetaPath = path.join(dir, 'meta.json');
    try {
      const rm = JSON.parse(fs.readFileSync(recMetaPath, 'utf8'));
      Object.assign(rm, { status: 'done', error: null, model, segmentCount: segments.length, durationMs, retranscribedAt: Date.now() });
      fs.writeFileSync(recMetaPath, JSON.stringify(rm, null, 2));
    } catch { /* the session meta below is the one the UI actually reads */ }

    updateMeta(sessionId, (m) => {
      const row = (m.recordings || []).find((r) => r.id === rid);
      if (!row) return;
      Object.assign(row, { status: 'done', error: null, model, segmentCount: segments.length, durationMs, retranscribedAt: Date.now() });
    });

    return { segments, durationMs, model };
  } finally {
    cleanup();
  }
}

/** Can this recording be re-transcribed at all? */
export function canRetranscribe(sessionId, rid) {
  const dir = recordingDir(sessionId, rid);
  return fileBytes(path.join(dir, 'audio.pcm')) > BYTES_PER_SEC
    || fileBytes(path.join(dir, 'audio.m4a')) > 2048;
}
