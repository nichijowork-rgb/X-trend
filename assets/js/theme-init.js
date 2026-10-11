// テーマは OS 設定（prefers-color-scheme）に自動追従（指定が無ければダーク）。手動切替は廃止。
// 以前の版で localStorage に保存した手動テーマ（dark/light）が残っていてもライト固定などにならないよう消す。
(function () {
  try {
    window.localStorage.removeItem('xreport-theme');
  } catch (e) {
    /* localStorage が使えない環境では何もしない */
  }
  document.documentElement.removeAttribute('data-theme');
})();
