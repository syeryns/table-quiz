// 사진 줄이기·회전·자르기와 칸 잘라내기

export const MAX_EDGE = 2000;

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// 파일을 읽어 긴 변이 maxEdge 이하인 canvas로. 사진의 EXIF 방향은 브라우저가 적용한다.
export async function loadImageFile(file, maxEdge = MAX_EDGE) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return scaleTo(img, img.naturalWidth, img.naturalHeight, maxEdge);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function scaleTo(src, w, h, maxEdge) {
  const s = Math.min(1, maxEdge / Math.max(w, h));
  const c = makeCanvas(w * s, h * s);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// 각도(도)만큼 돌린 canvas. 빈 모서리는 흰색으로 채운다.
export function rotateCanvas(src, deg, into = null) {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const w = Math.round(src.width * cos + src.height * sin);
  const h = Math.round(src.width * sin + src.height * cos);
  const c = into || makeCanvas(w, h);
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(rad);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  ctx.restore();
  return c;
}

// frac = { x0, y0, x1, y1 } (0~1 비율)
export function cropCanvas(src, frac) {
  const x0 = Math.round(frac.x0 * src.width), y0 = Math.round(frac.y0 * src.height);
  const x1 = Math.round(frac.x1 * src.width), y1 = Math.round(frac.y1 * src.height);
  const c = makeCanvas(x1 - x0, y1 - y0);
  c.getContext('2d').drawImage(src, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
  return c;
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('이미지 변환 실패'))), type, quality);
  });
}

// 칸 안에서 글자가 있는 영역만 남긴다. 가장자리에 남은 선 조각은 무시한다.
// 결과는 칸 안 좌표 { x, y, w, h }. 빈 칸이면 null.
export function contentBox(imageData, pad = 6) {
  const { width: w, height: h, data } = imageData;
  const lum = new Uint8Array(w * h);
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    const v = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    lum[i] = v; hist[v]++;
  }
  // 배경 밝기 = 밝은 쪽 90번째 백분위
  let acc = 0, bg = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= lum.length * 0.9) { bg = v; break; }
  }
  const thr = bg - Math.max(40, bg * 0.25);
  const dark = (x, y) => lum[y * w + x] < thr;

  // 가장자리 8px 안에서 60% 넘게 어두운 줄은 선 조각으로 보고 잘라낸다
  const edge = Math.min(8, Math.floor(Math.min(w, h) / 4));
  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  const rowDark = (y) => { let n = 0; for (let x = left; x <= right; x++) n += dark(x, y); return n / (right - left + 1); };
  const colDark = (x) => { let n = 0; for (let y = top; y <= bottom; y++) n += dark(x, y); return n / (bottom - top + 1); };
  for (let k = 0; k < 2; k++) {
    for (let y = top; y < edge && rowDark(y) > 0.6; y++) top = y + 1;
    for (let y = bottom; y > h - 1 - edge && rowDark(y) > 0.6; y--) bottom = y - 1;
    for (let x = left; x < edge && colDark(x) > 0.6; x++) left = x + 1;
    for (let x = right; x > w - 1 - edge && colDark(x) > 0.6; x--) right = x - 1;
  }
  if (top > bottom || left > right) return null;

  // 점 하나짜리 잡티는 무시: 어두운 픽셀이 2개 이상인 줄만 센다
  let y0 = -1, y1 = -1, x0 = -1, x1 = -1;
  const colCount = new Uint32Array(w);
  for (let y = top; y <= bottom; y++) {
    let n = 0;
    for (let x = left; x <= right; x++) if (dark(x, y)) { n++; colCount[x]++; }
    if (n >= 2) { if (y0 < 0) y0 = y; y1 = y; }
  }
  for (let x = left; x <= right; x++) {
    if (colCount[x] >= 2) { if (x0 < 0) x0 = x; x1 = x; }
  }
  if (y0 < 0 || x0 < 0) return null;
  const bx0 = Math.max(left, x0 - pad), by0 = Math.max(top, y0 - pad);
  const bx1 = Math.min(right, x1 + pad), by1 = Math.min(bottom, y1 + pad);
  return { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 };
}

// 격자대로 칸을 잘라 Blob으로. merges = [{ col, r0, r1 }]
// 결과: [{ row, col, rowSpan, blob, blank }]
export async function cropCells(src, grid, merges, thickness = 2) {
  const { xs, ys } = grid;
  const inset = Math.ceil(thickness / 2) + 1;
  const ctx = src.getContext('2d', { willReadFrequently: true });
  const out = [];
  for (let col = 0; col < xs.length - 1; col++) {
    for (let row = 0; row < ys.length - 1; row++) {
      const covering = merges.find((m) => m.col === col && row >= m.r0 && row <= m.r1);
      if (covering && covering.r0 !== row) continue; // 병합 칸의 아래쪽 행은 건너뜀
      const rowSpan = covering ? covering.r1 - covering.r0 + 1 : 1;
      const x = xs[col] + inset, y = ys[row] + inset;
      const w = Math.max(1, xs[col + 1] - inset - x);
      const h = Math.max(1, ys[row + rowSpan] - inset - y);
      const box = contentBox(ctx.getImageData(x, y, w, h));
      const r = box || { x: 0, y: 0, w, h };
      const c = makeCanvas(r.w, r.h);
      c.getContext('2d').drawImage(src, x + r.x, y + r.y, r.w, r.h, 0, 0, r.w, r.h);
      out.push({ row, col, rowSpan, blob: await canvasToBlob(c), blank: !box });
    }
  }
  return out;
}
