import fs from 'node:fs';
import path from 'node:path';
import { sessionDir, assertId, newId } from './store.js';
import { convertToPdf, probePageCount, pdfToText } from './slides.js';

/*
 * Materials are the handouts, readings and textbook extracts that go with a
 * lecture: anything the lecturer gave out or told the student to read that is
 * not the slide deck. They fill the "Reference documents" slot in the export,
 * next to the module notes.
 *
 * A material is stored as the untouched original plus whatever we could make
 * of it: a PDF rendition for office documents (so the skill can read it page
 * by page) and a plain-text extraction (so it can be searched and quoted
 * cheaply). Nothing here is required to succeed for the upload to succeed —
 * a file we cannot read is still filed, copied into the bundle and listed in
 * the manifest. The student put it there for a reason.
 */

export const materialsDir = (id) => path.join(sessionDir(id), 'materials');
export const materialDir = (id, mid) => path.join(materialsDir(id), assertId(mid, 'material id'));

const KINDS = {
  '.pdf': 'pdf',
  '.doc': 'office', '.docx': 'office', '.odt': 'office', '.rtf': 'office', '.pages': 'office',
  '.ppt': 'office', '.pptx': 'office', '.odp': 'office', '.key': 'office',
  '.xls': 'office', '.xlsx': 'office', '.ods': 'office', '.numbers': 'office',
  '.md': 'text', '.markdown': 'text', '.txt': 'text', '.csv': 'text', '.json': 'text',
  '.html': 'text', '.htm': 'text',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image',
  '.heic': 'image', '.tif': 'image', '.tiff': 'image', '.bmp': 'image',
};
// LibreOffice has no filter for these; say so instead of failing obscurely.
const UNCONVERTIBLE = new Set(['.pages', '.key', '.numbers']);

export const MAX_MATERIAL_BYTES = 200 * 1024 * 1024;

/**
 * Keep a folder upload's structure, but only the safe part of it: no leading
 * slashes, no `..`, no characters that are awkward on disk or in markdown.
 * "Week 4/Readings/Chapter 6.pdf" -> "Week-4/Readings/Chapter-6.pdf".
 */
export function safeRelPath(relPath, fallbackName) {
  const parts = String(relPath || fallbackName || 'file')
    .split(/[\\/]+/)
    .map((p) => p.trim())
    .filter((p) => p && p !== '.' && p !== '..')
    .map((p) => p.replace(/[^\w.\- ()]+/g, '').replace(/\s+/g, '-').replace(/^\.+/, '').slice(0, 120))
    .filter(Boolean);
  if (!parts.length) return 'file';
  return parts.join('/');
}

const wordCount = (text) => (String(text || '').match(/\S+/g) || []).length;

/**
 * File one uploaded material under a lecture.
 * @param {Buffer} buffer       the bytes
 * @param {string} originalName "Chapter 6.pdf"
 * @param {string} relPath      "Readings/Chapter 6.pdf" from a folder upload, or '' for a single file
 * @param {string} dir          the material's own directory (created here)
 */
export async function ingestMaterial(buffer, originalName, relPath, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const name = path.basename(String(originalName || relPath || 'file'));
  const rawExt = path.extname(name);
  const ext = rawExt.toLowerCase();
  const kind = KINDS[ext] || 'other';

  // The original is kept byte-for-byte under its own extension; `original`
  // rather than the real name so a path is never built from user input here.
  const originalFile = `original${ext.replace(/[^a-z0-9.]/g, '')}`;
  fs.writeFileSync(path.join(dir, originalFile), buffer);

  const material = {
    id: path.basename(dir),
    name,
    relPath: safeRelPath(relPath, name),
    ext,
    kind,
    bytes: buffer.length,
    originalFile,
    pdfFile: null,      // a PDF rendition: the original for a PDF, converted.pdf for office files
    pages: null,
    hasText: false,
    words: 0,
    note: '',           // the student's one line on what this is / why it matters
    problem: null,      // why we could not read it, in plain words, if we could not
    createdAt: Date.now(),
  };

  try {
    if (kind === 'pdf') {
      material.pdfFile = originalFile;
    } else if (kind === 'office') {
      if (UNCONVERTIBLE.has(ext)) {
        material.problem = `${rawExt} files cannot be converted here — export it to PDF from the app that made it and upload that instead. The file is kept and will still be in the bundle.`;
      } else {
        // convertToPdf writes <dir>/original.pdf; keep the name honest.
        await convertToPdf(path.join(dir, originalFile), dir, name);
        fs.renameSync(path.join(dir, 'original.pdf'), path.join(dir, 'converted.pdf'));
        material.pdfFile = 'converted.pdf';
      }
    } else if (kind === 'text') {
      const text = ext === '.html' || ext === '.htm' ? stripHtml(buffer.toString('utf8')) : buffer.toString('utf8');
      writeText(dir, text, material);
    }

    if (material.pdfFile) {
      const pdfPath = path.join(dir, material.pdfFile);
      try { material.pages = await probePageCount(pdfPath); } catch { material.pages = null; }
      writeText(dir, await pdfToText(pdfPath), material);
      if (!material.hasText) {
        material.problem = material.pages
          ? 'No text could be extracted — it is probably a scanned document. The PDF is still in the bundle and can be read page by page.'
          : 'poppler is not installed, so the page count and text could not be read. The file is still in the bundle.';
      }
    }
  } catch (err) {
    // A conversion failure is information for the student, not a reason to
    // lose the file.
    material.problem = err.message;
  }

  writeAtomic(path.join(dir, 'material.json'), JSON.stringify(material, null, 2));
  return material;
}

function writeText(dir, text, material) {
  const t = String(text || '');
  fs.writeFileSync(path.join(dir, 'text.txt'), t);
  material.hasText = t.trim().length > 0;
  material.words = wordCount(t);
}

/** Good enough to make a saved web page quotable; not a parser. */
function stripHtml(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function readMaterial(id, mid) {
  try { return JSON.parse(fs.readFileSync(path.join(materialDir(id, mid), 'material.json'), 'utf8')); }
  catch { return null; }
}

export function materialText(id, mid) {
  try { return fs.readFileSync(path.join(materialDir(id, mid), 'text.txt'), 'utf8'); }
  catch { return ''; }
}

export function materialFile(id, mid, which = 'original') {
  const m = readMaterial(id, mid);
  if (!m) return null;
  const file = which === 'pdf' ? m.pdfFile : m.originalFile;
  return file ? path.join(materialDir(id, mid), file) : null;
}

export function deleteMaterial(id, mid) {
  fs.rmSync(materialDir(id, mid), { recursive: true, force: true });
}

export const newMaterialId = () => newId('m');

function writeAtomic(file, contents) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}
