// 세션 설정 화면과 결과 화면

import * as db from './db.js';
import { h, go, toast } from './ui.js';
import { buildModel, startSession, DEFAULT_SETTINGS } from './quiz.js';
import { loadTableData, colTag } from './quiz-screen.js';

const OPTIONS = [
  ['mode', '모드', [['full', '전체 슬롯'], ['column', '열 단계']]],
  ['recallGate', '먼저 떠올리기', [['off', '끔'], ['tap', '탭해서 열기'], ['delay3s', '3초 뒤 열기']]],
  ['optionCount', '보기 개수', [[3, '3'], [4, '4'], [5, '5'], [6, '6'], [7, '7'], [8, '8'], ['all', '같은 열 전체']]],
  ['trayLayout', '트레이 배치', [['byCol', '열별 줄'], ['mixed', '모두 섞기']]],
  ['order', '행 순서', [['table', '표 순서'], ['random', '무작위'], ['weak-first', '약한 행 먼저']]],
];

function bar(title, tableId, right = null) {
  return h('header', { class: 'bar' },
    h('button', { class: 'btn', onclick: () => go(tableId ? `#/table/${tableId}/settings` : '#/') }, tableId ? '표 설정' : '홈'),
    h('h1', {}, title),
    right || h('span', { class: 'bar-spacer' }));
}

export async function sessionScreen(tableId) {
  const data = await loadTableData(tableId);
  if (!data) { go('#/'); return h('div'); }
  const { table } = data;
  const model = buildModel(table, data.cells);
  const existing = await db.get('sessions', tableId);
  const inProgress = existing && !existing.done ? existing : null;
  const settings = { ...DEFAULT_SETTINGS, ...table.quizSettings };

  const form = h('div', { class: 'session-form' });
  const renderForm = () => {
    form.replaceChildren(...OPTIONS.map(([key, label, choices]) => {
      // 트레이 배치는 전체 슬롯 모드에서만 쓴다
      const disabled = key === 'trayLayout' && settings.mode === 'column';
      return h('div', { class: 'option-row' + (disabled ? ' disabled' : '') },
        h('span', { class: 'option-label' }, label),
        h('div', { class: 'chips' }, choices.map(([value, text]) => h('button', {
          class: 'chip', 'aria-pressed': String(settings[key] === value), disabled,
          onclick: () => { settings[key] = value; renderForm(); },
        }, text))));
    }));
  };
  renderForm();

  const start = async () => {
    if (inProgress && !confirm('진행 중인 세션을 지우고 새로 시작할까요?')) return;
    table.quizSettings = { ...settings };
    await db.put('tables', table);
    await startSession(model, settings);
    go(`#/table/${tableId}/quiz`);
  };

  const canStart = model.items.length > 0;
  const info = canStart
    ? `문제 ${model.items.length}개 · 출제 열 ${model.quizCols.length}개`
    : '물을 문제가 없어요. 표 설정에서 출제 열과 행을 확인하세요';

  return h('section', { class: 'screen' },
    bar(table.name, tableId),
    h('main', { class: 'content settings-body' },
      h('section', { class: 'panel' }, h('h2', {}, '세션 설정'), form),
      h('p', { class: 'muted' }, info),
      h('div', { class: 'session-actions' },
        inProgress ? h('button', { class: 'btn primary big', onclick: () => go(`#/table/${tableId}/quiz`) },
          `이어하기 (${inProgress.round}바퀴 ${inProgress.index + 1}/${inProgress.queue.length})`) : null,
        h('button', { class: 'btn big' + (inProgress ? '' : ' primary'), disabled: !canStart, onclick: start },
          inProgress ? '새로 시작' : '시작'))));
}

export async function resultScreen(tableId) {
  const data = await loadTableData(tableId);
  if (!data) { go('#/'); return h('div'); }
  const session = await db.get('sessions', tableId);
  if (!session?.done || !session.summary) { go(`#/table/${tableId}/session`); return h('div'); }
  const s = session.summary;
  const { table, urls } = data;
  const pct = Math.round(s.firstAccuracy * 100);

  const stat = (label, value) => h('div', { class: 'stat' }, h('span', { class: 'stat-value' }, value), h('span', { class: 'stat-label' }, label));

  const wrongList = s.wrongItems.length
    ? h('ul', { class: 'wrong-list' }, s.wrongItems.slice(0, 10).map((w) => h('li', {},
      urls.has(w.repCellId) ? h('img', { src: urls.get(w.repCellId), alt: '', draggable: 'false' }) : h('span', {}, `${w.rows[0] + 1}행`),
      h('span', { class: 'wrong-count' }, `${w.count}번`))))
    : h('p', { class: 'muted' }, '틀린 문제가 없어요');

  const colEntries = (table.quizCols || []).filter((c) => c !== table.repCol);
  const colList = h('ul', { class: 'col-wrong' }, colEntries.map((col) => h('li', {},
    colTag(data, col), h('span', { class: s.colWrong[col] ? 'wrong-count' : 'muted' }, `${s.colWrong[col] || 0}개`))));

  // 열별 줄로 풀어 90% 넘게 맞혔으면 섞어서 풀어보라고 권한다
  const suggest = s.trayLayout === 'byCol' && s.firstAccuracy >= 0.9 && table.quizSettings?.trayLayout !== 'mixed'
    ? h('button', {
      class: 'btn primary big', onclick: async (e) => {
        table.quizSettings = { ...DEFAULT_SETTINGS, ...table.quizSettings, trayLayout: 'mixed' };
        await db.put('tables', table);
        e.currentTarget.disabled = true;
        e.currentTarget.textContent = '다음엔 모두 섞기로 ✓';
        toast('다음 세션부터 모두 섞어요');
      },
    }, '다음엔 모두 섞기로')
    : null;

  return h('section', { class: 'screen' },
    bar('결과', null),
    h('main', { class: 'content settings-body' },
      h('section', { class: 'panel stats' },
        stat('바퀴', `${s.rounds}`),
        stat('첫 바퀴 정답률', `${pct}%`),
        stat('문제', `${s.items}`)),
      suggest,
      h('section', { class: 'panel' }, h('h2', {}, '자주 틀린 행'), wrongList),
      h('section', { class: 'panel' }, h('h2', {}, '열별 오답 수'), colList),
      h('div', { class: 'session-actions' },
        h('button', { class: 'btn big', onclick: () => go('#/') }, '홈'),
        h('button', { class: 'btn primary big', onclick: () => go(`#/table/${tableId}/session`) }, '다시 하기'))));
}
