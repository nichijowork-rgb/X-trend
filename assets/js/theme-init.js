// テーマの初期適用（描画前に同期実行してちらつきを防ぐ）。
// 保存値: 'light' | 'dark'。未保存なら OS 設定（prefers-color-scheme）に追従し、指定が無ければダーク。
(function () {
  try {
    var t = window.localStorage.getItem('xreport-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    /* localStorage が使えない環境（プライベートモード等）では OS 設定に追従 */
  }
})();
