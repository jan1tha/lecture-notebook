import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readMeta,
  readNotebook,
  allTranscripts,
  exportDir,
  assetsDir,
  deckDir,
  shortTime,
} from './store.js';
import { loadSettings } from './config.js';
import { readModule, readModuleNotes, moduleAssetsDir } from './modules.js';

/* --------------------------------------------------------------- helpers */

const pad2 = (n) => String(n).padStart(2, '0');
const pad3 = (n) => String(n).padStart(3, '0');

/** "2026-08-20 09:15:00" from an epoch-ms wall-clock value — local time, no deps. */
function fmtWall(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown time';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Strip a deck's own extension and any characters that are awkward in a filename. */
function safeDeckName(name) {
  const base = String(name || 'deck').replace(/\.[A-Za-z0-9]+$/, '');
  const cleaned = base.replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '-');
  return cleaned || 'deck';
}

/** "Marketing — Week 4: STP" -> "Marketing-Week-4-STP", for use in a filename. */
function safeTitle(title) {
  const words = String(title || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.length ? words.join('-') : 'Lecture-Notes';
}

function truncate(text, n) {
  const t = String(text || '').trim();
  return t.length > n ? `${t.slice(0, n).trim()}…` : t;
}

/**
 * The editor stores an exam hint as `!! …` — a prefix chosen because it
 * round-trips through the block editor cleanly. Nothing outside this app knows
 * that convention, so it becomes a real markdown callout on the way out.
 */
const HINT_RE = /^(\s*)!!\s?/;
function mdForExport(md) {
  const raw = String(md || '').replace(/\s+$/, '');
  const hint = HINT_RE.exec(raw);
  if (!hint) return raw;
  return `${hint[1]}> **⚠️ EXAM HINT** — ${raw.slice(hint[0].length)}`;
}

/** The same content on one line, for the correlation file. */
function inlineNote(md) {
  const raw = String(md || '').trim();
  const hint = HINT_RE.exec(raw);
  const body = hint ? `⚠️ **EXAM HINT** — ${raw.slice(hint[0].length)}` : raw;
  return body.replace(/\s*\n+\s*/g, ' ¶ ');
}

/** Collapse a multi-line note body onto one correlation line without losing paragraph breaks. */
function inlineMd(md) {
  return String(md || '').trim().replace(/\s*\n+\s*/g, ' ¶ ');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/** Copy a source file into the bundle; returns true on success, false (silently) if the source is gone. */
function copyIfExists(src, dest) {
  try {
    if (!fs.statSync(src).isFile()) return false;
  } catch {
    return false;
  }
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  return true;
}

/* ------------------------------------------------------------------ main */

/**
 * Rebuild the export bundle from scratch.
 * @returns {{ dir, prompt, files: string[], stats: object }}
 */
export async function buildExport(sessionId, opts = {}) {
  const meta = readMeta(sessionId);
  if (!meta) throw new Error(`No lecture-notebook session found with id "${sessionId}". Check the session id and try again.`);

  const notebook = readNotebook(sessionId);
  const blocks = Array.isArray(notebook.blocks) ? notebook.blocks : [];
  const transcripts = allTranscripts(meta); // [{ recording, segments }], one entry per recording in meta.recordings order
  const recordingsById = new Map((meta.recordings || []).map((r) => [r.id, r]));
  const decksById = new Map((meta.decks || []).map((d) => [d.id, d]));

  const mod = meta.moduleId ? readModule(meta.moduleId) : null;
  const moduleNotes = mod ? readModuleNotes(meta.moduleId) : null;
  const moduleBlocks = Array.isArray(moduleNotes?.blocks) ? moduleNotes.blocks : [];

  const warnings = [];
  const files = []; // absolute paths of everything we actually write, in write order

  const dir = exportDir(sessionId);
  // "Rebuild from scratch" — never let a stale file from a previous export survive.
  fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);

  const write = (relPath, contents) => {
    const full = path.join(dir, relPath);
    ensureDir(path.dirname(full));
    fs.writeFileSync(full, contents);
    files.push(full);
    return full;
  };

  /* ---------------------------------------------------------- slide text */
  // Cache page-text reads: the same slide is often quoted from more than one block.
  const slideTextCache = new Map();
  function slideText(deckId, page) {
    const key = `${deckId}:${page}`;
    if (slideTextCache.has(key)) return slideTextCache.get(key);
    let text = null;
    try {
      text = fs.readFileSync(path.join(deckDir(sessionId, deckId), 'text', `page-${pad3(page)}.txt`), 'utf8');
    } catch { /* no extracted text for this page — fine, it's supplementary */ }
    slideTextCache.set(key, text);
    return text;
  }

  function deckLabel(deckId) {
    const deck = decksById.get(deckId);
    return deck ? deck.name : `(unknown deck ${deckId})`;
  }

  /* --------------------------------------------------------- slide decks */
  let slidesExported = 0;
  let annotatedExported = 0;
  for (const deck of meta.decks || []) {
    const srcDir = deckDir(sessionId, deck.id);
    const name = safeDeckName(deck.name);
    const pdfDest = path.join(dir, 'slides', `${name}.pdf`);
    if (copyIfExists(path.join(srcDir, 'original.pdf'), pdfDest)) {
      files.push(pdfDest);
      slidesExported += 1;
    } else {
      warnings.push(`Deck "${deck.name}" (${deck.id}) has no original.pdf on disk — its slide deck was not exported.`);
    }
    for (const page of deck.annotatedPages || []) {
      const src = path.join(srcDir, 'annotations', `page-${pad3(page)}.png`);
      const dest = path.join(dir, 'slides', 'annotated', `${name}-p${pad2(page)}.png`);
      if (copyIfExists(src, dest)) {
        files.push(dest);
        annotatedExported += 1;
      } else {
        warnings.push(`Deck "${deck.name}" (${deck.id}) lists page ${page} as annotated, but its composited PNG is missing.`);
      }
    }
  }

  /* -------------------------------------------------- images and sketches */
  // Only export assets a block actually references — the assets folder can accumulate orphans over a session.
  const assetExport = new Map(); // filename -> { kind, exportedTo (relative) | null, referencedBy: [] }
  for (const b of blocks) {
    if (b.type !== 'image' && b.type !== 'sketch') continue;
    if (!b.asset) { warnings.push(`Block ${b.id} is a ${b.type} block with no asset filename — skipped.`); continue; }
    if (!assetExport.has(b.asset)) assetExport.set(b.asset, { kind: b.type, exportedTo: null, referencedBy: [] });
    assetExport.get(b.asset).referencedBy.push(b.id);
  }
  for (const [asset, info] of assetExport) {
    const folder = info.kind === 'sketch' ? 'sketches' : 'images';
    const dest = path.join(dir, folder, asset);
    if (copyIfExists(path.join(assetsDir(sessionId), asset), dest)) {
      files.push(dest);
      info.exportedTo = `${folder}/${asset}`;
    } else {
      warnings.push(`Asset "${asset}" (referenced by block(s) ${info.referencedBy.join(', ')}) is missing from disk — skipped.`);
    }
  }

  /* -------------------------------------------------------- transcript.md */
  const transcriptParts = [];
  if (transcripts.length === 0) {
    transcriptParts.push('_No recordings were made in this session._');
  } else {
    for (const { recording, segments } of transcripts) {
      const dur = Number.isFinite(recording.durationMs) ? shortTime(recording.durationMs) : 'unknown';
      transcriptParts.push(
        `## Recording ${recording.id}`,
        '',
        `Started ${fmtWall(recording.startedAt)} · duration ${dur} · model \`${recording.model || 'unknown'}\` · status ${recording.status || 'unknown'}`,
        '',
      );
      // A restart mid-lecture leaves a short hole in the audio. Saying where
      // beats letting the skill infer a non-sequitur is the lecturer's own.
      if (recording.gaps?.length) {
        transcriptParts.push(
          `> **Audio gaps:** capture had to be restarted ${recording.gaps.length} time(s) during this recording, at ${recording.gaps.map((g) => shortTime(g.atMs)).join(', ')}. A few seconds are missing at each point, so a sentence may break off mid-thought there. Do not treat those seams as the lecturer changing subject.`,
          '',
        );
      }
      if (!segments.length) {
        // Transcription happens in the background, so a bundle can honestly be
        // built before it has run. Say so rather than implying silence.
        const pending = { queued: 'is still waiting in the transcription queue', transcribing: 'is being transcribed right now', interrupted: 'was interrupted and has not been transcribed yet' }[recording.status];
        transcriptParts.push(pending
          ? `_This recording ${pending} — rebuild the bundle once it finishes, or ask the student to._`
          : '_No transcript segments captured for this recording._', '');
      } else {
        for (const seg of segments) {
          // Raw whisper output, deliberately not cleaned — the skill does its own noise pass.
          transcriptParts.push(`**[${shortTime(seg.start)}]** ${seg.text}`);
        }
        transcriptParts.push('');
      }
    }
  }
  write('transcript.md', `# Transcript\n\n${transcriptParts.join('\n')}\n`);

  /* ---------------------------------------------------- shared renderers */

  function renderNoteInline(b) {
    switch (b.type) {
      case 'text':
        return inlineNote(b.md);
      case 'divider':
        return '— — —';
      case 'image': {
        const info = assetExport.get(b.asset);
        const caption = b.caption || b.asset || 'image';
        return info?.exportedTo ? `🖼️ image — ${caption} (${info.exportedTo})` : `🖼️ image — ${caption} (file missing, not exported)`;
      }
      case 'sketch': {
        const info = assetExport.get(b.asset);
        const caption = b.caption || 'sketch';
        return info?.exportedTo ? `✏️ sketch — ${caption} (${info.exportedTo})` : `✏️ sketch — ${caption} (file missing, not exported)`;
      }
      case 'slide-ref':
        return `📌 Slide ${b.page} of ${deckLabel(b.deck)} — ${inlineMd(b.md)}`;
      default:
        return `[unrecognised block type "${b.type}"] ${inlineMd(b.md)}`;
    }
  }

  /** Full (non-inline) rendering used in my-notes.md, one block per document position. */
  function renderNoteBody(b) {
    switch (b.type) {
      case 'text':
        return mdForExport(b.md);
      case 'divider':
        return '---';
      case 'image': {
        const info = assetExport.get(b.asset);
        const caption = b.caption || b.asset || 'image';
        if (!info?.exportedTo) return `*(image "${b.asset}" referenced here but the file is missing — not exported)*`;
        return `![${caption}](${info.exportedTo})`;
      }
      case 'sketch': {
        const info = assetExport.get(b.asset);
        const caption = b.caption || 'sketch';
        if (!info?.exportedTo) return `*(sketch "${b.asset}" referenced here but the file is missing — not exported)*`;
        return `![${caption}](${info.exportedTo})`;
      }
      case 'slide-ref': {
        const lines = [`> 📌 **Slide ${b.page}** of ${deckLabel(b.deck)} — ${String(b.md || '').trim()}`];
        const text = slideText(b.deck, b.page);
        if (text) {
          // Every line of a multi-line quote needs its own "> " or markdown breaks the blockquote.
          const tLines = truncate(text, 400).split('\n');
          tLines[0] = `"${tLines[0]}`;
          tLines[tLines.length - 1] = `${tLines[tLines.length - 1]}"`;
          lines.push('>', ...tLines.map((l) => `> ${l}`));
        }
        return lines.join('\n');
      }
      default:
        return `*(block ${b.id} has unrecognised type "${b.type}")*\n\n${String(b.md || '')}`;
    }
  }

  /* ---------------------------------------------------------- my-notes.md */
  const notesParts = ['# My Notes', '', '_In the order they appear in the notebook._', ''];
  if (!blocks.length) {
    notesParts.push('_No notes were written in this session._');
  } else {
    for (const b of blocks) {
      const anchored = b.anchor && b.anchor.recId && recordingsById.has(b.anchor.recId);
      const prefix = anchored ? `**[⏱ ${shortTime(b.anchor.t)}]**` : '**[written outside the recording]**';
      notesParts.push(prefix, '', renderNoteBody(b), '');
    }
  }
  write('my-notes.md', `${notesParts.join('\n')}\n`);

  /* --------------------------------------------------- combined-timeline.md */
  const timelineParts = ['# Combined Timeline', '', 'Lecturer transcript and student notes merged and sorted by when they happened.', ''];

  const recordingsInOrder = (meta.recordings || []).slice().sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const sessionStart = recordingsInOrder.length ? recordingsInOrder[0].startedAt || 0 : null;

  const outsideBlocks = [];
  if (sessionStart === null) {
    // No recordings at all — everything the student wrote is, by definition, outside a recording.
    outsideBlocks.push(...blocks);
  } else {
    const events = [];
    for (const { recording, segments } of transcripts) {
      events.push({ abs: recording.startedAt || 0, order: 0, line: `### 🎙️ Recording ${recording.id} begins — ${fmtWall(recording.startedAt)} (model \`${recording.model || 'unknown'}\`)\n` });
      for (const seg of segments) {
        events.push({ abs: (recording.startedAt || 0) + seg.start, order: 2, line: `**[${shortTime(((recording.startedAt || 0) + seg.start) - sessionStart)}] 🎙️ LECTURER:** ${seg.text}` });
      }
    }
    for (const b of blocks) {
      const recId = b.anchor && b.anchor.recId;
      if (recId && recordingsById.has(recId)) {
        // Media time is authoritative for an anchored block: the wall clock can
        // disagree after a re-pin or an edit, but `t` is where in the audio the
        // note belongs, which is the whole point of this file.
        const startedAt = recordingsById.get(recId).startedAt || 0;
        const abs = Number.isFinite(b.anchor?.t)
          ? startedAt + b.anchor.t
          : (Number.isFinite(b.anchor?.wall) ? b.anchor.wall : startedAt);
        events.push({ abs, order: 1, line: `**[${shortTime(abs - sessionStart)}] 📝 MY NOTE:** ${renderNoteInline(b)}` });
      } else {
        if (recId) warnings.push(`Block ${b.id} anchors to recording "${recId}", which does not exist in this session — treated as written outside the recording.`);
        outsideBlocks.push(b);
      }
    }
    events.sort((a, b) => a.abs - b.abs || a.order - b.order);
    for (const e of events) timelineParts.push(e.line);
    if (!events.length) timelineParts.push('_No transcript segments or anchored notes to correlate._');
  }

  timelineParts.push('', '## Notes written outside the recording', '');
  if (!outsideBlocks.length) {
    timelineParts.push('_None._');
  } else {
    const sorted = outsideBlocks.slice().sort((a, b) => (a.anchor?.wall || 0) - (b.anchor?.wall || 0));
    for (const b of sorted) {
      const wall = b.anchor?.wall || b.editedWall || 0;
      timelineParts.push(`**[${fmtWall(wall)}]** ${renderNoteInline(b)}`);
    }
  }
  write('combined-timeline.md', `${timelineParts.join('\n')}\n`);

  /* ------------------------------------------------- reference documents */
  // The skill has a native "Reference documents" slot and no slot at all for
  // a student's own standing notes on a module. The student's module notes are
  // exactly that kind of reference: they were written across the whole term,
  // not during this lecture, and they say what the student already knows and
  // already cares about.
  let moduleNotesExported = false;
  if (mod) {
    const refAssets = new Map();
    for (const b of moduleBlocks) {
      if ((b.type === 'image' || b.type === 'sketch') && b.asset) refAssets.set(b.asset, b.type);
    }
    for (const [asset, kind] of refAssets) {
      const rel = `reference/images/${asset}`;
      if (copyIfExists(path.join(moduleAssetsDir(mod.id), asset), path.join(dir, rel))) {
        files.push(path.join(dir, rel));
      } else {
        refAssets.set(asset, null);
        warnings.push(`Module note asset "${asset}" (${kind}) is missing from disk — skipped.`);
      }
    }

    const head = [
      `# Module Notes — ${mod.name}`,
      '',
      `_The student's own standing notes on this module, written across the term rather than during this lecture._`,
      '',
      `- **Module:** ${mod.name}${mod.code ? ` (${mod.code})` : ''}`,
      `- **Lecturer:** ${mod.lecturer || '(not set)'}`,
      `- **Assessments:** ${mod.assessments?.length ? mod.assessments.join(', ') : '(none recorded)'}`,
      '',
      '---',
      '',
    ];
    const body = moduleBlocks.length
      ? moduleBlocks.map((b) => {
        if (b.type === 'image' || b.type === 'sketch') {
          const caption = b.caption || b.asset || b.type;
          return refAssets.get(b.asset)
            ? `![${caption}](reference/images/${b.asset})`
            : `*(${b.type} "${b.asset}" referenced here but the file is missing — not exported)*`;
        }
        if (b.type === 'divider') return '---';
        return mdForExport(b.md);
      }).filter((line) => line !== '').join('\n\n')
      : '_No module notes have been written yet._';

    write('reference/module-notes.md', `${head.join('\n')}${body}\n`);
    moduleNotesExported = moduleBlocks.length > 0;
  }

  /* --------------------------------------------------------- session.json */
  const assetMap = {};
  for (const [asset, info] of assetExport) {
    assetMap[asset] = { kind: info.kind, referencedBy: info.referencedBy, exportedTo: info.exportedTo };
  }
  const sessionJson = {
    exportedAt: Date.now(),
    meta,
    module: mod ? { ...mod, notes: moduleBlocks } : null,
    blocks,
    transcripts: transcripts.map(({ recording, segments }) => ({
      recordingId: recording.id,
      startedAt: recording.startedAt,
      endedAt: recording.endedAt,
      durationMs: recording.durationMs,
      model: recording.model,
      status: recording.status,
      segments,
    })),
    assets: assetMap,
    warnings,
  };
  write('session.json', `${JSON.stringify(sessionJson, null, 2)}\n`);

  /* ------------------------------------------------------------ MANIFEST.md */
  for (const r of meta.recordings || []) {
    if (r.gaps?.length) {
      warnings.push(`Recording ${r.id} lost audio ${r.gaps.length} time(s) (at ${r.gaps.map((g) => shortTime(g.atMs)).join(', ')}) because capture had to be restarted mid-lecture.`);
    }
  }

  const pendingRecordings = (meta.recordings || [])
    .filter((r) => ['queued', 'transcribing', 'interrupted'].includes(r.status))
    .map((r) => r.id);
  if (pendingRecordings.length) {
    warnings.push(`${pendingRecordings.length} recording(s) have no transcript yet (${pendingRecordings.join(', ')}) — transcription runs in the background. Rebuild this bundle once it finishes.`);
  }

  const totalDurationMs = (meta.recordings || []).reduce((s, r) => s + (r.durationMs || 0), 0);
  // A lecture rarely carries its own assessments; the module it belongs to
  // does, and that is where the student actually maintains them.
  const assessments = meta.assessments?.length ? meta.assessments : (mod?.assessments || []);
  const assessmentsLine = assessments.length
    ? `${assessments.join(', ')}${!meta.assessments?.length && mod ? ` (from the module "${mod.name}")` : ''}`
    : '(none recorded — ask the student, or infer from the lecturer\'s own references in the transcript)';
  const deckLines = (meta.decks || []).map((d) => {
    const name = safeDeckName(d.name);
    const has = fs.existsSync(path.join(dir, 'slides', `${name}.pdf`));
    return `- \`slides/${name}.pdf\`${has ? '' : ' — **missing, not exported** (see Data caveats)'} — source: \`${d.name}\` (${d.pages} pages${d.annotatedPages?.length ? `, pages ${d.annotatedPages.join(', ')} annotated by the student` : ''})`;
  });
  const annotatedLines = [];
  for (const d of meta.decks || []) {
    const name = safeDeckName(d.name);
    for (const p of d.annotatedPages || []) {
      const f = path.join(dir, 'slides', 'annotated', `${name}-p${pad2(p)}.png`);
      if (fs.existsSync(f)) annotatedLines.push(`- \`slides/annotated/${name}-p${pad2(p)}.png\` — slide ${p} of ${d.name}, with the student's ink composited on top`);
    }
  }
  const imageCount = [...assetExport.values()].filter((i) => i.kind === 'image' && i.exportedTo).length;
  const sketchCount = [...assetExport.values()].filter((i) => i.kind === 'sketch' && i.exportedTo).length;

  const manifest = `# Export Bundle — ${meta.title}

This bundle was produced by lecture-notebook for the **\`mba-lecture-notes\`** skill. Read this file first; it answers the skill's Step 1 questions so no follow-up is needed.

## Session

- **Title:** ${meta.title}
- **Module:** ${mod ? `${mod.name}${mod.code ? ` (${mod.code})` : ''}` : (meta.module || '(not set)')}
- **Lecturer:** ${meta.lecturer || mod?.lecturer || '(not set)'}
- **Recorded:** ${meta.recordings?.length ? `${fmtWall(recordingsInOrder[0]?.startedAt)} — ${meta.recordings.length} recording(s), ${shortTime(totalDurationMs)} total` : 'no recordings in this session'}
- **Assessments for this module:** ${assessmentsLine}

## Materials in this bundle, mapped to what you need

**Transcript** → \`transcript.md\`
Raw whisper output, one section per recording, timestamped, deliberately **not** cleaned — do your own noise-cleaning pass on it (Step 3 of your own instructions) rather than trusting it verbatim.

**Lecture slide deck** → ${deckLines.length ? deckLines.join('\n') : '_no decks in this session_'}
The deck is the **authoritative source of structure, definitions and terminology** — read it fully with the Read tool's \`pages\` option before reconciling against the transcript.
${annotatedLines.length ? `\nAnnotated slide pages (student marked these up live during the lecture — read the PNGs directly, the ink is the student's own emphasis on top of the deck's content):\n${annotatedLines.join('\n')}\n` : ''}
**The student's own notes** → \`my-notes.md\`
Everything the student typed, photographed or sketched during the session, in the order they wrote it, each prefixed with when it was written. Treat every block here as a **first-hand emphasis signal**: anything the student bothered to type, photograph or annotate is a candidate key point or assessment hint, even if terse. Embedded images are in \`images/\` (${imageCount} file(s)), sketches in \`sketches/\` (${sketchCount} file(s)) — read the referenced PNGs, don't skip them.

Two conventions in that file are deliberate and worth acting on:
- **\`> **⚠️ EXAM HINT** — …\`** is a line the student flagged *in the room* as mattering for an assessment. These are the strongest signal in the whole bundle. Every one of them belongs in the assignment-focused section, attributed to the moment it was said.
- **\`- [ ]\`** is something the student did not follow and meant to come back to; **\`- [x]\`** is one they since settled. An unticked box is a gap in their understanding — answer it from the deck and the transcript rather than repeating it back.

**Correlation** → \`combined-timeline.md\`
Transcript segments and the student's anchored notes, merged and sorted by when they happened, across all recordings. Use this to work out **what the lecturer was saying at the moment** a terse note was written — that context is often the difference between a throwaway note and an assessment hint.

**Reference documents** → ${moduleNotesExported
    ? `\`reference/module-notes.md\`\nThe student's own standing notes on **${mod.name}** — written across the whole term, not during this lecture. Read it before the transcript: it tells you what the student already knows, which frameworks they keep coming back to, and what they have flagged for the assessments. Anything in this lecture that answers a question raised there is worth calling out explicitly in the notes you write.${
      moduleBlocks.some((b) => b.type === 'image' || b.type === 'sketch') ? ' Images it references are in `reference/images/`.' : ''}`
    : '_none — this lecture is not filed under a module, or the module has no standing notes yet. Do not wait for reference documents; there are none coming._'}

**Machine-readable dump** → \`session.json\`
The same data as structured JSON (session meta, every block, every transcript segment, an asset reference map) — useful only if you need to cross-check something programmatically; the Markdown files above are the primary reading material.

## Pre-answered Step 1 questions

1. **Output document name** — already decided by the invocation that pointed you here (see the \`Output:\` line you were given). Confirm the absolute path before writing, as usual.
2. **Materials** — transcript, slide deck, the student's lecture notes${moduleNotesExported ? ' and the module reference notes' : ''} are all present as mapped above. Nothing else is coming: if the student mentions a textbook or handout by name, that is a citation to note, not a file to wait for.
3. **Assessments for this module** — ${assessmentsLine}

## Bundle contents

\`\`\`
${files.map((f) => path.relative(dir, f)).sort().join('\n')}
\`\`\`

## Data caveats
${warnings.length ? warnings.map((w) => `- ${w}`).join('\n') : '- None — everything referenced by the session was found and exported cleanly.'}
`;
  write('MANIFEST.md', manifest);

  /* --------------------------------------------------------------- prompt */
  const notesDir = opts.notesDir || loadSettings().notesDir || path.join(os.homedir(), 'Documents', 'Personal', 'MBA', 'Notes');
  // Lectures are filed on disk the way they are filed in the app: one folder
  // per module, so a term's notes do not land in one flat heap.
  const outputPath = mod
    ? path.join(notesDir, safeTitle(mod.name), `${safeTitle(meta.title)}.md`)
    : path.join(notesDir, `${safeTitle(meta.title)}.md`);
  const prompt = [
    '/mba-lecture-notes',
    `Materials: ${dir}  (read MANIFEST.md first)`,
    `Output: ${outputPath}`,
  ].join('\n');

  const stats = {
    pendingRecordings,
    module: mod?.name || null,
    moduleNotesExported,
    recordings: meta.recordings?.length || 0,
    segments: transcripts.reduce((s, t) => s + t.segments.length, 0),
    blocks: blocks.length,
    decks: meta.decks?.length || 0,
    slidesExported,
    annotatedPagesExported: annotatedExported,
    imagesExported: imageCount,
    sketchesExported: sketchCount,
    warnings,
  };

  return { dir, prompt, files, stats };
}
