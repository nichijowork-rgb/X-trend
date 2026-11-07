// 自分で追加した画像の置き場所（ブラウザの IndexedDB。localStorage は容量が足りないため）。
// レコード: { id, full: Blob（長辺 1600px まで）, obs: data URL（長辺 1280px まで。OBS へ送る用）, type, at }
// 画像の情報（キャプション・どの話題か）は番組の保存データ（weeks[週].images）に入り、中身だけここに置く。

const DB = 'xtrend-show-images';
const STORE = 'images';
let dbp = null;

function reason(err) {
  const n = err && err.name;
  if (n === 'QuotaExceededError') return 'このパソコンの保存できる容量がいっぱいです（使わない画像を削除するか、ブラウザのデータを整理してください）';
  if (n === 'InvalidStateError' || n === 'SecurityError') return 'このブラウザ（シークレットウィンドウなど）では画像を保存できません';
  return `画像を保存できませんでした（${(err && err.message) || n || '理由不明'}）`;
}

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('このブラウザでは画像を保存できません（IndexedDB が使えません）')); return; }
    let req;
    try { req = indexedDB.open(DB, 1); } catch (e) { reject(new Error(reason(e))); return; }
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(reason(req.error)));
    req.onblocked = () => reject(new Error('画像の保存場所を開けませんでした（ほかのタブを閉じてもう一度）'));
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    let t;
    try { t = db.transaction(STORE, mode); } catch (e) { reject(new Error(reason(e))); return; }
    const store = t.objectStore(STORE);
    let out;
    try { out = fn(store); } catch (e) { reject(new Error(reason(e))); return; }
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    t.onerror = () => reject(new Error(reason(t.error)));
    t.onabort = () => reject(new Error(reason(t.error)));
  }));
}

export const putImage = (rec) => tx('readwrite', (s) => s.put(rec));
export const getImage = (id) => tx('readonly', (s) => s.get(id));
export const deleteImage = (id) => tx('readwrite', (s) => s.delete(id));
export const imageKeys = () => tx('readonly', (s) => s.getAllKeys());
