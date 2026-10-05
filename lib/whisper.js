import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MODELS_DIR, TMP_DIR, modelFile, modelInstalled } from './config.js';

const execFileP = promisify(execFile);

const CANDIDATE_BINARIES = [
  'whisper-cli',
  '/opt/homebrew/bin/whisper-cli',
  '/usr/local/bin/whisper-cli',
  'whisper-cpp',
  'main',
];

let cachedBinary;

/** Locate the whisper.cpp CLI once and remember it. Returns null when absent. */
export async function whisperBinary() {
  if (cachedBinary !== undefined) return cachedBinary;
  for (const candidate of CANDIDATE_BINARIES) {
    try {
      const { stdout } = await execFileP('command', ['-v', candidate], { shell: '/bin/bash' });
      const resolved = stdout.trim();
      if (resolved) { cachedBinary = resolved; return cachedBinary; }
    } catch { /* keep looking */ }
  }
  cachedBinary = null;
  return null;
}

export function resetBinaryCache() { cachedBinary = undefined; }

export async function whisperVersion() {
  const bin = await whisperBinary();
  if (!bin) return null;
  try {
    const { stdout, stderr } = await execFileP(bin, ['--version']);
    const version = `${stdout}${stderr}`.match(/\bv?(\d+\.\d+(?:\.\d+)?)\b/);
    return version ? `v${version[1]}` : 'installed';
  } catch {
    return 'installed';
  }
}

/**
 * Transcribe a 16 kHz mono WAV file.
 *
 * `offsetMs` is added to every returned timestamp so callers can pass a slice
 * of a longer recording and get transcript-absolute times back.
 */
export async function transcribeWav(wavPath, opts = {}) {
  const {
    model = 'base.en',
    language = 'auto',
    translate = false,
    threads = 0,
    offsetMs = 0,
    prompt = '',
    // Tokens of previous text whisper carries into the next window. The
    // default (-1, unlimited) is what makes whisper loop: on quiet or
    // far-field audio it starts repeating its own recent output, that
    // repetition becomes the context for the next window, and the rest of the
    // lecture locks into one sentence repeated hundreds of times. Measured on
    // a real 15-minute lecture: 63% of segments were repeats with the default,
    // 7% with this off. Do not "restore" this without re-running that test.
    maxContext = 0,
    signal,
    // Background jobs are transcribing a lecture that already happened, so
    // they yield to everything else on the machine — including a recording
    // that is happening right now.
    background = false,
  } = opts;

  const bin = await whisperBinary();
  if (!bin) throw new Error('whisper.cpp is not installed. Run the setup step first.');
  if (!modelInstalled(model)) throw new Error(`Model "${model}" is not downloaded yet.`);

  const outPrefix = path.join(TMP_DIR, `w-${path.basename(wavPath, '.wav')}-${process.pid}`);
  const args = [
    '-m', modelFile(model),
    '-f', wavPath,
    '-oj', '-of', outPrefix,
    '-np',
    '-l', language || 'auto',
    // Non-speech tokens like (music) / [BLANK_AUDIO] are noise in a meeting transcript.
    '-sns',
  ];
  if (translate) args.push('-tr');
  if (threads > 0) args.push('-t', String(threads));
  else if (background) args.push('-t', String(Math.max(2, Math.floor(os.cpus().length / 2))));
  else args.push('-t', String(Math.max(2, Math.min(8, os.cpus().length - 2))));
  if (Number.isFinite(maxContext) && maxContext >= 0) args.push('-mc', String(maxContext));
  if (prompt) args.push('--prompt', prompt.slice(0, 800));

  await run(bin, args, signal, { lowPriority: background && opts.lowPriority !== false });

  const jsonPath = `${outPrefix}.json`;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    throw new Error('whisper produced no output for this chunk');
  } finally {
    fs.rm(jsonPath, { force: true }, () => {});
  }

  const segments = (parsed.transcription || [])
    .map((s) => ({
      start: (s.offsets?.from ?? 0) + offsetMs,
      end: (s.offsets?.to ?? 0) + offsetMs,
      text: cleanText(s.text || ''),
    }))
    .filter((s) => s.text.length > 0);

  return { segments, language: parsed.result?.language || language };
}

// whisper emits leading spaces and bracketed non-speech markers; strip both.
const NOISE = /^[\[(](blank_audio|music|silence|inaudible|no speech|sound|applause|laughter)[\])]$/i;
function cleanText(raw) {
  const text = raw.replace(/\s+/g, ' ').trim();
  return NOISE.test(text) ? '' : text;
}

function run(bin, args, signal, { lowPriority = false } = {}) {
  return new Promise((resolve, reject) => {
    // `nice` is the cheapest way to keep a long background transcription from
    // making the machine feel sluggish; if it is missing, run as normal.
    const [cmd, argv] = lowPriority && process.platform !== 'win32'
      ? ['nice', ['-n', '10', bin, ...args]]
      : [bin, args];
    const child = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 8000) stderr = stderr.slice(-4000); });

    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });

    child.on('error', (err) => { signal?.removeEventListener('abort', abort); reject(err); });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { aborted: true }));
      if (code === 0) return resolve();
      reject(new Error(`whisper exited ${code}: ${stderr.split('\n').slice(-4).join(' ').trim()}`));
    });
  });
}

/** Which GGML models are actually on disk. */
export function installedModels() {
  try {
    return fs.readdirSync(MODELS_DIR)
      .filter((f) => f.startsWith('ggml-') && f.endsWith('.bin'))
      .map((f) => f.slice(5, -4));
  } catch {
    return [];
  }
}
