import fs from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { SAMPLE_RATE, CHANNELS, BYTES_PER_SAMPLE, BYTES_PER_SEC } from './config.js';

export const hasFfmpeg = () => new Promise((resolve) => {
  execFile('ffmpeg', ['-version'], { timeout: 5000 }, (err) => resolve(!err));
});

/** 44-byte canonical WAV header for raw s16le PCM of `dataBytes` length. */
export function wavHeader(dataBytes) {
  const h = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);            // PCM fmt chunk size
  h.writeUInt16LE(1, 20);             // format = PCM
  h.writeUInt16LE(CHANNELS, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32); // block align
  h.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/**
 * Copy PCM bytes [from,to) out of `pcmPath` into a standalone WAV at `wavPath`.
 *
 * Streamed, not buffered: a long recording's flush window can be tens of
 * minutes of audio, and reading that through `Buffer.alloc` + `Buffer.concat`
 * meant a transient allocation of twice the slice (~460 MB for a two-hour
 * flush) at exactly the moment the machine is busiest. The header is written
 * from the real on-disk length so it can never over-declare the data chunk.
 */
export async function writeWavSlice(pcmPath, wavPath, from, to) {
  const size = (await fs.promises.stat(pcmPath)).size;
  const start = alignDown(Math.max(0, from));
  const end = alignDown(Math.min(Math.max(start, to), size));
  const length = end - start;
  if (length <= 0) throw new Error('empty audio slice');

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(wavPath);
    out.on('error', reject);
    out.on('finish', resolve);
    out.write(wavHeader(length));
    const input = fs.createReadStream(pcmPath, { start, end: end - 1, highWaterMark: 1 << 20 });
    input.on('error', (err) => { out.destroy(); reject(err); });
    input.pipe(out);
  });
  return length / BYTES_PER_SEC;
}

/**
 * Decode any audio file back to the normalised PCM the transcriber expects.
 * Used to re-transcribe a finished recording from its compressed m4a when the
 * raw PCM has already been reclaimed.
 */
export function decodeToPcm(srcPath, pcmPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', srcPath,
      '-vn',
      '-f', 's16le', '-acodec', 'pcm_s16le',
      '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS),
      pcmPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(pcmPath) : reject(new Error(stderr.trim() || `ffmpeg exited ${code}`))));
  });
}

// PCM frames must not be split mid-sample or the slice picks up a click.
const alignDown = (n) => n - (n % (CHANNELS * BYTES_PER_SAMPLE));

/**
 * ffmpeg reading a browser MediaRecorder stream (webm/opus) on stdin and
 * emitting normalised s16le PCM on stdout. Low-latency flags matter here:
 * the default probe would sit on several seconds of audio before producing
 * anything, which would stall live transcription at the start of a recording.
 */
export function startStreamTranscoder() {
  return spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-fflags', 'nobuffer',
    '-probesize', '32k',
    '-analyzeduration', '0',
    '-i', 'pipe:0',
    '-vn',
    '-af', 'aresample=async=1',
    '-f', 's16le', '-acodec', 'pcm_s16le',
    '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS),
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * ffmpeg capturing a CoreAudio input device (BlackHole, an Aggregate Device,
 * or a plain microphone) straight to normalised PCM on stdout.
 */
export function startDeviceCapture(deviceIndex) {
  return spawn('ffmpeg', [
    // Without -nostdin ffmpeg reads the /dev/null stdin, sees EOF and treats it
    // as the interactive "q" quit key — capture would end the instant it began.
    '-nostdin',
    '-hide_banner', '-loglevel', 'error',
    '-f', 'avfoundation',
    '-i', `:${deviceIndex}`,
    '-vn',
    // Load-bearing. avfoundation hands ffmpeg buffers with gaps in their
    // timestamps — on this Mac's built-in microphone, consistently about 13%
    // of them. Without async the encoder simply concatenates what it received,
    // so an hour of lecture came out as 52 minutes of audio and every
    // timestamp after the first minute drifted further from reality. With it,
    // the resampler honours the timestamps and the recording stays in step
    // with the clock. Measured: 13.3% lost without, 2.7% with (and that 2.7%
    // is the startup lag, not ongoing loss).
    // The browser path has always had this, which is why only device
    // recordings were affected.
    '-af', 'aresample=async=1:first_pts=0',
    '-f', 's16le', '-acodec', 'pcm_s16le',
    '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS),
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Compress the raw session PCM into a small playable file for the library. */
export function encodeFinal(pcmPath, outPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS),
      '-i', pcmPath,
      '-c:a', 'aac', '-b:a', '64k',
      outPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(outPath) : reject(new Error(stderr.trim() || `ffmpeg exited ${code}`))));
  });
}

/**
 * RMS loudness of a PCM buffer, 0..1.
 *
 * Peak is what the meter wants — it has to twitch. Whether a recording is
 * usable is an RMS question: a lecture can peak near full scale on a cough and
 * still average far too quiet for a transcriber to find words in.
 */
export function bufferRms(buf) {
  if (buf.length < 2) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const v = buf.readInt16LE(i) / 32768;
    sum += v * v;
    n += 1;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/** Peak-ish loudness of a PCM buffer, 0..1, for the level meter. */
export function bufferLevel(buf) {
  if (buf.length < 2) return 0;
  let peak = 0;
  // Sampling every 16th frame is plenty for a 10 Hz meter and keeps this cheap.
  for (let i = 0; i + 1 < buf.length; i += 32) {
    const v = Math.abs(buf.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return Math.min(1, peak / 32768);
}
