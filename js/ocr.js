// 글자 열 인식, 쪼개기·정규화

import { makeCanvas } from './cropper.js';

// [기준 글자, 버튼 이름]
export const SPLIT_OPTIONS = [
  [',', ','],
  ['+', '+'],
  ['\n', '줄바꿈'],
  ['/', '/'],
  [';', ';'],
  ['·', '·'],
];
export const DEFAULT_SPLIT = [',', '+', '\n'];
export const LOW_CONF = 70;

const PAIRS = { '(': ')', '[': ']', '{': '}', '（': '）', '［': '］' };
const CLOSERS = new Set(Object.values(PAIRS));

// 비교용 값: 앞뒤·중복 공백 정리, 대소문자 통일
export function normKey(s) {
  return String(s).normalize('NFC').replace(/\s+/g, ' ').trim().toUpperCase();
}

// 전체를 감싼 괄호만 벗긴다. "(추1,추2)" → "추1,추2", "(a) (b)"는 그대로
export function stripWrap(s) {
  let t = String(s).trim();
  for (;;) {
    const close = PAIRS[t[0]];
    if (!close || t[t.length - 1] !== close) return t;
    let depth = 0, wraps = true;
    for (let i = 0; i < t.length; i++) {
      if (PAIRS[t[i]]) depth++;
      else if (CLOSERS.has(t[i])) {
        depth--;
        if (depth === 0 && i < t.length - 1) { wraps = false; break; }
      }
    }
    if (!wraps) return t;
    t = t.slice(1, -1).trim();
  }
}

// 기준 글자로 쪼갠다. 괄호 안의 기준 글자는 쪼개지 않는다: "C6 (C7, C8)" → 한 조각
export function splitText(text, splitChars = DEFAULT_SPLIT) {
  const body = stripWrap((text ?? '').replace(/\r/g, ''));
  if (!body) return [];
  const seps = new Set(splitChars);
  const pieces = [];
  let cur = '', depth = 0;
  for (const ch of body) {
    if (PAIRS[ch]) depth++;
    else if (CLOSERS.has(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0 && seps.has(ch)) { pieces.push(cur); cur = ''; }
    else cur += ch;
  }
  pieces.push(cur);
  const seen = new Set();
  const out = [];
  for (const p of pieces) {
    const t = stripWrap(p.replace(/\n/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const k = normKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

// 인식 결과 다듬기: 줄 끝 공백, 빈 줄, 겹친 공백 정리
export function cleanText(s) {
  return String(s)
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

// ---- 신경 번호 보정 ----
// 인식 엔진이 C5, C6의 C를 숫자 6으로 읽는 일이 잦다("65+66").
// 열의 조각 상당수가 C5·T1·L4·S1 꼴이면 6x/Gx를 Cx로 고친다.

const LEVEL = /^[CTLS]\d{1,2}$/i;

export function looksLikeLevels(partsList) {
  const all = partsList.flat();
  const n = all.filter((p) => LEVEL.test(p)).length;
  return n >= 2 && n >= all.length * 0.3;
}

export function fixLevelText(text) {
  return String(text).replace(/(^|[^A-Za-z0-9])[6G]([1-8])(?![0-9])/g, '$1C$2');
}

// ---- 인식 엔진 ----

let workerPromise = null;

// 처음 부를 때만 엔진과 한국어·영어 데이터를 불러온다
export function loadEngine() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const { default: Tesseract } = await import('../vendor/tesseract/tesseract.esm.min.js');
    const base = new URL('../vendor/tesseract/', import.meta.url).href;
    const worker = await Tesseract.createWorker(['kor', 'eng'], Tesseract.OEM.LSTM_ONLY, {
      workerPath: base + 'worker.min.js',
      corePath: base,
      langPath: base + 'lang',
      gzip: true,
      cacheMethod: 'none',   // 파일 캐시는 service worker가 맡는다
      workerBlobURL: false,
    });
    await worker.setParameters({
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
      preserve_interword_spaces: '1',
    });
    return worker;
  })().catch((e) => {
    workerPromise = null;
    throw e;
  });
  return workerPromise;
}

// 작은 칸 이미지는 키우고 흰 여백을 둘러야 잘 읽힌다
async function prepare(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(2, 2400 / Math.max(bmp.width, bmp.height));
  const pad = 16;
  const c = makeCanvas(bmp.width * scale + pad * 2, bmp.height * scale + pad * 2);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, pad, pad, bmp.width * scale, bmp.height * scale);
  bmp.close?.();
  return c;
}

// 칸 이미지 하나를 읽는다 → { text, confidence }
export async function recognize(blob) {
  const worker = await loadEngine();
  const { data } = await worker.recognize(await prepare(blob));
  return { text: cleanText(data.text), confidence: Math.round(data.confidence) };
}
