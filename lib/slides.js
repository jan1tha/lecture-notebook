import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TMP_DIR } from './config.js';

const execFileP = promisify(execFile);
const pad3 = (n) => String(n).padStart(3, '0');

const SOURCE_TYPES = { '.pdf': 'pdf', '.ppt': 'ppt', '.pptx': 'pptx', '.odp': 'odp' };

// LibreOffice/poppler aren't always symlinked onto PATH (esp. Homebrew casks),
// so try the bare command first and fall back to the well-known install paths.
const SOFFICE_CANDIDATES = ['soffice', '/opt/homebrew/bin/soffice', '/usr/local/bin/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'];
const PDFTOPPM_CANDIDATES = ['pdftoppm', '/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm'];
const PDFTOTEXT_CANDIDATES = ['pdftotext', '/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext'];
const PDFINFO_CANDIDATES = ['pdfinfo', '/opt/homebrew/bin/pdfinfo', '/usr/local/bin/pdfinfo'];

const binaryCache = new Map();

/** Resolve the first candidate that's actually on this machine, and remember it. */
async function findBinary(candidates) {
  const key = candidates[0];
  if (binaryCache.has(key)) return binaryCache.get(key);
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileP('command', ['-v', candidate], { shell: '/bin/bash' });
      const resolved = stdout.trim();
      if (resolved) { binaryCache.set(key, resolved); return resolved; }
    } catch { /* keep looking */ }
  }
  binaryCache.set(key, null);
  return null;
}

const sofficeBinary = () => findBinary(SOFFICE_CANDIDATES);
const pdftoppmBinary = () => findBinary(PDFTOPPM_CANDIDATES);
const pdftotextBinary = () => findBinary(PDFTOTEXT_CANDIDATES);
const pdfinfoBinary = () => findBinary(PDFINFO_CANDIDATES);

export const hasSoffice = () => sofficeBinary().then(Boolean);
export const hasPoppler = () => pdftoppmBinary().then(Boolean);

/**
 * Convert an uploaded deck into a rendered deck folder.
 * @param {Buffer} buffer      the uploaded file bytes
 * @param {string} originalName e.g. "Week4-STP.pptx"
 * @param {string} dir         absolute deck dir to populate (already exists or create it)
 * @param {object} opts        { dpi = 140, onProgress }
 *   onProgress is called with:
 *     { phase: 'convert' }                        // pptx -> pdf running
 *     { phase: 'probe', pages }                   // page count known
 *     { phase: 'page', page, pages }              // after each page renders
 * @returns deck descriptor object (see below)
 */
export async function ingestDeck(buffer, originalName, dir, opts = {}) {
  const { dpi = 140, onProgress } = opts;

  const pagesDir = path.join(dir, 'pages');
  const textDir = path.join(dir, 'text');
  fs.mkdirSync(pagesDir, { recursive: true });
  fs.mkdirSync(textDir, { recursive: true });

  const rawExt = path.extname(originalName || '');
  const ext = rawExt.toLowerCase();
  if (ext === '.key') {
    throw new Error('Keynote files (.key) are not supported — LibreOffice cannot open them. Export the deck to PDF or PPTX from Keynote and upload that instead.');
  }
  const sourceType = SOURCE_TYPES[ext];
  if (!sourceType) {
    throw new Error(`Unsupported file type "${rawExt || '(none)'}". Upload a PDF, PPT, PPTX, or ODP.`);
  }

  const sourcePath = path.join(dir, `source${rawExt}`);
  fs.writeFileSync(sourcePath, buffer);

  const originalPdfPath = path.join(dir, 'original.pdf');
  if (sourceType === 'pdf') {
    fs.copyFileSync(sourcePath, originalPdfPath);
  } else {
    await convertToPdf(sourcePath, dir, originalName, onProgress);
  }

  const pages = await probePageCount(originalPdfPath);
  onProgress?.({ phase: 'probe', pages });

  // A re-ingest (e.g. re-rendering at a different dpi) must not leave stale
  // pages from a previous run lying around next to the fresh ones.
  fs.rmSync(pagesDir, { recursive: true, force: true });
  fs.rmSync(textDir, { recursive: true, force: true });
  fs.mkdirSync(pagesDir, { recursive: true });
  fs.mkdirSync(textDir, { recursive: true });

  await renderPages(originalPdfPath, pagesDir, dir, pages, dpi, onProgress);
  const hasText = await extractText(originalPdfPath, textDir, pages);

  const { width: pageW, height: pageH } = readPngSize(pagePath(dir, 1));

  const deck = {
    id: path.basename(dir),
    name: originalName,
    sourceType,
    pages,
    dpi,
    pageW,
    pageH,
    createdAt: Date.now(),
    hasText,
  };
  writeAtomic(path.join(dir, 'deck.json'), JSON.stringify(deck, null, 2));
  return deck;
}

export function readDeck(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'deck.json'), 'utf8')); }
  catch { return null; }
}

export function pagePath(dir, n) {
  return path.join(dir, 'pages', `page-${pad3(n)}.png`);
}

/* --------------------------------------------------------------- helpers */

async function convertToPdf(sourcePath, dir, originalName, onProgress) {
  const soffice = await sofficeBinary();
  if (!soffice) throw new Error('LibreOffice (soffice) is not installed. It is required to convert PPT/PPTX/ODP files to PDF.');

  // A running LibreOffice GUI (or a second concurrent conversion) will collide
  // over the default user profile lock, so each conversion gets its own.
  const profileDir = path.join(TMP_DIR, `soffice-profile-${crypto.randomUUID()}`);
  const outDir = path.join(TMP_DIR, `soffice-out-${crypto.randomUUID()}`);
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  try {
    onProgress?.({ phase: 'convert' });
    try {
      await execFileP(soffice, [
        '--headless', '--norestore',
        `-env:UserInstallation=file://${profileDir}`,
        '--convert-to', 'pdf',
        '--outdir', outDir,
        sourcePath,
      ], { timeout: 120_000, killSignal: 'SIGKILL' });
    } catch (err) {
      if (err.killed) throw new Error(`Converting "${originalName}" to PDF timed out after 2 minutes.`);
      throw new Error(`Could not convert "${originalName}" to PDF: ${firstLine(err.stderr || err.message)}`);
    }

    const produced = fs.readdirSync(outDir).find((f) => f.endsWith('.pdf'));
    if (!produced) throw new Error(`LibreOffice did not produce a PDF for "${originalName}".`);
    fs.copyFileSync(path.join(outDir, produced), path.join(dir, 'original.pdf'));
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

async function probePageCount(pdfPath) {
  const pdfinfo = await pdfinfoBinary();
  if (!pdfinfo) throw new Error('poppler (pdfinfo) is not installed. It is required to read slide decks.');
  let stdout;
  try {
    ({ stdout } = await execFileP(pdfinfo, [pdfPath], { timeout: 30_000 }));
  } catch {
    throw new Error('Could not read that file as a slide deck.');
  }
  const pages = parseInt((stdout.match(/^Pages:\s+(\d+)/m) || [])[1] || '0', 10);
  if (!pages) throw new Error('Could not read that file as a slide deck.');
  return pages;
}

async function renderPages(pdfPath, pagesDir, dir, pages, dpi, onProgress) {
  const pdftoppm = await pdftoppmBinary();
  if (!pdftoppm) throw new Error('poppler (pdftoppm) is not installed. It is required to render slide images.');

  for (let n = 1; n <= pages; n++) {
    // pdftoppm's zero-pad width depends on the -f/-l range, not a fixed digit
    // count, so we render one page per call under a page-unique prefix and
    // rename whatever it produced rather than guess the padding.
    const prefix = path.join(pagesDir, `render${n}`);
    try {
      await execFileP(pdftoppm, ['-png', '-r', String(dpi), '-f', String(n), '-l', String(n), pdfPath, prefix],
        { timeout: 30_000, killSignal: 'SIGKILL' });
    } catch (err) {
      if (err.killed) throw new Error(`Rendering page ${n} of ${pages} timed out.`);
      throw new Error(`Could not render page ${n}: ${firstLine(err.stderr || err.message)}`);
    }
    const produced = fs.readdirSync(pagesDir).find((f) => f.startsWith(`render${n}-`) && f.endsWith('.png'));
    if (!produced) throw new Error(`pdftoppm produced no image for page ${n}.`);
    fs.renameSync(path.join(pagesDir, produced), pagePath(dir, n));
    onProgress?.({ phase: 'page', page: n, pages });
  }
}

async function extractText(pdfPath, textDir, pages) {
  const pdftotext = await pdftotextBinary();
  let hasText = false;
  for (let n = 1; n <= pages; n++) {
    let text = '';
    if (pdftotext) {
      try {
        const { stdout } = await execFileP(pdftotext, ['-layout', '-f', String(n), '-l', String(n), pdfPath, '-'],
          { timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 20 * 1024 * 1024 });
        text = stdout;
      } catch {
        // A single page's text failing to extract shouldn't sink the whole ingest.
        text = '';
      }
    }
    fs.writeFileSync(path.join(textDir, `page-${pad3(n)}.txt`), text);
    if (text.trim()) hasText = true;
  }
  return hasText;
}

/** Read a PNG's pixel size straight from its IHDR chunk — no image library needed. */
function readPngSize(pngPath) {
  const fd = fs.openSync(pngPath, 'r');
  try {
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    // 8-byte PNG signature + 4-byte chunk length + 4-byte "IHDR" tag, then
    // width/height as big-endian uint32s.
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

function writeAtomic(file, contents) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

const firstLine = (s) => String(s || '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
