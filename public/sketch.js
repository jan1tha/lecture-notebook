/* Freehand ink widget — inline sketch blocks and slide-overlay annotation share
   this one class. Strokes (not pixels) are the storage format so eraser is
   stroke-level and undo/redo just swap stroke-array snapshots. */

const MAX_HISTORY = 50;
const MAX_DPR = 2;
const MIN_MOVE = 2;              // px; below this we drop the point (decimation)
const HIGHLIGHTER_WIDTH_MULT = 4;
const HIGHLIGHTER_ALPHA = 0.35;

const COLORS = ['#1d2126', '#c0392b', '#1f6feb', '#1f8a4c', '#c77d1f'];
const SIZES = [2, 4, 8];

let styleInjected = false;

function injectStyle() {
  if (styleInjected || document.getElementById('sketch-style')) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.id = 'sketch-style';
  style.textContent = `
    .sketch { display: flex; flex-direction: column; gap: 6px; }
    .sketch__toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .sketch__group { display: flex; align-items: center; gap: 4px; }
    .sketch__sep { width: 1px; align-self: stretch; background: currentColor; opacity: .15; }
    .sketch__btn { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid currentColor;
      background: none; color: inherit; cursor: pointer; opacity: .7; line-height: 1.4; }
    .sketch__btn[aria-pressed="true"] { opacity: 1; font-weight: 600; }
    .sketch__btn:disabled { opacity: .3; cursor: default; }
    .sketch__swatch { width: 20px; height: 20px; border-radius: 50%; border: 2px solid transparent;
      padding: 0; cursor: pointer; }
    .sketch__swatch[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--surface, #fff), 0 0 0 4px currentColor; }
    .sketch__size { width: 30px; height: 30px; padding: 0; border-radius: 6px; border: 1px solid currentColor;
      background: none; opacity: .7; cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .sketch__size[aria-pressed="true"] { opacity: 1; border-width: 2px; }
    .sketch__size i { display: block; border-radius: 50%; background: currentColor; }
    .sketch__canvas-wrap { position: relative; }
    .sketch__canvas { position: absolute; top: 0; left: 0; }
    .sketch__canvas--ink { touch-action: none; }
    .sketch__canvas--bg { pointer-events: none; }
  `;
  document.head.append(style);
}

/* ─────────────────────────────────────────────────────────  geometry  ── */

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round1 = (n) => Math.round(n * 10) / 10;
const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function segDist(a, b, p) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  let t = lenSq ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq : 0;
  t = clamp(t, 0, 1);
  return dist([a[0] + t * dx, a[1] + t * dy], p);
}

function renderWidth(stroke) {
  return stroke.tool === 'highlighter' ? stroke.size * HIGHLIGHTER_WIDTH_MULT : stroke.size;
}

function applyStrokeStyle(ctx, stroke) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = renderWidth(stroke);
  if (stroke.tool === 'highlighter') {
    ctx.globalAlpha = HIGHLIGHTER_ALPHA;
    ctx.globalCompositeOperation = 'multiply';
  } else {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

function strokeHit(stroke, pt, eraseR) {
  const threshold = eraseR + renderWidth(stroke) / 2;
  const pts = stroke.points;
  if (pts.length === 1) return dist(pts[0], pt) <= threshold;
  for (let i = 0; i < pts.length - 1; i += 1) {
    if (segDist(pts[i], pts[i + 1], pt) <= threshold) return true;
  }
  return false;
}

// Whole-stroke render used on full replay: one continuous path, points as
// quadratic control points and their midpoints as the curve anchors — the
// classic trick for turning a polyline into a smooth freehand line.
function renderStrokeFull(ctx, stroke) {
  const pts = stroke.points;
  if (!pts.length) return;
  applyStrokeStyle(ctx, stroke);
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0], pts[0][1], renderWidth(stroke) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 2) {
    ctx.lineTo(pts[1][0], pts[1][1]);
  } else {
    for (let i = 1; i < pts.length - 1; i += 1) {
      const m = midpoint(pts[i], pts[i + 1]);
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], m[0], m[1]);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last[0], last[1]);
  }
  ctx.stroke();
}

function cloneStroke(s) {
  return { tool: s.tool, color: s.color, size: s.size, points: s.points.map((p) => [p[0], p[1]]) };
}

function finalizeStroke(active) {
  return {
    tool: active.tool,
    color: active.color,
    size: active.size,
    points: active.points.map(([x, y]) => [round1(x), round1(y)]),
  };
}

/* ───────────────────────────────────────────────────────────  widget  ── */

export class SketchPad {
  constructor(opts) {
    const {
      container, width, height, strokes = [], background = null,
      readOnly = false, onChange = null, toolbar = true,
    } = opts;
    if (!container) throw new Error('SketchPad: container is required');
    if (!width || !height) throw new Error('SketchPad: width and height are required');

    this.container = container;
    this.width = width;
    this.height = height;
    this.readOnly = readOnly;
    this.onChange = onChange;
    this.showToolbar = toolbar;

    this.strokes = strokes.map(cloneStroke);
    this.undoStack = [];
    this.redoStack = [];

    this.tool = 'pen';
    this.color = COLORS[0];
    this.size = SIZES[1];

    this._active = null;
    this._drawBefore = null;
    this._eraseBefore = null;
    this._eraseChanged = false;
    this._changeTimer = null;
    this._bgImage = null;
    this._bgReady = Promise.resolve();

    injectStyle();
    this._buildDom();
    this._bindEvents();
    this._resizeCanvases();
    if (background) this._loadBackground(background);
    this._replay();
    this._updateToolbarState();
  }

  /* ────────────────────────────────────────────────────────  dom  ── */

  _buildDom() {
    this.root = document.createElement('div');
    this.root.className = 'sketch';

    if (this.showToolbar) {
      this.toolbarEl = this._buildToolbar();
      if (this.readOnly) {
        this.toolbarEl.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      }
      this.root.append(this.toolbarEl);
    }

    this.wrap = document.createElement('div');
    this.wrap.className = 'sketch__canvas-wrap';
    this.wrap.style.width = `${this.width}px`;
    this.wrap.style.height = `${this.height}px`;

    this.bgCanvas = document.createElement('canvas');
    this.bgCanvas.className = 'sketch__canvas sketch__canvas--bg';
    this.inkCanvas = document.createElement('canvas');
    this.inkCanvas.className = 'sketch__canvas sketch__canvas--ink';

    this.wrap.append(this.bgCanvas, this.inkCanvas);
    this.root.append(this.wrap);
    this.container.append(this.root);

    this.bgCtx = this.bgCanvas.getContext('2d');
    this.inkCtx = this.inkCanvas.getContext('2d');
  }

  _buildToolbar() {
    const sep = () => {
      const s = document.createElement('span');
      s.className = 'sketch__sep';
      return s;
    };

    const bar = document.createElement('div');
    bar.className = 'sketch__toolbar';

    const tools = document.createElement('div');
    tools.className = 'sketch__group';
    this._toolButtons = {};
    for (const [tool, label] of [['pen', 'Pen'], ['highlighter', 'Marker'], ['eraser', 'Eraser']]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sketch__btn';
      btn.textContent = label;
      btn.addEventListener('click', () => this.setTool(tool));
      this._toolButtons[tool] = btn;
      tools.append(btn);
    }

    const colors = document.createElement('div');
    colors.className = 'sketch__group';
    this._colorButtons = {};
    for (const color of COLORS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sketch__swatch';
      btn.style.background = color;
      btn.setAttribute('aria-label', `Color ${color}`);
      btn.addEventListener('click', () => this.setColor(color));
      this._colorButtons[color] = btn;
      colors.append(btn);
    }

    const sizes = document.createElement('div');
    sizes.className = 'sketch__group';
    this._sizeButtons = {};
    for (const size of SIZES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sketch__size';
      const dot = document.createElement('i');
      dot.style.width = `${size + 4}px`;
      dot.style.height = `${size + 4}px`;
      btn.append(dot);
      btn.setAttribute('aria-label', `Size ${size}`);
      btn.addEventListener('click', () => this.setSize(size));
      this._sizeButtons[size] = btn;
      sizes.append(btn);
    }

    const history = document.createElement('div');
    history.className = 'sketch__group';
    this.undoBtn = document.createElement('button');
    this.undoBtn.type = 'button';
    this.undoBtn.className = 'sketch__btn';
    this.undoBtn.textContent = 'Undo';
    this.undoBtn.addEventListener('click', () => this.undo());
    this.redoBtn = document.createElement('button');
    this.redoBtn.type = 'button';
    this.redoBtn.className = 'sketch__btn';
    this.redoBtn.textContent = 'Redo';
    this.redoBtn.addEventListener('click', () => this.redo());
    this.clearBtn = document.createElement('button');
    this.clearBtn.type = 'button';
    this.clearBtn.className = 'sketch__btn';
    this.clearBtn.textContent = 'Clear';
    this.clearBtn.addEventListener('click', () => this.clear());
    history.append(this.undoBtn, this.redoBtn, this.clearBtn);

    bar.append(tools, sep(), colors, sep(), sizes, sep(), history);
    return bar;
  }

  _updateToolbarState() {
    if (!this.toolbarEl) return;
    for (const [tool, btn] of Object.entries(this._toolButtons)) {
      btn.setAttribute('aria-pressed', String(tool === this.tool));
    }
    for (const [color, btn] of Object.entries(this._colorButtons)) {
      btn.setAttribute('aria-pressed', String(color === this.color));
    }
    for (const [size, btn] of Object.entries(this._sizeButtons)) {
      btn.setAttribute('aria-pressed', String(Number(size) === this.size));
    }
    this.undoBtn.disabled = !this.undoStack.length;
    this.redoBtn.disabled = !this.redoStack.length;
  }

  /* ─────────────────────────────────────────────────────  canvas  ── */

  _resizeCanvases() {
    this.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    for (const canvas of [this.bgCanvas, this.inkCanvas]) {
      canvas.width = Math.round(this.width * this.dpr);
      canvas.height = Math.round(this.height * this.dpr);
      canvas.style.width = `${this.width}px`;
      canvas.style.height = `${this.height}px`;
    }
    // Coordinate system stays logical px so saved strokes replay identically
    // at any DPR — only the backing store is high-res.
    this.bgCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.inkCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  _loadBackground(url) {
    this._bgReady = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { this._bgImage = img; this._drawBackground(); resolve(); };
      img.onerror = () => resolve();
      img.src = url;
    });
  }

  _drawBackground() {
    this.bgCtx.clearRect(0, 0, this.width, this.height);
    if (this._bgImage) this.bgCtx.drawImage(this._bgImage, 0, 0, this.width, this.height);
  }

  _replay() {
    const ctx = this.inkCtx;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    for (const s of this.strokes) renderStrokeFull(ctx, s);
  }

  _drawDot(stroke) {
    const ctx = this.inkCtx;
    applyStrokeStyle(ctx, stroke);
    const p = stroke.points[0];
    ctx.beginPath();
    ctx.arc(p[0], p[1], renderWidth(stroke) / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Live drawing only paints the newest segment — full replay is reserved
  // for undo/redo/clear/setStrokes so a long stroke stays cheap to draw.
  _drawIncremental(stroke, i) {
    const ctx = this.inkCtx;
    const pts = stroke.points;
    applyStrokeStyle(ctx, stroke);
    ctx.beginPath();
    if (i === 1) {
      ctx.moveTo(pts[0][0], pts[0][1]);
      ctx.lineTo(pts[1][0], pts[1][1]);
    } else {
      const p1 = pts[i - 1];
      const p2 = pts[i];
      const m0 = midpoint(pts[i - 2], p1);
      const m1 = midpoint(p1, p2);
      ctx.moveTo(m0[0], m0[1]);
      ctx.quadraticCurveTo(p1[0], p1[1], m1[0], m1[1]);
    }
    ctx.stroke();
  }

  _toLogical(e) {
    const rect = this.inkCanvas.getBoundingClientRect();
    const x = clamp((e.clientX - rect.left) * (this.width / rect.width), 0, this.width);
    const y = clamp((e.clientY - rect.top) * (this.height / rect.height), 0, this.height);
    return [x, y];
  }

  /* ─────────────────────────────────────────────────────  pointer  ── */

  _bindEvents() {
    this._onDown = this._onPointerDown.bind(this);
    this._onMove = this._onPointerMove.bind(this);
    this._onUp = this._onPointerUp.bind(this);
    this.inkCanvas.addEventListener('pointerdown', this._onDown, { passive: false });
    this.inkCanvas.addEventListener('pointermove', this._onMove, { passive: false });
    this.inkCanvas.addEventListener('pointerup', this._onUp, { passive: false });
    this.inkCanvas.addEventListener('pointercancel', this._onUp, { passive: false });
  }

  _onPointerDown(e) {
    if (this.readOnly || !e.isPrimary) return;
    e.preventDefault();
    this.inkCanvas.setPointerCapture(e.pointerId);
    const pt = this._toLogical(e);
    if (this.tool === 'eraser') {
      this._eraseBefore = this.strokes.map(cloneStroke);
      this._eraseChanged = false;
      this._eraseAt(pt);
    } else {
      this._drawBefore = this.strokes.map(cloneStroke);
      this._active = { tool: this.tool, color: this.color, size: this.size, points: [pt] };
      this._drawDot(this._active);
    }
  }

  _onPointerMove(e) {
    if (this.readOnly || !e.isPrimary) return;
    e.preventDefault();
    const pt = this._toLogical(e);
    if (this.tool === 'eraser') {
      if (this._eraseBefore) this._eraseAt(pt);
      return;
    }
    if (!this._active) return;
    const pts = this._active.points;
    if (dist(pts[pts.length - 1], pt) < MIN_MOVE) return;
    pts.push(pt);
    this._drawIncremental(this._active, pts.length - 1);
  }

  _onPointerUp(e) {
    if (this.readOnly || !e.isPrimary) return;
    e.preventDefault();
    try { this.inkCanvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (this.tool === 'eraser') {
      if (this._eraseChanged) {
        this._pushUndo(this._eraseBefore);
        this._scheduleChange();
      }
      this._eraseBefore = null;
      this._eraseChanged = false;
      return;
    }
    if (!this._active) return;
    const stroke = finalizeStroke(this._active);
    this._pushUndo(this._drawBefore);
    this.strokes.push(stroke);
    this._active = null;
    this._drawBefore = null;
    this._scheduleChange();
  }

  _eraseAt(pt) {
    const eraseR = Math.max(this.size * 1.5, 10);
    let changed = false;
    for (let i = this.strokes.length - 1; i >= 0; i -= 1) {
      if (strokeHit(this.strokes[i], pt, eraseR)) {
        this.strokes.splice(i, 1);
        changed = true;
      }
    }
    if (changed) {
      this._eraseChanged = true;
      this._replay();
    }
  }

  /* ─────────────────────────────────────────────────────  history  ── */

  _pushUndo(before) {
    this.undoStack.push(before);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
    this._updateToolbarState();
  }

  _scheduleChange() {
    if (!this.onChange) return;
    clearTimeout(this._changeTimer);
    this._changeTimer = setTimeout(() => this.onChange(this.getStrokes()), 600);
  }

  undo() {
    if (!this.undoStack.length) return;
    const prev = this.undoStack.pop();
    this.redoStack.push(this.strokes.map(cloneStroke));
    if (this.redoStack.length > MAX_HISTORY) this.redoStack.shift();
    this.strokes = prev;
    this._replay();
    this._updateToolbarState();
    this._scheduleChange();
  }

  redo() {
    if (!this.redoStack.length) return;
    const next = this.redoStack.pop();
    this.undoStack.push(this.strokes.map(cloneStroke));
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.strokes = next;
    this._replay();
    this._updateToolbarState();
    this._scheduleChange();
  }

  clear() {
    if (!this.strokes.length) return;
    this._pushUndo(this.strokes.map(cloneStroke));
    this.strokes = [];
    this._replay();
    this._scheduleChange();
  }

  /* ─────────────────────────────────────────────────────  public  ── */

  getStrokes() {
    return this.strokes.map(cloneStroke);
  }

  setStrokes(strokes) {
    this.strokes = (strokes || []).map(cloneStroke);
    this.undoStack = [];
    this.redoStack = [];
    this._replay();
    this._updateToolbarState();
  }

  setTool(tool) {
    this.tool = tool;
    this._updateToolbarState();
  }

  setColor(color) {
    this.color = color;
    this._updateToolbarState();
  }

  setSize(n) {
    this.size = n;
    this._updateToolbarState();
  }

  get isEmpty() {
    return this.strokes.length === 0;
  }

  toBlob() {
    return new Promise((resolve) => {
      this.inkCanvas.toBlob((blob) => resolve(blob || new Blob([], { type: 'image/png' })), 'image/png');
    });
  }

  async toFlatBlob() {
    await this._bgReady;
    return new Promise((resolve) => {
      const out = document.createElement('canvas');
      out.width = this.inkCanvas.width;
      out.height = this.inkCanvas.height;
      const ctx = out.getContext('2d');
      ctx.drawImage(this.bgCanvas, 0, 0);
      ctx.drawImage(this.inkCanvas, 0, 0);
      out.toBlob((blob) => resolve(blob || new Blob([], { type: 'image/png' })), 'image/png');
    });
  }

  destroy() {
    clearTimeout(this._changeTimer);
    this.inkCanvas.removeEventListener('pointerdown', this._onDown);
    this.inkCanvas.removeEventListener('pointermove', this._onMove);
    this.inkCanvas.removeEventListener('pointerup', this._onUp);
    this.inkCanvas.removeEventListener('pointercancel', this._onUp);
    this.root.remove();
  }
}
