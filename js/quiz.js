// 퀴즈 엔진: 문제 묶기, 보기 만들기, 채점, 세션 진행. 화면과 분리된 순수 계산.
//
// 판정 단위(unit): 같은 답으로 치는 값 하나.
//   사진 열: 같은 값 그룹이면 'g<그룹번호>', 아니면 'c<칸 id>'. 병합 칸은 칸 하나라 자연히 같은 값.
//   글자 열: 정규화한 조각 글자. 같은 글자면 같은 값.
// cardKey: 사진 열은 칸 id, 글자 열은 정규화한 조각 글자 (PRD 데이터 모델)

import * as db from './db.js';
import { normKey } from './ocr.js';

export const DEFAULT_SETTINGS = {
  mode: 'full',          // 'full' 전체 슬롯 | 'column' 열 단계
  recallGate: 'tap',     // 'off' | 'tap' | 'delay3s'
  optionCount: 5,        // 3~8 | 'all'
  trayLayout: 'byCol',   // 'byCol' 열별 줄 | 'mixed' 모두 섞기
  order: 'random',       // 'table' | 'random' | 'weak-first'
};

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- 표 → 퀴즈 모델 ----

export function buildModel(table, cells) {
  const headerRows = table.hasHeader ? 1 : 0;
  const rows = table.grid.ys.length - 1;
  const excluded = new Set(table.excludedRows || []);
  const isText = (col) => table.colModes?.[col] === 'text';
  const cellById = new Map(cells.map((c) => [c.id, c]));

  const groupIndex = new Map();
  (table.sameGroups || []).forEach((g, i) => g.forEach((id) => groupIndex.set(id, i)));

  // (행, 열)을 덮는 칸. 병합 칸이면 위쪽 칸
  const cover = new Map();
  for (const c of cells) {
    for (let r = c.row; r < c.row + (c.rowSpan || 1); r++) cover.set(`${r},${c.col}`, c);
  }
  const cellAt = (row, col) => cover.get(`${row},${col}`);

  const isBlank = (c) => !c || (isText(c.col) ? !(c.parts?.length) : !!c.blank);
  const imageUnit = (c) => (groupIndex.has(c.id) ? `g${groupIndex.get(c.id)}` : `c${c.id}`);
  const textUnits = (c) => [...new Set((c.parts || []).map(normKey))];

  // 열마다: 단위 → 대표 카드 / 표시 글자
  const colUnits = new Map();
  for (let col = 0; col < table.grid.xs.length - 1; col++) {
    const units = new Map(); // unit → { card, label }
    for (const c of cells) {
      if (c.col !== col || c.row < headerRows || isBlank(c)) continue;
      if (isText(col)) {
        for (const p of c.parts) {
          const k = normKey(p);
          if (!units.has(k)) units.set(k, { card: k, label: p });
        }
      } else {
        const u = imageUnit(c);
        if (!units.has(u)) units.set(u, { card: c.id });
      }
    }
    colUnits.set(col, units);
  }

  // 카드 → 판정 단위
  const unitOf = (col, card) => {
    if (isText(col)) return card;
    const c = cellById.get(card);
    return c ? imageUnit(c) : null;
  };

  // 한 문제의 한 열 정답 단위들과, 그 단위를 보여줄 카드(가능하면 이 문제 행의 칸)
  const answers = (item, col) => {
    const out = new Map(); // unit → card
    const seen = new Set();
    for (const r of item.rows) {
      const c = cellAt(r, col);
      if (!c || seen.has(c.id) || isBlank(c)) continue;
      seen.add(c.id);
      if (isText(col)) for (const k of textUnits(c)) { if (!out.has(k)) out.set(k, k); }
      else { const u = imageUnit(c); if (!out.has(u)) out.set(u, c.id); }
    }
    return out;
  };

  // 대표 열 값이 같은 행은 한 문제로 묶는다 (병합 칸, 같은 값 그룹, 같은 글자)
  const repKey = (row) => {
    const c = cellAt(row, table.repCol);
    if (!c) return `row${row}`;
    if (isText(table.repCol)) {
      const ks = textUnits(c).sort();
      return ks.length ? `t:${ks.join('|')}` : `c${c.id}`;
    }
    return imageUnit(c);
  };

  const quizCols = (table.quizCols || []).filter((c) => c !== table.repCol);
  const byRep = new Map();
  for (let r = headerRows; r < rows; r++) {
    if (excluded.has(r)) continue;
    const k = repKey(r);
    if (!byRep.has(k)) byRep.set(k, []);
    byRep.get(k).push(r);
  }
  const items = [];
  for (const rs of byRep.values()) {
    const item = { key: rs.join('-'), rows: rs, repCellId: cellAt(rs[0], table.repCol)?.id };
    // 물을 칸이 하나도 없는 문제(출제 열이 모두 빈 칸)는 뺀다
    item.cols = quizCols.filter((col) => answers(item, col).size > 0);
    if (item.cols.length) items.push(item);
  }
  const itemByKey = new Map(items.map((it) => [it.key, it]));

  return {
    table, cells, cellById, headerRows, isText, cellAt, quizCols,
    items, itemByKey, colUnits, unitOf, answers,
    cardLabel: (col, card) => colUnits.get(col)?.get(card)?.label ?? card,
  };
}

// ---- 문제 만들기 ----

// retry = { wrongCols, locked: { col: [card] } } (틀린 칸만 다시 묻기)
export function makeQuestion(model, item, settings, retry = null) {
  const cols = settings.mode === 'column' && retry ? item.cols.filter((c) => retry.wrongCols.includes(c)) : item.cols;
  const q = { itemKey: item.key, retry: !!retry, cols, slots: {}, locked: {}, placed: {}, trays: {}, checked: {}, colIdx: 0, phase: 'answer' };

  for (const col of cols) {
    const ans = model.answers(item, col);
    let locked = [];
    if (retry) {
      locked = retry.wrongCols.includes(col) ? (retry.locked[col] || []) : [...ans.values()];
      const lockedUnits = new Set(locked.map((k) => model.unitOf(col, k)));
      locked = locked.filter((k) => ans.has(model.unitOf(col, k)));
      q.slots[col] = ans.size - lockedUnits.size;
    } else q.slots[col] = ans.size;
    q.locked[col] = locked;
    q.placed[col] = Array(q.slots[col]).fill(null);

    const lockedUnits = new Set(locked.map((k) => model.unitOf(col, k)));
    const need = [...ans].filter(([u]) => !lockedUnits.has(u)).map(([, card]) => card);
    const units = model.colUnits.get(col);
    const others = shuffle([...units].filter(([u]) => !ans.has(u)).map(([, v]) => v.card));
    const total = settings.optionCount === 'all'
      ? need.length + others.length
      : Math.max(Number(settings.optionCount) || 5, need.length + 1);
    const distractors = others.slice(0, Math.max(0, total - need.length));
    q.trays[col] = q.slots[col] > 0 ? shuffle([...need, ...distractors]) : [];
  }
  q.mixed = shuffle(cols.flatMap((col) => q.trays[col].map((card) => cardId(col, card))));
  return q;
}

export const cardId = (col, card) => `${col}|${card}`;
export function parseCardId(id) {
  const i = id.indexOf('|');
  return { col: Number(id.slice(0, i)), card: id.slice(i + 1) };
}

// 열 하나 채점. 슬롯 순서는 상관없고, 같은 단위를 두 번 놓으면 두 번째는 틀림
export function judgeCol(model, item, q, col) {
  const ans = model.answers(item, col);
  const covered = new Set(q.locked[col].map((k) => model.unitOf(col, k)));
  const slots = q.placed[col].map((id) => {
    if (!id) return false;
    const { col: from, card } = parseCardId(id);
    if (from !== col) return false; // 다른 열 카드
    const u = model.unitOf(col, card);
    if (!ans.has(u) || covered.has(u)) return false;
    covered.add(u);
    return true;
  });
  const missing = [...ans].filter(([u]) => !covered.has(u)).map(([, card]) => card);
  const correctCards = q.placed[col]
    .filter((id, i) => id && slots[i])
    .map((id) => parseCardId(id).card);
  return { slots, missing, correct: slots.every(Boolean), correctCards };
}

// ---- 출제 순서 ----

export async function orderItems(model, settings) {
  const items = model.items;
  if (settings.order === 'table') return items.map((it) => it.key);
  if (settings.order === 'weak-first') {
    const stats = await db.getAllByIndex('rowStats', 'tableId', model.table.id);
    const wrong = new Map(stats.map((s) => [s.row, s.wrongCount || 0]));
    const score = (it) => Math.max(...it.rows.map((r) => wrong.get(r) || 0));
    return shuffle(items).sort((a, b) => score(b) - score(a)).map((it) => it.key);
  }
  return shuffle(items).map((it) => it.key);
}

// ---- 세션 ----

export async function startSession(model, settings) {
  const now = Date.now();
  const session = {
    tableId: model.table.id,
    settings: { ...settings },
    round: 1,
    queue: await orderItems(model, settings),
    index: 0,
    retry: {},       // 이번 바퀴에서 다시 묻는 문제 → { wrongCols, locked }
    wrongNext: {},   // 다음 바퀴로 넘길 문제
    current: null,
    results: [],     // { round, item, col, correct }
    wrongTally: {},  // 문제별 틀린 바퀴 수
    done: false,
    summary: null,
    startedAt: now,
    updatedAt: now,
  };
  await db.put('sessions', session);
  return session;
}

export function currentQuestion(model, session) {
  if (session.current) return session.current;
  const key = session.queue[session.index];
  const item = model.itemByKey.get(key);
  if (!item) return null;
  session.current = makeQuestion(model, item, session.settings, session.retry[key] || null);
  return session.current;
}

// 문제 하나를 마친 결과를 기록하고 다음으로. 끝났으면 true
export function finishQuestion(model, session, judged) {
  const q = session.current;
  const wrongCols = [];
  const locked = {};
  for (const col of q.cols) {
    const j = judged[col];
    if (!j) continue;
    if (q.slots[col] > 0) session.results.push({ round: session.round, item: q.itemKey, col, correct: j.correct });
    locked[col] = [...q.locked[col], ...j.correctCards];
    if (!j.correct) wrongCols.push(col);
  }
  if (wrongCols.length) {
    session.wrongNext[q.itemKey] = { wrongCols, locked };
    session.wrongTally[q.itemKey] = (session.wrongTally[q.itemKey] || 0) + 1;
  }
  session.current = null;
  session.index++;
  if (session.index < session.queue.length) return false;

  // 바퀴 끝: 틀린 문제만 섞어서 다음 바퀴
  const wrongKeys = Object.keys(session.wrongNext);
  if (!wrongKeys.length) return true;
  session.round++;
  session.queue = shuffle(wrongKeys);
  session.retry = session.wrongNext;
  session.wrongNext = {};
  session.index = 0;
  return false;
}

export function summarize(model, session) {
  const first = session.results.filter((r) => r.round === 1);
  const firstCorrect = first.filter((r) => r.correct).length;
  const colWrong = {};
  for (const r of session.results) if (!r.correct) colWrong[r.col] = (colWrong[r.col] || 0) + 1;
  const wrongItems = Object.entries(session.wrongTally)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count, repCellId: model.itemByKey.get(key)?.repCellId, rows: model.itemByKey.get(key)?.rows || [] }));
  return {
    rounds: session.round,
    items: new Set(session.results.filter((r) => r.round === 1).map((r) => r.item)).size,
    firstTotal: first.length,
    firstCorrect,
    firstAccuracy: first.length ? firstCorrect / first.length : 1,
    colWrong,
    wrongItems,
    trayLayout: session.settings.trayLayout,
    finishedAt: Date.now(),
  };
}

// 세션이 끝나면 행별 누적 오답 수를 더한다 ('약한 행 먼저'에 쓰임)
export async function recordStats(model, session) {
  const now = Date.now();
  const updates = [];
  for (const [key, count] of Object.entries(session.wrongTally)) {
    const item = model.itemByKey.get(key);
    if (!item) continue;
    for (const row of item.rows) {
      const prev = await db.get('rowStats', [model.table.id, row]);
      updates.push({ tableId: model.table.id, row, wrongCount: (prev?.wrongCount || 0) + count, lastWrongAt: now });
    }
  }
  if (updates.length) await db.putMany('rowStats', updates);
}
