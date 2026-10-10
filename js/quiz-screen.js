// 퀴즈 화면: 대표 칸, 슬롯, 카드 트레이

import * as db from './db.js';
import { h, go, toast, blobURL } from './ui.js';
import { enableDnD } from './dnd.js';
import {
  buildModel, currentQuestion, judgeCol, finishQuestion, summarize, recordStats,
  cardId, parseCardId, DEFAULT_SETTINGS,
} from './quiz.js';

const CARD_MAX_W = 240;
const CARD_MAX_H = 140;
const CARD_MIN_H = 56;
const TEXT_FONT = '600 17px -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", system-ui, sans-serif';

// 표·칸·이미지 URL·이미지 크기를 한 번에
export async function loadTableData(tableId) {
  const table = await db.get('tables', tableId);
  if (!table) return null;
  const cells = await db.getAllByIndex('cells', 'tableId', tableId);
  const urls = new Map();
  const dims = new Map();
  await Promise.all(cells.map(async (c) => {
    const img = await db.get('images', c.imageId);
    if (!img) return;
    urls.set(c.id, blobURL(img.blob));
    try {
      const bmp = await createImageBitmap(img.blob);
      dims.set(c.id, { w: bmp.width, h: bmp.height });
      bmp.close?.();
    } catch { dims.set(c.id, { w: 100, h: 40 }); }
  }));
  return { table, cells, urls, dims };
}

// 열 이름표: 헤더 칸 그림이 있으면 그림, 없으면 이름
export function colTag(data, col) {
  const { table, cells, urls } = data;
  const hc = table.hasHeader ? cells.find((c) => c.row === 0 && c.col === col) : null;
  if (hc && urls.has(hc.id) && !table.colNames?.[col]) {
    return h('img', { class: 'col-tag', src: urls.get(hc.id), alt: `열 ${col + 1}`, draggable: 'false' });
  }
  return h('span', { class: 'col-tag-text' }, table.colNames?.[col] || `열 ${col + 1}`);
}

export async function quizScreen(tableId) {
  const data = await loadTableData(tableId);
  if (!data) { go('#/'); return h('div'); }
  const session = await db.get('sessions', tableId);
  if (!session || session.done) { go(`#/table/${tableId}/session`); return h('div'); }
  session.settings = { ...DEFAULT_SETTINGS, ...session.settings };

  const model = buildModel(data.table, data.cells);
  const settings = session.settings;
  const columnMode = settings.mode === 'column';

  // ---- 카드 틀: 한 열의 카드는 모두 같은 크기 ----
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = TEXT_FONT;
  const frames = new Map();
  const frameFor = (col) => {
    if (frames.has(col)) return frames.get(col);
    let f;
    if (model.isText(col)) {
      const labels = [...model.colUnits.get(col).values()].map((u) => u.label);
      const w = Math.max(...labels.map((l) => measure.measureText(l).width), 20);
      f = { w: Math.round(Math.min(260, Math.max(72, w + 32))), h: CARD_MIN_H, scale: 1 };
    } else {
      const sizes = data.cells
        .filter((c) => c.col === col && c.row >= model.headerRows && !c.blank && data.dims.has(c.id))
        .map((c) => data.dims.get(c.id));
      const maxW = Math.max(...sizes.map((d) => d.w), 40);
      const maxH = Math.max(...sizes.map((d) => d.h), 20);
      const s = Math.min(1, CARD_MAX_W / maxW, CARD_MAX_H / maxH);
      f = { w: Math.round(maxW * s) + 16, h: Math.max(CARD_MIN_H, Math.round(maxH * s) + 16), scale: s };
    }
    frames.set(col, f);
    return f;
  };

  // ---- 화면 상태 ----
  let q = currentQuestion(model, session);
  let picked = null;      // 탭 방식으로 고른 카드
  let revealed = settings.recallGate === 'off';
  let busy = false;       // 채점 표시 중에는 손대지 않음
  let revealTimer = null;
  let saveTimer = null;

  const save = () => {
    clearTimeout(saveTimer);
    session.updatedAt = Date.now();
    return db.put('sessions', session).catch((e) => { console.error(e); toast('저장하지 못했어요'); });
  };
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 300); };

  const item = () => model.itemByKey.get(q.itemKey);
  const shownCols = () => (columnMode ? [q.cols[q.colIdx]] : q.cols);

  // ---- 카드 그리기 ----
  function cardEl(col, card, { id = null, locked = false, extraClass = '' } = {}) {
    const f = frameFor(col);
    const el = h('div', {
      class: `card ${extraClass}` + (picked && picked === id ? ' picked' : ''),
      style: { width: `${f.w}px`, height: `${f.h}px` },
      'data-card': id || undefined,
      'data-locked': locked || undefined,
    });
    if (model.isText(col)) {
      el.classList.add('text');
      el.append(h('span', {}, model.cardLabel(col, card)));
    } else {
      const d = data.dims.get(card);
      el.append(h('img', {
        src: data.urls.get(card), alt: '', draggable: 'false',
        style: d ? { maxWidth: `${Math.round(d.w * f.scale)}px`, maxHeight: `${Math.round(d.h * f.scale)}px` } : {},
      }));
    }
    return el;
  }

  // ---- 배치 ----
  const where = (id) => {
    for (const col of q.cols) {
      const i = q.placed[col].indexOf(id);
      if (i >= 0) return { col, i };
    }
    return null;
  };
  const parseSlot = (s) => { const [c, i] = s.split('#').map(Number); return { col: c, i }; };

  function place(id, slotId) {
    const { col, i } = parseSlot(slotId);
    if (q.phase !== 'answer' || q.checked[col]) return;
    const from = where(id);
    if (from) q.placed[from.col][from.i] = null;
    q.placed[col][i] = id; // 이미 있던 카드는 트레이로 돌아간다
    picked = null;
    changed(col);
  }

  function unplace(id) {
    const from = where(id);
    if (!from || q.checked[from.col]) return;
    q.placed[from.col][from.i] = null;
    changed(from.col);
  }

  function changed(col) {
    saveSoon();
    render();
    if (columnMode && q.placed[col].every(Boolean)) checkColumn(col);
  }

  // ---- 채점 ----
  function checkColumn(col) {
    const j = judgeCol(model, item(), q, col);
    q.checked[col] = j;
    busy = true;
    render();
    // 맞으면 잠깐, 틀리면 정답을 1초 보여준 뒤 다음 열
    setTimeout(() => {
      busy = false;
      q.colIdx++;
      if (q.colIdx >= q.cols.length) completeQuestion();
      else { resetGate(); save(); render(); }
    }, j.correct ? 500 : 1000);
  }

  function checkAll() {
    for (const col of q.cols) q.checked[col] = judgeCol(model, item(), q, col);
    q.phase = 'checked';
    save();
    render();
    // 정답 표시가 가려져 있으면 보이게
    slotsBox.querySelector('.reveal')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function completeQuestion() {
    for (const col of q.cols) q.checked[col] ||= judgeCol(model, item(), q, col);
    const done = finishQuestion(model, session, q.checked);
    if (done) {
      session.done = true;
      session.summary = summarize(model, session);
      await recordStats(model, session);
      await save();
      go(`#/table/${tableId}/result`);
      return;
    }
    q = currentQuestion(model, session);
    picked = null;
    resetGate();
    await save();
    render();
  }

  // ---- 먼저 떠올리기 ----
  function resetGate() {
    clearTimeout(revealTimer);
    revealed = settings.recallGate === 'off';
    if (settings.recallGate === 'delay3s') {
      revealTimer = setTimeout(() => { revealed = true; render(); }, 3000);
    }
  }

  // ---- 길게 눌러 확대 ----
  let preview = null;
  const showPreview = (el) => {
    // 그림은 원래 크기의 3배까지만 키운다 (더 키우면 흐려짐)
    const { card } = parseCardId(el.dataset.card || '|');
    const d = data.dims.get(card);
    const content = el.querySelector('img')
      ? h('img', { src: el.querySelector('img').src, alt: '', draggable: 'false', style: d ? { width: `min(92vw, ${d.w * 3}px)` } : {} })
      : h('span', {}, el.textContent);
    preview = h('div', { class: 'card-preview' }, content);
    document.body.append(preview);
  };
  const hidePreview = () => { preview?.remove(); preview = null; };

  // ---- 그리기 ----
  const progress = h('span', { class: 'quiz-progress' });
  const repBox = h('div', { class: 'rep-card' });
  const slotsBox = h('div', { class: 'slot-groups' });
  const actions = h('div', { class: 'quiz-actions' });
  const tray = h('div', { class: 'tray' });
  const trayWrap = h('div', { class: 'tray-wrap' }, tray);
  const body = h('div', { class: 'quiz-body' },
    h('div', { class: 'quiz-main' }, repBox, slotsBox, actions),
    trayWrap);

  function render() {
    progress.textContent = `${session.round}바퀴 · ${session.index + 1}/${session.queue.length}`;

    const rep = data.cells.find((c) => c.id === item().repCellId);
    const d = rep && data.dims.get(rep.id);
    repBox.replaceChildren(rep && data.urls.has(rep.id)
      ? h('img', { src: data.urls.get(rep.id), alt: '대표 칸', draggable: 'false', style: d ? { width: `${Math.round(d.w * 1.4)}px` } : {} })
      : h('span', { class: 'muted' }, '대표 칸 없음'));

    slotsBox.replaceChildren(...shownCols().map(slotGroup));
    renderActions();
    renderTray();
  }

  function slotGroup(col) {
    const f = frameFor(col);
    const j = q.checked[col];
    const slots = [];
    for (const card of q.locked[col]) {
      slots.push(h('div', { class: 'slot locked', style: { width: `${f.w + 8}px`, height: `${f.h + 8}px` } },
        cardEl(col, card, { locked: true })));
    }
    q.placed[col].forEach((id, i) => {
      const result = j ? (j.slots[i] ? 'ok' : 'bad') : '';
      const slot = h('div', {
        class: `slot ${result}`,
        style: { width: `${f.w + 8}px`, height: `${f.h + 8}px` },
        'data-slot': `${col}#${i}`,
        'data-locked': j || undefined,
        'aria-label': `빈 칸 ${i + 1}`,
      });
      if (id) {
        const p = parseCardId(id);
        slot.append(cardEl(p.col, p.card, { id, locked: !!j }));
      }
      if (result) slot.append(h('span', { class: `mark ${result}`, 'aria-label': result === 'ok' ? '맞음' : '틀림' }, result === 'ok' ? '✓' : '✗'));
      slots.push(slot);
    });
    const reveal = j && !j.correct && j.missing.length
      ? h('div', { class: 'reveal' }, h('span', { class: 'reveal-label' }, '정답'),
        j.missing.map((card) => cardEl(col, card, { locked: true, extraClass: 'answer' })))
      : null;
    return h('div', { class: 'slot-group' + (j ? (j.correct ? ' ok' : ' bad') : '') },
      h('div', { class: 'slot-label' }, colTag(data, col)),
      h('div', { class: 'slots' }, slots),
      reveal);
  }

  function renderActions() {
    if (columnMode) { actions.replaceChildren(); return; }
    if (q.phase === 'answer') {
      const full = q.cols.every((col) => q.placed[col].every(Boolean));
      actions.replaceChildren(h('button', { class: 'btn primary wide', disabled: !full, onclick: checkAll }, '확인'));
    } else {
      actions.replaceChildren(h('button', { class: 'btn primary wide', onclick: () => completeQuestion() }, '다음'));
    }
  }

  function renderTray() {
    const placed = new Set(q.cols.flatMap((col) => q.placed[col]).filter(Boolean));
    const cols = shownCols().filter((col) => q.slots[col] > 0);
    const done = !columnMode && q.phase === 'checked';
    const cardsOf = (ids) => ids.filter((id) => !placed.has(id)).map((id) => {
      const p = parseCardId(id);
      return cardEl(p.col, p.card, { id, locked: done });
    });

    if (!columnMode && settings.trayLayout === 'mixed') {
      tray.replaceChildren(h('div', { class: 'tray-mixed' }, cardsOf(q.mixed.filter((id) => cols.includes(parseCardId(id).col)))));
    } else {
      tray.replaceChildren(...cols.map((col) => h('div', { class: 'tray-row' },
        h('div', { class: 'tray-cards' }, cardsOf(q.trays[col].map((card) => cardId(col, card)))))));
    }

    trayWrap.querySelector('.recall-cover')?.remove();
    if (!revealed && q.phase === 'answer' && cols.length) {
      const cover = h('button', { class: 'recall-cover', onclick: () => { clearTimeout(revealTimer); revealed = true; render(); } },
        h('span', { class: 'recall-title' }, '떠올렸으면 탭'),
        settings.recallGate === 'delay3s' ? h('span', { class: 'muted' }, '3초 뒤 열려요') : null);
      trayWrap.append(cover);
    }
  }

  enableDnD(body, {
    disabled: () => busy || !revealed,
    onDrop: (id, slotId) => { if (slotId) place(id, slotId); else unplace(id); },
    onTapCard: (id) => {
      if (where(id)) { unplace(id); return; }
      picked = picked === id ? null : id;
      render();
    },
    onTapSlot: (slotId) => {
      if (busy) return;
      if (picked) { place(picked, slotId); return; }
      const { col, i } = parseSlot(slotId);
      const id = q.placed[col]?.[i];
      if (id) unplace(id);
    },
    onLongPress: showPreview,
    onLongPressEnd: hidePreview,
  });

  if (!q) { toast('물을 문제가 없어요'); go(`#/table/${tableId}/session`); return h('div'); }
  resetGate();
  render();
  save();

  return h('section', { class: 'screen fill quiz' + (columnMode ? ' column-mode' : '') },
    h('header', { class: 'bar' },
      h('button', { class: 'btn', onclick: async () => { await save(); go('#/'); } }, '나가기'),
      progress,
      h('span', { class: 'bar-spacer' })),
    body);
}
