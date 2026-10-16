// 再描画で X 埋め込み（iframe）を作り直さないための差し替え。
// 画面は毎回まるごと作り直すが、data-keep を付けた要素は「前と同じ要素」をその場に残し、中身だけ差し替える。
// data-keep-leaf を付けた要素（埋め込みの入れ物）は中身もそのまま残す（iframe は DOM から外すと読み直しになるため）。
// 並びが変わった要素だけ移動する（移動した埋め込みは読み直しになる）。

function copyAttributes(from, to) {
  for (const a of [...to.attributes]) if (!from.hasAttribute(a.name)) to.removeAttribute(a.name);
  for (const a of [...from.attributes]) if (to.getAttribute(a.name) !== a.value) to.setAttribute(a.name, a.value);
}

function keyOf(n) {
  return n && n.nodeType === 1 && n.dataset ? n.dataset.keep || null : null;
}

function patchChildren(oldP, newP) {
  const oldKeep = new Map();
  for (const c of [...oldP.children]) { const k = keyOf(c); if (k && !oldKeep.has(k)) oldKeep.set(k, c); }
  for (const c of [...oldP.childNodes]) if (!keyOf(c) || oldKeep.get(keyOf(c)) !== c) c.remove();
  const used = new Set();
  let cursor = oldP.firstChild;
  for (const nk of [...newP.childNodes]) {
    const k = keyOf(nk);
    const ok = k && !used.has(k) ? oldKeep.get(k) : null;
    if (ok) {
      used.add(k);
      if (ok === cursor) cursor = cursor.nextSibling;
      else oldP.insertBefore(ok, cursor);
      if (!nk.hasAttribute('data-keep-leaf')) {
        copyAttributes(nk, ok);
        patchChildren(ok, nk);
      }
      continue;
    }
    oldP.insertBefore(nk, cursor);
  }
  for (const [k, el] of oldKeep) if (!used.has(k)) el.remove();
}

/** oldRoot（表示中）を newRoot の内容に合わせる。ルートの data-keep が違えば false（呼び出し側で入れ替える） */
export function patchView(oldRoot, newRoot) {
  if (!oldRoot || !keyOf(oldRoot) || keyOf(oldRoot) !== keyOf(newRoot)) return false;
  copyAttributes(newRoot, oldRoot);
  patchChildren(oldRoot, newRoot);
  return true;
}
