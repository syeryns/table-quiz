// IndexedDB 래퍼. 저장소 구성은 PRD "핵심 개념과 데이터 모델" 참고.

const DB_NAME = 'table-quiz';
const DB_VERSION = 1;
const BACKUP_FORMAT = 'table-quiz-backup';
const BACKUP_VERSION = 1;

export const STORES = {
  tables: { keyPath: 'id' },
  cells: { keyPath: 'id', indexes: { tableId: 'tableId' } },
  images: { keyPath: 'id' },
  sessions: { keyPath: 'tableId' },
  rowStats: { keyPath: ['tableId', 'row'], indexes: { tableId: 'tableId' } },
};

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, def] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const store = db.createObjectStore(name, { keyPath: def.keyPath });
        for (const [idx, path] of Object.entries(def.indexes || {})) {
          store.createIndex(idx, path);
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // 다른 탭에서 버전을 올리면 연결을 닫고 다음 호출에서 다시 연다
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => console.warn('IndexedDB 업그레이드가 다른 탭에 막혔어요');
  });
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new DOMException('트랜잭션 중단', 'AbortError'));
  });
}

// 여러 저장소에 걸친 작업을 한 트랜잭션으로 묶는다.
// fn(stores)는 동기적으로 요청만 걸어야 한다 (await 금지: Safari에서 트랜잭션이 닫힘).
export async function transaction(storeNames, mode, fn) {
  const db = await openDB();
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  const tx = db.transaction(names, mode);
  const stores = Object.fromEntries(names.map((n) => [n, tx.objectStore(n)]));
  const result = fn(stores, tx);
  await txDone(tx);
  return result;
}

export async function get(store, key) {
  const db = await openDB();
  return promisify(db.transaction(store).objectStore(store).get(key));
}

export async function getAll(store) {
  const db = await openDB();
  return promisify(db.transaction(store).objectStore(store).getAll());
}

export async function getAllByIndex(store, index, value) {
  const db = await openDB();
  return promisify(db.transaction(store).objectStore(store).index(index).getAll(value));
}

export async function put(store, value) {
  return transaction(store, 'readwrite', (s) => { s[store].put(value); });
}

export async function putMany(store, values) {
  return transaction(store, 'readwrite', (s) => {
    for (const v of values) s[store].put(v);
  });
}

export async function del(store, key) {
  return transaction(store, 'readwrite', (s) => { s[store].delete(key); });
}

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ---- 표 단위 작업 ----

export async function listTables() {
  const tables = await getAll('tables');
  return tables.sort((a, b) => b.createdAt - a.createdAt);
}

// 표와 그 칸·이미지·세션·누적 기록을 모두 지운다
export async function deleteTable(tableId) {
  const table = await get('tables', tableId);
  if (!table) return;
  const cells = await getAllByIndex('cells', 'tableId', tableId);
  const stats = await getAllByIndex('rowStats', 'tableId', tableId);
  const imageIds = new Set(cells.map((c) => c.imageId).filter(Boolean));
  if (table.sourceImageId) imageIds.add(table.sourceImageId);

  await transaction(['tables', 'cells', 'images', 'sessions', 'rowStats'], 'readwrite', (s) => {
    s.tables.delete(tableId);
    for (const c of cells) s.cells.delete(c.id);
    for (const id of imageIds) s.images.delete(id);
    s.sessions.delete(tableId);
    for (const r of stats) s.rowStats.delete([r.tableId, r.row]);
  });
}

// 표를 칸·이미지까지 통째로 복사한다. 세션과 누적 기록은 새로 시작.
export async function duplicateTable(tableId, name) {
  const table = await get('tables', tableId);
  if (!table) throw new Error('표를 찾지 못했어요');
  const cells = await getAllByIndex('cells', 'tableId', tableId);
  const newTableId = newId();
  const imageMap = new Map();
  const mapImage = (id) => {
    if (!id) return id;
    if (!imageMap.has(id)) imageMap.set(id, newId());
    return imageMap.get(id);
  };
  const cellMap = new Map(cells.map((c) => [c.id, newId()]));
  const newCells = cells.map((c) => ({ ...c, id: cellMap.get(c.id), tableId: newTableId, imageId: mapImage(c.imageId) }));
  const newTable = {
    ...structuredClone(table),
    id: newTableId,
    name,
    createdAt: Date.now(),
    sourceImageId: mapImage(table.sourceImageId),
    sameGroups: (table.sameGroups || []).map((g) => g.map((id) => cellMap.get(id)).filter(Boolean)),
  };
  const images = await Promise.all([...imageMap].map(async ([oldId, id]) => {
    const img = await get('images', oldId);
    return img && { id, blob: img.blob };
  }));
  await transaction(['tables', 'cells', 'images'], 'readwrite', (s) => {
    for (const img of images) if (img) s.images.put(img);
    for (const c of newCells) s.cells.put(c);
    s.tables.put(newTable);
  });
  return newTableId;
}

// ---- 백업 ----

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function dataURLToBlob(dataURL) {
  const res = await fetch(dataURL);
  return res.blob();
}

// 전체 데이터를 JSON 문자열로. 이미지 Blob은 base64 data URL로 담는다.
export async function exportAll() {
  const data = {};
  for (const name of Object.keys(STORES)) {
    data[name] = await getAll(name);
  }
  data.images = await Promise.all(
    data.images.map(async (img) => ({ id: img.id, blob: await blobToDataURL(img.blob) }))
  );
  return JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    data,
  });
}

// 백업을 기존 데이터에 덮어쓴다. 같은 id는 백업 값으로 바뀌고 백업에 없는 표는 그대로 남는다.
export async function importAll(json) {
  const backup = typeof json === 'string' ? JSON.parse(json) : json;
  if (backup?.format !== BACKUP_FORMAT || !backup.data) {
    throw new Error('표 암기 백업 파일이 아니에요');
  }
  if (backup.version > BACKUP_VERSION) {
    throw new Error('더 새 버전 앱에서 만든 백업이에요');
  }
  const data = backup.data;
  // Blob 변환은 트랜잭션 밖에서 미리 끝낸다
  const images = await Promise.all(
    (data.images || []).map(async (img) => ({ id: img.id, blob: await dataURLToBlob(img.blob) }))
  );
  const names = Object.keys(STORES);
  await transaction(names, 'readwrite', (s) => {
    for (const name of names) {
      const rows = name === 'images' ? images : data[name] || [];
      for (const row of rows) s[name].put(row);
    }
  });
  return { tables: (data.tables || []).length, images: images.length };
}

// ---- 저장소 보존 ----

export async function requestPersist() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted?.()) return true;
  return navigator.storage.persist();
}
