import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  BYTES_PER_SEC, TMP_DIR, loadSettings,
} from './config.js';
import {
  startStreamTranscoder, startDeviceCapture, writeWavSlice, encodeFinal, bufferLevel, bufferRms,
} from './audio.js';
import { transcribeWav } from './whisper.js';

// A live window is never allowed to grow past this multiple of the configured
// chunk length, even if whisper keeps handing back one unterminated segment.
const MAX_WINDOW_FACTOR = 2.5;
// A trailing segment closer than this to the window edge is probably cut off,
// so it is left for the next window rather than emitted.
const EDGE_GUARD_MS = 1200;
// How often the session reports duration / backlog / health to the UI. Without
// this the browser has nothing but its own wall clock to go on, which keeps
// counting happily while capture is dead.
const TICK_MS = 2000;
// Capture is restarted rather than failed, but not forever — after this many
// restarts the session stays up and flagged instead of thrashing.
const MAX_CAPTURE_RESTARTS = 24;

/* ---- input level ------------------------------------------------------- */
// An input this quiet produces transcripts a model has to guess at, which is
// where whisper starts repeating itself. A real lecture recorded here averaged
// -27 dB; anything under -24 dB is worth saying something about.
const QUIET_RMS = 0.063;      // ≈ -24 dBFS
// Below this there is no signal at all — an unplugged input, or nobody
// talking yet. Warning about that would just be noise.
const SILENT_RMS = 0.0018;    // ≈ -55 dBFS
// Judge on the loudest two-second window in the last half minute, so ordinary
// pauses between sentences do not count against the recording — but start
// judging after ten seconds, because the whole value of this warning is that
// you hear it while the microphone is still movable.
const LEVEL_WINDOWS = 15;
const LEVEL_MIN_WINDOWS = 5;

const secToBytes = (s) => Math.floor(s * BYTES_PER_SEC);
const bytesToMs = (b) => Math.floor((b / BYTES_PER_SEC) * 1000);

export class RecordingSession extends EventEmitter {
  constructor({ id, dir, source, deviceIndex = null, deviceName = '', title = '', settings = {}, onPersist = null, resolveDevice = null }) {
    super();
    if (!dir) throw new Error('RecordingSession needs a dir');
    this.id = id;
    this.onPersist = onPersist;
    // (name, lastIndex) => device | null. Lets a restart follow an input that
    // has moved rather than recording whatever now sits at the old index.
    this.resolveDevice = resolveDevice;
    this.source = source;                       // 'browser' | 'device'
    this.deviceIndex = deviceIndex;
    this.deviceName = deviceName;
    this.settings = { ...loadSettings(), ...settings };
    this.status = 'idle';                       // idle|recording|finishing|processing|done|error
    this.error = null;

    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.pcmPath = path.join(this.dir, 'audio.pcm');
    this.audioPath = path.join(this.dir, 'audio.m4a');

    this.bytesWritten = 0;
    this.cursorBytes = 0;
    this.segments = [];
    this.requestedAt = Date.now();  // when record was pressed
    this.startedAt = this.requestedAt;  // corrected to the first sample below
    this.startupLagMs = null;
    this.endedAt = null;
    this.level = 0;
    this.busy = false;
    this.title = title || defaultTitle(this.startedAt);
    this.sourceLabel = source === 'device' ? (deviceName || `Input ${deviceIndex}`) : 'Browser tab / screen';

    /* ---- health -------------------------------------------------------- */
    this.lastPcmAt = 0;        // when capture last produced audio
    this.quiet = false;        // input is audible but too quiet, right now
    this.levelDb = null;       // loudest recent window, in dBFS
    this._loudestEver = 0;     // loudest window of the whole recording
    this._rmsSum = 0;          // running sum of squares for the current window
    this._rmsN = 0;
    this._windows = [];        // recent per-window RMS values
    this.stalled = false;      // capture has gone quiet for longer than it should
    this.restarts = 0;         // how many times capture had to be respawned
    this.gaps = [];            // [{ atMs, reason }] — where audio was lost
    this.degraded = false;     // something went wrong but the lecture kept going

    this._ff = null;
    this._pcmOut = null;
    this._timer = null;
    this._tick = null;
    this._stderr = '';
    this._lastLevelEmit = 0;
    this._inputEnded = false;
    this._recovering = false;
    this._awaitingHeader = false;  // browser mode: waiting for a fresh webm header
    this._warnedBehind = false;
    this._abort = new AbortController();
  }

  /* ------------------------------------------------------------ lifecycle */

  async start() {
    if (this.status !== 'idle') throw new Error('session already started');
    this._pcmOut = fs.createWriteStream(this.pcmPath);
    this._spawnCapture();

    this.status = 'recording';
    this.requestedAt = Date.now();
    this.startedAt = this.requestedAt;
    this.lastPcmAt = Date.now();
    // Live preview is optional and off by default: the transcript that gets
    // kept is produced afterwards by the background queue, so during the
    // lecture this process does nothing but move audio onto disk.
    if (this.settings.liveTranscribe) this._timer = setInterval(() => this._maybeTranscribe(), 1000);
    this._tick = setInterval(() => this._onTick(), TICK_MS);
    this._emitState();
    this.persist();
    return this;
  }

  /**
   * Spawn (or respawn) the capture process and wire it to the PCM file.
   *
   * The PCM write stream deliberately outlives the ffmpeg process: a restart
   * appends to the same file, so a mid-lecture recovery costs a short gap in
   * the audio rather than a second recording the student has to stitch.
   */
  _spawnCapture() {
    const ff = this.source === 'device'
      ? startDeviceCapture(this.deviceIndex)
      : startStreamTranscoder();
    this._ff = ff;
    this._ffClosed = false;

    ff.stdout.on('data', (chunk) => this._onPcm(chunk));
    ff.stderr.on('data', (d) => {
      this._stderr += d;
      if (this._stderr.length > 6000) this._stderr = this._stderr.slice(-3000);
    });
    ff.on('error', (err) => this._fail(`ffmpeg failed to start: ${err.message}`));
    ff.on('close', (code) => {
      this._ffClosed = true;
      if (this.status !== 'recording' || this._inputEnded) return;
      // Capture died under us mid-lecture. Ending the whole recording here is
      // what used to lose the back half of a long lecture, so restart instead.
      this._recoverCapture(`capture exited ${code}${lastLine(this._stderr) ? ` — ${lastLine(this._stderr)}` : ''}`);
    });
    // Writing to a dead ffmpeg raises EPIPE on the stdin stream; swallow it,
    // the 'close' handler above already reports the real problem.
    ff.stdin?.on('error', () => {});
  }

  /**
   * Bring capture back after it died or went silent.
   *
   * In browser mode the new ffmpeg cannot join a webm stream mid-flight — it
   * needs the container header again — so incoming audio is dropped until the
   * client answers `reopenInput` with a fresh MediaRecorder.
   */
  _recoverCapture(reason) {
    if (this._recovering || this.status !== 'recording') return;
    this._recovering = true;
    this.degraded = true;
    const atMs = this.durationMs;

    if (this.restarts >= MAX_CAPTURE_RESTARTS) {
      this._recovering = false;
      this.emit('event', {
        type: 'warning',
        message: 'Audio capture keeps failing. Stop the recording to keep what has been captured so far.',
      });
      return;
    }
    this.restarts += 1;
    this.gaps.push({ atMs, reason });
    try { this._ff?.kill('SIGKILL'); } catch { /* already gone */ }

    setTimeout(async () => {
      if (this.status !== 'recording') { this._recovering = false; return; }
      try {
        await this._followDevice();
        if (this.source === 'browser') this._awaitingHeader = true;
        this._spawnCapture();
        this.lastPcmAt = Date.now();
        this.stalled = false;
        this.emit('event', {
          type: 'warning',
          message: `Audio capture restarted at ${fmtClock(atMs)} (${reason}). A few seconds of audio were lost there.`,
        });
        if (this.source === 'browser') this.emit('event', { type: 'reopenInput', atMs });
        this._emitState();
        this.persist();
      } catch (err) {
        this._fail(`Could not restart audio capture: ${err.message}`);
      } finally {
        this._recovering = false;
      }
    }, 400);
  }

  /**
   * avfoundation renumbers its inputs whenever one is plugged in or removed,
   * which is one of the commonest ways capture dies partway through an
   * in-person lecture. Respawning against the remembered index would then
   * cheerfully record a different input, so follow the device by name.
   */
  async _followDevice() {
    if (this.source !== 'device' || !this.resolveDevice || !this.deviceName) return;
    let found = null;
    try { found = await this.resolveDevice(this.deviceName, this.deviceIndex); } catch { return; }
    if (!found || found.index === this.deviceIndex) return;
    this.emit('event', {
      type: 'warning',
      message: `"${this.deviceName}" moved to input ${found.index} — following it.`,
    });
    this.deviceIndex = found.index;
    this.sourceLabel = found.name || this.sourceLabel;
  }

  /**
   * Browser mode: push a MediaRecorder blob into the transcoder.
   *
   * Resolves once ffmpeg has accepted the bytes, so the HTTP response is the
   * browser's backpressure signal — without it a stalled transcoder just grows
   * an unbounded stdin buffer in memory for the rest of the lecture.
   */
  async feed(chunk, { fresh = false } = {}) {
    if (this.status !== 'recording') return false;
    if (fresh) this._awaitingHeader = false;
    // Tail of the pre-restart stream: headerless to the new ffmpeg, so binning
    // it is the difference between a short gap and a poisoned decoder.
    if (this._awaitingHeader) return false;

    const stdin = this._ff?.stdin;
    if (!stdin?.writable) return false;
    if (stdin.write(chunk)) return true;
    await new Promise((resolve) => {
      const done = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(done, 5000);
      stdin.once('drain', done);
    });
    return true;
  }

  /**
   * The browser telling us when its MediaRecorder actually began capturing,
   * which is media time zero for that stream. Accepted once, and only if it
   * is sane — a clock-skewed client should not be able to move a recording's
   * timeline somewhere absurd.
   */
  noteMediaStart(ms) {
    if (this._mediaStartedAt !== undefined || this.source !== 'browser') return;
    const t = Number(ms);
    if (!Number.isFinite(t) || t < this.requestedAt - 5000 || t > Date.now() + 1000) return;
    this._mediaStartedAt = t;
    this.startedAt = t;
    this.startupLagMs = t - this.requestedAt;
  }

  /** Browser mode: true while the server is waiting for a fresh webm header. */
  needsFreshInput() { return this._awaitingHeader; }

  /**
   * The client has decided its stream is no good (uploads failing, its own
   * recorder errored). Restart the transcoder so both halves re-sync on a
   * fresh webm header instead of splicing one into a stream mid-flight.
   */
  requestFreshInput(reason = 'the browser asked for a fresh stream') {
    if (this.source !== 'browser' || this.status !== 'recording') return false;
    this._recoverCapture(reason);
    return true;
  }

  endInput() {
    this._inputEnded = true;
    if (this._ff?.stdin?.writable) this._ff.stdin.end();
  }

  async stop() {
    if (this.status === 'done' || this.status === 'error') return this.toJSON();
    if (this.status === 'finishing' || this.status === 'processing') return this.toJSON();

    this.status = 'finishing';
    this._emitState();
    clearInterval(this._timer); this._timer = null;
    clearInterval(this._tick); this._tick = null;

    // Let capture drain: close stdin (browser) or signal ffmpeg (device).
    this._inputEnded = true;
    if (this.source === 'device') this._ff?.kill('SIGINT');
    else this.endInput();
    await this._awaitCaptureExit(10000);
    await new Promise((resolve) => this._pcmOut.end(resolve));

    this.endedAt = Date.now();
    this.status = 'processing';
    this._emitState();

    try {
      // Only a live-preview window can be in flight, and it is cheap to wait
      // out; nothing here transcribes.
      await this._settleBusy(60000);
      this.persistTranscript();

      if (this.bytesWritten > 0) {
        this.emit('event', { type: 'encoding' });
        await encodeFinal(this.pcmPath, this.audioPath).catch(() => null);
      }

      // The transcript is the background queue's job. Stopping a recording is
      // therefore instant, cannot hang on whisper, and cannot fail in a way
      // that costs the lecture — the audio is on disk and queued.
      // The raw PCM stays until that job succeeds, so a retry has the best
      // possible source to work from.
      const worthTranscribing = this.bytesWritten > secToBytes(0.5);
      this.status = worthTranscribing ? 'queued' : 'done';
      this.persist();
      this._emitState();
      this.emit('done', this.toJSON());
    } catch (err) {
      this._fail(err.message);
    }
    return this.toJSON();
  }

  cancel() {
    this._abort.abort();
    clearInterval(this._timer);
    clearInterval(this._tick);
    try { this._ff?.kill('SIGKILL'); } catch {}
    try { this._pcmOut?.end(); } catch {}
    this.status = 'done';
    this._emitState();
  }

  /** Wait for an in-flight live window to finish before touching the cursor. */
  async _settleBusy(timeoutMs = 300000) {
    const deadline = Date.now() + timeoutMs;
    while (this.busy && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /* -------------------------------------------------------------- capture */

  _onPcm(chunk) {
    // Media time zero is the first sample, not the moment the button was
    // pressed: opening a CoreAudio device takes about half a second, and the
    // exporter maps note and transcript timestamps onto the wall clock with
    // `startedAt + t`. Anchoring that to the button press made every timestamp
    // in a bundle around half a second early. Corrected once, on the first
    // sample ever — a mid-lecture capture restart must not move it.
    if (this._audioBegunAt === undefined) {
      this._audioBegunAt = Date.now();
      // Device capture hands over samples as it takes them, so the first one
      // arriving *is* media time zero. The browser path is different: its
      // first chunk carries up to a second of audio recorded before it was
      // uploaded, so taking the arrival time would push every timestamp a
      // second late. There the client reports its own start — see
      // noteMediaStart().
      if (this.source === 'device' && this._mediaStartedAt === undefined) {
        this.startedAt = this._audioBegunAt;
        this.startupLagMs = this.startedAt - this.requestedAt;
      }
    }

    // Windows are read back off disk, so only count bytes the write stream has
    // actually flushed — otherwise a slice can run past the end of the file.
    this._pcmOut.write(chunk, () => { this.bytesWritten += chunk.length; });
    this.lastPcmAt = Date.now();
    if (this.stalled) {
      this.stalled = false;
      this.emit('event', { type: 'warning', message: 'Audio is flowing again.' });
    }

    // Accumulated per chunk, judged per tick: cheap, and it needs a window
    // longer than one buffer to mean anything.
    this._rmsSum += bufferRms(chunk) ** 2;
    this._rmsN += 1;

    const now = Date.now();
    if (now - this._lastLevelEmit > 100) {
      this._lastLevelEmit = now;
      this.level = bufferLevel(chunk);
      this.emit('event', { type: 'level', level: this.level, durationMs: this.durationMs });
    }
  }

  /**
   * Is the input loud enough to be worth transcribing? Answered on the
   * loudest recent window, so pauses do not drag the verdict down.
   */
  _checkLevel() {
    if (this._rmsN === 0) return;
    this._windows.push(Math.sqrt(this._rmsSum / this._rmsN));
    this._rmsSum = 0;
    this._rmsN = 0;
    if (this._windows.length > LEVEL_WINDOWS) this._windows.shift();
    if (this._windows.length < LEVEL_MIN_WINDOWS) return;

    const loudest = Math.max(...this._windows);
    this._loudestEver = Math.max(this._loudestEver, loudest);
    this.levelDb = loudest > 0 ? Math.round(20 * Math.log10(loudest)) : null;
    const wasQuiet = this.quiet;
    this.quiet = loudest > SILENT_RMS && loudest < QUIET_RMS;
    if (this.quiet && !wasQuiet) {
      this.emit('event', {
        type: 'warning',
        message: `The input is very quiet (${this.levelDb} dB). Move the microphone closer or raise the input level — a transcript from audio this quiet will be poor.`,
      });
    }
  }

  /**
   * The heartbeat. Two jobs: tell the UI how much audio actually exists (its
   * own wall clock cannot know), and notice when capture has gone quiet.
   */
  _onTick() {
    if (this.status !== 'recording') return;
    const stallMs = Math.max(5, Number(this.settings.stallSeconds) || 12) * 1000;
    const quietMs = Date.now() - (this.lastPcmAt || this.startedAt);

    if (!this.stalled && !this._recovering && quietMs > stallMs) {
      this.stalled = true;
      this.emit('event', {
        type: 'warning',
        message: `No audio for ${Math.round(quietMs / 1000)}s — restarting capture.`,
      });
      this._recoverCapture(`no audio for ${Math.round(quietMs / 1000)}s`);
    }
    this._checkLevel();
    this.emit('event', { type: 'tick', ...this.health() });
  }

  health() {
    const transcribedMs = bytesToMs(this.cursorBytes);
    return {
      durationMs: this.durationMs,
      transcribedMs,
      backlogMs: Math.max(0, this.durationMs - transcribedMs),
      stalled: this.stalled,
      quiet: this.quiet,
      levelDb: this.levelDb,
      degraded: this.degraded,
      gaps: this.gaps.length,
      restarts: this.restarts,
      segmentCount: this.segments.length,
    };
  }

  /**
   * Captured audio as a fraction of the wall-clock time it was captured over.
   * 1.0 is a healthy recording; the device path used to sit at 0.87.
   */
  captureRatio() {
    const span = (this.endedAt || Date.now()) - this.startedAt;
    if (span < 5000) return null;
    return Math.min(1, Number((this.durationMs / span).toFixed(4)));
  }

  /** The loudest moment of the recording so far, in dBFS. */
  loudestDb() {
    return this._loudestEver > 0 ? Math.round(20 * Math.log10(this._loudestEver)) : null;
  }

  /** Was this recording, taken as a whole, too quiet to transcribe well? */
  wasQuiet() {
    return this._loudestEver > SILENT_RMS && this._loudestEver < QUIET_RMS;
  }

  _awaitCaptureExit(timeoutMs) {
    if (this._ffClosed || !this._ff) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(() => { try { this._ff.kill('SIGKILL'); } catch {} resolve(); }, timeoutMs);
      this._ff.once('close', done);
    });
  }

  /* --------------------------------------------------------- transcription */

  async _maybeTranscribe() {
    if (this.busy || this.status !== 'recording' || !this.settings.liveTranscribe) return;
    const pending = this.bytesWritten - this.cursorBytes;
    const chunkSec = this.settings.chunkSeconds;
    if (pending < secToBytes(chunkSec)) return;

    // Falling behind the lecturer: widen the window instead of grinding through
    // one chunk per call. whisper pays a fixed model-load cost per invocation,
    // so a single 60 s window is far cheaper than three 20 s ones — this is
    // what lets the live pass claw its way back rather than drift forever.
    const behindSec = pending / BYTES_PER_SEC;
    const ceilingSec = Math.max(chunkSec, Number(this.settings.catchupSeconds) || 60);
    const windowSec = behindSec > chunkSec * 2
      ? Math.min(ceilingSec, Math.round(behindSec))
      : chunkSec;

    if (behindSec > 120 && !this._warnedBehind) {
      this._warnedBehind = true;
      this.emit('event', {
        type: 'warning',
        message: 'Live transcription is behind the lecturer. Nothing is being lost — the polish pass on stop re-reads the whole recording.',
      });
    }

    try {
      await this._runWindow({ windowSec });
    } catch (err) {
      if (!err.aborted) this.emit('event', { type: 'warning', message: err.message });
    }
  }

  /**
   * Transcribe one window starting at the cursor.
   *
   * The window is read with `contextSeconds` of already-transcribed audio in
   * front of it so whisper has a run-up, then those context segments are
   * discarded. The cursor advances to the end of the last *accepted* segment
   * rather than the window edge, so every cut lands on a natural pause.
   */
  async _runWindow({ force = false, windowSec = null, until = null }) {
    this.busy = true;
    const wavPath = path.join(TMP_DIR, `${this.id}-${this.cursorBytes}.wav`);
    try {
      const span = secToBytes(windowSec ?? this.settings.chunkSeconds);
      const ceiling = until ?? this.bytesWritten;
      const end = force ? ceiling : Math.min(ceiling, this.cursorBytes + span);
      const contextBytes = secToBytes(this.settings.contextSeconds);
      const readFrom = Math.max(0, this.cursorBytes - contextBytes);
      if (end - readFrom < secToBytes(0.4)) { this.cursorBytes = end; return; }

      await writeWavSlice(this.pcmPath, wavPath, readFrom, end);

      const { segments } = await transcribeWav(wavPath, {
        model: this.settings.model,
        language: this.settings.language,
        translate: this.settings.translate,
        threads: this.settings.threads,
        offsetMs: bytesToMs(readFrom),
        // Deliberately no prompt: see the note on `maxContext` in whisper.js.
        signal: this._abort.signal,
      });

      const cursorMs = bytesToMs(this.cursorBytes);
      const endMs = bytesToMs(end);
      // Drop anything that lives in the context lead-in — already transcribed.
      const fresh = segments.filter((s) => (s.start + s.end) / 2 > cursorMs);

      const { emit, nextCursorMs } = this._selectSegments(fresh, cursorMs, endMs, force, span);
      for (const seg of emit) this._pushSegment(seg);
      this.cursorBytes = Math.max(this.cursorBytes, Math.min(end, secToBytes(nextCursorMs / 1000)));
      // Persist as we go: a crash or a kill during a two-hour lecture must not
      // take the transcript that is already on screen down with it.
      if (emit.length) this.persistTranscript();
    } finally {
      fs.rm(wavPath, { force: true }, () => {});
      this.busy = false;
    }
  }

  _selectSegments(fresh, cursorMs, endMs, force, spanBytes) {
    if (fresh.length === 0) return { emit: [], nextCursorMs: endMs };
    if (force) return { emit: fresh, nextCursorMs: endMs };

    const last = fresh[fresh.length - 1];
    const nearEdge = endMs - last.end < EDGE_GUARD_MS;
    const overgrown = endMs - cursorMs >= (spanBytes / BYTES_PER_SEC) * 1000 * MAX_WINDOW_FACTOR;

    // The final segment of a window is the one at risk of being cut mid-sentence
    // (and of tempting whisper into inventing an ending), so hold it back for
    // the next window — unless the window has already grown too long.
    if (nearEdge && !overgrown) {
      const keep = fresh.slice(0, -1);
      if (keep.length === 0) return { emit: [], nextCursorMs: cursorMs };
      return { emit: keep, nextCursorMs: keep[keep.length - 1].end };
    }
    return { emit: fresh, nextCursorMs: last.end };
  }

  _pushSegment(seg) {
    const prev = this.segments[this.segments.length - 1];
    if (prev && prev.start === seg.start && prev.text === seg.text) return;
    this.segments.push(seg);
    this.emit('event', { type: 'segment', segment: seg, index: this.segments.length - 1 });
  }

  /* ---------------------------------------------------------------- state */

  get durationMs() { return bytesToMs(this.bytesWritten); }

  _fail(message) {
    if (this.status === 'error') return;
    this.status = 'error';
    this.error = message;
    clearInterval(this._timer);
    clearInterval(this._tick);
    try { this._ff?.kill('SIGKILL'); } catch {}
    // Whatever was captured before the failure is still on disk and still
    // worth having: keep the transcript and let the UI offer a re-transcribe.
    this.persistTranscript();
    this.persist();
    this._emitState();
  }

  _emitState() {
    this.emit('event', { type: 'state', ...this.toJSON() });
  }

  persistTranscript() {
    try {
      fs.writeFileSync(path.join(this.dir, 'transcript.json'), JSON.stringify(this.segments, null, 2));
    } catch { /* a failed transcript write must never kill a live recording */ }
  }

  persist() {
    try {
      fs.writeFileSync(path.join(this.dir, 'meta.json'), JSON.stringify(this.toMeta(), null, 2));
    } catch { /* ditto */ }
    if (this.status === 'done' || this.status === 'error') this.persistTranscript();
    // Let the notebook mirror this recording's state into its own meta.
    try { this.onPersist?.(this.toMeta()); } catch { /* never let bookkeeping kill a recording */ }
  }

  toMeta() {
    return {
      id: this.id,
      title: this.title,
      source: this.source,
      sourceLabel: this.sourceLabel,
      status: this.status,
      error: this.error,
      requestedAt: this.requestedAt,
      startedAt: this.startedAt,
      startupLagMs: this.startupLagMs,
      endedAt: this.endedAt,
      durationMs: this.durationMs,
      // How much of the wall-clock span is actually in the audio file. Below
      // ~0.97 something is dropping samples and the recording is not what the
      // clock says it is.
      captureRatio: this.captureRatio(),
      model: this.settings.liveTranscribe ? this.settings.model : null,
      language: this.settings.language,
      translate: this.settings.translate,
      segmentCount: this.segments.length,
      hasAudio: fs.existsSync(this.audioPath),
      hasPcm: fs.existsSync(this.pcmPath),
      degraded: this.degraded,
      restarts: this.restarts,
      gaps: this.gaps,
      // Kept on the recording so the exporter can tell the note-writing skill
      // that a thin transcript had a thin signal behind it. Judged on the
      // loudest moment of the whole recording, not the current one — a
      // recording does not stop having been too quiet because it ended in
      // silence.
      quiet: this.wasQuiet(),
      levelDb: this.loudestDb(),
    };
  }

  toJSON() {
    return { ...this.toMeta(), level: this.level, ...this.health() };
  }
}

function defaultTitle(ts) {
  const d = new Date(ts);
  const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `Recording — ${day} ${time}`;
}

const lastLine = (s) => (s || '').trim().split('\n').filter(Boolean).pop() || '';
const clamp01 = (n) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
const fileBytes = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

function fmtClock(ms) {
  const t = Math.max(0, ms);
  const p = (n) => String(Math.floor(n)).padStart(2, '0');
  return `${p(t / 3600000)}:${p((t % 3600000) / 60000)}:${p((t % 60000) / 1000)}`;
}

/* ------------------------------------------------------- in-memory registry */

const live = new Map();
export const putSession = (s) => live.set(s.id, s);
export const getSession = (id) => live.get(id);
export const dropSession = (id) => live.delete(id);
export const activeSessions = () => [...live.values()].filter((s) => s.status === 'recording');
