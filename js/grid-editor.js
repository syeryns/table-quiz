// 격자 수동 보정 UI. 확대·이동이 되는 그림 화면(ImageView) 위에 편집 도구를 얹는다.

const MOVE_SLOP = 8;       // 이만큼 움직이면 탭이 아니라 끌기 (CSS px)
const LONG_PRESS_MS = 500;
const HIT_PX = 20;         // 손가락으로 선을 잡는 허용 거리 (CSS px)

// 그림 하나를 확대·이동해서 보여주는 canvas.
// 한 손가락 동작은 tool(down/move/up/tap/longPress/cancel)에 넘기고,
// tool이 잡지 않은 한 손가락 끌기와 두 손가락 핀치는 화면 이동·확대로 쓴다.
export class ImageView {
  constructor(tool) {
    this.tool = tool;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'image-view';
    this.ctx = this.canvas.getContext('2d');
    this.source = null;
    this.scale = 1; this.tx = 0; this.ty = 0;
    this.fitScale = 1;
    this.pointers = new Map();
    this.gesture = null;
    this.drawQueued = false;

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onUp(e, true));
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => this.resize()).observe(c);
  }

  setSource(source, { keepView = false } = {}) {
    this.source = source;
    if (!keepView) this.fit(); else this.requestDraw();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    const first = !this.cssW;
    this.cssW = w; this.cssH = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    if (first) this.fit(); else this.requestDraw();
  }

  fit() {
    if (!this.source || !this.cssW) return;
    const pad = 12;
    const sw = this.source.width, sh = this.source.height;
    this.fitScale = Math.min((this.cssW - pad * 2) / sw, (this.cssH - pad * 2) / sh);
    this.scale = this.fitScale;
    this.tx = (this.cssW - sw * this.scale) / 2;
    this.ty = (this.cssH - sh * this.scale) / 2;
    this.requestDraw();
  }

  // 화면 좌표 → 그림 좌표
  toImage(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left - this.tx) / this.scale,
      y: (e.clientY - r.top - this.ty) / this.scale,
    };
  }

  // CSS px 거리를 그림 px 거리로
  px(n) { return n / this.scale; }

  requestDraw() {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => { this.drawQueued = false; this.draw(); });
  }

  draw() {
    const { ctx, canvas } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.source) return;
    ctx.setTransform(dpr * this.scale, 0, 0, dpr * this.scale, dpr * this.tx, dpr * this.ty);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.source, 0, 0);
    this.tool?.draw?.(ctx, this);
  }

  zoomAt(cx, cy, newScale) {
    const s = Math.min(this.fitScale * 10, Math.max(this.fitScale * 0.8, newScale));
    const ix = (cx - this.tx) / this.scale, iy = (cy - this.ty) / this.scale;
    this.scale = s;
    this.tx = cx - ix * s;
    this.ty = cy - iy * s;
    this.requestDraw();
  }

  onWheel(e) {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    this.zoomAt(e.clientX - r.left, e.clientY - r.top, this.scale * Math.exp(-e.deltaY * 0.002));
  }

  onDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size === 2) {
      // 두 손가락: 진행 중이던 한 손가락 동작을 취소하고 핀치로
      if (this.gesture?.captured) this.tool?.cancel?.();
      clearTimeout(this.gesture?.timer);
      const [a, b] = [...this.pointers.values()];
      const r = this.canvas.getBoundingClientRect();
      this.gesture = {
        type: 'pinch',
        d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        m0: { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top },
        s0: this.scale, t0: { x: this.tx, y: this.ty },
      };
      return;
    }
    if (this.pointers.size > 2) return;

    const pt = this.toImage(e);
    const g = {
      type: 'single', id: e.pointerId,
      start: { x: e.clientX, y: e.clientY },
      t0: { x: this.tx, y: this.ty },
      moved: false, longPressed: false,
      captured: !!this.tool?.down?.(pt, this),
    };
    g.timer = setTimeout(() => {
      if (this.gesture !== g || g.moved) return;
      g.longPressed = true;
      this.tool?.longPress?.(pt, this);
    }, LONG_PRESS_MS);
    this.gesture = g;
  }

  onMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = this.gesture;
    if (!g) return;

    if (g.type === 'pinch') {
      const [a, b] = [...this.pointers.values()];
      if (!b) return;
      const r = this.canvas.getBoundingClientRect();
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const m = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
      const s = Math.min(this.fitScale * 10, Math.max(this.fitScale * 0.8, g.s0 * d / g.d0));
      const ix = (g.m0.x - g.t0.x) / g.s0, iy = (g.m0.y - g.t0.y) / g.s0;
      this.scale = s;
      this.tx = m.x - ix * s;
      this.ty = m.y - iy * s;
      this.requestDraw();
      return;
    }

    if (e.pointerId !== g.id || g.longPressed) return;
    const dx = e.clientX - g.start.x, dy = e.clientY - g.start.y;
    if (!g.moved && Math.hypot(dx, dy) > MOVE_SLOP) {
      g.moved = true;
      clearTimeout(g.timer);
    }
    if (!g.moved) return;
    if (g.captured) {
      this.tool.move?.(this.toImage(e), this);
    } else {
      this.tx = g.t0.x + dx;
      this.ty = g.t0.y + dy;
      this.requestDraw();
    }
  }

  onUp(e, cancelled = false) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.type === 'pinch') {
      if (this.pointers.size === 0) this.gesture = null;
      return;
    }
    if (e.pointerId !== g.id) return;
    clearTimeout(g.timer);
    this.gesture = null;
    const pt = this.toImage(e);
    if (cancelled) {
      if (g.captured) this.tool?.cancel?.();
      return;
    }
    if (g.captured) this.tool.up?.(pt, { moved: g.moved, longPressed: g.longPressed }, this);
    if (!g.moved && !g.longPressed) this.tool?.tap?.(pt, this);
  }
}

// ---- 격자 선 편집 ----

const clone = (g) => ({ xs: [...g.xs], ys: [...g.ys] });

export class GridEditor {
  constructor({ onChange } = {}) {
    this.grid = { xs: [], ys: [] };
    this.history = [];
    this.addAxis = 'y';    // 'y' = 가로선 추가, 'x' = 세로선 추가
    this.drag = null;
    this.onChange = onChange || (() => {});
    this.view = new ImageView(this);
  }

  setImage(canvas, grid) {
    this.size = { w: canvas.width, h: canvas.height };
    this.grid = clone(grid);
    this.history = [];
    this.view.setSource(canvas);
    this.onChange();
  }

  setGrid(grid) {
    this.snapshot();
    this.grid = clone(grid);
    this.changed();
  }

  snapshot() { this.history.push(clone(this.grid)); }

  undo() {
    const prev = this.history.pop();
    if (!prev) return;
    this.grid = prev;
    this.changed();
  }

  changed() {
    this.view.requestDraw();
    this.onChange();
  }

  hit(pt) {
    const tol = this.view.px(HIT_PX);
    let best = null;
    for (const axis of ['x', 'y']) {
      const arr = axis === 'x' ? this.grid.xs : this.grid.ys;
      const v = axis === 'x' ? pt.x : pt.y;
      arr.forEach((p, i) => {
        const d = Math.abs(p - v);
        if (d <= tol && (!best || d < best.d)) best = { axis, i, d };
      });
    }
    return best;
  }

  clampPos(axis, v) {
    const max = axis === 'x' ? this.size.w - 1 : this.size.h - 1;
    return Math.round(Math.min(max, Math.max(0, v)));
  }

  down(pt) {
    const hit = this.hit(pt);
    if (!hit) return false;
    this.snapshot();
    this.drag = { axis: hit.axis, i: hit.i, from: (hit.axis === 'x' ? this.grid.xs : this.grid.ys)[hit.i] };
    this.view.requestDraw();
    return true;
  }

  move(pt) {
    if (!this.drag) return;
    const arr = this.drag.axis === 'x' ? this.grid.xs : this.grid.ys;
    arr[this.drag.i] = this.clampPos(this.drag.axis, this.drag.axis === 'x' ? pt.x : pt.y);
    this.view.requestDraw();
  }

  up(pt, { moved }) {
    if (!this.drag) return;
    const arr = this.drag.axis === 'x' ? this.grid.xs : this.grid.ys;
    if (!moved || arr[this.drag.i] === this.drag.from) {
      this.history.pop(); // 바뀐 게 없으면 실행 취소 기록도 남기지 않음
    } else {
      arr.sort((a, b) => a - b);
      this.onChange();
    }
    this.drag = null;
    this.view.requestDraw();
  }

  cancel() {
    if (!this.drag) return;
    this.grid = this.history.pop();
    this.drag = null;
    this.view.requestDraw();
  }

  tap(pt) {
    if (this.hit(pt)) return;
    if (pt.x < 0 || pt.y < 0 || pt.x >= this.size.w || pt.y >= this.size.h) return;
    const axis = this.addAxis;
    this.snapshot();
    const arr = axis === 'x' ? this.grid.xs : this.grid.ys;
    arr.push(this.clampPos(axis, axis === 'x' ? pt.x : pt.y));
    arr.sort((a, b) => a - b);
    this.changed();
  }

  longPress() {
    if (!this.drag) return;
    // down에서 남긴 기록을 삭제의 실행 취소 기록으로 그대로 쓴다
    const arr = this.drag.axis === 'x' ? this.grid.xs : this.grid.ys;
    arr.splice(this.drag.i, 1);
    this.drag = null;
    this.changed();
  }

  draw(ctx, view) {
    const lw = view.px(2);
    const { w, h } = this.size;
    const styles = getComputedStyle(document.documentElement);
    const color = styles.getPropertyValue('--line').trim() || '#e5484d';
    const active = styles.getPropertyValue('--highlight').trim() || '#f2c94c';
    for (const axis of ['x', 'y']) {
      const arr = axis === 'x' ? this.grid.xs : this.grid.ys;
      arr.forEach((p, i) => {
        const isActive = this.drag && this.drag.axis === axis && this.drag.i === i;
        ctx.strokeStyle = isActive ? active : color;
        ctx.lineWidth = isActive ? lw * 2 : lw;
        ctx.beginPath();
        if (axis === 'x') { ctx.moveTo(p + 0.5, 0); ctx.lineTo(p + 0.5, h); }
        else { ctx.moveTo(0, p + 0.5); ctx.lineTo(w, p + 0.5); }
        ctx.stroke();
      });
    }
  }
}

// ---- 병합 칸 지정 ----

export class MergeEditor {
  constructor({ onChange } = {}) {
    this.grid = null;
    this.merges = [];       // [{ col, r0, r1 }]
    this.suggestions = [];
    this.hasHeader = false;
    this.sel = null;
    this.onChange = onChange || (() => {});
    this.view = new ImageView(this);
  }

  setImage(canvas, grid, merges, suggestions) {
    this.grid = grid;
    this.merges = merges.map((m) => ({ ...m }));
    this.suggestions = suggestions;
    this.view.setSource(canvas);
    this.onChange();
  }

  get rows() { return this.grid.ys.length - 1; }
  get cols() { return this.grid.xs.length - 1; }

  cellAt(pt, col = null) {
    const { xs, ys } = this.grid;
    const c = col ?? xs.findIndex((x, i) => i < xs.length - 1 && pt.x >= x && pt.x < xs[i + 1]);
    if (c < 0) return null;
    let r = ys.findIndex((y, i) => i < ys.length - 1 && pt.y >= y && pt.y < ys[i + 1]);
    if (r < 0) {
      if (col == null) return null;
      r = pt.y < ys[0] ? 0 : this.rows - 1; // 끌다가 표 밖으로 나가면 끝 행
    }
    return { col: c, row: r };
  }

  mergeAt(cell) {
    return this.merges.find((m) => m.col === cell.col && cell.row >= m.r0 && cell.row <= m.r1);
  }

  addMerge(m) {
    let { col, r0, r1 } = m;
    // 겹치는 기존 병합은 하나로 합친다
    const keep = [];
    for (const o of this.merges) {
      if (o.col === col && o.r0 <= r1 && o.r1 >= r0) {
        r0 = Math.min(r0, o.r0); r1 = Math.max(r1, o.r1);
      } else keep.push(o);
    }
    keep.push({ col, r0, r1 });
    this.merges = keep;
  }

  applySuggestions() {
    for (const s of this.suggestions) this.addMerge(s);
    this.changed();
  }

  clearMerges() {
    this.merges = [];
    this.changed();
  }

  // 아직 적용하지 않은 제안
  get pending() {
    return this.suggestions.filter((s) =>
      !this.merges.some((m) => m.col === s.col && m.r0 <= s.r0 && m.r1 >= s.r1));
  }

  changed() {
    this.view.requestDraw();
    this.onChange();
  }

  down(pt) {
    const cell = this.cellAt(pt);
    if (!cell) return false;
    this.sel = { col: cell.col, r0: cell.row, r1: cell.row };
    this.view.requestDraw();
    return true;
  }

  move(pt) {
    if (!this.sel) return;
    const cell = this.cellAt(pt, this.sel.col);
    if (cell) this.sel.r1 = cell.row;
    this.view.requestDraw();
  }

  up() {
    const s = this.sel;
    this.sel = null;
    if (s && s.r0 !== s.r1) {
      this.addMerge({ col: s.col, r0: Math.min(s.r0, s.r1), r1: Math.max(s.r0, s.r1) });
      this.changed();
    } else this.view.requestDraw();
  }

  cancel() {
    this.sel = null;
    this.view.requestDraw();
  }

  tap(pt) {
    const cell = this.cellAt(pt);
    if (!cell) return;
    const m = this.mergeAt(cell);
    if (m) {
      this.merges = this.merges.filter((o) => o !== m);
      this.changed();
      return;
    }
    const s = this.pending.find((o) => o.col === cell.col && cell.row >= o.r0 && cell.row <= o.r1);
    if (s) { this.addMerge(s); this.changed(); }
  }

  rect(col, r0, r1) {
    const { xs, ys } = this.grid;
    return [xs[col], ys[r0], xs[col + 1] - xs[col], ys[r1 + 1] - ys[r0]];
  }

  draw(ctx, view) {
    const styles = getComputedStyle(document.documentElement);
    const line = styles.getPropertyValue('--line').trim() || '#e5484d';
    const accent = styles.getPropertyValue('--accent').trim() || '#2f6fdb';
    const hl = styles.getPropertyValue('--highlight').trim() || '#f2c94c';
    const { xs, ys } = this.grid;
    const w = xs[xs.length - 1], h = ys[ys.length - 1];
    const lw = view.px(1.5);

    if (this.hasHeader) {
      ctx.fillStyle = 'rgba(120, 120, 120, 0.22)';
      ctx.fillRect(xs[0], ys[0], w - xs[0], ys[1] - ys[0]);
    }

    ctx.strokeStyle = line;
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (const x of xs) { ctx.moveTo(x, ys[0]); ctx.lineTo(x, h); }
    for (const y of ys) { ctx.moveTo(xs[0], y); ctx.lineTo(w, y); }
    ctx.stroke();

    // 적용 안 한 제안: 노란 점선
    ctx.setLineDash([view.px(6), view.px(4)]);
    ctx.strokeStyle = hl;
    ctx.lineWidth = view.px(3);
    for (const s of this.pending) {
      const [x, y, rw, rh] = this.rect(s.col, s.r0, s.r1);
      ctx.strokeRect(x + lw * 2, y + lw * 2, rw - lw * 4, rh - lw * 4);
    }
    ctx.setLineDash([]);

    // 확정된 병합: 칠한 상자
    const inset = view.px(3);
    for (const m of this.merges) {
      const [x, y, rw, rh] = this.rect(m.col, m.r0, m.r1);
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = accent;
      ctx.fillRect(x, y, rw, rh);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = accent;
      ctx.lineWidth = view.px(3);
      ctx.strokeRect(x + inset, y + inset, rw - inset * 2, rh - inset * 2);
    }

    if (this.sel) {
      const r0 = Math.min(this.sel.r0, this.sel.r1), r1 = Math.max(this.sel.r0, this.sel.r1);
      const [x, y, rw, rh] = this.rect(this.sel.col, r0, r1);
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = hl;
      ctx.fillRect(x, y, rw, rh);
      ctx.globalAlpha = 1;
    }
  }
}
