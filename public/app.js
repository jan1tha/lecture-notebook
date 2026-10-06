/* Lecture Notebook — application shell.
   Owns: the library (modules and the lectures filed under them), the recording
   transport, the background transcription queue, the transcript feed, the
   slide deck viewer, and the export bundle. The editor lives in editor.js and
   the ink in sketch.js.

   The shape to hold in your head: during a lecture this app does exactly one
   thing that matters — get audio onto disk without a gap. Transcription is a
   background job that happens afterwards, so nothing here waits on whisper and
   nothing here can lose a lecture to it. */

import { NotebookEditor } from './editor.js';
import { SketchPad } from './sketch.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const el = {};
for (const id of [
  'railSession', 'railModuleBtn', 'sessionTitle', 'sessionModuleSelect',
  'queueStrip', 'queueText', 'queueFill', 'queueSheet', 'queueBody',
  'setupBtn', 'setupDot', 'setupLabel', 'setupSheet', 'setupBody',
  'newSessionBtn', 'newModuleBtn', 'librarySearch', 'libraryList',
  'lectureView', 'moduleView', 'emptyView', 'emptyNewModule', 'emptyNewLecture',
  'transport', 'recBtn', 'stopBtn', 'timecode', 'transportStatus', 'meter', 'healthChip',
  'sourceSelect', 'deviceSelect',
  'editor', 'addSketch', 'addImage', 'addHeading',
  'outlineBtn', 'archiveBtn', 'noteStats', 'saveHint', 'exportBtn', 'imageInput', 'outlinePop',
  'archBar', 'archText', 'archFreeBtn', 'archRestoreBtn', 'moduleArchive',
  'moduleSwatch', 'moduleName', 'moduleCode', 'moduleLecturer', 'moduleAssessments',
  'moduleColours', 'moduleLectureCount', 'moduleNewLecture', 'moduleDelete',
  'moduleEditor', 'modAddSketch', 'modAddImage', 'modOutlineBtn',
  'moduleStats', 'moduleSaveHint',
  'tabTranscript', 'tabSlides', 'paneTranscript', 'paneSlides',
  'tabMaterials', 'paneMaterials', 'addMaterials', 'addMaterialFolder', 'matCount', 'matList', 'matEmpty', 'matInput', 'matFolderInput',
  'transcriptSearch', 'recList', 'feed', 'transcriptEmpty',
  'deckSelect', 'addDeck', 'deck', 'deckEmpty', 'deckBar', 'pagePrev', 'pageNext',
  'pageCount', 'inkToggle', 'pinSlide', 'deckInput',
  'exportSheet', 'exportBody', 'sketchModal', 'sketchHost', 'sketchSave', 'toasts',
]) el[id] = document.getElementById(id);

const METER_SEGMENTS = 24;
// The browser's own clock says a recording is fine long after capture has
// died. When server-reported media time falls this far behind it, say so.
const DRIFT_WARN_MS = 8000;

const state = {
  env: null, settings: null, queue: { jobs: [], running: null, waiting: 0 },
  modules: [], sessions: [], collapsed: new Set(),
  view: 'empty',
  session: null, notebook: { rev: 0, blocks: [] },
  module: null, moduleNotes: { rev: 0, blocks: [] }, audio: null,
  transcripts: new Map(),      // recordingId -> segments
  activeRecordingId: null,
  rec: null,                   // { id, startedAtWall } while recording
  recording: false, health: null, gen: 0, recycling: false, freshNext: false,
  stream: null, micStream: null, captureStream: null, recorder: null,
  audioCtx: null, analyser: null,
  events: null, jobStream: null, uploads: Promise.resolve(), pendingChunks: 0,
  timer: null, meterRaf: null,
  deck: null, page: 1, inking: false, pad: null, deckPad: null, matUploading: null,
  dirty: false, moduleDirty: false, editor: null, modEditor: null,
};

/* ────────────────────────────────────────────────────────────  helpers  ── */

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mmss(ms) {
  const t = Math.max(0, ms || 0);
  const h = Math.floor(t / 3600000);
  const p = (n) => String(Math.floor(n)).padStart(2, '0');
  return h > 0 ? `${h}:${p((t % 3600000) / 60000)}:${p((t % 60000) / 1000)}` : `${p(t / 60000)}:${p((t % 60000) / 1000)}`;
}

function longTime(ms) {
  const t = Math.max(0, ms);
  const p = (n) => String(Math.floor(n)).padStart(2, '0');
  return `${p(t / 3600000)}:${p((t % 3600000) / 60000)}:${p((t % 60000) / 1000)}<small>.${Math.floor((t % 1000) / 100)}</small>`;
}

const relative = (ts) => {
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return `${Math.floor(d / 60000)} min ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

function toast(message, kind = '') {
  const n = document.createElement('div');
  n.className = `toast${kind ? ` toast--${kind}` : ''}`;
  n.textContent = message;
  el.toasts.append(n);
  setTimeout(() => n.remove(), kind === 'bad' ? 9000 : 4500);
}

// One warning per distinct problem per recording: a stall that lasts ten
// minutes should not produce three hundred toasts.
const said = new Set();
function toastOnce(key, message, kind) {
  if (said.has(key)) return;
  said.add(key);
  toast(message, kind);
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const json = (res.headers.get('content-type') || '').includes('json');
  const body = json ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error((body && body.error) || `Request failed (${res.status})`), { status: res.status, body });
  return body;
}

/** Shared reader for the SSE-over-POST endpoints (installs, uploads). */
async function streamPost(url, onEvent, body) {
  const res = await fetch(url, { method: 'POST', body });
  if (!res.body) throw new Error('No response stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop();
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (line) onEvent(JSON.parse(line.slice(6)));
    }
  }
}

function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

/* ──────────────────────────────────────────────────────────────  theme  ── */

function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  localStorage.setItem('notebook.theme', mode);
  $$('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === mode)));
}
$$('[data-theme-set]').forEach((b) => b.addEventListener('click', () => applyTheme(b.dataset.themeSet)));
applyTheme(localStorage.getItem('notebook.theme') || 'system');

/* ───────────────────────────────────────────────────────────  metering  ── */

function buildMeter() {
  el.meter.innerHTML = '';
  for (let i = 0; i < METER_SEGMENTS; i += 1) el.meter.append(document.createElement('i'));
}

function paintMeter(level) {
  const lit = Math.round(clamp(level, 0, 1) * METER_SEGMENTS);
  const bars = el.meter.children;
  for (let i = 0; i < bars.length; i += 1) {
    const on = i < lit;
    bars[i].classList.toggle('on', on);
    bars[i].style.background = on
      ? (i > METER_SEGMENTS * 0.88 ? 'var(--meter-hi)' : i > METER_SEGMENTS * 0.7 ? 'var(--meter-mid)' : 'var(--meter-lo)')
      : '';
  }
}

/* ────────────────────────────────────────────────────────────  library  ── */

async function loadLibrary() {
  const [{ sessions }, mods] = await Promise.all([
    api('/api/sessions'), api('/api/modules'),
  ]);
  state.sessions = sessions;
  state.modules = mods.modules;
  state.colours = mods.colours;
  paintModuleSelect();
  paintLibrary();
}

const COLLAPSE_KEY = 'notebook.collapsed';
try { state.collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')); } catch { /* fresh */ }
const rememberCollapsed = () => localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...state.collapsed]));

/**
 * The library is a two-level tree: module, then the lectures filed under it.
 * A search flattens it — when you are hunting for one lecture you do not care
 * which folder it is in, so matching modules open themselves.
 *
 * Archived work is filed out of the way at the bottom rather than hidden: a
 * search still finds it (that is usually why you are searching), and it is one
 * click from coming back.
 */
function paintLibrary() {
  const q = el.librarySearch.value.trim().toLowerCase();
  const hit = (s) => !q || `${s.title} ${s.module || ''}`.toLowerCase().includes(q);
  const shelved = (s) => Boolean(s.archivedAt);

  el.libraryList.textContent = '';
  const filed = new Set();

  for (const mod of state.modules) {
    if (mod.archivedAt) continue;
    const lectures = state.sessions.filter((s) => s.moduleId === mod.id);
    lectures.forEach((s) => filed.add(s.id));
    const live = lectures.filter((s) => !shelved(s));
    const shown = live.filter(hit);
    const modHit = !q || `${mod.name} ${mod.code || ''}`.toLowerCase().includes(q);
    if (q && !modHit && !shown.length) continue;
    el.libraryList.append(moduleGroup(mod, modHit && !q ? live : (modHit ? live : shown), q));
  }

  const loose = state.sessions.filter((s) => !filed.has(s.id) && !shelved(s) && hit(s));
  if (loose.length) el.libraryList.append(flatGroup('Not in a module', loose));

  const archivedLectures = state.sessions.filter((s) => shelved(s) && hit(s));
  const archivedModules = state.modules.filter((m) => m.archivedAt
    && (!q || `${m.name} ${m.code || ''}`.toLowerCase().includes(q)));
  if (archivedLectures.length || archivedModules.length) {
    el.libraryList.append(archiveGroup(archivedModules, archivedLectures, q));
  }

  if (!el.libraryList.children.length) {
    const none = document.createElement('p');
    none.className = 'library__none';
    none.textContent = state.sessions.length || state.modules.length
      ? 'Nothing matches that.'
      : 'Start with a module — Strategic Management, say — then add lectures to it.';
    el.libraryList.append(none);
  }
}

function flatGroup(label, rows) {
  const group = document.createElement('div');
  group.className = 'group';
  const head = document.createElement('div');
  head.className = 'group__head group__head--loose';
  head.innerHTML = '<span class="group__name"></span>';
  head.querySelector('.group__name').textContent = label;
  group.append(head);
  for (const s of rows) group.append(lectureRow(s));
  return group;
}

const ARCHIVE_OPEN = 'notebook.archiveOpen';

/** One shelf at the bottom holding everything archived, lectures and modules. */
function archiveGroup(modules, lectures, q) {
  const open = q ? true : localStorage.getItem(ARCHIVE_OPEN) === '1';
  const group = document.createElement('div');
  group.className = 'group group--archived';

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'group__head group__head--archive';
  head.setAttribute('aria-expanded', String(open));
  head.innerHTML = `<span class="group__twist" aria-hidden="true">${open ? '▾' : '▸'}</span>
    <span class="group__name">Archived</span><span class="group__meta"></span>`;
  head.querySelector('.group__meta').textContent = [
    lectures.length ? `${lectures.length} lecture${lectures.length === 1 ? '' : 's'}` : null,
    modules.length ? `${modules.length} module${modules.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
  head.addEventListener('click', () => {
    localStorage.setItem(ARCHIVE_OPEN, open ? '0' : '1');
    paintLibrary();
  });
  group.append(head);

  if (!open) return group;

  for (const mod of modules) {
    const wrap = document.createElement('div');
    wrap.className = 'rowwrap';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row row--module row--archived';
    btn.dataset.colour = mod.colour || 'indigo';
    const n = (mod.lectureCount || 0) + (mod.archivedCount || 0);
    btn.innerHTML = '<span class="row__title"></span><span class="row__meta"></span>';
    btn.querySelector('.row__title').textContent = mod.name;
    btn.querySelector('.row__meta').textContent = `module · ${n} lecture${n === 1 ? '' : 's'}`;
    btn.addEventListener('click', () => openModule(mod.id));
    const act = document.createElement('button');
    act.type = 'button';
    act.className = 'row__act';
    act.textContent = '↩';
    act.title = `Restore the module "${mod.name}"`;
    act.setAttribute('aria-label', act.title);
    act.addEventListener('click', (e) => { e.stopPropagation(); archiveModule(mod.id, false); });
    wrap.append(btn, act);
    group.append(wrap);
  }
  for (const s of lectures) group.append(lectureRow(s, { showModule: true }));
  return group;
}

function moduleGroup(mod, lectures, q) {
  const group = document.createElement('div');
  group.className = 'group';
  group.dataset.colour = mod.colour || 'indigo';

  const collapsed = state.collapsed.has(mod.id) && !q;
  const head = document.createElement('div');
  head.className = `group__head${state.view === 'module' && state.module?.id === mod.id ? ' is-on' : ''}`;

  const twist = document.createElement('button');
  twist.type = 'button';
  twist.className = 'group__twist';
  twist.textContent = collapsed ? '▸' : '▾';
  twist.setAttribute('aria-expanded', String(!collapsed));
  twist.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${mod.name}`);
  twist.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.collapsed.has(mod.id)) state.collapsed.delete(mod.id); else state.collapsed.add(mod.id);
    rememberCollapsed();
    paintLibrary();
  });

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'group__open';
  open.innerHTML = '<span class="group__name"></span><span class="group__meta"></span>';
  open.querySelector('.group__name').textContent = mod.name;
  open.querySelector('.group__meta').textContent = [
    mod.code,
    `${mod.lectureCount ?? lectures.length} lecture${(mod.lectureCount ?? lectures.length) === 1 ? '' : 's'}`,
    mod.archivedCount ? `${mod.archivedCount} archived` : null,
  ].filter(Boolean).join(' · ');
  open.title = 'Open module notes';
  open.addEventListener('click', () => openModule(mod.id));

  head.append(twist, open);
  group.append(head);

  if (!collapsed) {
    for (const s of lectures) group.append(lectureRow(s));
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'group__add';
    add.textContent = '+ Lecture';
    add.addEventListener('click', () => newLecture(mod.id));
    group.append(add);
  }
  return group;
}

function lectureRow(s, { showModule = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'rowwrap';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `row${state.view === 'lecture' && state.session?.id === s.id ? ' is-on' : ''}${s.archivedAt ? ' row--archived' : ''}`;
  const mins = Math.round((s.recordings || []).reduce((a, r) => a + (r.durationMs || 0), 0) / 60000);
  const pending = (s.recordings || []).filter((r) => ['queued', 'transcribing'].includes(r.status)).length;
  const broken = (s.recordings || []).filter((r) => ['interrupted', 'error'].includes(r.status)).length;

  btn.innerHTML = '<span class="row__title"></span><span class="row__meta"></span>';
  btn.querySelector('.row__title').textContent = s.title;
  btn.querySelector('.row__meta').textContent = [
    showModule ? (s.module || 'no module') : null,
    mins ? `${mins} min` : null,
    relative(s.createdAt),
  ].filter(Boolean).join(' · ');
  if (pending) btn.append(pip('queued', `${pending} recording(s) waiting to be transcribed`));
  if (broken) btn.append(pip('broken', `${broken} recording(s) need attention`));
  btn.addEventListener('click', () => openSession(s.id));
  wrap.append(btn);

  // Filing a term away should not need a round trip through each lecture.
  const act = document.createElement('button');
  act.type = 'button';
  act.className = 'row__act';
  act.textContent = s.archivedAt ? '↩' : '⌸';
  act.title = s.archivedAt ? `Restore "${s.title}"` : `Archive "${s.title}"`;
  act.setAttribute('aria-label', act.title);
  act.addEventListener('click', (e) => { e.stopPropagation(); archiveSession(s.id, !s.archivedAt); });
  wrap.append(act);
  return wrap;
}

function pip(kind, title) {
  const s = document.createElement('span');
  s.className = `pip pip--${kind}`;
  s.title = title;
  return s;
}

el.librarySearch.addEventListener('input', paintLibrary);

/* ────────────────────────────────────────────────────────────  archive  ── */

/* Archiving is filing, not deleting. Nothing is removed, nothing stops
   working, and the only irreversible part — releasing the audio — is a
   separate, explicit button that refuses to touch a recording with no
   transcript. */

const size = (bytes) => {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
};
// Below roughly half a minute of audio there is nothing worth offering to free.
const WORTH_FREEING = 200 * 1024;

async function archiveSession(id, archived) {
  try {
    await api(`/api/sessions/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ archived }),
    });
    if (state.session?.id === id) {
      state.session.archivedAt = archived ? Date.now() : null;
      paintArchiveState();
    }
    await loadLibrary();
    const title = state.sessions.find((s) => s.id === id)?.title || 'That lecture';
    toast(archived ? `${title} archived. It is on the Archived shelf.` : `${title} restored.`, 'ok');
  } catch (err) { toast(err.message, 'bad'); }
}

async function archiveModule(id, archived) {
  const mine = state.sessions.filter((s) => s.moduleId === id);
  const affected = mine.filter((s) => Boolean(s.archivedAt) !== archived).length;
  let cascade = false;
  if (affected) {
    const name = state.modules.find((m) => m.id === id)?.name || 'this module';
    cascade = confirm(archived
      ? `Archive the ${affected} lecture(s) in ${name} as well?\n\nOK archives the module and its lectures. Cancel archives only the module — its lectures stay where they are.`
      : `Restore the ${affected} archived lecture(s) in ${name} as well?\n\nOK restores the module and its lectures. Cancel restores only the module.`);
  }
  try {
    await api(`/api/modules/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ archived, cascade }),
    });
    if (state.module?.id === id) state.module.archivedAt = archived ? Date.now() : null;
    await loadLibrary();
    if (state.view === 'module' && state.module?.id === id) paintModuleArchiveState();
    toast(archived ? 'Module archived.' : 'Module restored.', 'ok');
  } catch (err) { toast(err.message, 'bad'); }
}

/** The banner on an archived lecture, and the Archive button's label. */
function paintArchiveState() {
  const archived = Boolean(state.session?.archivedAt);
  el.archBar.hidden = !archived;
  el.archiveBtn.textContent = archived ? 'Restore' : 'Archive';
  el.recBtn.disabled = archived || !state.env?.ready || !state.session || state.recording;
  if (!state.recording && el.transport.dataset.state === 'idle') {
    el.transportStatus.textContent = archived ? 'Archived' : (state.session ? 'Ready' : 'No lecture open');
  }

  if (!archived) return;
  const audio = state.audio || { bytes: 0, releasable: 0 };
  const when = new Date(state.session.archivedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  el.archText.textContent = audio.bytes
    ? `Filed ${when}. Everything is still here — notes, transcript and ${size(audio.bytes)} of audio.`
    : `Filed ${when}. Everything is still here.`;

  // Only offer to free audio that has already been transcribed.
  el.archFreeBtn.hidden = audio.releasable < WORTH_FREEING;
  el.archFreeBtn.textContent = `Free ${size(audio.releasable)} of audio`;
  el.archFreeBtn.title = 'Deletes the recorded audio of transcribed recordings. The transcript, notes and slides stay. This cannot be undone.';
}

function paintModuleArchiveState() {
  const archived = Boolean(state.module?.archivedAt);
  el.moduleArchive.textContent = archived ? 'Restore module' : 'Archive module';
  el.moduleView.classList.toggle('is-archived', archived);
}

el.archiveBtn.addEventListener('click', () => {
  if (state.session) archiveSession(state.session.id, !state.session.archivedAt);
});
el.archRestoreBtn.addEventListener('click', () => {
  if (state.session) archiveSession(state.session.id, false);
});
el.moduleArchive.addEventListener('click', () => {
  if (state.module) archiveModule(state.module.id, !state.module.archivedAt);
});

el.archFreeBtn.addEventListener('click', async () => {
  if (!state.session) return;
  const audio = state.audio || { releasable: 0 };
  const kept = (audio.recordings || []).filter((r) => !r.transcribed && r.bytes).length;
  const warn = `Delete ${size(audio.releasable)} of recorded audio from "${state.session.title}"?

The transcript, your notes, the slides and everything else stay exactly as they are — but the audio itself is gone for good, and the lecture can never be transcribed again with a better model.${kept ? `\n\n${kept} recording(s) have no transcript yet and will be left alone.` : ''}`;
  if (!confirm(warn)) return;
  try {
    const out = await api(`/api/sessions/${state.session.id}/audio`, { method: 'DELETE' });
    // Re-read rather than patch locally: whether a recording can still be
    // re-transcribed has just changed, and that is the server's call.
    await refreshSession();
    toast(`Freed ${size(out.freedBytes)}. The transcript and your notes are untouched.`, 'ok');
  } catch (err) { toast(err.message, 'bad'); }
});

/* ────────────────────────────────────────────────────────────  modules  ── */

function paintModuleSelect() {
  const sel = el.sessionModuleSelect;
  sel.innerHTML = '';
  sel.add(new Option('No module', ''));
  for (const m of state.modules) sel.add(new Option(m.name, m.id));
  sel.value = state.session?.moduleId || '';
}

el.sessionModuleSelect.addEventListener('change', async () => {
  if (!state.session) return;
  try {
    const { session } = await api(`/api/sessions/${state.session.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ moduleId: el.sessionModuleSelect.value || null }),
    });
    state.session = { ...state.session, ...session };
    paintCrumbs();
    await loadLibrary();
  } catch (err) { toast(err.message, 'bad'); }
});

async function newModule() {
  const name = prompt('Module name', '');
  if (name === null) return;
  const { module: mod } = await api('/api/modules', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: name.trim() || 'New module' }),
  });
  await loadLibrary();
  await openModule(mod.id);
  el.moduleName.focus();
  el.moduleName.select();
}

async function newLecture(moduleId = null) {
  if (state.recording) { toast('Stop the current recording first.', 'warn'); return; }
  const mid = moduleId || state.session?.moduleId || state.module?.id || null;
  const { session } = await api('/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '', moduleId: mid }),
  });
  await loadLibrary();
  await openSession(session.id);
  el.sessionTitle.focus();
  el.sessionTitle.select();
}

el.newModuleBtn.addEventListener('click', () => newModule().catch((e) => toast(e.message, 'bad')));
el.newSessionBtn.addEventListener('click', () => newLecture().catch((e) => toast(e.message, 'bad')));
el.emptyNewModule.addEventListener('click', () => newModule().catch((e) => toast(e.message, 'bad')));
el.emptyNewLecture.addEventListener('click', () => newLecture().catch((e) => toast(e.message, 'bad')));
el.moduleNewLecture.addEventListener('click', () => newLecture(state.module?.id).catch((e) => toast(e.message, 'bad')));

function showView(which) {
  state.view = which;
  el.lectureView.hidden = which !== 'lecture';
  el.moduleView.hidden = which !== 'module';
  el.emptyView.hidden = which !== 'empty';
  el.railSession.hidden = which !== 'lecture';
  closeOutline();
}

async function openModule(id) {
  await flushSaves();
  const data = await api(`/api/modules/${id}`);
  state.module = data.module;
  state.moduleNotes = data.notes;
  state.session = null;
  showView('module');

  el.moduleName.value = data.module.name;
  el.moduleCode.value = data.module.code || '';
  el.moduleLecturer.value = data.module.lecturer || '';
  el.moduleAssessments.value = (data.module.assessments || []).join(', ');
  el.moduleSwatch.dataset.colour = data.module.colour || 'indigo';
  const shelved = data.lectures.filter((l) => l.archivedAt).length;
  el.moduleLectureCount.textContent = [
    `${data.lectures.length} lecture${data.lectures.length === 1 ? '' : 's'}`,
    shelved ? `${shelved} archived` : null,
  ].filter(Boolean).join(' · ');
  paintSwatches();
  paintModuleArchiveState();

  const draft = takeDraft(`m:${id}`, data.notes);
  state.modEditor.load(draft ? draft.blocks : data.notes.blocks);
  if (draft) { markModuleDirty(); toast('Restored module notes this browser had not managed to save.', 'warn'); }
  paintModuleStats();
  paintLibrary();
  history.replaceState(null, '', `#m=${id}`);
}

function paintSwatches() {
  el.moduleColours.textContent = '';
  for (const c of (state.colours || ['indigo', 'teal', 'amber', 'rose', 'violet', 'lime'])) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.colour = c;
    b.setAttribute('aria-pressed', String(state.module?.colour === c));
    b.title = c;
    b.addEventListener('click', () => { el.moduleSwatch.dataset.colour = c; patchModule({ colour: c }); });
    el.moduleColours.append(b);
  }
}

const patchModuleDebounced = debounce(() => patchModule(), 600);

async function patchModule(extra = {}) {
  if (!state.module) return;
  try {
    const { module: mod } = await api(`/api/modules/${state.module.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: el.moduleName.value,
        code: el.moduleCode.value,
        lecturer: el.moduleLecturer.value,
        assessments: el.moduleAssessments.value,
        ...extra,
      }),
    });
    state.module = mod;
    el.moduleSwatch.dataset.colour = mod.colour;
    paintSwatches();
    await loadLibrary();
  } catch (err) { toast(err.message, 'bad'); }
}

for (const input of [el.moduleName, el.moduleCode, el.moduleLecturer, el.moduleAssessments]) {
  input.addEventListener('input', patchModuleDebounced);
}

el.moduleDelete.addEventListener('click', async () => {
  if (!state.module) return;
  const count = state.sessions.filter((s) => s.moduleId === state.module.id).length;
  const warn = count
    ? `Delete the module "${state.module.name}" and its module notes?\n\nThe ${count} lecture(s) in it are kept — they just stop being filed under anything.`
    : `Delete the module "${state.module.name}" and its module notes?`;
  if (!confirm(warn)) return;
  try {
    await api(`/api/modules/${state.module.id}`, { method: 'DELETE' });
    state.module = null;
    showView('empty');
    await loadLibrary();
  } catch (err) { toast(err.message, 'bad'); }
});

/* ────────────────────────────────────────────────────────────  session  ── */

async function openSession(id) {
  if (state.recording) { toast('Stop the current recording first.', 'warn'); return; }
  await flushSaves();
  const data = await api(`/api/sessions/${id}`);
  state.session = data.session;
  state.module = data.module;
  state.notebook = data.notebook;
  state.transcripts = new Map((data.transcripts || []).map((t) => [t.id, t.segments]));
  state.recordingInfo = new Map((data.transcripts || []).map((t) => [t.id, t]));
  state.audio = data.audio || null;
  // The last recording is usually the one you want — unless it is an empty
  // false start, in which case the one before it is.
  const recs = data.session.recordings || [];
  state.activeRecordingId = (recs.filter((r) => r.segmentCount > 0).at(-1) || recs.at(-1))?.id || null;
  state.deck = null;
  state.page = 1;

  showView('lecture');
  el.sessionTitle.value = data.session.title;
  paintModuleSelect();
  paintCrumbs();
  paintArchiveState();
  el.transportStatus.textContent = data.session.archivedAt ? 'Archived' : 'Ready';
  el.transport.dataset.state = 'idle';

  const draft = takeDraft(`s:${id}`, data.notebook);
  state.editor.load(draft ? draft.blocks : data.notebook.blocks);
  if (draft) { markDirty(); toast('Restored notes this browser had not managed to save.', 'warn'); }

  paintNoteStats();
  paintRecList();
  paintFeed();
  paintDeckSelect();
  paintMaterials();
  paintLibrary();
  history.replaceState(null, '', `#s=${id}`);
}

function paintCrumbs() {
  const mod = state.module;
  el.railModuleBtn.hidden = !mod;
  if (mod) {
    el.railModuleBtn.textContent = mod.name;
    el.railModuleBtn.dataset.colour = mod.colour || 'indigo';
    el.railModuleBtn.title = 'Open module notes';
  }
  el.sessionModuleSelect.value = state.session?.moduleId || '';
}
el.railModuleBtn.addEventListener('click', () => state.module && openModule(state.module.id));

const patchSession = debounce(async () => {
  if (!state.session) return;
  const { session } = await api(`/api/sessions/${state.session.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: el.sessionTitle.value }),
  });
  state.session = { ...state.session, ...session };
  loadLibrary();
}, 700);
el.sessionTitle.addEventListener('input', patchSession);

/* ───────────────────────────────────────────────────────────  notebook  ── */

/* Notes are the one thing here that cannot be recreated from anything else, so
   they get three layers of belt and braces: a debounced save, a local draft in
   this browser, and a beacon on the way out of the page. */

const draftKey = (key) => `notebook.draft.${key}`;

function keepDraft(key, doc, blocks) {
  try {
    localStorage.setItem(draftKey(key), JSON.stringify({ rev: doc.rev, at: Date.now(), blocks }));
  } catch { /* quota, private mode — the server save is still the main path */ }
}
const dropDraft = (key) => { try { localStorage.removeItem(draftKey(key)); } catch { /* fine */ } };

/** A draft is only interesting if it is newer than what the server has. */
function takeDraft(key, doc) {
  try {
    const raw = JSON.parse(localStorage.getItem(draftKey(key)) || 'null');
    if (!raw || !Array.isArray(raw.blocks)) return null;
    if (raw.at <= (doc.savedAt || 0)) { dropDraft(key); return null; }
    return raw;
  } catch { return null; }
}

function makeSaver({ url, alive, getDoc, setDoc, getBlocks, key, hint, onSaved }) {
  let failures = 0;
  const save = async () => {
    // The retry below outlives the view it belongs to; if the student has
    // moved on to another lecture there is nothing left to save it against.
    if (!alive()) { failures = 0; return false; }
    const blocks = getBlocks();
    try {
      const body = JSON.stringify({ rev: getDoc().rev, blocks });
      const out = await api(url(), { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
      setDoc(out.notebook || out.notes);
      failures = 0;
      dropDraft(key());
      hint('Saved', false);
      onSaved?.();
      return true;
    } catch (err) {
      failures += 1;
      keepDraft(key(), getDoc(), blocks);
      if (err.status === 409) {
        hint('Conflict', true);
        toastOnce('conflict', 'These notes were changed in another tab. Reload before typing more.', 'bad');
        return false;
      }
      hint(failures > 2 ? 'Offline — kept locally' : 'Retrying…', true);
      // Keep trying: a laptop that drops off the network mid-lecture should
      // catch up by itself, not silently stop saving.
      setTimeout(() => { if (failures) save(); }, Math.min(15000, 1000 * 2 ** failures));
      return false;
    }
  };
  return save;
}

const hintNote = (text, dirty) => {
  el.saveHint.textContent = text;
  el.saveHint.classList.toggle('is-dirty', dirty);
};
const hintModule = (text, dirty) => {
  el.moduleSaveHint.textContent = text;
  el.moduleSaveHint.classList.toggle('is-dirty', dirty);
};

const saveNote = makeSaver({
  url: () => `/api/sessions/${state.session.id}/notebook`,
  alive: () => !!state.session,
  getDoc: () => state.notebook,
  setDoc: (d) => { state.notebook = d; state.dirty = false; },
  getBlocks: () => state.editor.getBlocks(),
  key: () => `s:${state.session?.id}`,
  hint: hintNote,
});
const saveModuleNote = makeSaver({
  url: () => `/api/modules/${state.module.id}/notes`,
  alive: () => !!state.module,
  getDoc: () => state.moduleNotes,
  setDoc: (d) => { state.moduleNotes = d; state.moduleDirty = false; },
  getBlocks: () => state.modEditor.getBlocks(),
  key: () => `m:${state.module?.id}`,
  hint: hintModule,
});

const saveNoteSoon = debounce(() => state.session && saveNote(), 800);
const saveModuleSoon = debounce(() => state.module && saveModuleNote(), 800);

function markDirty() {
  state.dirty = true;
  hintNote('Saving…', true);
  keepDraft(`s:${state.session?.id}`, state.notebook, state.editor.getBlocks());
  paintNoteStats();
  saveNoteSoon();
}

function markModuleDirty() {
  state.moduleDirty = true;
  hintModule('Saving…', true);
  keepDraft(`m:${state.module?.id}`, state.moduleNotes, state.modEditor.getBlocks());
  paintModuleStats();
  saveModuleSoon();
}

async function flushSaves() {
  saveNoteSoon.cancel();
  saveModuleSoon.cancel();
  if (state.dirty && state.session) await saveNote().catch(() => {});
  if (state.moduleDirty && state.module) await saveModuleNote().catch(() => {});
}

// A lecture theatre is exactly where a laptop gets closed mid-sentence.
// sendBeacon is the only thing that survives that, and it is POST-only —
// which is why the notebook route accepts POST as well as PUT.
window.addEventListener('pagehide', () => {
  const beacon = (url, doc, blocks) => {
    try {
      navigator.sendBeacon(url, new Blob([JSON.stringify({ rev: doc.rev, blocks })], { type: 'application/json' }));
    } catch { /* nothing else to try at this point */ }
  };
  if (state.dirty && state.session) beacon(`/api/sessions/${state.session.id}/notebook`, state.notebook, state.editor.getBlocks());
  if (state.moduleDirty && state.module) beacon(`/api/modules/${state.module.id}/notes`, state.moduleNotes, state.modEditor.getBlocks());
});
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSaves(); });

function paintNoteStats() {
  const s = state.editor.getStats();
  el.noteStats.textContent = statLine(s);
}
function paintModuleStats() {
  el.moduleStats.textContent = statLine(state.modEditor.getStats());
}
function statLine(s) {
  const bits = [`${s.words} word${s.words === 1 ? '' : 's'}`];
  if (s.todo) bits.push(`${s.todoDone}/${s.todo} to-do`);
  return bits.join(' · ');
}

/** The stamp a new block gets: media time when recording, wall clock otherwise. */
function nowAnchor() {
  if (state.rec) {
    // Media time, not wall time: if capture stuttered, the note belongs where
    // the audio actually is. The server's tick is the authority on that.
    const media = Number.isFinite(state.health?.durationMs)
      ? state.health.durationMs + (Date.now() - (state.health.at || Date.now()))
      : Date.now() - state.rec.startedAtWall;
    return { wall: Date.now(), recId: state.rec.id, t: Math.max(0, Math.round(media)) };
  }
  return { wall: Date.now(), recId: null, t: null };
}

state.editor = new NotebookEditor({
  host: el.editor,
  onChange: markDirty,
  nowAnchor,
  assetUrl: (file) => `/api/sessions/${state.session.id}/assets/${encodeURIComponent(file)}`,
  onCommand: (cmd) => {
    if (cmd === 'sketch') openSketch(null);
    if (cmd === 'image') el.imageInput.click();
    if (cmd === 'slide') pinSlide();
  },
  onSeek: (anchor) => {
    if (!anchor?.recId) return;
    showTab('transcript');
    state.activeRecordingId = anchor.recId;
    paintRecList();
    paintFeed();
    highlightAt(anchor.t);
  },
});

state.modEditor = new NotebookEditor({
  host: el.moduleEditor,
  stamps: false,
  onChange: markModuleDirty,
  assetUrl: (file) => `/api/modules/${state.module.id}/assets/${encodeURIComponent(file)}`,
  onCommand: (cmd) => {
    if (cmd === 'sketch') openSketch(null, 'module');
    if (cmd === 'image') { imageTarget = 'module'; el.imageInput.click(); }
  },
});

el.editor.addEventListener('editsketch', (e) => openSketch(e.detail, 'lecture'));
el.moduleEditor.addEventListener('editsketch', (e) => openSketch(e.detail, 'module'));

const activeEditor = () => (state.view === 'module' ? state.modEditor : state.editor);

el.addHeading.addEventListener('click', () => state.editor.toggleHeading(2));
el.addImage.addEventListener('click', () => { imageTarget = 'lecture'; el.imageInput.click(); });
el.addSketch.addEventListener('click', () => openSketch(null, 'lecture'));
el.modAddImage.addEventListener('click', () => { imageTarget = 'module'; el.imageInput.click(); });
el.modAddSketch.addEventListener('click', () => openSketch(null, 'module'));

let imageTarget = 'lecture';

el.imageInput.addEventListener('change', async () => {
  for (const file of el.imageInput.files) await attachImage(file, imageTarget);
  el.imageInput.value = '';
});

// Pasting a screenshot is the fastest path in a lecture, so it gets first class
// treatment: intercept before the browser drops raw image data into the block.
document.addEventListener('paste', async (e) => {
  if (state.view === 'empty') return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  const file = item.getAsFile();
  if (file) await attachImage(file, state.view === 'module' ? 'module' : 'lecture');
});

for (const [host, where] of [[el.editor, 'lecture'], [el.moduleEditor, 'module']]) {
  host.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  host.addEventListener('drop', async (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) await attachImage(f, where);
  });
}

function assetBase(where) {
  return where === 'module'
    ? `/api/modules/${state.module.id}/assets`
    : `/api/sessions/${state.session.id}/assets`;
}

async function attachImage(file, where = 'lecture') {
  if (where === 'module' ? !state.module : !state.session) return;
  try {
    const ext = (file.type.split('/')[1] || 'png').replace(/\W/g, '');
    const { asset } = await api(`${assetBase(where)}?ext=${ext}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file,
    });
    (where === 'module' ? state.modEditor : state.editor).insert({ type: 'image', asset: asset.file, caption: '' });
  } catch (err) { toast(err.message, 'bad'); }
}

/* ────────────────────────────────────────────────────────────  outline  ── */

function openOutline(anchorBtn, editor) {
  const items = editor.getOutline();
  el.outlinePop.textContent = '';
  el.outlinePop.classList.remove('pop--wide');
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'pop__none';
    p.textContent = 'No headings yet. Press ⌘1–⌘3, or type "## " at the start of a line.';
    el.outlinePop.append(p);
  } else {
    for (const item of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `pop__item pop__item--h${item.level}`;
      b.textContent = item.text;
      b.addEventListener('click', () => { editor.focus(item.id, -1); closeOutline(); });
      el.outlinePop.append(b);
    }
  }
  const box = anchorBtn.getBoundingClientRect();
  el.outlinePop.hidden = false;
  el.outlinePop.style.left = `${Math.round(box.left)}px`;
  el.outlinePop.style.bottom = `${Math.round(window.innerHeight - box.top + 8)}px`;
  anchorBtn.setAttribute('aria-expanded', 'true');
}

function closeOutline() {
  el.outlinePop.hidden = true;
  el.outlineBtn.setAttribute('aria-expanded', 'false');
  el.modOutlineBtn.setAttribute('aria-expanded', 'false');
}

el.outlineBtn.addEventListener('click', () => (el.outlinePop.hidden ? openOutline(el.outlineBtn, state.editor) : closeOutline()));
el.modOutlineBtn.addEventListener('click', () => (el.outlinePop.hidden ? openOutline(el.modOutlineBtn, state.modEditor) : closeOutline()));
document.addEventListener('click', (e) => {
  if (el.outlinePop.hidden) return;
  if (e.target.closest('#outlinePop, #outlineBtn, #modOutlineBtn, .rec-chip__info')) return;
  closeOutline();
});

/* ─────────────────────────────────────────────────────────────  sketch  ── */

let sketchTarget = null;   // block being edited, or null for a new one
let sketchWhere = 'lecture';

function openSketch(block, where = 'lecture') {
  sketchTarget = block;
  sketchWhere = where;
  el.sketchModal.hidden = false;
  el.sketchHost.innerHTML = '';
  const width = Math.min(900, window.innerWidth - 120);
  state.pad = new SketchPad({
    container: el.sketchHost,
    width,
    height: Math.round(width * 0.58),
    strokes: [],
  });
  if (block?.strokes) {
    fetch(`${assetBase(where)}/${encodeURIComponent(block.strokes)}`)
      .then((r) => r.json())
      .then((s) => state.pad.setStrokes(s.strokes || s))
      .catch(() => {});
  }
}

function closeSketch() {
  el.sketchModal.hidden = true;
  state.pad?.destroy();
  state.pad = null;
  sketchTarget = null;
}
$$('[data-close-sketch]').forEach((n) => n.addEventListener('click', closeSketch));

el.sketchSave.addEventListener('click', async () => {
  if (!state.pad) return;
  const editor = sketchWhere === 'module' ? state.modEditor : state.editor;
  try {
    const id = sketchTarget?.asset?.replace(/\.png$/, '') || `sk-${Date.now().toString(36)}`;
    const png = await state.pad.toBlob();
    const strokes = JSON.stringify({ strokes: state.pad.getStrokes() });
    const base = assetBase(sketchWhere);
    await api(`${base}?name=${id}.png`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: png });
    await api(`${base}?name=${id}.strokes.json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: strokes });

    if (sketchTarget) {
      // Bust the browser cache: the filename is stable across edits by design.
      editor.update(sketchTarget.id, { asset: `${id}.png`, strokes: `${id}.strokes.json` });
      $$(`[data-id="${sketchTarget.id}"] img`, editor.host).forEach((i) => { i.src = `${i.src.split('?')[0]}?v=${Date.now()}`; });
    } else {
      editor.insert({ type: 'sketch', asset: `${id}.png`, strokes: `${id}.strokes.json`, caption: '' });
    }
    closeSketch();
  } catch (err) { toast(err.message, 'bad'); }
});

/* ─────────────────────────────────────────────────────────  recording  ── */

el.sourceSelect.addEventListener('change', () => {
  el.deviceSelect.hidden = el.sourceSelect.value !== 'device';
  if (el.sourceSelect.value === 'device') refreshStatus();
});

el.recBtn.addEventListener('click', () => (state.recording ? stopRecording() : startRecording()));
el.stopBtn.addEventListener('click', () => stopRecording());

async function startRecording() {
  if (state.recording || !state.session) return;
  if (!state.env?.ready) { openSetup(); return; }

  let mixed = null;
  try {
    const source = el.sourceSelect.value;
    if (source === 'browser') mixed = await grabDisplayAudio();

    const { recording } = await api(`/api/sessions/${state.session.id}/recordings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source,
        deviceIndex: el.deviceSelect.value ? Number(el.deviceSelect.value) : null,
        settings: {},
      }),
    });

    said.clear();
    state.rec = { id: recording.id, startedAtWall: Date.now() };
    state.health = { durationMs: 0, at: Date.now(), stalled: false, gaps: 0 };
    state.activeRecordingId = recording.id;
    state.transcripts.set(recording.id, []);
    state.session.recordings = [...(state.session.recordings || []), { id: recording.id, status: 'recording', durationMs: 0 }];
    paintRecList();
    paintFeed();

    if (mixed) { state.captureStream = mixed; startBrowserCapture(mixed); }
    openEventStream(recording.id);
    enterRecordingUi();
  } catch (err) {
    mixed?.getTracks().forEach((t) => t.stop());
    teardownCapture();
    toast(err.message, 'bad');
  }
}

async function grabDisplayAudio() {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('This browser cannot capture tab audio. Use Chrome or Edge.');
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1 },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
    });
  } catch (err) {
    if (err.name === 'NotAllowedError') throw new Error('Screen share was cancelled, so there is nothing to record.');
    throw err;
  }
  if (display.getAudioTracks().length === 0) {
    display.getTracks().forEach((t) => t.stop());
    throw new Error('That share had no audio. Pick a Chrome Tab and tick "Also share tab audio".');
  }
  display.getAudioTracks()[0].addEventListener('ended', () => {
    if (state.recording) { toast('The shared tab stopped — finishing the recording.', 'warn'); stopRecording(); }
  });

  let tracks = display.getAudioTracks();
  if (state.settings?.mixMic) {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      tracks = [...tracks, ...mic.getAudioTracks()];
      state.micStream = mic;
    } catch { toast('Microphone was refused — recording the tab only.', 'warn'); }
  }
  state.stream = display;

  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  for (const track of tracks) {
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const gain = ctx.createGain();
    gain.gain.value = tracks.length > 1 ? 0.85 : 1;
    src.connect(gain); gain.connect(dest); gain.connect(analyser);
  }
  state.audioCtx = ctx;
  state.analyser = analyser;
  return dest.stream;
}

/**
 * Start a MediaRecorder over the mixed stream.
 *
 * Each recorder gets a generation number. When the stream has to be recycled
 * (the server restarted its transcoder, or uploads started failing) the
 * generation moves on and the old recorder's trailing chunk is discarded
 * rather than being spliced into a fresh webm stream, which would give ffmpeg
 * a header it cannot parse and take the rest of the lecture down with it.
 */
function startBrowserCapture(stream, { fresh = false } = {}) {
  const mime = ['audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 96000 } : undefined);
  const gen = (state.gen += 1);
  state.freshNext = fresh;

  recorder.addEventListener('dataavailable', (e) => {
    if (!e.data?.size || !state.rec || gen !== state.gen) return;
    const first = state.freshNext;
    state.freshNext = false;
    state.pendingChunks += 1;
    const startStamp = state.mediaStartedAt;
    state.mediaStartedAt = null;
    state.uploads = state.uploads
      .then(() => uploadChunk(e.data, { fresh: first, startedAt: startStamp }))
      .catch(() => {})
      .finally(() => { state.pendingChunks -= 1; });
  });
  recorder.addEventListener('error', (e) => {
    if (gen !== state.gen) return;
    toastOnce('mrerror', `The browser's recorder hiccuped (${e.error?.name || 'unknown'}) — restarting it.`, 'warn');
    requestFreshStream('MediaRecorder error');
  });

  recorder.start(1000);
  // Media time zero for this stream. Sent with the first chunk so the server
  // can anchor the recording's timeline to when audio actually started being
  // captured, not when the bytes arrived a second later.
  if (!fresh) state.mediaStartedAt = Date.now();
  state.recorder = recorder;
  if (!state.meterRaf) startLocalMeter();
}

/**
 * Upload one chunk, retrying before giving up.
 *
 * A dropped chunk is not "a gap" — webm is a continuous container, so losing
 * a cluster can poison the decoder for everything that follows. Retrying, and
 * then re-syncing with a fresh stream, is the difference between a two-second
 * hole and a silent half-lecture.
 */
async function uploadChunk(blob, { fresh = false, startedAt = null } = {}) {
  if (!state.rec || !state.session) return;
  const q = new URLSearchParams();
  if (fresh) q.set('fresh', '1');
  if (startedAt) q.set('start', String(startedAt));
  const qs = q.toString();
  const url = `/api/sessions/${state.session.id}/recordings/${state.rec.id}/audio${qs ? `?${qs}` : ''}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/octet-stream' },
        body: blob, signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 409) { recordingVanished(); return; }
      if (!res.ok) throw new Error(`server said ${res.status}`);
      const out = await res.json().catch(() => ({}));
      if (out.needsFresh && !fresh) requestFreshStream('server wants a fresh stream');
      return;
    } catch (err) {
      clearTimeout(timer);
      if (attempt === 3) {
        toastOnce('upload', `Audio is not reaching the recorder (${err.message}). Re-syncing the stream.`, 'bad');
        requestFreshStream('uploads failing');
        return;
      }
      await sleep(250 * 2 ** attempt);
    }
  }
}

/** The server no longer knows about this recording — stop pushing into a hole. */
function recordingVanished() {
  if (!state.recording) return;
  toastOnce('vanished', 'The server lost track of this recording — it may have restarted. Stopping; the audio captured so far is safe and will be transcribed.', 'bad');
  stopRecording();
}

/**
 * Ask the server to restart its transcoder and hand it a brand new webm
 * stream. Both halves have to move together or the decoder chokes, so the
 * client waits for the server's `reopenInput` before recycling.
 */
let freshInFlight = false;
async function requestFreshStream(reason) {
  if (!state.recording || freshInFlight || el.sourceSelect.value !== 'browser') return;
  freshInFlight = true;
  try {
    await api(`/api/sessions/${state.session.id}/recordings/${state.rec.id}/reopen`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
  } catch { recycleRecorder(); }
  setTimeout(() => { freshInFlight = false; }, 3000);
}

function recycleRecorder() {
  if (!state.recording || state.recycling || !state.captureStream) return;
  state.recycling = true;
  try {
    const old = state.recorder;
    state.gen += 1;                       // orphan anything still in flight
    if (old && old.state !== 'inactive') { try { old.stop(); } catch { /* already dead */ } }
    startBrowserCapture(state.captureStream, { fresh: true });
  } finally {
    state.recycling = false;
  }
}

function startLocalMeter() {
  if (!state.analyser) return;
  const data = new Uint8Array(state.analyser.fftSize);
  const tick = () => {
    if (!state.analyser) { state.meterRaf = null; return; }
    state.analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i += 4) peak = Math.max(peak, Math.abs(data[i] - 128));
    paintMeter(Math.min(1, (peak / 128) ** 0.6 * 1.25));
    state.meterRaf = requestAnimationFrame(tick);
  };
  tick();
}

function enterRecordingUi() {
  state.recording = true;
  document.body.classList.add('is-recording');
  el.transport.dataset.state = 'recording';
  el.stopBtn.hidden = false;
  el.sourceSelect.disabled = true;
  el.transportStatus.textContent = 'Recording';
  state.timer = setInterval(paintTransport, 100);
}

/**
 * The timecode shows how much audio the server actually holds, not how long
 * ago the button was pressed. Those two used to be the same number, which is
 * why a dead capture looked exactly like a healthy one.
 */
function paintTransport() {
  if (!state.rec) return;
  const wall = Date.now() - state.rec.startedAtWall;
  const h = state.health;
  const media = h ? h.durationMs + (h.stalled ? 0 : Date.now() - h.at) : wall;
  el.timecode.innerHTML = longTime(media);

  const drift = wall - media;
  const bad = h?.stalled || drift > DRIFT_WARN_MS;
  el.transport.dataset.health = bad ? 'bad' : (h?.quiet || h?.gaps ? 'warn' : 'ok');
  if (h?.stalled) {
    showHealth('No audio arriving', 'Nothing has reached the recorder for a while. Recording continues and the app is retrying — check the shared tab or the input device.');
  } else if (drift > DRIFT_WARN_MS) {
    showHealth(`${Math.round(drift / 1000)}s behind`, 'The recorder holds less audio than the clock says. Some was lost.');
  } else if (h?.quiet) {
    // Worth interrupting for: it is fixable in the first minute and ruinous
    // if you only find out when you read the transcript.
    showHealth(`Very quiet${h.levelDb ? ` · ${h.levelDb} dB` : ''}`,
      'The input is too quiet to transcribe well. Move the microphone closer, or raise the input level. Audio this quiet makes the transcriber guess, and a guessing transcriber repeats itself.');
  } else if (h?.gaps) {
    showHealth(`${h.gaps} gap${h.gaps === 1 ? '' : 's'}`, 'Capture was restarted mid-lecture; a few seconds were lost at each restart.');
  } else {
    el.healthChip.hidden = true;
  }
}

function showHealth(text, title) {
  el.healthChip.hidden = false;
  el.healthChip.textContent = text;
  el.healthChip.title = title;
}

function teardownCapture() {
  clearInterval(state.timer);
  cancelAnimationFrame(state.meterRaf);
  state.meterRaf = null;
  state.stream?.getTracks().forEach((t) => t.stop());
  state.micStream?.getTracks().forEach((t) => t.stop());
  state.stream = null; state.micStream = null; state.captureStream = null;
  state.audioCtx?.close().catch(() => {});
  state.audioCtx = null; state.analyser = null;
  state.recorder = null;
  paintMeter(0);
}

function flushRecorder() {
  const r = state.recorder;
  if (!r || r.state === 'inactive') return Promise.resolve();
  return new Promise((resolve) => {
    r.addEventListener('stop', () => resolve(), { once: true });
    setTimeout(resolve, 3000);
    try { r.stop(); } catch { resolve(); }
  });
}

async function stopRecording() {
  if (!state.recording || !state.rec) return;
  const { id: rid } = state.rec;
  state.recording = false;
  document.body.classList.remove('is-recording');
  el.transport.dataset.state = 'processing';
  el.stopBtn.hidden = true;
  el.recBtn.disabled = true;
  el.transportStatus.textContent = 'Saving audio';

  await flushRecorder();
  teardownCapture();
  await state.uploads;
  try { await api(`/api/sessions/${state.session.id}/recordings/${rid}/stop`, { method: 'POST' }); }
  catch (err) { toast(err.message, 'bad'); }
}

function resetTransport() {
  el.transport.dataset.state = 'idle';
  el.transport.dataset.health = 'ok';
  el.healthChip.hidden = true;
  el.timecode.innerHTML = longTime(0);
  el.transportStatus.textContent = state.session ? 'Ready' : 'No lecture open';
  el.stopBtn.hidden = true;
  el.sourceSelect.disabled = false;
  el.recBtn.disabled = !state.env?.ready || !state.session || Boolean(state.session?.archivedAt);
  paintMeter(0);
  state.rec = null;
  state.health = null;
}

/* ──────────────────────────────────────────────────────────────  events ── */

function openEventStream(rid) {
  state.events?.close();
  const es = new EventSource(`/api/sessions/${state.session.id}/recordings/${rid}/events`);
  state.events = es;

  es.onmessage = (msg) => {
    let e; try { e = JSON.parse(msg.data); } catch { return; }
    switch (e.type) {
      case 'level':
        if (el.sourceSelect.value === 'device') paintMeter(Math.min(1, (e.level ?? 0) ** 0.6 * 1.25));
        if (Number.isFinite(e.durationMs)) state.health = { ...(state.health || {}), durationMs: e.durationMs, at: Date.now() };
        break;
      case 'tick':
        state.health = { ...e, at: Date.now() };
        break;
      case 'segment':
        // Addressed by index, because a reconnected event stream replays the
        // whole transcript from the top.
        setSegment(rid, e.index, e.segment);
        break;
      case 'reopenInput':
        recycleRecorder();
        break;
      case 'encoding':
        el.transportStatus.textContent = 'Saving audio';
        break;
      case 'warning': toast(e.message, 'warn'); break;
      case 'state': handleState(e, rid); break;
      default: break;
    }
  };
  es.onerror = () => { if (!state.recording) es.close(); };
}

function handleState(e, rid) {
  if (e.status === 'processing') el.transportStatus.textContent = 'Saving audio';
  if (e.status === 'error') {
    toast(e.error || 'Recording failed.', 'bad');
    state.events?.close();
    resetTransport();
    refreshSession(rid);
  }
  if (e.status === 'done' || e.status === 'queued') {
    el.transportStatus.textContent = e.status === 'queued' ? 'Queued' : 'Saved';
    state.events?.close();
    resetTransport();
    toast(e.status === 'queued'
      ? 'Audio saved. Transcription is running in the background — you can close this lecture.'
      : 'Recording saved.', 'ok');
    refreshSession(rid);
  }
}

async function refreshSession(rid = null) {
  if (!state.session) return;
  try {
    const data = await api(`/api/sessions/${state.session.id}`);
    state.session = data.session;
    state.module = data.module;
    state.transcripts = new Map((data.transcripts || []).map((t) => [t.id, t.segments]));
    state.recordingInfo = new Map((data.transcripts || []).map((t) => [t.id, t]));
    state.audio = data.audio || null;
    if (rid) state.activeRecordingId = rid;
    paintArchiveState();
    paintRecList();
    paintFeed();
    loadLibrary();
  } catch { /* the panel will catch up on the next refresh */ }
}

/* ────────────────────────────────────────────  transcription queue UI  ── */

function openJobStream() {
  state.jobStream?.close();
  const es = new EventSource('/api/jobs/events');
  state.jobStream = es;
  es.onmessage = (msg) => {
    let e; try { e = JSON.parse(msg.data); } catch { return; }
    if (e.type === 'queue') state.queue = { jobs: e.jobs, running: e.running, waiting: e.waiting };
    if (e.type === 'job') {
      const at = state.queue.jobs.findIndex((j) => j.id === e.job.id);
      if (at === -1) state.queue.jobs.push(e.job); else state.queue.jobs[at] = e.job;
      state.queue.running = state.queue.jobs.find((j) => j.status === 'running') || null;
      state.queue.waiting = state.queue.jobs.filter((j) => j.status === 'queued').length;
      onJobUpdate(e.job);
    }
    paintQueue();
  };
}

function onJobUpdate(job) {
  if (job.status === 'done') {
    toast(`Transcript ready — ${job.sessionTitle}.`, 'ok');
    if (state.session?.id === job.sessionId) refreshSession();
    else loadLibrary();
  }
  if (job.status === 'error') {
    toast(`Transcription failed for ${job.sessionTitle}: ${job.error}`, 'bad');
    if (state.session?.id === job.sessionId) refreshSession();
  }
  if (state.session?.id === job.sessionId) paintRecList();
}

function paintQueue() {
  const { running, waiting } = state.queue;
  const pending = waiting + (running ? 1 : 0);
  el.queueStrip.hidden = !pending;
  if (!pending) return;
  const pct = Math.round((running?.progress || 0) * 100);
  el.queueFill.style.width = `${pct}%`;
  el.queueText.textContent = running
    ? `Transcribing ${trim(running.sessionTitle, 22)} · ${pct}%${waiting ? ` · ${waiting} waiting` : ''}`
    : `${waiting} waiting to transcribe`;
  el.queueStrip.title = running
    ? `${running.sessionTitle} — ${etaText(running)}. Runs in the background at low priority.`
    : 'Waiting for the current job to finish.';
}

const trim = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

function etaText(job) {
  if (!job.startedAt || !job.progress) return 'estimating';
  const elapsed = Date.now() - job.startedAt;
  const left = elapsed / job.progress - elapsed;
  if (!Number.isFinite(left) || left < 0) return 'estimating';
  return left < 90000 ? 'under a minute left' : `about ${Math.round(left / 60000)} min left`;
}

el.queueStrip.addEventListener('click', () => { el.queueSheet.hidden = false; paintQueueSheet(); });
$$('[data-close-queue]').forEach((n) => n.addEventListener('click', () => { el.queueSheet.hidden = true; }));

function paintQueueSheet() {
  el.queueBody.textContent = '';
  const rows = state.queue.jobs.slice().reverse();
  if (!rows.length) {
    el.queueBody.innerHTML = '<div class="card"><p>Nothing in the queue. Recordings land here when you stop them.</p></div>';
    return;
  }
  for (const job of rows) {
    const card = document.createElement('div');
    card.className = 'card';
    const status = { queued: 'waiting', running: `${Math.round((job.progress || 0) * 100)}%`, done: 'done', error: 'failed', cancelled: 'cancelled' }[job.status] || job.status;
    const tone = { done: 'ok', error: 'bad', running: 'warn' }[job.status] || 'warn';
    card.innerHTML = `<div class="card__row"><h3></h3><span class="state state--${tone}">${status}</span></div>
      <p class="hint"></p>`;
    card.querySelector('h3').textContent = job.sessionTitle;
    card.querySelector('.hint').textContent = [
      `model ${job.model}`,
      job.status === 'running' ? etaText(job) : null,
      job.segments ? `${job.segments} lines` : null,
      job.error,
    ].filter(Boolean).join(' · ');
    if (job.status === 'queued' || job.status === 'running') {
      const cancel = document.createElement('button');
      cancel.className = 'btn btn--ghost btn--sm';
      cancel.type = 'button';
      cancel.textContent = job.status === 'running' ? 'Stop this one' : 'Remove from queue';
      cancel.addEventListener('click', async () => {
        try { await api(`/api/jobs?id=${encodeURIComponent(job.id)}`, { method: 'DELETE' }); paintQueueSheet(); }
        catch (err) { toast(err.message, 'bad'); }
      });
      card.append(cancel);
    }
    el.queueBody.append(card);
  }
  const clear = document.createElement('button');
  clear.className = 'btn btn--ghost btn--sm';
  clear.type = 'button';
  clear.textContent = 'Clear finished';
  clear.addEventListener('click', async () => {
    await api('/api/jobs/clear', { method: 'POST' }).catch(() => {});
    state.queue.jobs = state.queue.jobs.filter((j) => j.status === 'queued' || j.status === 'running');
    paintQueueSheet();
    paintQueue();
  });
  el.queueBody.append(clear);
}

/* ──────────────────────────────────────────────────────────  transcript ── */

const REC_STATE = {
  recording: { label: 'recording', tone: 'live' },
  finishing: { label: 'saving', tone: 'live' },
  processing: { label: 'saving', tone: 'live' },
  queued: { label: 'queued', tone: 'wait' },
  transcribing: { label: 'transcribing', tone: 'wait' },
  done: { label: '', tone: 'ok' },
  interrupted: { label: 'interrupted', tone: 'bad' },
  error: { label: 'failed', tone: 'bad' },
};

/** One chip per recording, carrying its state and its way out of trouble. */
function paintRecList() {
  const recs = state.session?.recordings || [];
  el.recList.textContent = '';
  el.recList.hidden = recs.length === 0;
  recs.forEach((r, i) => {
    const job = state.queue.jobs.find((j) => j.recordingId === r.id && j.sessionId === state.session.id);
    const live = job && (job.status === 'running' || job.status === 'queued');
    const status = live ? (job.status === 'running' ? 'transcribing' : 'queued') : r.status;
    const meta = REC_STATE[status] || { label: status, tone: 'wait' };

    const chip = document.createElement('div');
    chip.className = `rec-chip rec-chip--${meta.tone}${r.id === state.activeRecordingId ? ' is-on' : ''}`;

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'rec-chip__pick';
    const bits = [`Part ${i + 1}`, mmss(r.durationMs)];
    if (meta.label) bits.push(job?.status === 'running' ? `${meta.label} ${Math.round((job.progress || 0) * 100)}%` : meta.label);
    pick.textContent = bits.join(' · ');
    const notes = [];
    if (r.degraded || r.gaps?.length) notes.push(`Capture was restarted ${r.gaps.length} time(s) during this recording — there are short gaps in the audio.`);
    if (r.audioReleasedAt) notes.push('The audio was freed up to save space. The transcript is all that remains of this recording.');
    if (r.quiet) notes.push(`The input was very quiet during this recording (${r.levelDb} dB), so the transcript is less reliable than usual.`);
    if (Number.isFinite(r.captureRatio) && r.captureRatio < 0.97) {
      notes.push(`Only ${Math.round(r.captureRatio * 100)}% of the elapsed time made it into the audio — the input dropped samples, so parts of the lecture are missing.`);
    }
    if (notes.length) pick.title = notes.join(' ');
    pick.addEventListener('click', () => { state.activeRecordingId = r.id; paintRecList(); paintFeed(); });
    chip.append(pick);

    const info = state.recordingInfo?.get(r.id);
    const needsWork = ['interrupted', 'error'].includes(r.status) || (r.status === 'done' && !r.segmentCount);

    // Where the audio actually lives, without anyone having to guess at the
    // data directory. Also the only place in the app you can play it back.
    const details = document.createElement('button');
    details.type = 'button';
    details.className = 'rec-chip__info';
    details.textContent = 'ⓘ';
    details.title = 'Where this recording is stored, and play it back';
    details.setAttribute('aria-label', `Details for part ${i + 1}`);
    details.addEventListener('click', (e) => { e.stopPropagation(); openRecordingInfo(details, r, i); });
    chip.append(details);

    if (!live && info?.canRetranscribe) {
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'rec-chip__go';
      go.textContent = needsWork ? 'Transcribe' : '⟳';
      go.title = needsWork
        ? 'Transcribe this recording from the audio on disk'
        : 'Transcribe again — useful after downloading a better model';
      go.addEventListener('click', () => requestTranscription(r.id, needsWork));
      chip.append(go);
    }
    el.recList.append(chip);
  });
}

/**
 * Everything the app knows about one recording's file, in one place: the real
 * path, the format, a player, and a way into Finder.
 */
function openRecordingInfo(anchor, rec, index) {
  const audio = (state.audio?.recordings || []).find((a) => a.id === rec.id);
  el.outlinePop.textContent = '';
  el.outlinePop.classList.add('pop--wide');

  const head = document.createElement('div');
  head.className = 'pop__head';
  head.textContent = `Part ${index + 1} · ${mmss(rec.durationMs)}`;
  el.outlinePop.append(head);

  const facts = document.createElement('div');
  facts.className = 'pop__facts';
  // How much of the wall-clock span actually made it into the file. Anything
  // under 97% means the capture dropped audio and the recording is shorter
  // than the lecture was.
  const span = rec.endedAt && rec.startedAt ? rec.endedAt - rec.startedAt : 0;
  const ratio = Number.isFinite(rec.captureRatio) ? rec.captureRatio
    : (span > 5000 && rec.durationMs ? rec.durationMs / span : null);
  const rows = [
    ['Recorded', rec.startedAt ? new Date(rec.startedAt).toLocaleString() : '—'],
    ['Format', audio?.format || (rec.audioReleasedAt ? 'audio was freed up' : 'no audio on disk')],
    ['Size', audio?.bytes ? size(audio.bytes) : '—'],
    ['Transcript', rec.segmentCount ? `${rec.segmentCount} lines · ${rec.model || 'unknown model'}` : 'none yet'],
  ];
  if (Number.isFinite(rec.startupLagMs)) {
    rows.push(['Started after', `${(rec.startupLagMs / 1000).toFixed(2)}s (opening the input)`]);
  }
  if (ratio !== null && ratio < 0.995) {
    rows.push(['Audio captured', `${Math.round(ratio * 100)}% of ${mmss(span)}`]);
  }
  for (const [k, v] of rows) {
    const row = document.createElement('div');
    row.className = `pop__fact${k === 'Audio captured' && ratio < 0.97 ? ' pop__fact--bad' : ''}`;
    row.innerHTML = '<span></span><strong></strong>';
    row.querySelector('span').textContent = k;
    row.querySelector('strong').textContent = v;
    facts.append(row);
  }
  el.outlinePop.append(facts);

  if (audio?.file) {
    const pathBox = document.createElement('code');
    pathBox.className = 'pop__path';
    pathBox.textContent = audio.file;
    pathBox.title = 'Click to select the whole path';
    pathBox.addEventListener('click', () => {
      const r = document.createRange();
      r.selectNodeContents(pathBox);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    });
    el.outlinePop.append(pathBox);

    const player = document.createElement('audio');
    player.controls = true;
    player.preload = 'none';
    player.className = 'pop__audio';
    player.src = `/api/sessions/${state.session.id}/recordings/${rec.id}/audio`;
    el.outlinePop.append(player);
  }

  const acts = document.createElement('div');
  acts.className = 'pop__acts';
  const act = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn--ghost btn--sm';
    b.textContent = label;
    b.addEventListener('click', fn);
    acts.append(b);
    return b;
  };
  if (audio?.file) {
    act('Copy path', async () => {
      try { await navigator.clipboard.writeText(audio.file); toast('Path copied.', 'ok'); }
      catch { toast('Could not reach the clipboard — the path is selectable above.', 'warn'); }
    });
    act('Show in Finder', () => reveal({ recordingId: rec.id }));
  }
  act('Lecture folder', () => reveal({}));
  el.outlinePop.append(acts);

  const box = anchor.getBoundingClientRect();
  el.outlinePop.hidden = false;
  // Keep it on screen: the chips sit at the top of a narrow right-hand panel.
  const width = 340;
  el.outlinePop.style.left = `${Math.round(Math.min(box.left, window.innerWidth - width - 12))}px`;
  el.outlinePop.style.bottom = 'auto';
  el.outlinePop.style.top = `${Math.round(box.bottom + 6)}px`;
}

async function reveal(body) {
  try {
    const out = await api(`/api/sessions/${state.session.id}/reveal`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    toast(`Opened in Finder: ${out.path}`, 'ok');
  } catch (err) { toast(err.message, 'bad'); }
}

async function requestTranscription(rid, silent = false) {
  try {
    await api(`/api/sessions/${state.session.id}/recordings/${rid}/transcribe`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    if (!silent) toast('Queued. It runs in the background — carry on.', 'ok');
    paintRecList();
  } catch (err) { toast(err.message, 'bad'); }
}

function currentSegments() {
  return state.transcripts.get(state.activeRecordingId) || [];
}

function paintFeed() {
  const segments = currentSegments();
  el.feed.innerHTML = '';
  el.transcriptEmpty.hidden = segments.length > 0;
  segments.forEach((s, i) => el.feed.append(segmentRow(s, i)));
  filterTranscript();
}

/** Idempotent: the same index always lands in the same slot. */
function setSegment(rid, index, segment) {
  const list = state.transcripts.get(rid) || [];
  const isNew = index >= list.length;
  list[Number.isFinite(index) ? index : list.length] = segment;
  state.transcripts.set(rid, list);
  if (rid !== state.activeRecordingId) return;
  if (!isNew) { paintFeed(); return; }
  el.transcriptEmpty.hidden = true;
  const atBottom = el.feed.scrollHeight - el.feed.scrollTop - el.feed.clientHeight < 60;
  const row = segmentRow(segment, index);
  row.classList.add('seg-line--fresh');
  el.feed.append(row);
  if (atBottom) el.feed.scrollTop = el.feed.scrollHeight;
  filterTranscript();
}

function segmentRow(segment, index) {
  const row = document.createElement('div');
  row.className = 'seg-line';
  row.dataset.start = String(segment.start);
  row.dataset.index = String(index);
  row.title = 'Click to quote this line in your notes';

  const tc = document.createElement('span');
  tc.className = 'seg-line__tc';
  tc.textContent = mmss(segment.start);

  const text = document.createElement('span');
  text.className = 'seg-line__text';
  text.textContent = segment.text;

  row.append(tc, text);
  row.addEventListener('click', () => quoteSegment(segment));
  return row;
}

/** Pull a line the lecturer said into the notes, stamped at that moment. */
function quoteSegment(segment) {
  if (!state.session || state.view !== 'lecture') return;
  state.editor.insert({
    type: 'text',
    md: `> ${segment.text}`,
    anchor: { wall: Date.now(), recId: state.activeRecordingId, t: segment.start },
  });
}

function filterTranscript() {
  const q = el.transcriptSearch.value.trim().toLowerCase();
  const segments = currentSegments();
  for (const row of $$('.seg-line', el.feed)) {
    const raw = segments[Number(row.dataset.index)]?.text ?? '';
    const node = row.querySelector('.seg-line__text');
    if (!q) { node.textContent = raw; row.classList.remove('seg-line--hidden'); continue; }
    const hit = raw.toLowerCase().includes(q);
    row.classList.toggle('seg-line--hidden', !hit);
    node.innerHTML = hit ? highlight(raw, q) : escapeHtml(raw);
  }
}
el.transcriptSearch.addEventListener('input', filterTranscript);

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function highlight(text, q) {
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escapeHtml(text).replace(new RegExp(`(${esc})`, 'gi'), '<mark>$1</mark>');
}

/** Scroll the feed to the moment a note was written and flag the nearby lines. */
function highlightAt(t) {
  $$('.seg-line.is-near', el.feed).forEach((r) => r.classList.remove('is-near'));
  const rows = $$('.seg-line', el.feed);
  let target = null;
  for (const row of rows) {
    if (Number(row.dataset.start) <= t) target = row; else break;
  }
  if (!target) return;
  target.classList.add('is-near');
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* ──────────────────────────────────────────────────────────────  tabs  ── */

const TABS = { transcript: ['tabTranscript', 'paneTranscript'], slides: ['tabSlides', 'paneSlides'], materials: ['tabMaterials', 'paneMaterials'] };
function showTab(which) {
  for (const [name, [tab, pane]] of Object.entries(TABS)) {
    const on = name === which;
    el[tab].classList.toggle('is-on', on);
    el[tab].setAttribute('aria-selected', String(on));
    el[pane].hidden = !on;
  }
}
el.tabTranscript.addEventListener('click', () => showTab('transcript'));
el.tabSlides.addEventListener('click', () => showTab('slides'));
el.tabMaterials.addEventListener('click', () => showTab('materials'));

/* ─────────────────────────────────────────────────────────────  slides  ── */

function paintDeckSelect() {
  const decks = state.session?.decks || [];
  el.deckSelect.innerHTML = '';
  el.deckSelect.hidden = decks.length === 0;
  for (const d of decks) {
    const o = document.createElement('option');
    o.value = d.id; o.textContent = `${d.name} (${d.pages}p)`;
    el.deckSelect.append(o);
  }
  if (decks.length) {
    state.deck = decks.find((d) => d.id === state.deck?.id) || decks[0];
    el.deckSelect.value = state.deck.id;
    showPage(state.page);
  } else {
    state.deck = null;
    el.deckBar.hidden = true;
    el.deck.innerHTML = '';
    el.deck.append(el.deckEmpty);
    el.deckEmpty.hidden = false;
  }
}
el.deckSelect.addEventListener('change', () => {
  state.deck = (state.session.decks || []).find((d) => d.id === el.deckSelect.value);
  state.page = 1;
  showPage(1);
});

el.addDeck.addEventListener('click', () => el.deckInput.click());
el.deckInput.addEventListener('change', async () => {
  const file = el.deckInput.files[0];
  el.deckInput.value = '';
  if (!file || !state.session) return;
  await uploadDeck(file);
});

async function uploadDeck(file) {
  el.deckEmpty.hidden = false;
  el.deckEmpty.innerHTML = '<p>Converting deck…</p>';
  try {
    await streamPost(
      `/api/sessions/${state.session.id}/decks?name=${encodeURIComponent(file.name)}`,
      (e) => {
        if (e.type === 'progress') {
          if (e.phase === 'convert') el.deckEmpty.innerHTML = '<p>Converting PowerPoint to PDF…</p>';
          if (e.phase === 'probe') el.deckEmpty.innerHTML = `<p>Rendering ${e.pages} pages…</p>`;
          if (e.phase === 'page') el.deckEmpty.innerHTML = `<p>Rendering page ${e.page} of ${e.pages}…</p>`;
        }
        if (e.type === 'done') {
          if (!e.ok) { toast(e.error || 'Could not read that deck.', 'bad'); el.deckEmpty.innerHTML = '<p>That deck could not be read.</p>'; return; }
          toast(`${e.deck.name} — ${e.deck.pages} pages ready.`, 'ok');
        }
      },
      file,
    );
    const data = await api(`/api/sessions/${state.session.id}`);
    state.session = data.session;
    state.page = 1;
    paintDeckSelect();
  } catch (err) { toast(err.message, 'bad'); }
}

async function showPage(n) {
  const deck = state.deck;
  if (!deck) return;
  state.page = clamp(n, 1, deck.pages);
  el.deckEmpty.hidden = true;
  el.deckBar.hidden = false;
  el.pageCount.textContent = `${state.page} / ${deck.pages}`;

  el.deck.innerHTML = '';
  const stage = document.createElement('div');
  stage.className = 'deck__stage';
  const img = document.createElement('img');
  img.src = `/api/sessions/${state.session.id}/decks/${deck.id}/pages/${state.page}.png`;
  img.alt = `Slide ${state.page}`;
  stage.append(img);
  el.deck.append(stage);

  state.deckPad?.destroy();
  state.deckPad = null;
  if (state.inking) await mountInk(stage, img);
}

/** Mount the ink layer over the rendered page, in page pixel coordinates. */
async function mountInk(stage, img) {
  const deck = state.deck;
  if (!img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });

  let strokes = [];
  try {
    const got = await api(`/api/sessions/${state.session.id}/decks/${deck.id}/annotations/${state.page}`);
    strokes = got.strokes || [];
  } catch { /* first time on this page */ }

  const host = document.createElement('div');
  host.className = 'sketch';
  stage.append(host);

  state.deckPad = new SketchPad({
    container: host,
    width: deck.pageW,
    height: deck.pageH,
    strokes,
    toolbar: false,
    onChange: () => saveAnnotation(),
  });
}

const saveAnnotation = debounce(async () => {
  if (!state.deckPad || !state.deck) return;
  const deck = state.deck;
  const page = state.page;
  const base = `/api/sessions/${state.session.id}/decks/${deck.id}/annotations/${page}`;
  try {
    await fetch(base, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state.deckPad.getStrokes()),
    });
    if (!state.deckPad.isEmpty) {
      // The export wants page+ink flattened; only the browser can composite it.
      const png = await state.deckPad.toFlatBlob();
      await fetch(`${base}/png`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: png });
    }
    const data = await api(`/api/sessions/${state.session.id}`);
    state.session = data.session;
  } catch (err) { toast(err.message, 'bad'); }
}, 900);

el.pagePrev.addEventListener('click', () => showPage(state.page - 1));
el.pageNext.addEventListener('click', () => showPage(state.page + 1));

el.inkToggle.addEventListener('click', () => {
  state.inking = !state.inking;
  el.inkToggle.setAttribute('aria-pressed', String(state.inking));
  showPage(state.page);
});

function pinSlide() {
  if (!state.deck) { toast('Add a slide deck first.', 'warn'); return; }
  const block = state.editor.insert({
    type: 'slide-ref', deck: state.deck.id, page: state.page,
    deckName: state.deck.name, md: '',
  });
  state.editor.focus(block.id, 0);
}
el.pinSlide.addEventListener('click', pinSlide);

/* ──────────────────────────────────────────────────────────  materials  ── */

/* Handouts and readings. Each is uploaded on its own so one bad file does not
   sink a folder of good ones, and the list repaints after every upload so a
   twenty-file folder visibly fills in rather than appearing all at once. */

const MAT_KIND = { pdf: 'PDF', office: 'DOC', text: 'TEXT', image: 'IMG', other: 'FILE' };
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function paintMaterials() {
  const mats = state.session?.materials || [];
  el.matList.textContent = '';
  el.matCount.textContent = mats.length ? `${mats.length} file${mats.length === 1 ? '' : 's'}` : '';
  if (!mats.length && !state.matUploading) { el.matList.append(el.matEmpty); el.matEmpty.hidden = false; return; }
  const sorted = mats.slice().sort((a, b) => (a.relPath || a.name).localeCompare(b.relPath || b.name));
  for (const m of sorted) el.matList.append(materialRow(m));
  if (state.matUploading) {
    const busy = document.createElement('div');
    busy.className = 'mat mat--busy';
    busy.innerHTML = `<div class="mat__row"><span class="mat__name">${state.matUploading}</span></div><div class="mat__meta">uploading…</div>`;
    el.matList.append(busy);
  }
}

function materialRow(m) {
  const row = document.createElement('div');
  row.className = `mat${m.problem ? ' mat--bad' : ''}`;

  const top = document.createElement('div');
  top.className = 'mat__row';
  const name = document.createElement('span');
  name.className = 'mat__name';
  const dirPart = (m.relPath || '').includes('/') ? `${m.relPath.slice(0, m.relPath.lastIndexOf('/') + 1)}` : '';
  const link = document.createElement('a');
  // A browser can show a PDF rendition inline where it would only download a .docx.
  link.href = `/api/sessions/${state.session.id}/materials/${m.id}/file${m.pdfFile && m.kind !== 'pdf' ? '?as=pdf' : ''}`;
  link.target = '_blank'; link.rel = 'noopener';
  link.textContent = m.name;
  link.title = 'Open';
  if (dirPart) { const d = document.createElement('span'); d.className = 'mat__dir'; d.textContent = dirPart; name.append(d); }
  name.append(link);
  const kind = document.createElement('span');
  kind.className = 'mat__kind'; kind.textContent = MAT_KIND[m.kind] || 'FILE';
  const x = document.createElement('button');
  x.type = 'button'; x.className = 'mat__x'; x.textContent = '×'; x.title = 'Remove from this lecture';
  x.addEventListener('click', async () => {
    if (!confirm(`Remove "${m.name}" from this lecture?\n\nThe file is deleted from the notebook's copy. Your original is untouched.`)) return;
    try {
      await api(`/api/sessions/${state.session.id}/materials/${m.id}`, { method: 'DELETE' });
      state.session.materials = (state.session.materials || []).filter((y) => y.id !== m.id);
      paintMaterials();
    } catch (err) { toast(err.message, 'bad'); }
  });
  top.append(name, kind, x);

  const meta = document.createElement('div');
  meta.className = 'mat__meta';
  const bits = [fmtBytes(m.bytes)];
  if (m.pages) bits.push(`${m.pages} page${m.pages === 1 ? '' : 's'}`);
  if (m.hasText) bits.push(`${m.words.toLocaleString()} words`);
  else if (m.kind !== 'image') bits.push('no text');
  meta.textContent = bits.join(' · ');

  const note = document.createElement('input');
  note.className = 'mat__note'; note.type = 'text'; note.maxLength = 500;
  note.placeholder = 'Why this is here — "ch. 6, set reading for A1"';
  note.value = m.note || '';
  note.addEventListener('change', async () => {
    try {
      const { material } = await api(`/api/sessions/${state.session.id}/materials/${m.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: note.value }),
      });
      Object.assign(m, material);
    } catch (err) { toast(err.message, 'bad'); }
  });

  row.append(top, meta);
  if (m.problem) { const p = document.createElement('div'); p.className = 'mat__problem'; p.textContent = m.problem; row.append(p); }
  row.append(note);
  return row;
}

async function uploadMaterials(files) {
  if (!state.session) return;
  const list = [...files].filter((f) => f.size > 0 && !f.name.startsWith('.'));
  if (!list.length) return;
  const sessionId = state.session.id;
  let ok = 0;
  for (const f of list) {
    if (state.session?.id !== sessionId) break; // the student moved on; don't file into the wrong lecture
    const rel = f.webkitRelativePath || '';
    state.matUploading = rel || f.name;
    paintMaterials();
    try {
      const { material } = await api(
        `/api/sessions/${sessionId}/materials?name=${encodeURIComponent(f.name)}&path=${encodeURIComponent(rel)}`,
        { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: f },
      );
      state.session.materials = [...(state.session.materials || []), material];
      ok += 1;
    } catch (err) { toast(`${f.name}: ${err.message}`, 'bad'); }
    state.matUploading = null;
    paintMaterials();
  }
  if (ok) toast(`${ok} file${ok === 1 ? '' : 's'} added to this lecture.`, 'ok');
}

el.addMaterials.addEventListener('click', () => el.matInput.click());
el.addMaterialFolder.addEventListener('click', () => el.matFolderInput.click());
for (const input of [el.matInput, el.matFolderInput]) {
  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = '';
    await uploadMaterials(files);
  });
}

// Dropping onto the Materials pane. A dropped folder arrives as directory
// entries, which have to be walked; a dropped set of files is just files.
el.paneMaterials.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault(); el.matList.classList.add('is-dropping');
});
el.paneMaterials.addEventListener('dragleave', () => el.matList.classList.remove('is-dropping'));
el.paneMaterials.addEventListener('drop', async (e) => {
  el.matList.classList.remove('is-dropping');
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  const files = await filesFromDrop(e.dataTransfer);
  await uploadMaterials(files);
});

async function filesFromDrop(dt) {
  const items = [...(dt.items || [])];
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      // webkitRelativePath is read-only on a dropped File, so carry the path alongside.
      Object.defineProperty(file, 'webkitRelativePath', { value: prefix ? `${prefix}/${file.name}` : '', configurable: true });
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries returns in batches of up to 100; keep going until it is empty.
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
  }
  for (const entry of entries) await walk(entry, '');
  return out;
}

/* ─────────────────────────────────────────────────────────────  export  ── */

el.exportBtn.addEventListener('click', async () => {
  if (!state.session) return;
  el.exportBtn.disabled = true;
  el.exportBtn.textContent = 'Building…';
  try {
    await flushSaves();
    const result = await api(`/api/sessions/${state.session.id}/export`, { method: 'POST' });
    showExport(result);
  } catch (err) { toast(err.message, 'bad'); }
  el.exportBtn.disabled = false;
  el.exportBtn.textContent = 'Build note bundle';
});

function showExport({ dir, prompt, files, stats }) {
  el.exportSheet.hidden = false;
  el.exportBody.innerHTML = '';

  const intro = document.createElement('div');
  intro.className = 'card';
  intro.innerHTML = `<h3>Ready for Claude</h3>
    <p>Everything from this lecture — transcript, your notes, sketches, screenshots, annotated slides${stats.materialsExported ? `, ${stats.materialsExported} handout${stats.materialsExported === 1 ? '' : 's'}/reading${stats.materialsExported === 1 ? '' : 's'}` : ''}${stats.moduleNotesExported ? ' and your module notes as reference material' : ''} — is in one folder. Paste this into Claude Code to turn it into a proper lecture note.</p>`;
  const pre = document.createElement('pre');
  pre.className = 'term prompt';
  pre.textContent = prompt;
  const copy = document.createElement('button');
  copy.className = 'btn'; copy.type = 'button'; copy.textContent = 'Copy prompt';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(prompt); toast('Prompt copied.', 'ok'); }
    catch { toast('Could not reach the clipboard.', 'bad'); }
  });
  intro.append(pre, copy);
  el.exportBody.append(intro);

  if (stats.pendingRecordings?.length) {
    const wait = document.createElement('div');
    wait.className = 'card';
    wait.innerHTML = `<div class="card__row"><h3>Still transcribing</h3><span class="state state--warn">${stats.pendingRecordings.length} recording(s)</span></div>
      <p>This bundle has no transcript for them yet. Build it again once the queue finishes and the transcript will be included.</p>`;
    el.exportBody.append(wait);
  }

  const detail = document.createElement('div');
  detail.className = 'card';
  const bits = [
    `${stats.recordings} recording(s)`, `${stats.segments} transcript lines`,
    `${stats.blocks} note blocks`, `${stats.slidesExported} deck(s)`,
    `${stats.annotatedPagesExported} annotated page(s)`,
    `${stats.imagesExported} screenshot(s)`, `${stats.sketchesExported} sketch(es)`,
    `${stats.materialsExported} reference document(s)`,
  ];
  if (stats.module) bits.push(`module: ${stats.module}`);
  detail.innerHTML = `<div class="card__row"><h3>Bundle contents</h3><span class="state state--ok">built</span></div>
    <p>${bits.join(' · ')}</p>
    <p class="hint">${dir}</p>`;
  const list = document.createElement('ul');
  list.className = 'filelist';
  for (const f of files) { const li = document.createElement('li'); li.textContent = f; list.append(li); }
  detail.append(list);
  el.exportBody.append(detail);

  if (stats.warnings?.length) {
    const warn = document.createElement('div');
    warn.className = 'card';
    warn.innerHTML = '<h3>Worth knowing</h3>';
    const ul = document.createElement('ul');
    ul.className = 'steps';
    for (const w of stats.warnings) { const li = document.createElement('li'); li.textContent = w; ul.append(li); }
    warn.append(ul);
    el.exportBody.append(warn);
  }
}
$$('[data-close-export]').forEach((n) => n.addEventListener('click', () => { el.exportSheet.hidden = true; }));

/* ──────────────────────────────────────────────────────────────  setup  ── */

async function refreshStatus() {
  const data = await api('/api/status');
  state.env = data.env;
  state.settings = state.settings || data.settings;
  state.recommended = data.recommendedModel;
  state.effectiveModel = data.effectiveModel;
  paintSetupChip();
  paintDevices();
  return data;
}

function paintSetupChip() {
  const env = state.env;
  const missing = [];
  if (!env.ffmpeg.ok) missing.push('ffmpeg');
  if (!env.whisper.ok) missing.push('whisper.cpp');
  if (!env.anyModel) missing.push('a model');
  el.setupDot.className = 'chip__dot';
  if (missing.length) { el.setupDot.classList.add('is-bad'); el.setupLabel.textContent = `Setup — needs ${missing.join(', ')}`; }
  else if (state.effectiveModel !== state.settings?.transcribeModel) {
    el.setupDot.classList.add('is-warn');
    el.setupLabel.textContent = `Using ${state.effectiveModel}`;
  } else if (!env.slidesReady) { el.setupDot.classList.add('is-warn'); el.setupLabel.textContent = 'Setup — no slide support'; }
  else { el.setupDot.classList.add('is-ok'); el.setupLabel.textContent = `Setup — ${state.effectiveModel}`; }
  if (!state.recording) el.recBtn.disabled = !env.ready || !state.session || Boolean(state.session?.archivedAt);
}

function paintDevices() {
  const usable = (state.env.devices || []).filter((d) => !d.unusable);
  el.deviceSelect.innerHTML = '';
  for (const d of usable) {
    const o = document.createElement('option');
    o.value = String(d.index);
    o.textContent = d.loopback ? `${d.name} — system audio` : d.name;
    el.deviceSelect.append(o);
  }
  const loop = usable.find((d) => d.loopback);
  if (loop) el.deviceSelect.value = String(loop.index);
}

el.setupBtn.addEventListener('click', openSetup);
$$('[data-close-sheet]').forEach((n) => n.addEventListener('click', () => { el.setupSheet.hidden = true; }));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!el.sketchModal.hidden) closeSketch();
  else if (!el.exportSheet.hidden) el.exportSheet.hidden = true;
  else if (!el.queueSheet.hidden) el.queueSheet.hidden = true;
  else if (!el.setupSheet.hidden) el.setupSheet.hidden = true;
  else closeOutline();
});

// ⌘S is muscle memory; it should mean "flush now", not "save the web page".
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); flushSaves(); }
});

async function openSetup() {
  el.setupSheet.hidden = false;
  await refreshStatus();
  paintSetup();
}

function paintSetup() {
  const env = state.env;
  el.setupBody.innerHTML = '';

  el.setupBody.append(card('ffmpeg', env.ffmpeg.ok ? 'ok' : 'bad', env.ffmpeg.ok ? 'installed' : 'missing',
    env.ffmpeg.ok ? '<p>Normalises every audio source before transcription.</p>'
      : `<p>Recording needs it.</p><pre class="term">${env.ffmpeg.hint}</pre>`));

  const whisper = card('whisper.cpp', env.whisper.ok ? 'ok' : 'bad', env.whisper.ok ? (env.whisper.version || 'installed') : 'missing',
    env.whisper.ok ? `<p>Transcription runs locally on the GPU — no lecture audio leaves this Mac.</p><p class="hint">${env.whisper.path}</p>`
      : '<p>The transcription engine.</p>');
  if (!env.whisper.ok) whisper.append(installButton('/api/setup/whisper', 'Install with Homebrew'));
  el.setupBody.append(whisper);

  const models = document.createElement('div');
  models.className = 'card';
  const free = env.disk?.free;
  // A model that will not fit is the single commonest reason a download fails,
  // so the number is on screen before anyone presses Download.
  const tight = Number.isFinite(free) && free < 3 * 1073741824;
  models.innerHTML = `<div class="card__row"><h3>Transcription model</h3><span class="state state--${env.anyModel ? 'ok' : 'bad'}">${env.anyModel ? 'ready' : 'none yet'}</span></div>
    <p>Transcription runs <strong>after</strong> the lecture, in the background and at low priority — so pick for accuracy, not speed. <strong>Large v3 Turbo</strong> is the one to have.</p>
    <p class="hint">Shared with Audio Scribe: ${env.modelsDir}${Number.isFinite(free) ? ` · <span class="${tight ? 'is-tight' : ''}">${size(free)} free on this disk</span>` : ''}</p>`;
  const list = document.createElement('div');
  list.className = 'models';
  for (const m of env.models) list.append(modelRow(m, free));
  models.append(list, modelPicker());

  const parts = env.disk?.parts || [];
  if (parts.length) {
    const stale = parts.reduce((a, p) => a + p.bytes, 0);
    const box = document.createElement('div');
    box.className = 'model model--wide';
    box.innerHTML = `<div><div class="model__name">Unfinished downloads · ${size(stale)}</div>
      <div class="model__note">${parts.map((p) => `${p.model} (${size(p.bytes)})`).join(', ')} — left behind by a download that stopped partway.
      Starting that model again picks up where it left off, so only clear these if you want the space back.</div></div>`;
    const btn = document.createElement('button');
    btn.className = 'btn btn--ghost btn--sm';
    btn.type = 'button';
    btn.textContent = `Clear ${size(stale)}`;
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete ${size(stale)} of unfinished downloads?\n\nNothing you have installed is affected — but those models will have to start from the beginning next time.`)) return;
      try {
        const out = await api('/api/setup/parts', { method: 'DELETE' });
        toast(`Freed ${size(out.freed)}.`, 'ok');
        refreshStatus().then(paintSetup);
      } catch (err) { toast(err.message, 'bad'); }
    });
    box.append(btn);
    models.append(box);
  }

  el.setupBody.append(models);

  const poppler = card('Slide rendering', env.poppler.ok ? 'ok' : 'warn', env.poppler.ok ? 'ready' : 'not installed',
    env.poppler.ok
      ? `<p>PDF and PowerPoint decks render to pages you can draw on.${env.soffice.ok ? '' : ' PowerPoint needs LibreOffice as well — PDFs work now.'}</p>`
      : '<p>Without poppler you can still record and take notes, but slide decks cannot be rendered.</p>');
  if (!env.poppler.ok) poppler.append(installButton('/api/setup/poppler', 'Install poppler'));
  if (!env.soffice.ok) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.innerHTML = 'For .ppt/.pptx: <code>brew install --cask libreoffice</code>';
    poppler.append(p);
  }
  el.setupBody.append(poppler);

  const loop = card('System audio', env.loopback.ok ? 'ok' : 'warn',
    env.loopback.ok ? env.loopback.devices[0].name : 'tab audio only',
    env.loopback.ok
      ? `<p>Found <strong>${env.loopback.devices.map((d) => d.name).join(', ')}</strong>. Pick it as the input device to record any app.</p>`
      : `<p>Chrome shares the audio of any <strong>browser tab</strong> — enough for a lecture on Teams, Meet or Zoom in a tab, or a recorded lecture on YouTube.</p>
         <p>For an in-person lecture, choose <strong>Audio input device → MacBook Pro Microphone</strong>. To capture the Teams or Zoom desktop apps, install a loopback device:</p>
         <pre class="term">brew install --cask blackhole-2ch</pre>`);
  el.setupBody.append(loop);
}

function card(title, s, stateText, body) {
  const node = document.createElement('div');
  node.className = 'card';
  node.innerHTML = `<div class="card__row"><h3>${title}</h3><span class="state state--${s}">${stateText}</span></div>${body}`;
  return node;
}

function installButton(url, label) {
  const wrap = document.createElement('div');
  const btn = document.createElement('button');
  btn.className = 'btn'; btn.type = 'button'; btn.textContent = label;
  const out = document.createElement('pre'); out.className = 'term'; out.hidden = true;
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'Installing…';
    out.hidden = false; out.textContent = '';
    try {
      await streamPost(url, (e) => {
        if (e.type === 'log') { out.textContent += `${e.line}\n`; out.scrollTop = out.scrollHeight; }
        if (e.type === 'done') {
          toast(e.ok ? 'Installed.' : 'Install failed — see the log.', e.ok ? 'ok' : 'bad');
          refreshStatus().then(paintSetup);
        }
      });
    } catch (err) {
      toast(err.message, 'bad');
      btn.disabled = false; btn.textContent = label;
    }
  });
  wrap.append(btn, out);
  return wrap;
}

function modelRow(m, free = null) {
  const row = document.createElement('div');
  row.className = 'model';
  const part = (state.env.disk?.parts || []).find((p) => p.model === m.id);
  const badges = [
    m.size,
    m.shared ? 'shared' : null,
    m.id === state.recommended ? 'recommended' : null,
    part && !m.installed ? `${Math.round((part.bytes / (parseFloat(m.size) * (m.size.includes('MB') ? 1048576 : 1073741824))) * 100)}% downloaded` : null,
  ].filter(Boolean);
  row.innerHTML = `<div><div class="model__name">${m.label} <span class="model__note">· ${badges.join(' · ')}</span></div>
    <div class="model__note">${m.note}</div></div>`;
  const action = document.createElement('div');

  if (m.installed) {
    const del = document.createElement('button');
    del.className = 'btn btn--ghost btn--sm'; del.type = 'button'; del.textContent = 'Remove';
    del.addEventListener('click', async () => {
      const warning = m.shared
        ? `Remove ${m.label}?\n\nThis model file is shared with Audio Scribe — deleting it here removes it there too.`
        : `Remove ${m.label}?`;
      if (!confirm(warning)) return;
      try { await api(`/api/setup/model?id=${encodeURIComponent(m.id)}`, { method: 'DELETE' }); }
      catch (err) { toast(err.message, 'bad'); }
      refreshStatus().then(paintSetup);
    });
    action.append(del);
  } else {
    const get = document.createElement('button');
    get.className = m.id === state.recommended ? 'btn btn--sm' : 'btn btn--ghost btn--sm';
    get.type = 'button';
    get.textContent = part ? 'Resume' : 'Download';
    // Rough, but enough to stop someone starting a download that cannot land.
    const needs = parseFloat(m.size) * (m.size.includes('MB') ? 1048576 : 1073741824) - (part?.bytes || 0);
    if (Number.isFinite(free) && free < needs) {
      get.disabled = true;
      get.textContent = 'No room';
      get.title = `${m.label} needs about ${size(needs)} more and only ${size(free)} is free.`;
    }
    const bar = document.createElement('div');
    bar.className = 'model__bar'; bar.hidden = true;
    bar.innerHTML = '<i></i>';
    get.addEventListener('click', async () => {
      get.disabled = true; get.textContent = '0%'; bar.hidden = false;
      const fill = bar.querySelector('i');
      try {
        await streamPost(`/api/setup/model?id=${encodeURIComponent(m.id)}`, (e) => {
          if (e.type === 'progress') {
            const pct = Math.round((e.progress || 0) * 100);
            fill.style.width = `${pct}%`; get.textContent = `${pct}%`;
          }
          if (e.type === 'done') {
            toast(e.ok ? `${m.label} ready.` : (e.error || 'Download failed.'), e.ok ? 'ok' : 'bad');
            refreshStatus().then(paintSetup);
          }
        });
      } catch (err) {
        toast(err.message, 'bad');
        get.disabled = false; get.textContent = 'Download';
      }
    });
    action.append(get);
    row.append(bar);
  }
  row.insertBefore(action, row.children[1] || null);
  return row;
}

/** Which model transcribes, and whether a rough live preview runs at all. */
function modelPicker() {
  const wrap = document.createElement('div');
  wrap.className = 'model model--wide';
  const installed = state.env.models.filter((m) => m.installed);
  wrap.innerHTML = '<div><div class="model__name">Which model transcribes</div><div class="model__note">This is the one that produces the transcript you keep.</div></div>';

  const controls = document.createElement('div');
  controls.className = 'model__controls';

  const main = document.createElement('select');
  main.className = 'mini';
  for (const m of installed) main.add(new Option(m.label, m.id));
  if (!installed.some((m) => m.id === state.settings.transcribeModel)) {
    main.add(new Option(`${state.settings.transcribeModel} (not downloaded)`, state.settings.transcribeModel));
  }
  main.value = state.settings.transcribeModel;
  main.addEventListener('change', () => saveSettings({ transcribeModel: main.value }).then(() => refreshStatus()));

  const liveWrap = document.createElement('label');
  liveWrap.className = 'checkline';
  const live = document.createElement('input');
  live.type = 'checkbox';
  live.checked = !!state.settings.liveTranscribe;
  live.addEventListener('change', () => saveSettings({ liveTranscribe: live.checked }));
  const liveText = document.createElement('span');
  liveText.innerHTML = 'Also show a rough live transcript while recording <span class="model__note">— costs CPU during the lecture; the kept transcript is unaffected.</span>';
  liveWrap.append(live, liveText);

  controls.append(main, liveWrap);
  wrap.append(controls);
  return wrap;
}

async function saveSettings(patch) {
  try {
    const { settings } = await api('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
    });
    state.settings = settings;
    return settings;
  } catch (err) { toast(err.message, 'bad'); return null; }
}

/* ────────────────────────────────────────────────────────────────  boot  ── */

window.addEventListener('beforeunload', (e) => {
  if (state.recording) { e.preventDefault(); e.returnValue = ''; }
});

(async function boot() {
  buildMeter();
  paintMeter(0);
  el.timecode.innerHTML = longTime(0);
  showTab('transcript');
  showView('empty');

  try {
    const data = await api('/api/status');
    state.env = data.env;
    state.settings = data.settings;
    state.recommended = data.recommendedModel;
    state.effectiveModel = data.effectiveModel;
    state.queue = data.queue || state.queue;
    paintSetupChip();
    paintDevices();
    paintQueue();
    if (!data.env.ready) openSetup();
  } catch (err) {
    toast(`Could not reach the server: ${err.message}`, 'bad');
  }

  openJobStream();
  await loadLibrary();

  const hash = location.hash.match(/^#([sm])=([\w-]+)$/);
  if (hash && hash[1] === 'm') await openModule(hash[2]).catch(() => showView('empty'));
  else if (hash) await openSession(hash[2]).catch(() => showView('empty'));
  else if (state.sessions.length) await openSession(state.sessions[0].id).catch(() => showView('empty'));
  else if (state.modules.length) await openModule(state.modules[0].id).catch(() => showView('empty'));
})();
