// 표 선 감지와 병합 후보 찾기. canvas getImageData로 직접 계산한다.

// 이진화 결과. bin[y * w + x] === 1 이면 어두운 픽셀
export function analyze(canvas) {
  const w = canvas.width, h = canvas.height;
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }
  return { w, h, bin: binarize(gray, w, h) };
}

// 주변 평균보다 확실히 어두우면 1. 카메라 사진의 고르지 않은 조명에도 버틴다.
function binarize(gray, w, h) {
  const r = Math.max(8, Math.round(Math.min(w, h) / 60));
  const C = 10;
  // 적분 영상
  const W = w + 1;
  const integral = new Uint32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integral[(y + 1) * W + x + 1] = integral[y * W + x + 1] + rowSum;
    }
  }
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const sum = integral[y1 * W + x1] - integral[y0 * W + x1] - integral[y1 * W + x0] + integral[y0 * W + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      if (gray[y * w + x] < mean - C) bin[y * w + x] = 1;
    }
  }
  return bin;
}

// 0~n-1을 훑으며 at(k)가 1인 픽셀 가운데 minRun 이상 이어진 구간에 속한 것만 센다.
// 1px 끊김은 이어진 것으로 본다. 잡음과 글자는 짧게 끊기고 선은 길게 이어진다.
function coverage(at, n, minRun) {
  let total = 0, run = 0, gap = 0;
  for (let k = 0; k < n; k++) {
    if (at(k)) {
      if (run > 0 && gap <= 1) run += gap + 1;
      else { if (run >= minRun) total += run; run = 1; }
      gap = 0;
    } else if (run > 0 && ++gap > 1) {
      if (run >= minRun) total += run;
      run = 0; gap = 0;
    }
  }
  if (run >= minRun) total += run;
  return total;
}

const minRunFor = (len) => Math.max(8, Math.round(len * 0.015));

// 각 줄에서 길게 이어진 어두운 픽셀 수. 살짝 기운 1px 선도 잡도록 앞뒤 한 줄씩 겹쳐 본다.
function profile(an, axis) {
  const { w, h, bin } = an;
  const len = axis === 'y' ? h : w;
  const counts = new Uint32Array(len);
  if (axis === 'y') {
    const minRun = minRunFor(w);
    for (let y = 0; y < h; y++) {
      const a = Math.max(0, y - 1) * w, b = y * w, c = Math.min(h - 1, y + 1) * w;
      counts[y] = coverage((x) => bin[a + x] | bin[b + x] | bin[c + x], w, minRun);
    }
  } else {
    const minRun = minRunFor(h);
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - 1), c = Math.min(w - 1, x + 1);
      counts[x] = coverage((y) => bin[y * w + a] | bin[y * w + x] | bin[y * w + c], h, minRun);
    }
  }
  return counts;
}

// 길이의 60% 이상 어두운 줄을 후보로 잡고, 3px 안에 붙은 후보는 하나로 합친다
function findLines(counts, span) {
  const minCount = span * 0.6;
  const lines = [];
  let group = null;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] < minCount) continue;
    if (group && i - group.end <= 3) {
      group.end = i; group.sum += counts[i] * i; group.weight += counts[i];
    } else {
      if (group) lines.push(group);
      group = { start: i, end: i, sum: counts[i] * i, weight: counts[i] };
    }
  }
  if (group) lines.push(group);
  return lines.map((g) => ({
    pos: Math.round(g.sum / g.weight),
    // 겹쳐 보기 때문에 실제보다 2px 두껍게 잡힌다
    thickness: Math.max(1, g.end - g.start + 1 - 2),
  }));
}

// 첫 선 바깥에 글자가 있으면(바깥 테두리가 없는 표) 그림 끝을 경계로 쓴다.
// 바깥이 빈 여백이면 첫 선이 곧 테두리다.
function withEdges(an, axis, positions) {
  const len = axis === 'y' ? an.h : an.w;
  const out = [...positions];
  const gap = 4;
  if (!out.length || hasContent(an, axis, 0, out[0] - gap)) out.unshift(0);
  if (hasContent(an, axis, out[out.length - 1] + gap, len - 1)) out.push(len - 1);
  return out;
}

// axis 방향 a~b 띠에 글자가 있는지.
// 2×2가 모두 어두운 덩어리만 센다: 글자 획은 덩어리가 지고 잡음 점은 흩어져 있다.
// 종이 가장자리·그림자처럼 띠를 가로지르는 긴 줄은 글자가 아니므로 뺀다.
function hasContent(an, axis, a, b) {
  const { w, h, bin } = an;
  if (b - a < 6) return false;
  const solid = (x, y) => x + 1 < w && y + 1 < h &&
    bin[y * w + x] & bin[y * w + x + 1] & bin[(y + 1) * w + x] & bin[(y + 1) * w + x + 1];
  const len = axis === 'y' ? w : h;
  let n = 0;
  for (let i = a; i <= b; i++) {
    let line = 0;
    for (let k = 0; k < len; k++) line += axis === 'y' ? solid(k, i) : solid(i, k);
    if (line < len * 0.3) n += line;
  }
  // 글자가 있는 띠는 덩어리 밀도가 1% 넘고, 잡음뿐인 여백은 0.3% 안팎
  return n / ((b - a + 1) * len) > 0.006;
}

export function edgeGrid(an) {
  return { xs: [0, an.w - 1], ys: [0, an.h - 1] };
}

// 격자 감지. found가 false면 선을 거의 못 찾은 것이므로 수동 모드로 간다.
// 어두운 내용이 있는 영역의 폭·높이. 표를 바짝 자르지 않아도 선 길이를 표 크기에 견준다.
function contentSpan(an) {
  const { w, h, bin } = an;
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) {
    if (!coverage((x) => bin[y * w + x], w, 4)) continue;
    if (y < y0) y0 = y;
    y1 = y;
  }
  for (let x = 0; x < w; x++) {
    if (!coverage((y) => bin[y * w + x], h, 4)) continue;
    if (x < x0) x0 = x;
    x1 = x;
  }
  if (x1 < 0 || y1 < 0) return { w, h };
  return { w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function detectGrid(an) {
  const span = contentSpan(an);
  const hLines = findLines(profile(an, 'y'), span.w);
  const vLines = findLines(profile(an, 'x'), span.h);
  const found = hLines.length >= 2 && vLines.length >= 1;
  const all = [...hLines, ...vLines].map((l) => l.thickness).sort((a, b) => a - b);
  const thickness = all.length ? all[Math.floor(all.length / 2)] : 2;
  if (!found) return { grid: edgeGrid(an), thickness, found };
  return {
    grid: {
      xs: withEdges(an, 'x', vLines.map((l) => l.pos)),
      ys: withEdges(an, 'y', hLines.map((l) => l.pos)),
    },
    thickness,
    found,
  };
}

// 열마다 칸 경계의 가로선 구간을 검사해 선이 끊긴 곳을 병합 후보로 돌려준다.
// 결과: [{ col, r0, r1 }] (r0~r1 행을 합침, 양끝 포함)
export function suggestMerges(an, grid, thickness = 2) {
  const { w, bin } = an;
  const { xs, ys } = grid;
  const band = Math.max(2, Math.ceil(thickness / 2) + 2);
  const out = [];
  for (let c = 0; c < xs.length - 1; c++) {
    const cw = xs[c + 1] - xs[c];
    const inset = Math.max(thickness + 2, Math.round(cw * 0.1));
    const xa = xs[c] + inset, xb = xs[c + 1] - inset;
    if (xb - xa < 4) continue;
    let run = null;
    for (let i = 1; i < ys.length - 1; i++) {
      const ya = Math.max(1, ys[i] - band), yb = Math.min(an.h - 2, ys[i] + band);
      const len = xb - xa, minRun = Math.max(6, Math.round(len * 0.05));
      let best = 0;
      for (let y = ya; y <= yb; y++) {
        const r0 = (y - 1) * w, r1 = y * w, r2 = (y + 1) * w;
        best = Math.max(best, coverage((k) => bin[r0 + xa + k] | bin[r1 + xa + k] | bin[r2 + xa + k], len, minRun));
      }
      const broken = best / len < 0.6;
      if (broken) {
        // i번째 가로선이 끊김 → i-1행과 i행이 한 칸
        if (run && run.r1 === i - 1) run.r1 = i;
        else { run = { col: c, r0: i - 1, r1: i }; out.push(run); }
      }
    }
  }
  return out;
}
