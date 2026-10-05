/* Modules — the folder a lecture belongs to.

   A module is more than a label on a lecture. It is where the things that are
   true all term live: the assessments, the lecturer, and the student's own
   running notes on the subject — the reading, the framework they keep
   forgetting, the question they want to ask next week. Those notes are the
   same block document the lecture notebook uses, so the same editor edits
   them and the same exporter can carry them into a bundle.

   On disk each module is a directory, exactly like a session:
     data/modules/<id>/module.json   meta
     data/modules/<id>/notes.json    the block document
     data/modules/<id>/assets/       images and sketches pasted into them */

import fs from 'node:fs';
import path from 'node:path';
import { MODULES_DIR } from './config.js';
import {
  assertId, newId, writeAtomic, normaliseAssessments,
  emptyDoc, saveDocChecked, readDocAt, writeAssetIn, writeNamedAssetIn, assetPathIn,
} from './store.js';

// Enough to tell six modules apart at a glance in the library, no more.
const COLOURS = ['indigo', 'teal', 'amber', 'rose', 'violet', 'lime'];

export const moduleDir = (id) => path.join(MODULES_DIR, assertId(id, 'module id'));
const metaPath = (id) => path.join(moduleDir(id), 'module.json');
const notesPath = (id) => path.join(moduleDir(id), 'notes.json');
export const moduleAssetsDir = (id) => path.join(moduleDir(id), 'assets');

/* ------------------------------------------------------------------ meta */

export function readModule(id) {
  try { return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')); } catch { return null; }
}

export function listModules() {
  let ids = [];
  try { ids = fs.readdirSync(MODULES_DIR); } catch { return []; }
  return ids
    .map((d) => { try { return readModule(d); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export function createModule({ name, code, lecturer, assessments, colour } = {}) {
  const id = newId('m');
  const now = Date.now();
  fs.mkdirSync(moduleAssetsDir(id), { recursive: true });
  const meta = {
    id,
    name: (name || '').trim() || 'New module',
    code: (code || '').trim(),
    lecturer: (lecturer || '').trim(),
    assessments: normaliseAssessments(assessments),
    colour: COLOURS.includes(colour) ? colour : COLOURS[listModules().length % COLOURS.length],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  writeAtomic(metaPath(id), JSON.stringify(meta, null, 2));
  saveModuleNotes(id, emptyDoc());
  return meta;
}

export function updateModule(id, patch) {
  const meta = readModule(id);
  if (!meta) throw Object.assign(new Error('No such module'), { status: 404 });
  if (typeof patch.name === 'string') meta.name = patch.name.slice(0, 120).trim() || meta.name;
  if (typeof patch.code === 'string') meta.code = patch.code.slice(0, 40).trim();
  if (typeof patch.lecturer === 'string') meta.lecturer = patch.lecturer.slice(0, 120).trim();
  if (patch.assessments !== undefined) meta.assessments = normaliseAssessments(patch.assessments);
  if (COLOURS.includes(patch.colour)) meta.colour = patch.colour;
  // A finished term is the usual reason to archive a module. Its notes and its
  // lectures are untouched; the library just stops leading with it.
  if (patch.archived !== undefined) meta.archivedAt = patch.archived ? (meta.archivedAt || Date.now()) : null;
  meta.updatedAt = Date.now();
  writeAtomic(metaPath(id), JSON.stringify(meta, null, 2));
  return meta;
}

export function deleteModule(id) {
  fs.rmSync(moduleDir(id), { recursive: true, force: true });
}

/* ----------------------------------------------------------------- notes */

export const readModuleNotes = (id) => readDocAt(notesPath(id));

export function saveModuleNotes(id, doc) {
  fs.mkdirSync(moduleDir(id), { recursive: true });
  writeAtomic(notesPath(id), JSON.stringify(doc, null, 2));
  return doc;
}

export function saveModuleNotesChecked(id, body) {
  if (!readModule(id)) throw Object.assign(new Error('No such module'), { status: 404 });
  return saveDocChecked(notesPath(id), body);
}

/* ---------------------------------------------------------------- assets */

export const writeModuleAsset = (id, buffer, opts) => writeAssetIn(moduleAssetsDir(id), buffer, opts);
export const writeNamedModuleAsset = (id, name, buffer) => writeNamedAssetIn(moduleAssetsDir(id), name, buffer);
export const moduleAssetPath = (id, file) => assetPathIn(moduleAssetsDir(id), file);

export { COLOURS as MODULE_COLOURS };
