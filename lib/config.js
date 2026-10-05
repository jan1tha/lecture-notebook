import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
export const TMP_DIR = path.join(ROOT, 'tmp');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
// Modules are the folder a lecture belongs to: one dir each, holding the
// module's own meta, the student's running module notes and their assets.
export const MODULES_DIR = path.join(DATA_DIR, 'modules');

// Models are large. Prefer an explicit override, then the sibling audio-scribe
// checkout (so the two apps share one download), then our own folder.
const CANDIDATE_MODEL_DIRS = [
  process.env.MODELS_DIR,
  path.resolve(ROOT, '..', 'audio-scribe', 'models'),
  path.join(ROOT, 'models'),
].filter(Boolean);

export const MODELS_DIR = CANDIDATE_MODEL_DIRS.find((d) => {
  try { return fs.statSync(d).isDirectory(); } catch { return false; }
}) || path.join(ROOT, 'models');

for (const d of [DATA_DIR, SESSIONS_DIR, MODULES_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });

export const SAMPLE_RATE = 16000;
export const CHANNELS = 1;
export const BYTES_PER_SAMPLE = 2;
export const BYTES_PER_SEC = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;

export const MODELS = [
  { id: 'tiny.en',  label: 'Tiny (English)',   size: '75 MB',  note: 'Fastest, roughest. Only worth it as an optional live preview.' },
  { id: 'base.en',  label: 'Base (English)',   size: '142 MB', note: 'Light enough to run live during a lecture. Too rough to be the real transcript.' },
  { id: 'small.en', label: 'Small (English)',  size: '466 MB', note: 'The floor for a usable lecture-hall transcript. Roughly 8x faster than real time.' },
  { id: 'medium.en',label: 'Medium (English)', size: '1.5 GB', note: 'Excellent English accuracy, but slow — around real time on this Mac.' },
  { id: 'large-v3-turbo', label: 'Large v3 Turbo', size: '1.6 GB', note: 'Recommended. Near-large accuracy at several times real time, and it copes with non-English.' },
  { id: 'large-v3', label: 'Large v3', size: '3.1 GB', note: 'The most accurate option. Slow enough that you want it running overnight, not between lectures.' },
];

// Transcription runs after the lecture, so accuracy matters more than speed.
// This is what a fresh install is pointed at, and what Setup nudges towards.
export const RECOMMENDED_MODEL = 'large-v3-turbo';

const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
export const modelTarget = (id) => path.join(MODELS_DIR, `ggml-${id}.bin`);
export const modelUrl = (id) => `${MODEL_BASE_URL}/ggml-${id}.bin?download=true`;

export const modelFile = (id) => {
  for (const dir of CANDIDATE_MODEL_DIRS) {
    const candidate = path.join(dir, `ggml-${id}.bin`);
    try { if (fs.statSync(candidate).size > 1_000_000) return candidate; } catch { /* next */ }
  }
  return modelTarget(id);
};

export const modelInstalled = (id) => {
  try { return fs.statSync(modelFile(id)).size > 1_000_000; } catch { return false; }
};

const DEFAULTS = {
  /* ---- transcription -------------------------------------------------- */
  // The model that produces the transcript you actually keep. It runs in the
  // background after the lecture, so it is chosen for accuracy, not speed.
  transcribeModel: RECOMMENDED_MODEL,
  // A rough transcript scrolling past while the lecturer talks is nice to
  // have, but it costs CPU during the one part of the session that must not
  // glitch — so it is off unless asked for.
  liveTranscribe: false,
  model: 'base.en',       // the live preview model, when live preview is on
  language: 'auto',
  translate: false,
  chunkSeconds: 18,
  contextSeconds: 3,
  // Background jobs run at low priority on half the cores: transcribing last
  // week's lecture must never make this week's lecture drop audio.
  backgroundThreads: 0,   // 0 = half the cores
  lowPriority: true,

  /* ---- capture -------------------------------------------------------- */
  mixMic: false,
  threads: 0,
  slideDpi: 140,
  notesDir: '',           // where generated lecture notes should be written

  /* ---- reliability knobs (see lib/session.js) ------------------------- */
  // No PCM for this many seconds while "recording" means capture has died
  // quietly. The session restarts it rather than letting the lecture go dark.
  stallSeconds: 12,
  // Ceiling for the widened window the live pass uses when it falls behind.
  catchupSeconds: 60,
  // Keep audio.pcm after the transcript exists. Costs ~115 MB/hour; the m4a is
  // enough to re-transcribe from, so this is off unless you want the original.
  keepPcm: false,
};

/** Older settings files called the transcription model `finalModel`. */
function migrate(raw) {
  const out = { ...raw };
  if (!out.transcribeModel && out.finalModel) out.transcribeModel = out.finalModel;
  delete out.finalModel;
  delete out.finalPass;
  return out;
}

export function loadSettings() {
  try { return { ...DEFAULTS, ...migrate(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))) }; }
  catch { return { ...DEFAULTS }; }
}

/**
 * The transcription model to actually use: the configured one if it is on
 * disk, otherwise the best installed alternative. A setting that points at a
 * model the student never downloaded should degrade, not fail at stop time.
 */
export function resolveTranscribeModel(settings = loadSettings()) {
  const wanted = settings.transcribeModel || RECOMMENDED_MODEL;
  if (modelInstalled(wanted)) return wanted;
  const byQuality = ['large-v3', 'large-v3-turbo', 'medium.en', 'small.en', 'base.en', 'tiny.en'];
  return byQuality.find(modelInstalled) || wanted;
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  next.chunkSeconds = clamp(next.chunkSeconds, 5, 60, DEFAULTS.chunkSeconds);
  next.contextSeconds = clamp(next.contextSeconds, 0, 10, DEFAULTS.contextSeconds);
  next.threads = clamp(next.threads, 0, 16, 0);
  next.stallSeconds = clamp(next.stallSeconds, 5, 120, DEFAULTS.stallSeconds);
  next.catchupSeconds = clamp(next.catchupSeconds, 15, 180, DEFAULTS.catchupSeconds);
  next.slideDpi = clamp(next.slideDpi, 72, 220, DEFAULTS.slideDpi);
  if (!MODELS.some((m) => m.id === next.model)) next.model = DEFAULTS.model;
  if (next.finalModel && !MODELS.some((m) => m.id === next.finalModel)) next.finalModel = '';
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

const clamp = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

export { DEFAULTS };
