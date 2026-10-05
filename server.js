import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ROOT, MODELS, RECOMMENDED_MODEL, loadSettings, saveSettings, resolveTranscribeModel } from './lib/config.js';
import {
  environmentStatus, installWhisper, installPoppler, downloadModel, deleteModel, clearPartFiles,
} from './lib/setup.js';
import { listAudioDevices } from './lib/devices.js';
import { RecordingSession } from './lib/session.js';
import { ingestDeck, pagePath } from './lib/slides.js';
import { buildExport } from './lib/exporter.js';
import {
  createSession, readMeta, updateMeta, listMeta, deleteSession,
  readNotebook, saveNotebookChecked, readTranscript, reconcileInterrupted,
  setArchived, audioFootprint, releaseAudio,
  sessionDir, exportDir, recordingDir, deckDir, assetPath, writeAsset, writeNamedAsset,
  newId, assertId, normaliseAssessments,
} from './lib/store.js';
import {
  listModules, createModule, updateModule, deleteModule, readModule,
  readModuleNotes, saveModuleNotesChecked,
  writeModuleAsset, writeNamedModuleAsset, moduleAssetPath, MODULE_COLOURS,
} from './lib/modules.js';
import {
  enqueue, cancelJob, queueSummary, jobEvents, restoreQueue, clearFinished,
} from './lib/jobs.js';
import { canRetranscribe } from './lib/rescan.js';
import {
  sendJson, sendError, readJson, readBody, openSse, serveStatic, sendFile,
} from './lib/http.js';

const PORT = Number(process.env.PORT) || 4210;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(ROOT, 'public');

/** Live recordings, keyed "<sessionId>/<recordingId>". */
const live = new Map();
const liveKey = (id, rid) => `${id}/${rid}`;
const activeRecordings = () => [...live.entries()]
  .filter(([, s]) => s.status === 'recording')
  .map(([key, s]) => ({ key, ...s.toJSON() }));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await route(req, res, url);
      if (!handled) sendError(res, 404, `No route for ${req.method} ${url.pathname}`);
      return;
    }
    serveStatic(res, PUBLIC_DIR, url.pathname === '/' ? '/index.html' : url.pathname, req);
  } catch (err) {
    if (!res.headersSent) sendError(res, err.status || 500, err.message || 'internal error');
    else try { res.end(); } catch {}
  }
});

async function route(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  const seg = pathname.split('/').filter(Boolean);   // ['api', ...]

  /* ------------------------------------------------------- environment */

  if (pathname === '/api/status' && method === 'GET') {
    const settings = loadSettings();
    sendJson(res, 200, {
      env: await environmentStatus(),
      settings,
      catalog: MODELS,
      recommendedModel: RECOMMENDED_MODEL,
      effectiveModel: resolveTranscribeModel(settings),
      active: activeRecordings(),
      queue: queueSummary(),
    });
    return true;
  }

  if (pathname === '/api/devices' && method === 'GET') {
    sendJson(res, 200, { devices: await listAudioDevices({ maxAgeMs: 0 }) });
    return true;
  }

  if (pathname === '/api/settings' && method === 'POST') {
    sendJson(res, 200, { settings: saveSettings(pick(await readJson(req), SETTING_KEYS)) });
    return true;
  }

  if (pathname === '/api/setup/whisper' && method === 'POST') return streamInstall(req, res, installWhisper);
  if (pathname === '/api/setup/poppler' && method === 'POST') return streamInstall(req, res, installPoppler);

  if (pathname === '/api/setup/model' && method === 'POST') {
    const sse = openSse(req, res);
    try {
      let last = 0;
      await downloadModel(url.searchParams.get('id'), (p) => {
        const now = Date.now();
        if (now - last < 200 && p.progress < 1) return;
        last = now;
        sse.send({ type: 'progress', ...p });
      });
      sse.send({ type: 'done', ok: true, env: await environmentStatus() });
    } catch (err) {
      sse.send({ type: 'done', ok: false, error: err.message });
    }
    sse.close();
    return true;
  }

  // Abandoned .part files from failed downloads; several gigabytes of them is
  // exactly what stops the next download from working.
  if (pathname === '/api/setup/parts' && method === 'DELETE') {
    const freed = clearPartFiles(url.searchParams.get('id') || null);
    sendJson(res, 200, { freed, env: await environmentStatus() });
    return true;
  }

  if (pathname === '/api/setup/model' && method === 'DELETE') {
    deleteModel(url.searchParams.get('id'));
    sendJson(res, 200, { env: await environmentStatus() });
    return true;
  }

  /* ---------------------------------------------------------- sessions */

  if (pathname === '/api/sessions' && method === 'GET') {
    sendJson(res, 200, { sessions: listMeta() });
    return true;
  }

  if (pathname === '/api/sessions' && method === 'POST') {
    const body = await readJson(req);
    // store.js cannot resolve a module (modules.js reads store.js), so the
    // name is mirrored onto the new lecture here.
    const mod = body.moduleId ? readModule(assertId(body.moduleId, 'module id')) : null;
    sendJson(res, 201, {
      session: createSession({
        ...body,
        moduleId: mod?.id || null,
        module: mod ? mod.name : body.module,
        lecturer: body.lecturer ?? mod?.lecturer,
        assessments: body.assessments ?? mod?.assessments,
      }),
    });
    return true;
  }

  /* ----------------------------------------------------------- modules */

  if (pathname === '/api/modules' && method === 'GET') {
    sendJson(res, 200, { modules: withCounts(listModules()), colours: MODULE_COLOURS });
    return true;
  }

  if (pathname === '/api/modules' && method === 'POST') {
    sendJson(res, 201, { module: createModule(await readJson(req)) });
    return true;
  }

  if (seg[1] === 'modules' && seg[2]) {
    const mid = assertId(seg[2], 'module id');
    const mod = readModule(mid);
    if (!mod) return sendError(res, 404, 'No such module'), true;
    const what = seg[3];

    if (!what && method === 'GET') {
      sendJson(res, 200, {
        module: mod,
        notes: readModuleNotes(mid),
        lectures: listMeta().filter((m) => m.moduleId === mid),
      });
      return true;
    }

    if (!what && method === 'PATCH') {
      const body = await readJson(req);
      const updated = updateModule(mid, body);
      for (const m of listMeta()) {
        if (m.moduleId !== mid) continue;
        // The module's name is mirrored onto every lecture in it, so renaming
        // a module does not leave old bundles exporting the old name.
        if (m.module !== updated.name) updateMeta(m.id, (x) => { x.module = updated.name; });
        // Archiving a term normally means archiving the term's lectures too,
        // but that is the caller's call to make, not an implication.
        if (body.cascade && body.archived !== undefined) setArchived(m.id, body.archived);
      }
      sendJson(res, 200, { module: updated, lectures: listMeta().filter((m) => m.moduleId === mid) });
      return true;
    }

    if (!what && method === 'DELETE') {
      // Deleting a module never deletes lectures — it just unfiles them.
      for (const m of listMeta()) {
        if (m.moduleId === mid) updateMeta(m.id, (x) => { x.moduleId = null; });
      }
      deleteModule(mid);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (what === 'notes' && (method === 'PUT' || method === 'POST')) {
      const body = await readJson(req);
      try {
        sendJson(res, 200, { notes: saveModuleNotesChecked(mid, body) });
      } catch (err) {
        if (err.status === 409) sendJson(res, 409, { error: err.message, current: err.current });
        else throw err;
      }
      return true;
    }

    if (what === 'assets' && method === 'POST') {
      const buf = await readBody(req, 40 * 1024 * 1024);
      if (!buf.length) return sendError(res, 400, 'Empty upload'), true;
      const name = url.searchParams.get('name');
      const asset = name
        ? writeNamedModuleAsset(mid, name, buf)
        : writeModuleAsset(mid, buf, { ext: (url.searchParams.get('ext') || 'png').replace(/\W/g, '') });
      sendJson(res, 201, { asset });
      return true;
    }

    if (what === 'assets' && seg[4] && method === 'GET') {
      const file = moduleAssetPath(mid, seg[4]);
      fs.stat(file, (err, stat) => {
        if (err) return sendError(res, 404, 'No such asset');
        sendFile(res, file, stat, req);
      });
      return true;
    }
  }

  /* ------------------------------------------------- transcription queue */

  if (pathname === '/api/jobs' && method === 'GET') {
    sendJson(res, 200, queueSummary());
    return true;
  }

  if (pathname === '/api/jobs' && method === 'DELETE') {
    const job = cancelJob(url.searchParams.get('id'));
    if (!job) return sendError(res, 404, 'No such job'), true;
    sendJson(res, 200, { job });
    return true;
  }

  if (pathname === '/api/jobs/clear' && method === 'POST') {
    clearFinished();
    sendJson(res, 200, queueSummary());
    return true;
  }

  // One stream for the whole queue, not one per lecture: background work has
  // to stay visible while the student is off typing in a different lecture.
  if (pathname === '/api/jobs/events' && method === 'GET') {
    const sse = openSse(req, res);
    sse.send({ type: 'queue', ...queueSummary() });
    const onJob = (job) => sse.send({ type: 'job', job });
    const onQueue = (q) => sse.send({ type: 'queue', ...q });
    jobEvents.on('job', onJob);
    jobEvents.on('queue', onQueue);
    req.on('close', () => { jobEvents.off('job', onJob); jobEvents.off('queue', onQueue); });
    return true;
  }

  if (seg[0] !== 'api' || seg[1] !== 'sessions' || !seg[2]) return false;

  const id = assertId(seg[2], 'session id');
  const meta = readMeta(id);
  if (!meta) return sendError(res, 404, 'No such session'), true;
  const sub = seg[3];

  if (!sub && method === 'GET') {
    sendJson(res, 200, {
      session: meta,
      module: meta.moduleId ? readModule(meta.moduleId) : null,
      notebook: readNotebook(id),
      transcripts: (meta.recordings || []).map((r) => ({
        id: r.id,
        segments: readTranscript(id, r.id),
        canRetranscribe: canRetranscribe(id, r.id),
      })),
      audio: audioFootprint(id),
    });
    return true;
  }

  if (!sub && method === 'PATCH') {
    const body = await readJson(req);
    const updated = updateMeta(id, (m) => {
      if (typeof body.title === 'string') m.title = body.title.slice(0, 200) || m.title;
      if (typeof body.module === 'string') m.module = body.module.slice(0, 120);
      if (typeof body.lecturer === 'string') m.lecturer = body.lecturer.slice(0, 120);
      if (body.assessments !== undefined) m.assessments = normaliseAssessments(body.assessments);
      if (body.archived !== undefined) m.archivedAt = body.archived ? (m.archivedAt || Date.now()) : null;
      if (body.moduleId !== undefined) {
        const mod = body.moduleId ? readModule(assertId(body.moduleId, 'module id')) : null;
        m.moduleId = mod ? mod.id : null;
        // Keep the name mirrored so meta.module stays the single thing the
        // exporter has to read.
        m.module = mod ? mod.name : (typeof body.module === 'string' ? m.module : '');
      }
    });
    sendJson(res, 200, { session: updated });
    return true;
  }

  if (!sub && method === 'DELETE') {
    for (const [key, s] of live) if (key.startsWith(`${id}/`)) { s.cancel(); live.delete(key); }
    deleteSession(id);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // POST as well as PUT: a browser closing mid-lecture can only flush the last
  // edits with navigator.sendBeacon, and sendBeacon is POST-only.
  if (sub === 'notebook' && (method === 'PUT' || method === 'POST')) {
    const body = await readJson(req);
    try {
      sendJson(res, 200, { notebook: saveNotebookChecked(id, body) });
    } catch (err) {
      if (err.status === 409) sendJson(res, 409, { error: err.message, current: err.current });
      else throw err;
    }
    return true;
  }

  /* -------------------------------------------------------- recordings */

  if (sub === 'recordings' && method === 'POST' && !seg[4]) {
    const body = await readJson(req);
    // Everything from here to rec.start() is time the lecturer is already
    // talking and the microphone is not yet open, so it is all cached or
    // cheap. A full environment probe here used to cost the best part of a
    // second on its own.
    const env = await environmentStatus({ maxAgeMs: 30000 });
    if (!env.ready) return sendError(res, 412, 'Setup is incomplete — install whisper.cpp and a model first.'), true;

    const source = body.source === 'device' ? 'device' : 'browser';
    let deviceIndex = null, deviceName = '';
    if (source === 'device') {
      const found = (await listAudioDevices({ maxAgeMs: 15000 })).find((d) => d.index === Number(body.deviceIndex));
      if (!found) return sendError(res, 400, 'That audio input no longer exists.'), true;
      deviceIndex = found.index; deviceName = found.name;
    }

    // Pressing record on an archived lecture plainly means it is not finished
    // after all. Filing is not a lock, so bring it back rather than refusing.
    if (meta.archivedAt) setArchived(id, false);

    const settings = saveSettings(pick(body.settings || {}, SETTING_KEYS));
    const rid = `r${(meta.recordings?.length || 0) + 1}-${newId('x').slice(-6)}`;
    const rec = new RecordingSession({
      id: rid,
      dir: recordingDir(id, rid),
      source, deviceIndex, deviceName, settings,
      onPersist: (rmeta) => mirrorRecording(id, rmeta),
      // Used only when capture has to be restarted mid-lecture: prefer the
      // device with the same name over whatever now holds the old index.
      resolveDevice: async (name, lastIndex) => {
        const devices = await listAudioDevices({ maxAgeMs: 0 });
        return devices.find((d) => d.name === name) || devices.find((d) => d.index === lastIndex) || null;
      },
    });
    live.set(liveKey(id, rid), rec);
    rec.once('done', () => {
      // Capture is finished; the transcript is somebody else's problem now.
      if (rec.status === 'queued') enqueue(id, rid, { reason: 'recorded' });
      setTimeout(() => live.delete(liveKey(id, rid)), 30000);
    });
    await rec.start();
    sendJson(res, 201, { recording: rec.toJSON() });
    return true;
  }

  if (sub === 'recordings' && seg[4]) {
    const rid = assertId(seg[4], 'recording id');
    const action = seg[5];
    const rec = live.get(liveKey(id, rid));

    if (action === 'audio' && method === 'POST') {
      // 409, not 404: the browser must be able to tell "this recording ended"
      // from "the server restarted under me" and stop pushing into the void.
      if (!rec) return sendError(res, 409, 'That recording is no longer active — the app may have restarted.'), true;
      // The browser stamps its first chunk with when its recorder started, so
      // media time zero is the moment it began capturing rather than the
      // moment the bytes reached us.
      if (url.searchParams.has('start')) rec.noteMediaStart(url.searchParams.get('start'));
      const buf = await readBody(req);
      // Awaited: the response is the browser's backpressure signal. Without it
      // a stalled transcoder grows an unbounded stdin buffer for the rest of
      // the lecture.
      const accepted = buf.length ? await rec.feed(buf, { fresh: url.searchParams.get('fresh') === '1' }) : true;
      sendJson(res, 200, {
        ok: true,
        accepted,
        durationMs: rec.durationMs,
        stalled: rec.stalled,
        // Belt and braces for the SSE `reopenInput` event: if the event stream
        // is down, this tells the client to recycle its MediaRecorder anyway.
        needsFresh: rec.needsFreshInput(),
      });
      return true;
    }

    if (action === 'stop' && method === 'POST') {
      if (!rec) return sendError(res, 404, 'That recording is no longer active'), true;
      rec.stop().catch(() => {});
      sendJson(res, 202, { recording: rec.toJSON() });
      return true;
    }

    if (action === 'cancel' && method === 'POST') {
      if (rec) { rec.cancel(); live.delete(liveKey(id, rid)); }
      fs.rmSync(recordingDir(id, rid), { recursive: true, force: true });
      updateMeta(id, (m) => { m.recordings = (m.recordings || []).filter((r) => r.id !== rid); });
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (action === 'events' && method === 'GET') {
      if (!rec) return sendError(res, 404, 'That recording is no longer active'), true;
      const sse = openSse(req, res);
      sse.send({ type: 'state', ...rec.toJSON() });
      rec.segments.forEach((segment, index) => sse.send({ type: 'segment', segment, index }));
      const onEvent = (e) => sse.send(e);
      rec.on('event', onEvent);
      req.on('close', () => rec.off('event', onEvent));
      rec.once('done', () => setTimeout(() => sse.close(), 500));
      return true;
    }

    if (action === 'audio' && method === 'GET') {
      const file = path.join(recordingDir(id, rid), 'audio.m4a');
      fs.stat(file, (err, stat) => {
        if (err) return sendError(res, 404, 'No audio saved for that recording');
        sendFile(res, file, stat, req);
      });
      return true;
    }

    if (action === 'reopen' && method === 'POST') {
      if (!rec) return sendError(res, 409, 'That recording is no longer active'), true;
      const body = await readJson(req);
      const ok = rec.requestFreshInput(body.reason || 'the browser asked for a fresh stream');
      sendJson(res, ok ? 202 : 409, { ok });
      return true;
    }

    if (action === 'transcribe' && method === 'POST') {
      if (!canRetranscribe(id, rid)) {
        return sendError(res, 409, 'No audio survives for that recording, so there is nothing to transcribe.'), true;
      }
      const body = await readJson(req);
      const job = enqueue(id, rid, { model: body.model || null, reason: body.reason || 'requested' });
      sendJson(res, 202, { job, queue: queueSummary() });
      return true;
    }

    if (action === 'transcript' && method === 'GET') {
      sendJson(res, 200, { segments: readTranscript(id, rid) });
      return true;
    }
  }

  /* ------------------------------------------------------------ assets */

  if (sub === 'assets' && method === 'POST') {
    const buf = await readBody(req, 40 * 1024 * 1024);
    if (!buf.length) return sendError(res, 400, 'Empty upload'), true;
    const name = url.searchParams.get('name');
    // Sketches keep a caller-chosen name so re-saving overwrites in place;
    // pasted images are content-hashed so the same screenshot stores once.
    const asset = name
      ? writeNamedAsset(id, name, buf)
      : writeAsset(id, buf, { ext: (url.searchParams.get('ext') || 'png').replace(/\W/g, '') });
    sendJson(res, 201, { asset });
    return true;
  }

  if (sub === 'assets' && seg[4] && method === 'GET') {
    const file = assetPath(id, seg[4]);
    fs.stat(file, (err, stat) => {
      if (err) return sendError(res, 404, 'No such asset');
      sendFile(res, file, stat, req);
    });
    return true;
  }

  /* ------------------------------------------------------------- decks */

  if (sub === 'decks' && method === 'POST' && !seg[4]) {
    const name = url.searchParams.get('name') || 'deck.pdf';
    const buf = await readBody(req, 400 * 1024 * 1024);
    if (!buf.length) return sendError(res, 400, 'Empty upload'), true;
    const did = newId('d');
    const sse = openSse(req, res);
    try {
      const deck = await ingestDeck(buf, name, deckDir(id, did), {
        dpi: loadSettings().slideDpi,
        onProgress: (p) => sse.send({ type: 'progress', ...p }),
      });
      deck.id = did;
      updateMeta(id, (m) => { m.decks = [...(m.decks || []), { ...deck, annotatedPages: [] }]; });
      sse.send({ type: 'done', ok: true, deck: { ...deck, annotatedPages: [] } });
    } catch (err) {
      fs.rmSync(deckDir(id, did), { recursive: true, force: true });
      sse.send({ type: 'done', ok: false, error: err.message });
    }
    sse.close();
    return true;
  }

  if (sub === 'decks' && seg[4]) {
    const did = assertId(seg[4], 'deck id');
    const what = seg[5];

    if (what === 'pages' && seg[6] && method === 'GET') {
      const n = Number(String(seg[6]).replace(/\D/g, ''));
      const file = pagePath(deckDir(id, did), n);
      fs.stat(file, (err, stat) => {
        if (err) return sendError(res, 404, 'No such page');
        sendFile(res, file, stat, req);
      });
      return true;
    }

    if (what === 'original.pdf' && method === 'GET') {
      const file = path.join(deckDir(id, did), 'original.pdf');
      fs.stat(file, (err, stat) => {
        if (err) return sendError(res, 404, 'No original for that deck');
        sendFile(res, file, stat, req);
      });
      return true;
    }

    if (what === 'annotations' && seg[6]) {
      const page = Number(String(seg[6]).replace(/\D/g, ''));
      if (!page) return sendError(res, 400, 'Bad page number'), true;
      const dir = path.join(deckDir(id, did), 'annotations');
      const pad = String(page).padStart(3, '0');

      if (method === 'GET') {
        try {
          sendJson(res, 200, { strokes: JSON.parse(fs.readFileSync(path.join(dir, `page-${pad}.strokes.json`), 'utf8')) });
        } catch { sendJson(res, 200, { strokes: [] }); }
        return true;
      }

      if (method === 'PUT') {
        fs.mkdirSync(dir, { recursive: true });
        const isPng = seg[7] === 'png';
        const buf = await readBody(req, 40 * 1024 * 1024);
        fs.writeFileSync(path.join(dir, isPng ? `page-${pad}.png` : `page-${pad}.strokes.json`), buf);
        if (!isPng) {
          const empty = buf.length < 6 || JSON.parse(buf.toString('utf8') || '[]').length === 0;
          updateMeta(id, (m) => {
            const deck = (m.decks || []).find((d) => d.id === did);
            if (!deck) return;
            const set = new Set(deck.annotatedPages || []);
            if (empty) set.delete(page); else set.add(page);
            deck.annotatedPages = [...set].sort((a, b) => a - b);
          });
          // Ink removed entirely — drop the stale composite so exports stay honest.
          if (empty) fs.rmSync(path.join(dir, `page-${pad}.png`), { force: true });
        }
        sendJson(res, 200, { ok: true });
        return true;
      }
    }

    if (what === 'text' && seg[6] && method === 'GET') {
      const n = Number(String(seg[6]).replace(/\D/g, ''));
      try {
        const txt = fs.readFileSync(path.join(deckDir(id, did), 'text', `page-${String(n).padStart(3, '0')}.txt`), 'utf8');
        sendJson(res, 200, { text: txt });
      } catch { sendJson(res, 200, { text: '' }); }
      return true;
    }

    if (!what && method === 'DELETE') {
      fs.rmSync(deckDir(id, did), { recursive: true, force: true });
      updateMeta(id, (m) => { m.decks = (m.decks || []).filter((d) => d.id !== did); });
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  // Show a file in Finder. The path is derived here from ids the router has
  // already validated — the client never gets to name a path, so this cannot
  // be pointed at anything outside the app's own data.
  if (sub === 'reveal' && method === 'POST') {
    const body = await readJson(req);
    let target = sessionDir(id);
    if (body.recordingId) {
      const rdir = recordingDir(id, assertId(body.recordingId, 'recording id'));
      const m4a = path.join(rdir, 'audio.m4a');
      target = fs.existsSync(m4a) ? m4a : rdir;
    } else if (body.what === 'export') {
      target = exportDir(id);
    }
    if (!fs.existsSync(target)) return sendError(res, 404, 'That folder does not exist yet.'), true;
    revealInFinder(target);
    sendJson(res, 200, { ok: true, path: target });
    return true;
  }

  if (sub === 'audio' && method === 'DELETE') {
    const out = releaseAudio(id);
    sendJson(res, 200, { ...out, audio: audioFootprint(id) });
    return true;
  }

  /* ------------------------------------------------------------ export */

  if (sub === 'export' && method === 'POST') {
    const result = await buildExport(id, { notesDir: loadSettings().notesDir });
    sendJson(res, 200, result);
    return true;
  }

  return false;
}

/* --------------------------------------------------------------- helpers */

/** Open Finder with the file selected. macOS only, and harmless if it fails. */
function revealInFinder(target) {
  if (process.platform !== 'darwin') return;
  execFile('open', ['-R', target], () => { /* Finder not being there is not an error worth raising */ });
}

/** Modules, each with how many lectures are filed under it. */
function withCounts(modules) {
  const sessions = listMeta();
  return modules.map((m) => {
    const mine = sessions.filter((s) => s.moduleId === m.id);
    const live = mine.filter((s) => !s.archivedAt);
    return {
      ...m,
      lectureCount: live.length,
      archivedCount: mine.length - live.length,
      lastLectureAt: mine.reduce((a, s) => Math.max(a, s.createdAt || 0), 0),
    };
  });
}

async function streamInstall(req, res, installer) {
  const sse = openSse(req, res);
  const ok = await installer((line) => sse.send({ type: 'log', line }));
  sse.send({ type: 'done', ok, env: await environmentStatus() });
  sse.close();
  return true;
}

/** Mirror a recording's own meta into the notebook session's meta. */
function mirrorRecording(id, rmeta) {
  updateMeta(id, (m) => {
    const list = m.recordings || (m.recordings = []);
    const at = list.findIndex((r) => r.id === rmeta.id);
    const row = {
      id: rmeta.id,
      requestedAt: rmeta.requestedAt,
      startedAt: rmeta.startedAt,
      startupLagMs: rmeta.startupLagMs,
      captureRatio: rmeta.captureRatio,
      endedAt: rmeta.endedAt,
      durationMs: rmeta.durationMs,
      model: rmeta.model,
      status: rmeta.status,
      error: rmeta.error,
      segmentCount: rmeta.segmentCount,
      hasAudio: rmeta.hasAudio,
      hasPcm: rmeta.hasPcm,
      degraded: rmeta.degraded,
      gaps: rmeta.gaps,
      quiet: rmeta.quiet,
      levelDb: rmeta.levelDb,
    };
    if (at === -1) list.push(row); else list[at] = row;
  });
}

const SETTING_KEYS = ['model', 'transcribeModel', 'liveTranscribe', 'language', 'translate',
  'chunkSeconds', 'contextSeconds', 'mixMic', 'threads', 'backgroundThreads', 'lowPriority',
  'slideDpi', 'notesDir', 'stallSeconds', 'catchupSeconds', 'keepPcm'];
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in (obj || {})).map((k) => [k, obj[k]]));

/* ------------------------------------------------------------- lifecycle */

server.listen(PORT, HOST, () => {
  console.log(`Lecture Notebook listening on http://${HOST}:${PORT}`);

  // Anything the last run left mid-flight is put right before the first
  // request arrives: recordings stuck at "recording" become "interrupted",
  // and every recording that still owes a transcript goes back in the queue.
  // Closing the laptop mid-lecture should cost the tail of the audio, nothing
  // more.
  try {
    const orphans = reconcileInterrupted();
    restoreQueue();
    let requeued = 0;
    for (const o of orphans) {
      if (!canRetranscribe(o.sessionId, o.recordingId)) continue;
      enqueue(o.sessionId, o.recordingId, { reason: 'recovered' });
      requeued += 1;
    }
    if (requeued) console.log(`Recovered ${requeued} recording(s) from the last run — queued for transcription.`);
  } catch (err) {
    console.error(`Recovery pass failed: ${err.message}`);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Set PORT=<free port> and retry.`);
  else console.error(err.message);
  process.exit(1);
});

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    const pending = [...live.values()].filter((s) => s.status === 'recording');
    if (pending.length) console.log(`\nStopping — finalising ${pending.length} recording(s)…`);
    // Stop only closes the audio file now, so this is quick. Even if the
    // encode is cut short the raw PCM is still on disk and the queue picks the
    // recording back up on the next start.
    Promise.race([
      Promise.all(pending.map((s) => s.stop().catch(() => {}))),
      new Promise((r) => setTimeout(r, 30000)),
    ]).then(() => { server.close(); process.exit(0); });
  });
}
