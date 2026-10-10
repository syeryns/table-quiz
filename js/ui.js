// 화면들이 같이 쓰는 작은 DOM 도우미

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return el;
}

let toastTimer = null;
export function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'toast', role: 'status' });
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

export function go(hash) {
  location.hash = hash;
}

export function formatDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
}

// 화면에서 만든 Blob URL. 다른 화면으로 넘어갈 때 한꺼번에 해제한다.
let screenUrls = [];
export function blobURL(blob) {
  const url = URL.createObjectURL(blob);
  screenUrls.push(url);
  return url;
}
export function releaseScreenUrls() {
  for (const u of screenUrls) URL.revokeObjectURL(u);
  screenUrls = [];
}
