/* Block editor.
   A block is the unit that carries a timestamp — "the thought I had at 12:34".
   Text blocks store raw markdown (`## Heading`, `- item`, `  - [ ] todo`)
   because that is what the export bundle and the note-generating skill
   consume, but the caret never sees the prefix: it is stripped for display and
   re-added on serialise.

   Two rules keep this usable during a live lecture:

   1. Typing never re-renders. `_onInput` mutates the model and the row's data
      attributes and stops there. Structural edits (Enter, Backspace-merge,
      insert, delete, move) touch only the rows that actually changed. A full
      `render()` happens once, when a document is loaded. The old version
      rebuilt every block on every keystroke-adjacent event, which on an
      hour's notes meant the caret visibly lurching.
   2. Everything you can reach with the mouse you can reach from the keyboard,
      because during a lecture one hand is usually doing something else. */

const uid = () => `b_${Math.random().toString(36).slice(2, 9)}`;

const INDENT = '  ';
const MAX_INDENT = 4;

const INDENT_RE = /^((?:  )*)/;
const HEADING_RE = /^(#{1,3})\s+/;
const TODO_RE = /^[-*]\s+\[([ xX])\]\s+/;
const LIST_RE = /^[-*]\s+/;
const ORDERED_RE = /^\d+[.)]\s+/;
const QUOTE_RE = /^>\s?/;
const HINT_RE = /^!!\s?/;

/** Typing these at the head of an empty-ish block turns it into that thing. */
const SHORTCUTS = [
  { re: /^(#{1,3})\s$/, fmt: (m) => ({ level: m[1].length }) },
  { re: /^>\s$/, fmt: () => ({ quote: true }) },
  { re: /^!!\s$/, fmt: () => ({ hint: true }) },
  { re: /^\[[ xX]?\]\s$/, fmt: () => ({ list: 'todo' }) },
  { re: /^[-*]\s$/, fmt: () => ({ list: 'bullet' }) },
  { re: /^\d+[.)]\s$/, fmt: () => ({ list: 'ordered' }) },
];

// "/", optionally followed by a word — and nothing else in the block.
const SLASH_RE = /^\/\w*$/;

const BLANK_FMT = { indent: 0, level: 0, list: '', quote: false, hint: false, done: false };

/** md (stored) -> { indent, text, level, list, quote, hint, done } (displayed) */
export function parseMd(md = '') {
  const raw = String(md);
  const indent = Math.min(MAX_INDENT, Math.floor((INDENT_RE.exec(raw)[1] || '').length / 2));
  let rest = raw.slice(indent * 2);
  const out = { ...BLANK_FMT, indent, text: rest };

  const heading = HEADING_RE.exec(rest);
  if (heading) return { ...out, level: heading[1].length, text: rest.slice(heading[0].length) };

  if (HINT_RE.test(rest)) return { ...out, hint: true, text: rest.replace(HINT_RE, '') };
  if (QUOTE_RE.test(rest)) return { ...out, quote: true, text: rest.replace(QUOTE_RE, '') };

  const todo = TODO_RE.exec(rest);
  if (todo) return { ...out, list: 'todo', done: todo[1].toLowerCase() === 'x', text: rest.slice(todo[0].length) };

  if (ORDERED_RE.test(rest)) return { ...out, list: 'ordered', text: rest.replace(ORDERED_RE, '') };
  if (LIST_RE.test(rest)) return { ...out, list: 'bullet', text: rest.replace(LIST_RE, '') };
  return out;
}

/** { text, indent, level, list, quote, hint, done } -> md */
export function toMd(text, fmt = {}) {
  const pad = INDENT.repeat(Math.min(MAX_INDENT, Math.max(0, fmt.indent || 0)));
  const body = String(text ?? '');
  if (fmt.level > 0) return `${pad}${'#'.repeat(fmt.level)} ${body}`;
  if (fmt.hint) return `${pad}!! ${body}`;
  if (fmt.quote) return `${pad}> ${body}`;
  if (fmt.list === 'todo') return `${pad}- [${fmt.done ? 'x' : ' '}] ${body}`;
  if (fmt.list === 'ordered') return `${pad}${fmt.ordinal || 1}. ${body}`;
  if (fmt.list === 'bullet') return `${pad}- ${body}`;
  return `${pad}${body}`;
}

/* ---------------------------------------------------------- slash commands */

export const COMMANDS = [
  { id: 'h1', label: 'Heading 1', hint: 'Section of the lecture', keys: '⌘1', fmt: { level: 1 } },
  { id: 'h2', label: 'Heading 2', hint: 'Topic', keys: '⌘2', fmt: { level: 2 } },
  { id: 'h3', label: 'Heading 3', hint: 'Sub-point', keys: '⌘3', fmt: { level: 3 } },
  { id: 'bullet', label: 'Bullet', hint: 'A point', keys: '- ', fmt: { list: 'bullet' } },
  { id: 'ordered', label: 'Numbered', hint: 'A sequence or a framework', keys: '1. ', fmt: { list: 'ordered' } },
  { id: 'todo', label: 'To-do', hint: 'Look this up later', keys: '[] ', fmt: { list: 'todo' } },
  { id: 'quote', label: 'Quote', hint: 'What the lecturer actually said', keys: '> ', fmt: { quote: true } },
  { id: 'hint', label: 'Exam hint', hint: 'Flag it for the assessment', keys: '!! ', fmt: { hint: true } },
  { id: 'text', label: 'Plain text', hint: 'Clear the formatting', keys: '', fmt: {} },
  { id: 'divider', label: 'Divider', hint: 'Break between topics', keys: '---', insert: 'divider' },
  { id: 'sketch', label: 'Sketch', hint: 'Draw a diagram', keys: '', app: 'sketch' },
  { id: 'image', label: 'Screenshot', hint: 'Paste or pick an image', keys: '⌘V', app: 'image' },
  { id: 'slide', label: 'Note on this slide', hint: 'Pin to the slide on screen', keys: '', app: 'slide' },
];

export class NotebookEditor {
  /**
   * @param {object} opts
   *   host       container element
   *   onChange   called whenever the document changes (debounce upstream)
   *   onSeek     called with (anchor) when a block's timestamp is clicked
   *   onCommand  called with a command id the app owns ('sketch'|'image'|'slide')
   *   nowAnchor  () => ({wall, recId, t}) — stamps a block on first content
   *   assetUrl   (file) => url
   *   stamps     false to hide the timestamp gutter (module notes have no clock)
   */
  constructor({ host, onChange, onSeek, onCommand, nowAnchor, assetUrl, stamps = true }) {
    this.host = host;
    this.onChange = onChange || (() => {});
    this.onSeek = onSeek || (() => {});
    this.onCommand = onCommand || (() => {});
    this.nowAnchor = nowAnchor || (() => ({ wall: Date.now(), recId: null, t: null }));
    this.assetUrl = assetUrl || ((f) => f);
    this.stamps = stamps;
    this.blocks = [];
    this.host.classList.toggle('editor--nostamps', !stamps);

    this.host.addEventListener('keydown', (e) => this._onKeyDown(e));
    this.host.addEventListener('input', (e) => this._onInput(e));
    this.host.addEventListener('focusout', (e) => this._onBlur(e));
    this.host.addEventListener('focusin', () => this._closeMenu());

    this.menu = null;
    this.menuFor = null;
  }

  /* ------------------------------------------------------------- state */

  load(blocks) {
    this.blocks = (blocks || []).map((b) => ({ ...b }));
    if (this.blocks.length === 0) this.blocks.push(this._blank());
    this.render();
  }

  getBlocks() { return this.blocks.map((b) => ({ ...b })); }

  /** Headings, for the outline strip. */
  getOutline() {
    return this.blocks
      .filter((b) => b.type === 'text')
      .map((b) => ({ block: b, ...parseMd(b.md || '') }))
      .filter((p) => p.level > 0 && p.text.trim())
      .map((p) => ({ id: p.block.id, level: p.level, text: p.text.trim() }));
  }

  getStats() {
    let words = 0;
    let todo = 0;
    let done = 0;
    for (const b of this.blocks) {
      if (b.type !== 'text' && b.type !== 'slide-ref') continue;
      const p = parseMd(b.md || '');
      words += p.text.trim() ? p.text.trim().split(/\s+/).length : 0;
      if (p.list === 'todo') { todo += 1; if (p.done) done += 1; }
    }
    return { words, blocks: this.blocks.length, todo, todoDone: done };
  }

  _blank(fmt = null) {
    return { id: uid(), type: 'text', md: fmt ? toMd('', fmt) : '', anchor: null, editedWall: 0 };
  }

  _changed() { this.onChange(this.getBlocks()); }

  /** Stamp the moment a block first gets content — never on later edits. */
  _stampIfNeeded(block) {
    if (!block.anchor) block.anchor = this.nowAnchor();
    block.editedWall = Date.now();
  }

  _at(id) { return this.blocks.findIndex((b) => b.id === id); }
  _rowOf(id) { return this.host.querySelector(`.block[data-id="${id}"]`); }

  /* ------------------------------------------------------------ render */

  render() {
    const active = document.activeElement;
    const keepId = active?.closest?.('.block')?.dataset.id;
    const caret = keepId ? caretOffset(active) : null;

    this.host.textContent = '';
    for (const block of this.blocks) this.host.append(this._renderBlock(block));

    if (keepId) this.focus(keepId, caret);
  }

  _renderBlock(block) {
    const row = document.createElement('div');
    row.className = 'block';
    row.dataset.id = block.id;
    row.dataset.type = block.type;
    row.append(this._stamp(block), this._body(block, row), this._tools(block));
    return row;
  }

  /** Swap one row for a freshly built one, keeping the caret where it was. */
  _refresh(block, caret = null) {
    const row = this._rowOf(block.id);
    if (!row) return;
    const had = row.contains(document.activeElement);
    const at = caret ?? (had ? caretOffset(row.querySelector('.block__text')) : null);
    const fresh = this._renderBlock(block);
    row.replaceWith(fresh);
    if (had) this.focus(block.id, at);
  }

  _stamp(block) {
    const stamp = document.createElement('div');
    stamp.className = 'block__stamp';
    if (!this.stamps) { stamp.hidden = true; return stamp; }
    const a = block.anchor;
    if (!a) { stamp.classList.add('is-none'); stamp.textContent = '·'; }
    else if (a.recId && Number.isFinite(a.t)) {
      stamp.textContent = mmss(a.t);
      stamp.title = 'Jump to this moment in the transcript';
      stamp.classList.add('is-linked');
    } else {
      stamp.classList.add('is-none');
      stamp.textContent = new Date(a.wall).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      stamp.title = 'Written outside a recording';
    }
    stamp.addEventListener('click', () => block.anchor && this.onSeek(block.anchor));
    return stamp;
  }

  _body(block, row) {
    const body = document.createElement('div');
    body.className = 'block__body';

    if (block.type === 'divider') {
      const hr = document.createElement('div');
      hr.className = 'block__divider';
      body.append(hr);
      return body;
    }

    if (block.type === 'image' || block.type === 'sketch') {
      body.append(this._figure(block));
      return body;
    }

    if (block.type === 'slide-ref') {
      const box = document.createElement('div');
      box.className = 'block__slide';
      const ref = document.createElement('div');
      ref.className = 'block__slideref';
      ref.textContent = `Slide ${block.page}${block.deckName ? ` · ${block.deckName}` : ''}`;
      box.append(ref, this._textNode(block, row, 'What did they say about this slide?'));
      body.append(box);
      return body;
    }

    body.append(this._textNode(block, row, 'Type, or press / for commands'));
    return body;
  }

  _figure(block) {
    const fig = document.createElement('div');
    fig.className = 'block__figure';
    const img = document.createElement('img');
    img.src = this.assetUrl(block.asset);
    img.alt = block.caption || (block.type === 'sketch' ? 'Sketch' : 'Screenshot');
    img.loading = 'lazy';
    const cap = document.createElement('div');
    cap.className = 'block__figcap';
    const capInput = document.createElement('input');
    capInput.value = block.caption || '';
    capInput.placeholder = block.type === 'sketch' ? 'Sketch caption' : 'Caption';
    capInput.addEventListener('input', () => { block.caption = capInput.value; this._changed(); });
    cap.append(capInput);
    if (block.type === 'sketch') {
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'btn btn--ghost btn--sm'; edit.textContent = 'Edit';
      edit.addEventListener('click', () => this.host.dispatchEvent(
        new CustomEvent('editsketch', { detail: block, bubbles: true })));
      cap.append(edit);
    }
    fig.append(img, cap);
    return fig;
  }

  _textNode(block, row, placeholder) {
    const fmt = parseMd(block.md || '');
    this._applyFmtAttrs(row, fmt);

    const wrap = document.createElement('div');
    wrap.className = 'block__line';

    if (fmt.list === 'todo') {
      const box = document.createElement('button');
      box.type = 'button';
      box.className = 'block__check';
      box.setAttribute('aria-pressed', String(fmt.done));
      box.title = 'Toggle (⌘⏎)';
      box.addEventListener('click', () => this.toggleDone(block.id));
      wrap.append(box);
    } else if (fmt.list) {
      const marker = document.createElement('span');
      marker.className = 'block__marker';
      marker.textContent = fmt.list === 'ordered' ? `${this._ordinalOf(block)}.` : '•';
      wrap.append(marker);
    }

    const node = document.createElement('div');
    node.className = 'block__text';
    node.contentEditable = 'true';
    node.spellcheck = true;
    node.dataset.placeholder = placeholder;
    node.textContent = fmt.text;
    paintInline(node);
    wrap.append(node);
    return wrap;
  }

  _applyFmtAttrs(row, fmt) {
    row.dataset.level = String(fmt.level || 0);
    row.dataset.list = fmt.list || '';
    row.dataset.quote = fmt.quote ? '1' : '0';
    row.dataset.hint = fmt.hint ? '1' : '0';
    row.dataset.indent = String(fmt.indent || 0);
    row.dataset.done = fmt.done ? '1' : '0';
  }

  /** Position within the run of numbered items this block belongs to. */
  _ordinalOf(block) {
    const at = this._at(block.id);
    const me = parseMd(block.md || '');
    let n = 1;
    for (let i = at - 1; i >= 0; i -= 1) {
      const b = this.blocks[i];
      if (b.type !== 'text') break;
      const p = parseMd(b.md || '');
      if (p.list !== 'ordered' || p.indent !== me.indent) break;
      n += 1;
    }
    return n;
  }

  /** Renumber the visible markers of an ordered run after an edit. */
  _renumber() {
    for (const block of this.blocks) {
      if (block.type !== 'text') continue;
      const fmt = parseMd(block.md || '');
      if (fmt.list !== 'ordered') continue;
      const marker = this._rowOf(block.id)?.querySelector('.block__marker');
      if (marker) marker.textContent = `${this._ordinalOf(block)}.`;
    }
  }

  _tools(block) {
    const tools = document.createElement('div');
    tools.className = 'block__tools';
    const add = (label, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.title = title;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', fn);
      tools.append(b);
      return b;
    };
    add('↑', 'Move up (⌥↑)', () => this.move(block.id, -1));
    add('↓', 'Move down (⌥↓)', () => this.move(block.id, 1));
    if (this.stamps && block.anchor) add('⏱', 'Re-stamp to the current moment', () => {
      block.anchor = this.nowAnchor();
      this._refresh(block);
      this._changed();
    });
    add('✕', 'Delete this block', () => this.remove(block.id));
    return tools;
  }

  /* ------------------------------------------------------------- input */

  _onInput(e) {
    const node = e.target.closest?.('.block__text');
    if (!node) return;
    const row = node.closest('.block');
    const block = this.blocks.find((b) => b.id === row.dataset.id);
    if (!block) return;

    let text = node.textContent;
    const fmt = this._fmtOf(row);

    // A shortcut fires only when the prefix is the whole of the block — every
    // pattern is anchored at both ends — so "- " halfway through a sentence
    // stays a dash. Existing formatting is replaced rather than blocking the
    // shortcut: typing "[] " on a bullet plainly means "make this a to-do".
    // Indentation is the one thing that survives, because it is position,
    // not kind.
    const hit = SHORTCUTS.find((s) => s.re.test(text));
    if (hit) {
      const next = { ...BLANK_FMT, indent: fmt.indent, ...hit.fmt(hit.re.exec(text)) };
      block.md = toMd('', next);
      this._refresh(block, 0);
      this._changed();
      return;
    }

    // "/" opens the command menu, whatever the block is already formatted as —
    // wanting a sketch halfway down a bullet list is normal. The anchor and
    // the \w-only tail are what keep a URL from summoning it mid-sentence.
    if (SLASH_RE.test(text)) this._openMenu(block, node, text.slice(1));
    else this._closeMenu();

    block.md = toMd(text, fmt);
    if (text.trim()) this._stampIfNeeded(block);
    this._syncStamp(row, block);
    this._changed();
  }

  /** Re-apply the inline markup styling once the caret leaves a block. */
  _onBlur(e) {
    const node = e.target.closest?.('.block__text');
    if (node) paintInline(node);
  }

  _fmtOf(row) {
    return {
      indent: Number(row.dataset.indent) || 0,
      level: Number(row.dataset.level) || 0,
      list: row.dataset.list || '',
      quote: row.dataset.quote === '1',
      hint: row.dataset.hint === '1',
      done: row.dataset.done === '1',
    };
  }

  _syncStamp(row, block) {
    const stamp = row.querySelector('.block__stamp');
    if (!stamp || !block.anchor || stamp.classList.contains('is-linked')) return;
    stamp.replaceWith(this._stamp(block));
  }

  _onKeyDown(e) {
    if (this.menu && this._menuKey(e)) return;

    const node = e.target.closest?.('.block__text');
    if (!node) return;
    const row = node.closest('.block');
    const index = this._at(row.dataset.id);
    if (index === -1) return;
    const block = this.blocks[index];
    const fmt = this._fmtOf(row);
    const mod = e.metaKey || e.ctrlKey;

    /* ---- formatting shortcuts ---------------------------------------- */
    if (mod && !e.shiftKey && ['1', '2', '3'].includes(e.key)) {
      e.preventDefault();
      const level = Number(e.key);
      return this.setFormat(block.id, fmt.level === level ? {} : { level });
    }
    if (mod && e.shiftKey && e.code === 'Digit8') { e.preventDefault(); return this.setFormat(block.id, fmt.list === 'bullet' ? {} : { list: 'bullet' }); }
    if (mod && e.shiftKey && e.code === 'Digit7') { e.preventDefault(); return this.setFormat(block.id, fmt.list === 'ordered' ? {} : { list: 'ordered' }); }
    if (mod && e.shiftKey && e.code === 'Digit9') { e.preventDefault(); return this.setFormat(block.id, fmt.list === 'todo' ? {} : { list: 'todo' }); }
    if (mod && e.shiftKey && e.code === 'KeyE') { e.preventDefault(); return this.setFormat(block.id, fmt.hint ? {} : { hint: true }); }
    if (mod && e.shiftKey && e.code === 'KeyK') { e.preventDefault(); return this.setFormat(block.id, fmt.quote ? {} : { quote: true }); }
    if (mod && e.key === 'Enter') { e.preventDefault(); return this.toggleDone(block.id); }
    if (mod && (e.key === 'b' || e.key === 'i')) { e.preventDefault(); return this._wrapSelection(node, block, e.key === 'b' ? '**' : '*'); }

    /* ---- moving blocks ------------------------------------------------ */
    const movingUp = e.key === 'ArrowUp' && (e.altKey || (mod && e.shiftKey));
    const movingDown = e.key === 'ArrowDown' && (e.altKey || (mod && e.shiftKey));
    if (movingUp || movingDown) { e.preventDefault(); return this.move(block.id, movingUp ? -1 : 1); }

    /* ---- indent ------------------------------------------------------- */
    if (e.key === 'Tab') {
      e.preventDefault();
      const delta = e.shiftKey ? -1 : 1;
      const indent = Math.max(0, Math.min(MAX_INDENT, fmt.indent + delta));
      if (indent === fmt.indent) return;
      return this.setFormat(block.id, { ...fmt, indent }, { keepCaret: true });
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      return this._onEnter(node, row, block, index, fmt);
    }

    if (e.key === 'Backspace' && caretOffset(node) === 0 && window.getSelection()?.isCollapsed) {
      return this._onBackspace(e, node, row, block, index, fmt);
    }

    if (e.key === 'ArrowUp' && caretOffset(node) === 0) {
      const prev = this._prevTextBlock(index);
      if (prev) { e.preventDefault(); this.focus(prev.id, -1); }
    }
    if (e.key === 'ArrowDown' && caretOffset(node) === node.textContent.length) {
      const next = this._nextTextBlock(index);
      if (next) { e.preventDefault(); this.focus(next.id, 0); }
    }
    return undefined;
  }

  _onEnter(node, row, block, index, fmt) {
    const offset = caretOffset(node);
    const text = node.textContent;
    const before = text.slice(0, offset);
    const after = text.slice(offset);

    // "---" on its own line becomes a divider rather than a paragraph of dashes.
    if (before.trim() === '---' && !after) {
      block.type = 'divider';
      delete block.md;
      this._stampIfNeeded(block);
      this._refresh(block);
      const next = this._blank();
      this._insertAfter(next, index);
      this.focus(next.id, 0);
      this._changed();
      return;
    }

    // Enter on an empty list item ends the list instead of making another one.
    if ((fmt.list || fmt.quote) && !text.trim()) {
      if (fmt.indent > 0) return this.setFormat(block.id, { ...fmt, indent: fmt.indent - 1 });
      return this.setFormat(block.id, {});
    }

    block.md = toMd(before, fmt);
    node.textContent = before;
    paintInline(node);

    // A list or a quote continues onto the next line; a heading does not, and
    // neither does an exam hint — flagging one line is the whole point of it,
    // and a hint that quietly swallowed the next three notes would be worse
    // than useless come revision.
    const carry = (fmt.list || fmt.quote)
      ? { indent: fmt.indent, list: fmt.list, quote: fmt.quote, done: false }
      : { indent: fmt.indent };
    const next = this._blank();
    next.md = toMd(after, carry);
    if (after.trim()) this._stampIfNeeded(next);

    this._insertAfter(next, index);
    this.focus(next.id, 0);
    this._renumber();
    this._changed();
  }

  _onBackspace(e, node, row, block, index, fmt) {
    // First backspace strips indent, then formatting, and only then merges up:
    // three presses to destroy a block is deliberate.
    if (fmt.indent > 0) { e.preventDefault(); return this.setFormat(block.id, { ...fmt, indent: fmt.indent - 1 }, { keepCaret: true }); }
    if (fmt.level > 0 || fmt.list || fmt.quote || fmt.hint) { e.preventDefault(); return this.setFormat(block.id, {}, { keepCaret: true }); }

    const prev = this.blocks[index - 1];
    if (!prev) return undefined;
    e.preventDefault();

    if (prev.type !== 'text') {
      // Don't silently swallow a sketch, a screenshot or a divider.
      if (!node.textContent) { this.remove(block.id); this.focus(prev.id, -1); }
      return undefined;
    }
    const prevFmt = parseMd(prev.md || '');
    const joinAt = prevFmt.text.length;
    prev.md = toMd(prevFmt.text + node.textContent, prevFmt);
    this.blocks.splice(index, 1);
    this._rowOf(block.id)?.remove();
    this._refresh(prev);
    this.focus(prev.id, joinAt);
    this._renumber();
    this._changed();
    return undefined;
  }

  _prevTextBlock(index) {
    for (let i = index - 1; i >= 0; i -= 1) if (this.blocks[i].type !== 'divider' && this.blocks[i].type !== 'image' && this.blocks[i].type !== 'sketch') return this.blocks[i];
    return null;
  }

  _nextTextBlock(index) {
    for (let i = index + 1; i < this.blocks.length; i += 1) if (this.blocks[i].type !== 'divider' && this.blocks[i].type !== 'image' && this.blocks[i].type !== 'sketch') return this.blocks[i];
    return null;
  }

  /** Wrap the selection (or the word under the caret) in markdown markers. */
  _wrapSelection(node, block, marker) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return;
    const chosen = range.toString();
    const start = caretOffsetTo(node, range.startContainer, range.startOffset);
    const text = node.textContent;
    const next = text.slice(0, start) + marker + chosen + marker + text.slice(start + chosen.length);
    node.textContent = next;
    block.md = toMd(next, this._fmtOf(node.closest('.block')));
    paintInline(node);
    this.focus(block.id, start + marker.length * 2 + chosen.length);
    this._changed();
  }

  /* ---------------------------------------------------------- mutation */

  _insertAfter(block, index) {
    this.blocks.splice(index + 1, 0, block);
    const row = this._renderBlock(block);
    const prevRow = this.host.children[index];
    if (prevRow) prevRow.after(row); else this.host.append(row);
    return row;
  }

  /** Insert a block after the focused one (or at the end) and stamp it now. */
  insert(block) {
    const focused = document.activeElement?.closest?.('.block');
    const at = focused ? this._at(focused.dataset.id) : this.blocks.length - 1;
    const full = { id: uid(), anchor: this.nowAnchor(), editedWall: Date.now(), ...block };
    this._insertAfter(full, at);

    // Keep a trailing text block so there is always somewhere to type next.
    let follow = null;
    if (full.type !== 'text' && at + 1 === this.blocks.length - 1) {
      follow = this._blank();
      this._insertAfter(follow, this.blocks.length - 1);
    }
    if (follow) this.focus(follow.id, 0);
    else if (full.type === 'text' || full.type === 'slide-ref') this.focus(full.id, -1);
    this._changed();
    return full;
  }

  update(id, patch) {
    const block = this.blocks.find((b) => b.id === id);
    if (!block) return;
    Object.assign(block, patch);
    this._refresh(block);
    this._changed();
  }

  remove(id) {
    const at = this._at(id);
    if (at === -1) return;
    this.blocks.splice(at, 1);
    this._rowOf(id)?.remove();
    if (this.blocks.length === 0) {
      const blank = this._blank();
      this.blocks.push(blank);
      this.host.append(this._renderBlock(blank));
      this.focus(blank.id, 0);
    } else {
      const neighbour = this.blocks[Math.max(0, at - 1)];
      if (neighbour?.type === 'text') this.focus(neighbour.id, -1);
    }
    this._renumber();
    this._changed();
  }

  move(id, dir) {
    const at = this._at(id);
    const to = at + dir;
    if (at === -1 || to < 0 || to >= this.blocks.length) return;
    const [block] = this.blocks.splice(at, 1);
    this.blocks.splice(to, 0, block);

    const row = this._rowOf(id);
    const other = this.host.children[to];
    if (row && other) {
      if (dir < 0) other.before(row); else other.after(row);
    }
    this._renumber();
    const node = row?.querySelector('.block__text');
    if (node) { node.focus(); setCaret(node, node.textContent.length); }
    this._changed();
  }

  /**
   * Apply a formatting shape to a block. An empty `fmt` clears it back to
   * plain text, which is what every "toggle off" path wants.
   */
  setFormat(id, fmt = {}, { keepCaret = false } = {}) {
    const block = this.blocks.find((b) => b.id === id);
    if (!block || (block.type !== 'text' && block.type !== 'slide-ref')) return;
    const current = parseMd(block.md || '');
    const next = { ...BLANK_FMT, indent: fmt.indent ?? current.indent, ...fmt };
    block.md = toMd(current.text, next);
    const caret = keepCaret ? null : current.text.length;
    this._refresh(block, caret);
    this._renumber();
    this._changed();
  }

  toggleDone(id) {
    const block = this.blocks.find((b) => b.id === id);
    if (!block) return;
    const fmt = parseMd(block.md || '');
    // Marking something done is also how a plain line becomes a to-do.
    const next = fmt.list === 'todo' ? { ...fmt, done: !fmt.done } : { ...fmt, list: 'todo', done: false };
    block.md = toMd(fmt.text, next);
    this._refresh(block);
    this._changed();
  }

  /** Turn the focused block into a heading, or back to body text. */
  toggleHeading(level = 2) {
    const row = document.activeElement?.closest?.('.block') || this.host.querySelector('.block');
    if (!row) return;
    const block = this.blocks.find((b) => b.id === row.dataset.id);
    if (!block) return;
    const current = parseMd(block.md || '');
    this.setFormat(block.id, current.level === level ? {} : { level });
  }

  /** Apply a slash-menu command to the focused (or given) block. */
  runCommand(id, blockId = null) {
    const cmd = COMMANDS.find((c) => c.id === id);
    if (!cmd) return;
    const target = blockId || document.activeElement?.closest?.('.block')?.dataset.id;
    if (!target) return;
    if (cmd.app) { this.onCommand(cmd.app, target); return; }
    if (cmd.insert === 'divider') {
      const block = this.blocks.find((b) => b.id === target);
      const at = this._at(target);
      if (parseMd(block?.md || '').text.trim()) {
        this.insert({ type: 'divider' });
      } else {
        block.type = 'divider';
        delete block.md;
        this._refresh(block);
        const next = this._blank();
        this._insertAfter(next, at);
        this.focus(next.id, 0);
        this._changed();
      }
      return;
    }
    this.setFormat(target, cmd.fmt || {});
  }

  /* -------------------------------------------------------- slash menu */

  _openMenu(block, node, query) {
    const rows = COMMANDS.filter((c) => !query
      || c.label.toLowerCase().includes(query.toLowerCase())
      || c.id.startsWith(query.toLowerCase()));
    if (!rows.length) return this._closeMenu();

    if (!this.menu) {
      this.menu = document.createElement('div');
      this.menu.className = 'slash';
      document.body.append(this.menu);
    }
    this.menuFor = block.id;
    this.menu.textContent = '';
    rows.forEach((cmd, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `slash__item${i === 0 ? ' is-on' : ''}`;
      item.dataset.cmd = cmd.id;
      item.innerHTML = '<span class="slash__label"></span><span class="slash__hint"></span><span class="slash__keys"></span>';
      item.querySelector('.slash__label').textContent = cmd.label;
      item.querySelector('.slash__hint').textContent = cmd.hint;
      item.querySelector('.slash__keys').textContent = cmd.keys;
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => this._pickMenu(cmd.id));
      this.menu.append(item);
    });

    const box = node.getBoundingClientRect();
    const below = window.innerHeight - box.bottom;
    this.menu.style.left = `${Math.round(box.left)}px`;
    // Flip above the caret when there is no room under it.
    if (below < 260) {
      this.menu.style.top = 'auto';
      this.menu.style.bottom = `${Math.round(window.innerHeight - box.top + 6)}px`;
    } else {
      this.menu.style.bottom = 'auto';
      this.menu.style.top = `${Math.round(box.bottom + 6)}px`;
    }
    return undefined;
  }

  _closeMenu() {
    this.menu?.remove();
    this.menu = null;
    this.menuFor = null;
  }

  _menuKey(e) {
    const items = [...this.menu.querySelectorAll('.slash__item')];
    const at = items.findIndex((i) => i.classList.contains('is-on'));
    if (e.key === 'Escape') { e.preventDefault(); this._closeMenu(); return true; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const to = (at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      items[at]?.classList.remove('is-on');
      items[to]?.classList.add('is-on');
      items[to]?.scrollIntoView({ block: 'nearest' });
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      this._pickMenu(items[at]?.dataset.cmd);
      return true;
    }
    return false;
  }

  _pickMenu(cmdId) {
    const blockId = this.menuFor;
    this._closeMenu();
    if (!cmdId || !blockId) return;
    // Drop the "/query" the student typed to summon the menu.
    const block = this.blocks.find((b) => b.id === blockId);
    if (block && block.type === 'text') {
      const fmt = parseMd(block.md || '');
      block.md = toMd('', fmt);
      const node = this._rowOf(blockId)?.querySelector('.block__text');
      if (node) node.textContent = '';
    }
    this.runCommand(cmdId, blockId);
  }

  /* -------------------------------------------------------------- focus */

  focus(id, offset = -1) {
    const node = this.host.querySelector(`.block[data-id="${id}"] .block__text`);
    if (!node) return;
    node.focus();
    setCaret(node, offset === null ? node.textContent.length : (offset < 0 ? node.textContent.length : offset));
    keepInView(node);
  }

  focusLast() {
    const last = this.blocks[this.blocks.length - 1];
    if (last?.type === 'text') this.focus(last.id, -1);
  }
}

/* ------------------------------------------------------- inline markup */

const ESCAPE = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * Style **bold**, *italic*, `code` and ==highlight== without hiding the
 * markers. Keeping every character means the node's textContent still equals
 * the stored text, so caret offsets stay honest and typing never desyncs.
 */
function inlineHtml(text) {
  let html = ESCAPE(text);
  html = html.replace(/(`)([^`]+)(`)/g, (_, a, b, c) => `<code class="im">${mk(a)}${b}${mk(c)}</code>`);
  html = html.replace(/(\*\*)([^*]+)(\*\*)/g, (_, a, b, c) => `<b class="im">${mk(a)}${b}${mk(c)}</b>`);
  html = html.replace(/(?<![*\w])(\*)([^*]+)(\*)(?!\*)/g, (_, a, b, c) => `<i class="im">${mk(a)}${b}${mk(c)}</i>`);
  html = html.replace(/(==)([^=]+)(==)/g, (_, a, b, c) => `<mark class="im">${mk(a)}${b}${mk(c)}</mark>`);
  return html;
}
const mk = (s) => `<span class="mk">${s}</span>`;

function paintInline(node) {
  const text = node.textContent;
  if (!/[*`=]/.test(text)) { if (node.firstElementChild) node.textContent = text; return; }
  const html = inlineHtml(text);
  if (node.innerHTML !== html) node.innerHTML = html;
}

/* ------------------------------------------------------------- caret ops */

function caretOffset(node) {
  const sel = window.getSelection();
  if (!node || !sel || sel.rangeCount === 0 || !node.contains(sel.anchorNode)) return 0;
  const r = sel.getRangeAt(0);
  return caretOffsetTo(node, r.endContainer, r.endOffset);
}

function caretOffsetTo(node, container, offset) {
  const range = document.createRange();
  range.selectNodeContents(node);
  try { range.setEnd(container, offset); } catch { return 0; }
  return range.toString().length;
}

/** Place the caret `offset` characters in, walking across inline markup. */
function setCaret(node, offset) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset ?? 0);
  let last = null;
  let placed = false;
  let t = walker.nextNode();
  while (t) {
    last = t;
    if (remaining <= t.length) { range.setStart(t, remaining); placed = true; break; }
    remaining -= t.length;
    t = walker.nextNode();
  }
  if (!placed) {
    if (last) range.setStart(last, last.length);
    else { range.selectNodeContents(node); }
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Typewriter-ish: never let the line being typed sit under the composer. */
function keepInView(node) {
  const scroller = node.closest('.editor-wrap');
  if (!scroller) return;
  const box = node.getBoundingClientRect();
  const frame = scroller.getBoundingClientRect();
  const margin = 80;
  if (box.bottom > frame.bottom - margin) scroller.scrollTop += box.bottom - (frame.bottom - margin);
  else if (box.top < frame.top + margin) scroller.scrollTop -= (frame.top + margin) - box.top;
}

const mmss = (ms) => {
  const t = Math.max(0, ms || 0);
  const h = Math.floor(t / 3600000);
  const m = String(Math.floor((t % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((t % 60000) / 1000)).padStart(2, '0');
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
};
