// 가져오기 화면: 사진 선택 → 자르기·회전 → 격자 → 병합 → 저장

import * as db from './db.js';
import { h, toast, go } from './ui.js';
import { analyze, detectGrid, edgeGrid, suggestMerges } from './grid-detect.js';
import { ImageView, GridEditor, MergeEditor } from './grid-editor.js';
import { loadImageFile, scaleTo, rotateCanvas, cropCanvas, canvasToBlob, cropCells } from './cropper.js';

const STEPS = [
  ['pick', '사진'],
  ['crop', '자르기'],
  ['grid', '격자'],
  ['merge', '병합'],
];
const PREVIEW_EDGE = 1200;
const MIN_CROP = 0.05;
const HANDLE_PX = 26;

export function importScreen() {
  const s = {
    step: 'pick',
    src: null,          // 줄인 원본
    preview: null,      // 자르기 화면용 작은 원본
    rot90: 0, fine: 0,
    crop: { x0: 0, y0: 0, x1: 1, y1: 1 },
    work: null,         // 회전·자르기를 마친 그림. 격자 좌표의 기준
    an: null, grid: null, thickness: 2, found: true,
    merges: [], suggestions: [], mergeFor: null,
    hasHeader: true,
  };

  const body = h('div', { class: 'import-body' });
  const stepper = h('ol', { class: 'stepper' });
  const screen = h('section', { class: 'screen fill import' },
    h('header', { class: 'bar' },
      h('button', { class: 'btn', onclick: () => go('#/') }, '취소'),
      stepper,
      h('span', { class: 'bar-spacer' })),
    body);

  function show(step) {
    s.step = step;
    stepper.replaceChildren(...STEPS.map(([key, label], i) =>
      h('li', { class: key === step ? 'on' : '' }, `${i + 1} ${label}`)));
    body.replaceChildren(({ pick: pickStep, crop: cropStep, grid: gridStep, merge: mergeStep })[step](s, show));
  }
  show('pick');
  return screen;
}

// ---- 1 사진 선택 ----

function pickStep(s, show) {
  const input = h('input', { type: 'file', accept: 'image/*', class: 'visually-hidden' });
  const status = h('p', { class: 'muted' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    status.textContent = '불러오는 중…';
    try {
      s.src = await loadImageFile(file);
      s.preview = scaleTo(s.src, s.src.width, s.src.height, PREVIEW_EDGE);
      s.rot90 = 0; s.fine = 0;
      s.crop = { x0: 0, y0: 0, x1: 1, y1: 1 };
      s.work = null;
      show('crop');
    } catch (e) {
      console.error(e);
      status.textContent = '';
      toast('사진을 열지 못했어요');
    }
  });
  return h('div', { class: 'content center' },
    h('label', { class: 'btn primary big' }, '사진 선택', input),
    h('p', { class: 'hint' }, '강의 PDF는 스크린샷으로 넣으면 칸 인식이 잘 돼요'),
    status);
}

// ---- 2 자르기·회전 ----

class CropTool {
  constructor(s) { this.s = s; this.drag = null; }

  rectPx(view) {
    const { width: w, height: hgt } = view.source;
    const c = this.s.crop;
    return { x0: c.x0 * w, y0: c.y0 * hgt, x1: c.x1 * w, y1: c.y1 * hgt, w, h: hgt };
  }

  down(pt, view) {
    const r = this.rectPx(view);
    const tol = view.px(HANDLE_PX);
    const near = (a, b) => Math.abs(a - b) <= tol;
    const inY = pt.y >= r.y0 - tol && pt.y <= r.y1 + tol;
    const inX = pt.x >= r.x0 - tol && pt.x <= r.x1 + tol;
    const edges = {
      x0: near(pt.x, r.x0) && inY, x1: near(pt.x, r.x1) && inY,
      y0: near(pt.y, r.y0) && inX, y1: near(pt.y, r.y1) && inX,
    };
    // 양쪽 가장자리가 다 가까우면(작은 상자) 더 가까운 쪽만
    if (edges.x0 && edges.x1) edges[Math.abs(pt.x - r.x0) < Math.abs(pt.x - r.x1) ? 'x1' : 'x0'] = false;
    if (edges.y0 && edges.y1) edges[Math.abs(pt.y - r.y0) < Math.abs(pt.y - r.y1) ? 'y1' : 'y0'] = false;
    const keys = Object.keys(edges).filter((k) => edges[k]);
    const inside = pt.x > r.x0 && pt.x < r.x1 && pt.y > r.y0 && pt.y < r.y1;
    if (!keys.length && !inside) return false;
    this.drag = { keys, start: pt, from: { ...this.s.crop }, w: r.w, h: r.h };
    return true;
  }

  move(pt, view) {
    const d = this.drag;
    if (!d) return;
    const dx = (pt.x - d.start.x) / d.w, dy = (pt.y - d.start.y) / d.h;
    const c = { ...d.from };
    if (!d.keys.length) {
      const mx = Math.min(Math.max(dx, -c.x0), 1 - c.x1);
      const my = Math.min(Math.max(dy, -c.y0), 1 - c.y1);
      c.x0 += mx; c.x1 += mx; c.y0 += my; c.y1 += my;
    }
    if (d.keys.includes('x0')) c.x0 = Math.min(Math.max(0, d.from.x0 + dx), c.x1 - MIN_CROP);
    if (d.keys.includes('x1')) c.x1 = Math.max(Math.min(1, d.from.x1 + dx), c.x0 + MIN_CROP);
    if (d.keys.includes('y0')) c.y0 = Math.min(Math.max(0, d.from.y0 + dy), c.y1 - MIN_CROP);
    if (d.keys.includes('y1')) c.y1 = Math.max(Math.min(1, d.from.y1 + dy), c.y0 + MIN_CROP);
    this.s.crop = c;
    view.requestDraw();
  }

  up() { this.drag = null; }
  cancel() { if (this.drag) this.s.crop = this.drag.from; this.drag = null; }

  draw(ctx, view) {
    const r = this.rectPx(view);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.beginPath();
    ctx.rect(0, 0, r.w, r.h);
    ctx.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = view.px(2);
    ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    // 모서리 손잡이
    const L = view.px(22), T = view.px(5);
    ctx.fillStyle = '#fff';
    for (const [x, y, sx, sy] of [[r.x0, r.y0, 1, 1], [r.x1, r.y0, -1, 1], [r.x0, r.y1, 1, -1], [r.x1, r.y1, -1, -1]]) {
      ctx.fillRect(sx > 0 ? x : x - L, sy > 0 ? y : y - T, L, T);
      ctx.fillRect(sx > 0 ? x : x - T, sy > 0 ? y : y - L, T, L);
    }
  }
}

function cropStep(s, show) {
  const tool = new CropTool(s);
  const view = new ImageView(tool);
  const rotated = document.createElement('canvas');
  const angle = () => s.rot90 * 90 + s.fine;
  const redraw = (keepView) => {
    rotateCanvas(s.preview, angle(), rotated);
    view.setSource(rotated, { keepView });
  };

  const fineLabel = h('output', { class: 'fine-value' });
  const slider = h('input', { type: 'range', min: -5, max: 5, step: 0.5, value: s.fine, 'aria-label': '미세 회전' });
  const setFine = (v) => {
    s.fine = v;
    slider.value = v;
    fineLabel.textContent = `${v > 0 ? '+' : ''}${v}°`;
    redraw(true);
  };
  slider.addEventListener('input', () => setFine(Number(slider.value)));

  const turn = (d) => {
    s.rot90 = (s.rot90 + d + 4) % 4;
    // 90° 돌리면 자르기 상자도 함께 돌린다
    const c = s.crop;
    s.crop = d > 0
      ? { x0: 1 - c.y1, y0: c.x0, x1: 1 - c.y0, y1: c.x1 }
      : { x0: c.y0, y0: 1 - c.x1, x1: c.y1, y1: 1 - c.x0 };
    redraw(false);
  };

  const next = async () => {
    nextBtn.disabled = true;
    nextBtn.textContent = '처리 중…';
    await new Promise((r) => setTimeout(r, 30)); // 버튼 상태를 먼저 그림
    try {
      const full = rotateCanvas(s.src, angle());
      s.work = cropCanvas(full, s.crop);
      s.an = analyze(s.work);
      const res = detectGrid(s.an);
      s.grid = res.grid; s.thickness = res.thickness; s.found = res.found;
      s.mergeFor = null;
      if (!res.found) toast('선을 찾지 못했어요');
      show('grid');
    } catch (e) {
      console.error(e);
      toast('처리하지 못했어요');
      nextBtn.disabled = false;
      nextBtn.textContent = '다음';
    }
  };
  const nextBtn = h('button', { class: 'btn primary', onclick: next }, '다음');

  setFine(s.fine);
  return h('div', { class: 'editor' },
    h('div', { class: 'stage' }, view.canvas),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn', onclick: () => show('pick') }, '이전'),
      h('button', { class: 'btn', onclick: () => turn(-1), 'aria-label': '왼쪽으로 90도 회전' }, '↺ 90°'),
      h('button', { class: 'btn', onclick: () => turn(1), 'aria-label': '오른쪽으로 90도 회전' }, '↻ 90°'),
      h('label', { class: 'fine' }, slider, fineLabel),
      h('button', { class: 'btn', onclick: () => { s.crop = { x0: 0, y0: 0, x1: 1, y1: 1 }; view.requestDraw(); } }, '전체'),
      h('span', { class: 'grow' }),
      nextBtn));
}

// ---- 3 격자 ----

function gridStep(s, show) {
  const count = h('span', { class: 'count' });
  const undoBtn = h('button', { class: 'btn', onclick: () => editor.undo() }, '실행 취소');
  const nextBtn = h('button', { class: 'btn primary', onclick: () => {
    s.grid = editor.grid;
    show('merge');
  } }, '다음');

  const editor = new GridEditor({
    onChange: () => {
      const g = editor.grid;
      const rows = g.ys.length - 1, cols = g.xs.length - 1;
      count.textContent = `${Math.max(0, rows)}행 × ${Math.max(0, cols)}열`;
      undoBtn.disabled = !editor.history.length;
      nextBtn.disabled = rows < 1 || cols < 1;
    },
  });

  const axisBtns = [['y', '가로선'], ['x', '세로선']].map(([axis, label]) =>
    h('button', {
      class: 'seg-btn', 'aria-pressed': String(editor.addAxis === axis),
      onclick: (e) => {
        editor.addAxis = axis;
        for (const b of axisBtns) b.setAttribute('aria-pressed', String(b === e.currentTarget));
      },
    }, label));

  const redetect = () => {
    const res = detectGrid(s.an);
    s.thickness = res.thickness;
    editor.setGrid(res.grid);
    toast(res.found ? '다시 찾았어요' : '선을 찾지 못했어요');
  };

  editor.setImage(s.work, s.grid);
  return h('div', { class: 'editor' },
    h('div', { class: 'stage' },
      editor.view.canvas,
      h('div', { class: 'stage-hint' }, '끌어서 이동 · 탭해서 추가 · 길게 눌러 삭제'),
      s.found ? null : h('div', { class: 'stage-note' }, '선을 찾지 못했어요')),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn', onclick: () => { s.grid = editor.grid; show('crop'); } }, '이전'),
      undoBtn,
      h('div', { class: 'seg', role: 'group', 'aria-label': '추가할 선' }, axisBtns),
      h('button', { class: 'btn', onclick: redetect }, '다시 찾기'),
      h('button', { class: 'btn', onclick: () => editor.setGrid(edgeGrid(s.an)) }, '모두 지우기'),
      h('button', { class: 'btn', onclick: () => editor.view.fit() }, '맞춤'),
      h('span', { class: 'grow' }),
      count,
      nextBtn));
}

// ---- 4 병합·헤더·저장 ----

function gridKey(g) { return g.xs.join(',') + '|' + g.ys.join(','); }

function mergeStep(s, show) {
  // 격자가 바뀌었으면 병합을 새로 제안
  if (s.mergeFor !== gridKey(s.grid)) {
    s.suggestions = suggestMerges(s.an, s.grid, s.thickness);
    s.merges = [];
    s.mergeFor = gridKey(s.grid);
  }

  const applyBtn = h('button', { class: 'btn', onclick: () => editor.applySuggestions() });
  const clearBtn = h('button', { class: 'btn', onclick: () => editor.clearMerges() }, '모두 해제');
  const editor = new MergeEditor({
    onChange: () => {
      s.merges = editor.merges;
      const n = editor.pending.length;
      applyBtn.textContent = `제안 적용 ${n}`;
      applyBtn.disabled = n === 0;
      clearBtn.disabled = editor.merges.length === 0;
    },
  });
  editor.hasHeader = s.hasHeader;

  const header = h('input', { type: 'checkbox', checked: s.hasHeader });
  header.addEventListener('change', () => {
    s.hasHeader = header.checked;
    editor.hasHeader = header.checked;
    editor.view.requestDraw();
  });

  const saveBtn = h('button', { class: 'btn primary', onclick: async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = '저장 중…';
    try {
      const id = await saveTable(s);
      go(`#/table/${id}/settings`);
    } catch (e) {
      console.error(e);
      toast('저장하지 못했어요');
      saveBtn.disabled = false;
      saveBtn.textContent = '저장';
    }
  } }, '저장');

  editor.setImage(s.work, s.grid, s.merges, s.suggestions);
  return h('div', { class: 'editor' },
    h('div', { class: 'stage' },
      editor.view.canvas,
      h('div', { class: 'stage-hint' }, '세로로 끌어서 합치기 · 탭해서 풀기')),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn', onclick: () => show('grid') }, '이전'),
      applyBtn,
      clearBtn,
      h('label', { class: 'switch' }, header, h('span', {}, '첫 행은 열 이름')),
      h('button', { class: 'btn', onclick: () => editor.view.fit() }, '맞춤'),
      h('span', { class: 'grow' }),
      saveBtn));
}

function defaultName(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function saveTable(s) {
  const now = Date.now();
  const tableId = db.newId();
  const sourceImageId = db.newId();
  const [sourceBlob, pieces] = await Promise.all([
    canvasToBlob(s.work, 'image/jpeg', 0.9),
    cropCells(s.work, s.grid, s.merges, s.thickness),
  ]);

  const images = [{ id: sourceImageId, blob: sourceBlob }];
  const cells = pieces.map((p) => {
    const imageId = db.newId();
    images.push({ id: imageId, blob: p.blob });
    return { id: db.newId(), tableId, row: p.row, col: p.col, rowSpan: p.rowSpan, imageId, blank: p.blank };
  });
  const cols = s.grid.xs.length - 1;
  const table = {
    id: tableId,
    name: defaultName(now),
    createdAt: now,
    sourceImageId,
    grid: { xs: [...s.grid.xs], ys: [...s.grid.ys] },
    hasHeader: s.hasHeader,
    repCol: 0,
    quizCols: Array.from({ length: cols - 1 }, (_, i) => i + 1),
    colModes: {},
    splitChars: [',', '\n'],
    excludedRows: [],
    sameGroups: [],
    quizSettings: { mode: 'full', optionCount: 5, trayLayout: 'byCol', order: 'random', recallGate: 'tap' },
  };

  await db.transaction(['tables', 'cells', 'images'], 'readwrite', (st) => {
    for (const img of images) st.images.put(img);
    for (const c of cells) st.cells.put(c);
    st.tables.put(table);
  });
  return tableId;
}
