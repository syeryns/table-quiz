// 표 설정 화면: 대표·출제 열, 열 이름, 읽기 방식, 쪼개기 기준, 행 제외, 같은 값 묶기

import * as db from './db.js';
import { h, go, toast, blobURL } from './ui.js';
import { SPLIT_OPTIONS, DEFAULT_SPLIT, LOW_CONF, splitText, recognize, loadEngine, looksLikeLevels, fixLevelText } from './ocr.js';

const GROUP_COLORS = 8;

function notFound() {
  return h('section', { class: 'screen' },
    h('header', { class: 'bar' },
      h('button', { class: 'btn', onclick: () => go('#/') }, '홈'),
      h('h1', {}, '표 설정'),
      h('span', { class: 'bar-spacer' })),
    h('main', { class: 'content' }, h('div', { class: 'empty' }, h('p', {}, '표를 찾지 못했어요'))));
}

// 예전 버전에서 만든 표에 빠진 값 채우기
function upgrade(table) {
  table.colModes ||= {};
  table.colNames ||= {};
  table.excludedRows ||= [];
  table.sameGroups ||= [];
  table.quizCols ||= [];
  if (!table.splitChars || table.splitChars.join('') === ',\n') table.splitChars = [...DEFAULT_SPLIT];
}

export async function settingsScreen(tableId) {
  const table = await db.get('tables', tableId);
  if (!table) return notFound();
  upgrade(table);

  const cells = await db.getAllByIndex('cells', 'tableId', tableId);
  const urls = new Map();
  await Promise.all(cells.map(async (c) => {
    const img = await db.get('images', c.imageId);
    if (img) urls.set(c.id, blobURL(img.blob));
  }));

  const { xs, ys } = table.grid;
  const cols = xs.length - 1, rows = ys.length - 1;
  const headerRows = table.hasHeader ? 1 : 0;
  const cellById = new Map(cells.map((c) => [c.id, c]));
  const headerCell = (col) => cells.find((c) => c.row === 0 && c.col === col);
  // 한 열의 본문 칸 (병합 칸은 한 번만)
  const bodyCells = (col) => cells.filter((c) => c.col === col && c.row >= headerRows).sort((a, b) => a.row - b.row);

  const isText = (col) => table.colModes[col] === 'text';
  const colName = (col) => table.colNames[col] || `열 ${col + 1}`;
  const save = () => db.put('tables', table).catch((e) => { console.error(e); toast('저장하지 못했어요'); });
  const saveCells = (list) => db.putMany('cells', list).catch((e) => { console.error(e); toast('저장하지 못했어요'); });

  const ui = { groupCol: null, selected: new Set() };
  const main = h('main', { class: 'content settings-body' });
  const sheetHost = h('div');

  function render() {
    const y = window.scrollY;
    main.replaceChildren(
      columnsSection(),
      splitSection(),
      previewSection(),
      groupSection());
    startBtn.disabled = !canStart();
    window.scrollTo(0, y);
  }

  function canStart() {
    const active = Array.from({ length: rows - headerRows }, (_, i) => i + headerRows)
      .filter((r) => !table.excludedRows.includes(r));
    return table.quizCols.length > 0 && active.length > 0;
  }

  // ---- 열 이름표 ----

  function colLabel(col, { editable = false } = {}) {
    const hc = headerRows ? headerCell(col) : null;
    if (hc && urls.has(hc.id)) {
      return h('span', { class: 'col-label' }, h('img', { src: urls.get(hc.id), alt: colName(col), draggable: 'false' }));
    }
    if (!editable) return h('span', { class: 'col-label text' }, colName(col));
    const input = h('input', {
      class: 'col-name-input', type: 'text', value: table.colNames[col] || '',
      placeholder: `열 ${col + 1}`, 'aria-label': `열 ${col + 1} 이름`,
    });
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (v) table.colNames[col] = v; else delete table.colNames[col];
      save();
      render();
    });
    return input;
  }

  // 버튼·제목에 넣는 작은 열 이름표: 헤더 칸 그림이 있으면 그림, 없으면 이름
  function colTag(col) {
    const hc = headerRows ? headerCell(col) : null;
    if (hc && urls.has(hc.id) && !table.colNames[col]) {
      return h('img', { class: 'col-tag', src: urls.get(hc.id), alt: colName(col), draggable: 'false' });
    }
    return colName(col);
  }

  // ---- 열 ----

  function setRep(col) {
    const old = table.repCol;
    if (old === col) return;
    table.repCol = col;
    const q = new Set(table.quizCols);
    if (q.delete(col) && old != null) q.add(old); // 출제 열을 대표로 올리면 옛 대표가 출제 열로
    table.quizCols = [...q].sort((a, b) => a - b);
    save();
    render();
  }

  function toggleQuiz(col) {
    const q = new Set(table.quizCols);
    if (q.has(col)) q.delete(col); else q.add(col);
    table.quizCols = [...q].sort((a, b) => a - b);
    save();
    render();
  }

  function setMode(col, mode) {
    if (mode === 'image') {
      delete table.colModes[col]; // 고친 글자는 칸에 그대로 남겨둔다
      save();
      render();
      return;
    }
    table.colModes[col] = 'text';
    if (ui.groupCol === col) ui.groupCol = null;
    save();
    render();
    openTextSheet(col);
  }

  function columnsSection() {
    const list = h('div', { class: 'col-list' },
      Array.from({ length: cols }, (_, col) => {
        const rep = table.repCol === col;
        const quiz = table.quizCols.includes(col);
        return h('div', { class: 'col-row' + (rep ? ' rep' : '') },
          h('div', { class: 'col-row-label' }, colLabel(col, { editable: true })),
          h('div', { class: 'col-row-actions' },
            h('button', { class: 'chip', 'aria-pressed': String(rep), onclick: () => setRep(col) }, '대표'),
            h('button', {
              class: 'chip', 'aria-pressed': String(quiz && !rep), disabled: rep,
              onclick: () => toggleQuiz(col),
            }, '출제'),
            h('div', { class: 'seg small', role: 'group', 'aria-label': '읽기 방식' },
              h('button', { class: 'seg-btn', 'aria-pressed': String(!isText(col)), onclick: () => !isText(col) || setMode(col, 'image') }, '사진'),
              h('button', { class: 'seg-btn', 'aria-pressed': String(isText(col)), onclick: () => isText(col) || setMode(col, 'text') }, '글자')),
            isText(col) ? h('button', { class: 'btn', onclick: () => openTextSheet(col) }, '글자 확인') : null));
      }));
    return h('section', { class: 'panel' }, h('h2', {}, '열'), list);
  }

  // ---- 쪼개기 기준 ----

  function splitSection() {
    if (!Array.from({ length: cols }, (_, c) => isText(c)).some(Boolean)) return null;
    const chips = SPLIT_OPTIONS.map(([ch, label]) => {
      const on = table.splitChars.includes(ch);
      return h('button', {
        class: 'chip mono', 'aria-pressed': String(on),
        onclick: () => {
          const set = new Set(table.splitChars);
          if (on) set.delete(ch); else set.add(ch);
          table.splitChars = SPLIT_OPTIONS.map(([c]) => c).filter((c) => set.has(c));
          const changed = cells.filter((c) => c.text != null);
          for (const c of changed) c.parts = splitText(c.text, table.splitChars);
          save();
          saveCells(changed);
          render();
        },
      }, label);
    });
    return h('section', { class: 'panel' }, h('h2', {}, '쪼개기 기준'), h('div', { class: 'chips' }, chips));
  }

  // ---- 표 미리보기와 행 제외 ----

  function groupOf(cell) {
    return table.sameGroups.find((g) => g.includes(cell.id));
  }

  // 같은 열의 묶음끼리 번호·색을 매긴다
  function groupsInCol(col) {
    return table.sameGroups.filter((g) => g.some((id) => cellById.get(id)?.col === col));
  }

  function groupDot(cell) {
    if (isText(cell.col)) return null;
    const g = groupOf(cell);
    if (!g) return null;
    const i = groupsInCol(cell.col).indexOf(g);
    return h('span', { class: `dot g${i % GROUP_COLORS}`, 'aria-label': `묶음 ${i + 1}` }, String(i + 1));
  }

  function partChips(cell) {
    if (!isText(cell.col) || cell.row < headerRows) return null;
    if (cell.text == null) return h('div', { class: 'parts muted' }, '읽기 전');
    if (!cell.parts?.length) return h('div', { class: 'parts muted' }, '빈 칸');
    return h('div', { class: 'parts' }, cell.parts.map((p) => h('span', { class: 'part' }, p)));
  }

  function toggleRow(r) {
    const set = new Set(table.excludedRows);
    if (set.has(r)) set.delete(r); else set.add(r);
    table.excludedRows = [...set].sort((a, b) => a - b);
    save();
    render();
  }

  function previewSection() {
    const template = 'auto ' + Array.from({ length: cols }, (_, i) => `minmax(0, ${xs[i + 1] - xs[i]}fr)`).join(' ');
    const items = [];
    for (let r = headerRows; r < rows; r++) {
      const off = table.excludedRows.includes(r);
      items.push(h('button', {
        class: 'row-toggle' + (off ? ' off' : ''), 'aria-pressed': String(!off),
        'aria-label': `${r - headerRows + 1}행 ${off ? '포함' : '제외'}`,
        style: { gridColumn: '1', gridRow: String(r + 1) },
        onclick: () => toggleRow(r),
      }, off ? '제외' : String(r - headerRows + 1)));
    }
    for (const c of cells) {
      const spanned = Array.from({ length: c.rowSpan }, (_, i) => c.row + i);
      const header = c.row < headerRows;
      const excluded = !header && spanned.every((r) => table.excludedRows.includes(r));
      const cls = ['preview-cell'];
      if (header) cls.push('header');
      if (c.rowSpan > 1) cls.push('merged');
      if (c.col === table.repCol) cls.push('rep');
      else if (!table.quizCols.includes(c.col)) cls.push('off');
      if (excluded) cls.push('excluded');
      items.push(h('div', {
        class: cls.join(' '),
        style: { gridColumn: String(c.col + 2), gridRow: `${c.row + 1} / span ${c.rowSpan}` },
      },
      urls.has(c.id) ? h('img', { src: urls.get(c.id), alt: '', draggable: 'false' }) : null,
      partChips(c),
      groupDot(c)));
    }
    return h('section', { class: 'panel' },
      h('h2', {}, '표'),
      h('p', { class: 'muted small' }, `${rows - headerRows}행 × ${cols}열 · 행 번호를 누르면 제외`),
      h('div', { class: 'table-preview', style: { gridTemplateColumns: template } }, items));
  }

  // ---- 같은 값 묶기 (사진 열만) ----

  function groupSection() {
    const photoCols = Array.from({ length: cols }, (_, c) => c).filter((c) => !isText(c));
    if (!photoCols.length) return null;
    if (!photoCols.includes(ui.groupCol)) {
      ui.groupCol = photoCols.find((c) => table.quizCols.includes(c)) ?? photoCols[0];
      ui.selected.clear();
    }
    const col = ui.groupCol;

    const pick = h('div', { class: 'seg', role: 'group', 'aria-label': '묶을 열' },
      photoCols.map((c) => h('button', {
        class: 'seg-btn', 'aria-pressed': String(c === col),
        onclick: () => { ui.groupCol = c; ui.selected.clear(); render(); },
      }, colTag(c))));

    const tapCell = (cell) => {
      const g = groupOf(cell);
      if (g && ui.selected.size) {
        // 고른 칸들을 이 묶음에 더한다
        for (const id of ui.selected) if (!g.includes(id)) g.push(id);
        ui.selected.clear();
        save();
      } else if (g) {
        // 묶인 칸을 다시 탭하면 빠짐. 하나만 남으면 묶음을 없앤다
        g.splice(g.indexOf(cell.id), 1);
        if (g.length < 2) table.sameGroups = table.sameGroups.filter((o) => o !== g);
        save();
      } else if (ui.selected.has(cell.id)) ui.selected.delete(cell.id);
      else ui.selected.add(cell.id);
      render();
    };

    const thumbs = h('div', { class: 'thumbs' },
      bodyCells(col).map((cell) => h('button', {
        class: 'thumb' + (ui.selected.has(cell.id) ? ' selected' : '') + (groupOf(cell) ? ' grouped' : ''),
        'aria-pressed': String(ui.selected.has(cell.id)),
        onclick: () => tapCell(cell),
      },
      urls.has(cell.id) ? h('img', { src: urls.get(cell.id), alt: '', draggable: 'false' }) : null,
      groupDot(cell))));

    const groupBtn = h('button', {
      class: 'btn primary', disabled: ui.selected.size < 2,
      onclick: () => {
        table.sameGroups.push([...ui.selected]);
        ui.selected.clear();
        save();
        render();
      },
    }, ui.selected.size ? `묶기 ${ui.selected.size}` : '묶기');

    return h('section', { class: 'panel' },
      h('h2', {}, '같은 값 묶기'),
      h('div', { class: 'toolbar flat' }, pick, h('span', { class: 'grow' }),
        h('button', { class: 'btn', disabled: !ui.selected.size, onclick: () => { ui.selected.clear(); render(); } }, '선택 해제'),
        groupBtn),
      h('p', { class: 'muted small' }, '같은 내용 탭 → 묶기 · 묶인 칸 탭하면 빠짐 · 고른 뒤 묶인 칸 탭하면 그 묶음에 추가'),
      thumbs);
  }

  // ---- 글자 확인 시트 ----

  function openTextSheet(col) {
    let closed = false;
    const status = h('p', { class: 'sheet-status muted' });
    const list = h('div', { class: 'check-list' });
    const close = () => {
      closed = true;
      sheet.remove();
      document.body.classList.remove('sheet-open');
      render();
    };
    const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${colName(col)} 글자 확인` },
      h('div', { class: 'sheet-inner' },
        h('header', { class: 'bar' },
          h('span', { class: 'bar-spacer' }),
          h('h1', { class: 'sheet-title' }, colTag(col), '글자 확인'),
          h('button', { class: 'btn primary', onclick: close }, '완료')),
        status,
        list));
    sheetHost.replaceChildren(sheet);
    document.body.classList.add('sheet-open');

    const target = bodyCells(col);

    const fillList = () => {
      const low = (c) => !c.checked && (c.ocrConf ?? 100) < LOW_CONF;
      const sorted = [...target].sort((a, b) =>
        (low(b) - low(a)) || (low(a) ? (a.ocrConf ?? 0) - (b.ocrConf ?? 0) : 0) || a.row - b.row);
      const lowCount = sorted.filter(low).length;
      status.textContent = lowCount ? `노란 칸 ${lowCount}개를 먼저 확인하세요` : '';
      list.replaceChildren(...sorted.map((cell) => checkRow(cell, low(cell))));
    };

    const checkRow = (cell, isLow) => {
      const parts = h('div', { class: 'parts' });
      const showParts = () => parts.replaceChildren(
        ...(cell.parts?.length ? cell.parts.map((p) => h('span', { class: 'part' }, p)) : [h('span', { class: 'muted' }, '빈 칸')]));
      showParts();
      const ta = h('textarea', { rows: String(Math.max(1, (cell.text || '').split('\n').length)), 'aria-label': `${cell.row - headerRows + 1}행 글자` });
      ta.value = cell.text || '';
      let timer = null;
      const row = h('div', { class: 'check-row' + (isLow ? ' low' : '') },
        h('div', { class: 'check-img' }, urls.has(cell.id) ? h('img', { src: urls.get(cell.id), alt: '', draggable: 'false' }) : null),
        h('div', { class: 'check-edit' }, ta, parts));
      ta.addEventListener('input', () => {
        cell.text = ta.value;
        cell.parts = splitText(ta.value, table.splitChars);
        cell.checked = true;
        row.classList.remove('low');
        showParts();
        clearTimeout(timer);
        timer = setTimeout(() => saveCells([cell]), 400);
      });
      ta.addEventListener('blur', () => { clearTimeout(timer); saveCells([cell]); });
      return row;
    };

    const missing = target.filter((c) => c.text == null);
    if (!missing.length) { fillList(); return; }

    (async () => {
      try {
        status.textContent = '글자 인식 준비 중…';
        await loadEngine();
        for (let i = 0; i < missing.length && !closed; i++) {
          status.textContent = `읽는 중 ${i + 1}/${missing.length}`;
          const cell = missing[i];
          const img = await db.get('images', cell.imageId);
          const res = cell.blank || !img ? { text: '', confidence: 100 } : await recognize(img.blob);
          cell.text = res.text;
          cell.ocrConf = res.confidence;
          cell.checked = false;
          cell.parts = splitText(res.text, table.splitChars);
          await db.put('cells', cell);
        }
        // 신경 번호 열이면 C를 6으로 읽은 칸을 고치고 노란 표시로 확인하게 한다
        if (looksLikeLevels(target.map((c) => c.parts || []))) {
          const fixed = [];
          for (const cell of target) {
            if (cell.checked || cell.text == null) continue;
            const t = fixLevelText(cell.text);
            if (t === cell.text) continue;
            cell.text = t;
            cell.parts = splitText(t, table.splitChars);
            cell.ocrConf = Math.min(cell.ocrConf ?? 100, LOW_CONF - 1);
            fixed.push(cell);
          }
          if (fixed.length) await db.putMany('cells', fixed);
        }
        if (!closed) fillList();
      } catch (e) {
        console.error(e);
        status.textContent = '글자를 읽지 못했어요';
        toast('글자를 읽지 못했어요');
      }
    })();
  }

  // ---- 화면 틀 ----

  const nameInput = h('input', { class: 'title-input', type: 'text', value: table.name, 'aria-label': '표 이름' });
  nameInput.addEventListener('change', () => {
    table.name = nameInput.value.trim() || table.name;
    nameInput.value = table.name;
    save();
  });
  const startBtn = h('button', { class: 'btn primary', onclick: () => go(`#/table/${tableId}/session`) }, '퀴즈 시작');

  render();
  return h('section', { class: 'screen settings' },
    h('header', { class: 'bar' },
      h('button', { class: 'btn', onclick: () => go('#/') }, '홈'),
      nameInput,
      startBtn),
    main,
    sheetHost);
}
