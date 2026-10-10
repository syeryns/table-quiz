// 표 설정 화면. 지금은 저장된 칸을 표 모양으로 다시 짜서 보여준다. (설정 항목은 3단계)

import * as db from './db.js';
import { h, go, blobURL } from './ui.js';

export async function settingsScreen(tableId) {
  const table = await db.get('tables', tableId);
  if (!table) {
    return h('section', { class: 'screen' },
      h('header', { class: 'bar' },
        h('button', { class: 'btn', onclick: () => go('#/') }, '홈'),
        h('h1', {}, '표 설정'),
        h('span', { class: 'bar-spacer' })),
      h('main', { class: 'content' }, h('div', { class: 'empty' }, h('p', {}, '표를 찾지 못했어요'))));
  }

  const cells = await db.getAllByIndex('cells', 'tableId', tableId);
  const images = new Map();
  await Promise.all(cells.map(async (c) => {
    const img = await db.get('images', c.imageId);
    if (img) images.set(c.id, blobURL(img.blob));
  }));

  const { xs, ys } = table.grid;
  const cols = xs.length - 1, rows = ys.length - 1;
  // 열 너비는 원래 표 비율대로
  const template = Array.from({ length: cols }, (_, i) => `minmax(0, ${xs[i + 1] - xs[i]}fr)`).join(' ');

  const preview = h('div', { class: 'table-preview', style: { gridTemplateColumns: template } },
    cells.map((c) =>
      h('div', {
        class: 'preview-cell' + (table.hasHeader && c.row === 0 ? ' header' : '') + (c.rowSpan > 1 ? ' merged' : ''),
        style: { gridColumn: `${c.col + 1}`, gridRow: `${c.row + 1} / span ${c.rowSpan}` },
      }, images.has(c.id) ? h('img', { src: images.get(c.id), alt: '', draggable: 'false' }) : null)));

  return h('section', { class: 'screen' },
    h('header', { class: 'bar' },
      h('button', { class: 'btn', onclick: () => go('#/') }, '홈'),
      h('h1', {}, table.name),
      h('span', { class: 'bar-spacer' })),
    h('main', { class: 'content' },
      h('p', { class: 'muted' }, `${rows}행 × ${cols}열 · 칸 ${cells.length}개`),
      preview));
}
