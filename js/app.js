// 화면 전환(해시 라우팅)과 홈 화면

import * as db from './db.js';
import { h, toast, go, formatDate, releaseScreenUrls } from './ui.js';
import { importScreen } from './import.js';
import { settingsScreen } from './settings.js';

const app = document.getElementById('app');

// ---- 백업 ----

async function exportBackup() {
  try {
    const json = await db.exportAll();
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `table-quiz-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
    const file = new File([json], name, { type: 'application/json' });

    // iPad는 공유 시트에서 "파일에 저장"을 고를 수 있다
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return; // 사용자가 닫음
        // 사용자 제스처가 끊겨 막힌 경우 등은 다운로드로 넘어간다
      }
    }
    const url = URL.createObjectURL(file);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    console.error(e);
    toast('내보내지 못했어요');
  }
}

function pickBackupFile() {
  const input = h('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (!confirm('백업을 가져올까요? 같은 표는 백업 내용으로 바뀌어요.')) return;
    try {
      const { tables } = await db.importAll(await file.text());
      toast(`표 ${tables}개를 가져왔어요`);
      render();
    } catch (e) {
      console.error(e);
      toast(e.message || '가져오지 못했어요');
    }
  });
  input.click();
}

// ---- 화면 ----

async function homeScreen() {
  const tables = await db.listTables();

  const list = tables.length
    ? h('ul', { class: 'table-list' },
        tables.map((t) =>
          h('li', {},
            h('button', { class: 'table-item', onclick: () => go(`#/table/${t.id}/settings`) },
              h('span', { class: 'table-name' }, t.name),
              h('span', { class: 'table-date' }, formatDate(t.createdAt)))
          )
        ))
    : h('div', { class: 'empty' },
        h('p', {}, '아직 표가 없어요'),
        h('p', { class: 'muted' }, '표 사진을 넣어 시작하세요'));

  return h('section', { class: 'screen home' },
    h('header', { class: 'bar' },
      h('h1', {}, '표 암기'),
      h('button', { class: 'btn primary', onclick: () => go('#/import') }, '새 표')),
    h('main', { class: 'content' }, list),
    h('footer', { class: 'backup' },
      h('button', { class: 'btn', onclick: exportBackup }, '전체 내보내기'),
      h('button', { class: 'btn', onclick: pickBackupFile }, '가져오기')));
}

// 아직 만들지 않은 화면
function placeholder(title) {
  return h('section', { class: 'screen' },
    h('header', { class: 'bar' },
      h('button', { class: 'btn', onclick: () => go('#/') }, '홈'),
      h('h1', {}, title),
      h('span', { class: 'bar-spacer' })),
    h('main', { class: 'content' },
      h('div', { class: 'empty' }, h('p', { class: 'muted' }, '준비 중'))));
}

// 홈 / 가져오기 / 표 설정 / 세션 설정 / 퀴즈 / 결과
const routes = [
  { pattern: /^\/?$/, screen: homeScreen },
  { pattern: /^\/import$/, screen: importScreen },
  { pattern: /^\/table\/([^/]+)\/settings$/, screen: settingsScreen },
  { pattern: /^\/table\/([^/]+)\/session$/, screen: () => placeholder('세션 설정') },
  { pattern: /^\/table\/([^/]+)\/quiz$/, screen: () => placeholder('퀴즈') },
  { pattern: /^\/table\/([^/]+)\/result$/, screen: () => placeholder('결과') },
];

let renderSeq = 0;
async function render() {
  const path = location.hash.replace(/^#/, '');
  const route = routes.find((r) => r.pattern.test(path));
  if (!route) { go('#/'); return; }
  const params = path.match(route.pattern).slice(1);
  const seq = ++renderSeq;
  try {
    const view = await route.screen(...params);
    if (seq !== renderSeq) return; // 그 사이 다른 화면으로 이동함
    releaseScreenUrls();
    app.replaceChildren(view);
    window.scrollTo(0, 0);
  } catch (e) {
    console.error(e);
    toast('화면을 열지 못했어요');
  }
}

window.addEventListener('hashchange', render);
render();

// iPad Safari의 두 손가락 확대가 화면 전체를 키우지 않게
document.addEventListener('gesturestart', (e) => e.preventDefault());

db.requestPersist().catch(() => {});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW 등록 실패', e));
}
