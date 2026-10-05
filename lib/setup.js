import fs from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { MODELS, MODELS_DIR, ROOT, modelTarget, modelUrl, modelInstalled, modelFile } from './config.js';
import { whisperBinary, whisperVersion, resetBinaryCache } from './whisper.js';
import { hasFfmpeg } from './audio.js';
import { listAudioDevices } from './devices.js';
import { hasPoppler, hasSoffice } from './slides.js';

const OWN_MODELS_DIR = path.join(ROOT, 'models');

const has = (bin) => new Promise((resolve) => {
  execFile('command', ['-v', bin], { shell: '/bin/bash' }, (err, out) => resolve(!err && !!out.trim()));
});

let envCache = null;
let envCachedAt = 0;

/**
 * Everything the UI needs to say what still has to be set up.
 *
 * Costs the best part of a second — it shells out to ffmpeg, whisper, pdftoppm,
 * soffice and the device list — so callers on a latency-sensitive path (the
 * one between pressing record and the microphone opening) pass a `maxAgeMs`
 * and take the cached answer. Anything that has just changed the environment,
 * like an install or a model download, calls with no argument and gets a
 * fresh one.
 */
export async function environmentStatus({ maxAgeMs = 0 } = {}) {
  if (envCache && maxAgeMs > 0 && Date.now() - envCachedAt < maxAgeMs) return envCache;
  const out = await computeEnvironmentStatus();
  envCache = out;
  envCachedAt = Date.now();
  return out;
}

async function computeEnvironmentStatus() {
  const [ffmpeg, brew, binary, devices, poppler, soffice] = await Promise.all([
    hasFfmpeg(), has('brew'), whisperBinary(), listAudioDevices({ maxAgeMs: 0 }),
    hasPoppler(), hasSoffice(),
  ]);
  const version = binary ? await whisperVersion() : null;
  const models = MODELS.map((m) => ({
    ...m,
    installed: modelInstalled(m.id),
    // Borrowed from a sibling app rather than owned here — removing it there
    // would break that app too, so the UI has to say so.
    shared: modelInstalled(m.id) && !modelFile(m.id).startsWith(OWN_MODELS_DIR),
  }));
  const loopback = devices.filter((d) => d.loopback);

  return {
    ffmpeg: { ok: ffmpeg, hint: 'brew install ffmpeg' },
    brew: { ok: brew },
    whisper: { ok: !!binary, path: binary, version, hint: 'brew install whisper-cpp' },
    poppler: { ok: poppler, hint: 'brew install poppler' },
    soffice: { ok: soffice, hint: 'brew install --cask libreoffice' },
    models,
    modelsDir: MODELS_DIR,
    // A nearly full disk is the commonest reason a model "won't download",
    // and the one thing the old UI could not say.
    disk: { free: freeBytes(), parts: stalePartFiles().map(({ path: _p, ...rest }) => rest) },
    anyModel: models.some((m) => m.installed),
    devices,
    loopback: { ok: loopback.length > 0, devices: loopback, hint: 'brew install --cask blackhole-2ch' },
    // Slides are optional; recording + notes are not.
    ready: ffmpeg && !!binary && models.some((m) => m.installed),
    slidesReady: poppler,
  };
}

export function installWhisper(onLine) {
  return new Promise((resolve) => {
    const child = spawn('brew', ['install', 'whisper-cpp'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const pump = (s) => s.on('data', (d) => String(d).split('\n').filter(Boolean).forEach(onLine));
    pump(child.stdout); pump(child.stderr);
    child.on('error', (err) => { onLine(`error: ${err.message}`); resolve(false); });
    child.on('close', (code) => { resetBinaryCache(); resolve(code === 0); });
  });
}

export function installPoppler(onLine) {
  return new Promise((resolve) => {
    const child = spawn('brew', ['install', 'poppler'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const pump = (s) => s.on('data', (d) => String(d).split('\n').filter(Boolean).forEach(onLine));
    pump(child.stdout); pump(child.stderr);
    child.on('error', (err) => { onLine(`error: ${err.message}`); resolve(false); });
    child.on('close', (code) => resolve(code === 0));
  });
}

/** Bytes free on the volume the models live on, or null if it cannot be read. */
export function freeBytes(dir = MODELS_DIR) {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch { return null; }
}

/** Abandoned `.part` files from downloads that never finished. */
export function stalePartFiles() {
  try {
    return fs.readdirSync(MODELS_DIR)
      .filter((f) => f.endsWith('.bin.part'))
      .map((f) => {
        const full = path.join(MODELS_DIR, f);
        const st = fs.statSync(full);
        return { file: f, path: full, bytes: st.size, mtime: st.mtimeMs, model: f.replace(/^ggml-|\.bin\.part$/g, '') };
      });
  } catch { return []; }
}

export function clearPartFiles(only = null) {
  let freed = 0;
  for (const p of stalePartFiles()) {
    if (only && p.model !== only) continue;
    freed += p.bytes;
    fs.rmSync(p.path, { force: true });
  }
  return freed;
}

const gb = (n) => `${(n / 1073741824).toFixed(1)} GB`;

/**
 * Download a model, resuming a half-finished attempt where possible.
 *
 * Three things this has to get right, all learned the hard way on a nearly
 * full disk: say up front when there is not enough room, fail loudly rather
 * than silently when the write fails partway, and never leave a `.part` file
 * behind that the next attempt cannot make sense of.
 */
export async function downloadModel(id, onProgress) {
  const model = MODELS.find((m) => m.id === id);
  if (!model) throw new Error(`Unknown model "${id}"`);
  const dest = modelTarget(id);
  const tmp = `${dest}.part`;
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  // Ask for the size first so the disk check can be made before anything is
  // written, rather than after several hundred megabytes of wasted download.
  const head = await fetch(modelUrl(id), { method: 'HEAD', redirect: 'follow' }).catch(() => null);
  const expected = Number(head?.headers.get('content-length')) || 0;

  let resumeFrom = 0;
  try {
    const part = fs.statSync(tmp);
    // Only resume something that could plausibly be this file.
    if (expected && part.size > 0 && part.size < expected) resumeFrom = part.size;
    else if (part.size >= expected && expected) fs.rmSync(tmp, { force: true });
  } catch { /* no part file, start clean */ }

  const stillNeeded = Math.max(0, (expected || 0) - resumeFrom);
  const free = freeBytes();
  // Leave the machine some room to breathe; a volume with nothing spare is a
  // worse problem than a missing model.
  const HEADROOM = 512 * 1024 * 1024;
  if (free !== null && stillNeeded && free < stillNeeded + HEADROOM) {
    const stale = stalePartFiles().filter((p) => p.model !== id).reduce((a, p) => a + p.bytes, 0);
    throw new Error(
      `Not enough disk space for ${model.label}: it needs ${gb(stillNeeded)} and only ${gb(free)} is free.`
      + (stale ? ` There is ${gb(stale)} of abandoned download files in the models folder you can clear first.` : '')
      + ' Free some space and try again.',
    );
  }

  const res = await fetch(modelUrl(id), {
    redirect: 'follow',
    headers: resumeFrom ? { range: `bytes=${resumeFrom}-` } : {},
  });
  // 206 means the resume was honoured; a plain 200 means it was not, so the
  // part file is useless and the download starts over.
  const resumed = resumeFrom > 0 && res.status === 206;
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  if (resumeFrom && !resumed) resumeFrom = 0;

  const total = expected || (Number(res.headers.get('content-length')) || 0) + resumeFrom;
  let received = resumeFrom;

  const out = fs.createWriteStream(tmp, resumed ? { flags: 'a' } : { flags: 'w' });
  // Without this an ENOSPC mid-download is an unhandled 'error' event, which
  // takes the whole server down — and the awaited 'drain' below would never
  // fire anyway, so the download would simply hang for ever.
  const failed = new Promise((_, reject) => out.once('error', (err) => reject(
    err.code === 'ENOSPC'
      ? new Error(`The disk filled up after ${gb(received)}. Free some space; the partial download is kept so it can resume.`)
      : err,
  )));

  try {
    await Promise.race([failed, (async () => {
      for await (const chunk of res.body) {
        received += chunk.length;
        if (!out.write(chunk)) {
          await Promise.race([failed, new Promise((r) => out.once('drain', r))]);
        }
        onProgress?.({ received, total, progress: total ? received / total : 0, resumed });
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    })()]);

    // A truncated file that gets renamed into place looks installed and then
    // fails at transcription time, which is far more confusing than a failed
    // download. Check before committing.
    const written = fs.statSync(tmp).size;
    if (total && written < total) {
      throw new Error(`Download stopped early: got ${gb(written)} of ${gb(total)}. The partial file is kept so it can resume.`);
    }
    fs.renameSync(tmp, dest);
  } catch (err) {
    out.destroy();
    // Keep the part file: it is what makes the next attempt a resume rather
    // than a fresh 1.6 GB. It is only removed when it is unusable.
    if (err.code === 'ERR_INVALID_STATE' || /HTTP/.test(err.message)) fs.rm(tmp, { force: true }, () => {});
    throw err;
  }
  return { id, bytes: received, resumed };
}

export function deleteModel(id) {
  if (!MODELS.some((m) => m.id === id)) throw new Error('unknown model');
  const file = modelFile(id);
  if (!fs.existsSync(file)) return;
  fs.rmSync(file, { force: true });
}
