// 右クリックメニュー・「移動先…」・名前入力のダイアログ（編成画面）。キーボードでも操作できる。
import { h, btn } from '../dom.js';

/**
 * 右クリック／「…」のメニュー。items: [{ label, run, key?, danger?, disabled?, heading? }]
 * x, y: 画面上の位置。onClose: 閉じたとき
 */
export function contextMenu(items, x, y, onClose) {
  const menu = h('div', { class: 'ctx-menu', attrs: { role: 'menu', 'aria-label': '操作' }, dataset: { key: 'ctx-menu' } });
  for (const it of items) {
    if (!it) continue;
    if (it.heading) { menu.append(h('p', { class: 'ctx-heading', attrs: { role: 'presentation' } }, it.heading)); continue; }
    if (it.sep) { menu.append(h('hr', { class: 'ctx-sep' })); continue; }
    menu.append(h('button', {
      type: 'button', class: `ctx-item${it.danger ? ' is-danger' : ''}`, disabled: Boolean(it.disabled), dataset: { key: it.key || '' },
      attrs: { role: 'menuitem', title: it.title || null },
      on: { click: (e) => { e.stopPropagation(); onClose(); it.run(); } },
    }, it.label, it.hint ? h('kbd', {}, it.hint) : null));
  }
  menu.addEventListener('keydown', (e) => {
    const list = [...menu.querySelectorAll('.ctx-item:not(:disabled)')];
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); (list[i + 1] || list[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (list[i - 1] || list[list.length - 1]).focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === 'Tab') { e.preventDefault(); }
  });
  // 画面からはみ出さない位置へ（描いた後に調整）
  menu.style.left = `${Math.max(4, x)}px`;
  menu.style.top = `${Math.max(4, y)}px`;
  requestAnimationFrame(() => {
    if (!menu.isConnected) return;
    const r = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (r.right > vw - 4) menu.style.left = `${Math.max(4, vw - r.width - 4)}px`;
    if (r.bottom > vh - 4) menu.style.top = `${Math.max(4, vh - r.height - 4)}px`;
    const first = menu.querySelector('.ctx-item:not(:disabled)');
    if (first && !menu.contains(document.activeElement)) first.focus({ preventScroll: true });
  });
  return menu;
}

/**
 * 「移動先…」ダイアログ。targets: [{ key, label, sub?, group, disabled? }]
 * onPick(key) で選ぶ。上下キーで移動・Enter で決定・Esc で閉じる。絞り込み欄つき。
 */
export function moveDialog({ title, targets, onPick, onClose, filter = '' }) {
  const dlg = h('dialog', { class: 'move-dialog', attrs: { 'data-modal': '', 'aria-labelledby': 'move-title' }, dataset: { keep: 'move-dialog' } });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); onClose(); });
  const input = h('input', { class: 'input', type: 'search', placeholder: 'フォルダ名で絞り込み', value: filter, dataset: { key: 'move-filter' }, attrs: { 'aria-label': 'フォルダ名で絞り込み', autocomplete: 'off' } });
  const list = h('div', { class: 'move-list', attrs: { role: 'listbox', 'aria-label': '移動先' } });
  const fill = () => {
    while (list.firstChild) list.firstChild.remove();
    const q = input.value.trim().normalize('NFKC').toLowerCase();
    let lastGroup = null;
    for (const t of targets) {
      if (q && !`${t.label} ${t.sub || ''}`.normalize('NFKC').toLowerCase().includes(q)) continue;
      if (t.group !== lastGroup) { list.append(h('p', { class: 'move-group' }, t.group)); lastGroup = t.group; }
      list.append(h('button', {
        type: 'button', class: `move-item${t.genre ? ` g-${t.genre}-edge` : ''}`, disabled: Boolean(t.disabled), dataset: { key: `move-to-${t.key}` },
        attrs: { role: 'option' }, on: { click: () => onPick(t.key) },
      }, h('span', { class: 'move-label' }, t.label), t.sub ? h('span', { class: 'move-sub' }, t.sub) : null));
    }
    if (!list.querySelector('.move-item')) list.append(h('p', { class: 'muted' }, '該当なし'));
  };
  input.addEventListener('input', fill);
  dlg.addEventListener('keydown', (e) => {
    const items = [...list.querySelectorAll('.move-item:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); (items[i + 1] || items[0])?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (i <= 0) input.focus(); else items[i - 1].focus(); }
    else if (e.key === 'Enter' && document.activeElement === input && items[0]) { e.preventDefault(); items[0].click(); }
  });
  fill();
  dlg.append(h('header', { class: 'move-head' }, h('h2', { id: 'move-title' }, title), btn('閉じる', onClose, 'btn btn-small btn-ghost', { 'data-key': 'move-close' })),
    input, list);
  return dlg;
}

/**
 * 名前（とジャンル）を入れるダイアログ（新しいまとまり・まとまりにする・名前を変える）。
 * fields: { name, genre?（null ならジャンル欄なし）, genres: [{key,label}] }
 */
export function nameDialog({ title, okLabel, name = '', genre = null, genres = [], onOk, onClose }) {
  const dlg = h('dialog', { class: 'name-dialog', attrs: { 'data-modal': '', 'aria-labelledby': 'name-title' }, dataset: { keep: 'name-dialog' } });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); onClose(); });
  const input = h('input', { class: 'input', type: 'text', value: name, maxLength: 80, dataset: { key: 'name-input' }, attrs: { autocomplete: 'off', 'aria-label': '名前' } });
  const sel = genre != null ? h('select', { class: 'input', dataset: { key: 'name-genre' }, attrs: { 'aria-label': 'ジャンル' } }, genres.map((g) => h('option', { value: g.key, selected: g.key === genre }, g.label))) : null;
  const ok = () => onOk(input.value, sel ? sel.value : null);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
  dlg.append(h('h2', { id: 'name-title', class: 'name-title' }, title),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, '名前'), input),
    sel ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'ジャンル'), sel) : null,
    h('div', { class: 'row' }, btn(okLabel, ok, 'btn btn-red', { 'data-key': 'name-ok' }), btn('やめる', onClose, 'btn btn-ghost', { 'data-key': 'name-cancel' })));
  requestAnimationFrame(() => { if (input.isConnected) { input.focus(); input.select(); } });
  return dlg;
}
