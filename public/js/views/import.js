// 取り込み（#/import）
import { get, post as apiPost } from '../api.js';
import { state, canWrite, refreshStatus, isConfigured } from '../state.js';
import {
  h, icon, mount, button, selectEl, field, sectionCard, pageHead, emptyEl, errorEl, loadingEl, toast, toastError, copyText,
  exactNum, fmtDateTime, timeEl, badge, JOB_LABELS, RUN_STATUS_LABELS, nextId,
} from '../ui.js';

const GENRE_OPTS = [['', '自動判定'], ['nightlife', '夜職'], ['general', '一般']];
const MAX_FILE = 15 * 1024 * 1024;

/** { added, merged, skipped, errors } の表示 */
export function importResult(res, { title = '取り込み結果' } = {}) {
  const errors = Array.isArray(res.errors) ? res.errors : [];
  return h('div', { class: ['result', errors.length ? 'result-warn' : 'result-ok'], attrs: { role: 'status' } },
    h('p', { class: 'result-title', text: title }),
    h('ul', { class: 'result-counts' },
      h('li', {}, h('strong', { text: exactNum(res.added ?? 0) }), ' 件追加'),
      h('li', {}, h('strong', { text: exactNum(res.merged ?? 0) }), ' 件統合（既存と同じ投稿）'),
      h('li', {}, h('strong', { text: exactNum(res.skipped ?? 0) }), ' 件スキップ'),
      h('li', {}, h('strong', { text: exactNum(errors.length) }), ' 件エラー')),
    errors.length
      ? h('details', { class: 'result-errors' }, h('summary', { text: 'エラーの内容を見る' }),
        h('ul', {}, errors.slice(0, 50).map((e) => h('li', { text: typeof e === 'string' ? e : `${e.index !== undefined ? `#${e.index}: ` : ''}${e.message || JSON.stringify(e)}` }))),
        errors.length > 50 ? h('p', { class: 'hint', text: `ほか ${errors.length - 50}件` }) : null)
      : null,
    (res.added || res.merged) ? h('a', { class: 'btn btn-secondary btn-sm', href: '#/feed' }, icon('feed'), h('span', { text: 'フィードで見る' })) : null);
}

export async function render(root, ctx) {
  const writable = canWrite();
  mount(root,
    pageHead('取り込み', 'URL・ファイル・ブックマークレットで投稿を追加し、自動収集を実行します。'),
    writable ? null : h('p', { class: 'notice-inline notice-viewer' }, icon('lock'), h('span', { text: '閲覧専用のため、取り込みや収集はできません。実行履歴のみ表示しています。' })),
    h('div', { class: 'grid-2' },
      h('div', { class: 'col' },
        writable ? urlSection() : null,
        writable ? fileSection() : null),
      h('div', { class: 'col' },
        collectSection(ctx, writable),
        writable ? bookmarkletSection(ctx) : null)));
}

/* ---------- URL 保存 ---------- */
function urlSection() {
  const ta = h('textarea', {
    class: 'input', rows: 4, id: nextId('urls'),
    attrs: { placeholder: 'https://x.com/user/status/1234567890\n（1行に1件。URLだけでも保存できます）', spellcheck: 'false' },
  });
  let genre = '';
  const out = h('div', { class: 'result-area', attrs: { 'aria-live': 'polite' } });
  const save = async () => {
    const lines = ta.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { mount(out, h('p', { class: 'form-error', text: 'URLを入力してください。' })); ta.focus(); return; }
    if (lines.length > 200) { mount(out, h('p', { class: 'form-error', text: '一度に保存できるのは200件までです。' })); return; }
    const rows = h('ul', { class: 'url-results' });
    const progress = h('p', { class: 'hint', text: `0 / ${lines.length} 件処理中…` });
    mount(out, progress, rows);
    let ok = 0, created = 0, failed = [];
    for (const [i, line] of lines.entries()) {
      try {
        const res = await apiPost('/posts/url', { url: line, genre: genre || undefined });
        ok++; if (res.created) created++;
        const p = res.post || {};
        rows.append(h('li', { class: 'ok' }, icon('plus'),
          h('span', { text: `${res.created ? '新規保存' : '既存に統合'}：${p.authorHandle ? '@' + p.authorHandle + ' ' : ''}ID ${p.postId || '?'}` })));
      } catch (err) {
        if (err.isNetwork) { failed.push(...lines.slice(i)); rows.append(h('li', { class: 'ng', text: err.message })); break; }
        failed.push(line);
        rows.append(h('li', { class: 'ng' }, icon('alert'), h('span', { text: `${line.slice(0, 80)} — ${err.message}` })));
      }
      progress.textContent = `${i + 1} / ${lines.length} 件処理`;
    }
    progress.textContent = `${ok}件を保存しました（新規 ${created}件）${failed.length ? `、${failed.length}件は失敗` : ''}。`;
    ta.value = failed.join('\n');
    if (ok) { toast(`${ok}件のURLを保存しました`, { type: 'success' }); refreshStatus(); }
  };
  return sectionCard('URLを貼り付けて保存',
    h('p', { class: 'panel-desc', text: '気になった投稿のURLを貼るだけで保存できます。本文などは取得できた場合のみ補完されます。' }),
    field('投稿URL（複数行可）', ta),
    h('div', { class: 'form-row' },
      field('ジャンル', selectEl(GENRE_OPTS, genre, { onChange: (v) => { genre = v; } }), { inline: true }),
      button('保存する', { variant: 'primary', iconName: 'plus', onClick: save })),
    out);
}

/* ---------- JSON / CSV ---------- */
function looksLikeCapture(obj) {
  return obj && typeof obj === 'object' && !Array.isArray(obj) && Array.isArray(obj.posts) && ('v' in obj || 'capturedAt' in obj);
}
function fileSection() {
  let format = 'auto', genre = '', filename = '';
  const fileInput = h('input', { type: 'file', class: 'file-input', id: nextId('file'), accept: '.json,.csv,application/json,text/csv' });
  const fileName = h('span', { class: 'hint', text: 'ファイル未選択' });
  const ta = h('textarea', { class: 'input mono', rows: 6, id: nextId('paste'), attrs: { placeholder: '[{"id":"123…","text":"…","like_count":12}] や CSV（ヘッダ行あり）を貼り付け', spellcheck: 'false' } });
  const out = h('div', { class: 'result-area', attrs: { 'aria-live': 'polite' } });

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    if (f.size > MAX_FILE) { mount(out, h('p', { class: 'form-error', text: 'ファイルが大きすぎます（15MBまで）。分割してください。' })); return; }
    try {
      ta.value = await f.text();
      filename = f.name;
      fileName.textContent = `${f.name}（${exactNum(f.size)} バイト）`;
      if (/\.csv$/i.test(f.name)) { format = 'csv'; fmtSel.value = 'csv'; }
      else if (/\.json$/i.test(f.name)) { format = 'json'; fmtSel.value = 'json'; }
      mount(out);
    } catch { mount(out, h('p', { class: 'form-error', text: 'ファイルを読み込めませんでした。' })); }
  });
  ta.addEventListener('input', () => { if (filename) { filename = ''; fileName.textContent = '貼り付けたテキスト'; } });

  const fmtSel = selectEl([['auto', '自動判定'], ['json', 'JSON'], ['csv', 'CSV']], format, { onChange: (v) => { format = v; } });
  const submit = async () => {
    const content = ta.value.trim();
    if (!content) { mount(out, h('p', { class: 'form-error', text: 'ファイルを選ぶか、内容を貼り付けてください。' })); return; }
    let fmt = format;
    if (fmt === 'auto') fmt = /^[[{]/.test(content) ? 'json' : 'csv';
    try {
      let res;
      if (fmt === 'json') {
        let parsed = null;
        try { parsed = JSON.parse(content); } catch { mount(out, h('p', { class: 'form-error', text: 'JSONとして読み取れません。形式を確認してください。' })); return; }
        if (looksLikeCapture(parsed)) {
          res = await apiPost('/capture', { payload: parsed });
          mount(out, importResult(res, { title: 'ブックマークレットのデータを取り込みました' }));
        } else {
          res = await apiPost('/import', { format: 'json', content, filename: filename || undefined, genre: genre || undefined });
          mount(out, importResult(res));
        }
      } else {
        res = await apiPost('/import', { format: 'csv', content, filename: filename || undefined, genre: genre || undefined });
        mount(out, importResult(res));
      }
      if (res.added || res.merged) { toast(`${exactNum((res.added || 0) + (res.merged || 0))}件を取り込みました`, { type: 'success' }); refreshStatus(); }
    } catch (err) {
      mount(out, h('p', { class: 'form-error', attrs: { role: 'alert' }, text: err.message }));
    }
  };

  return sectionCard('JSON / CSV を取り込む',
    h('p', { class: 'panel-desc', text: 'エクスポートしたデータや、ブックマークレットでコピーしたJSONを取り込めます。id / url / text / like_count / public_metrics などの列名に対応します。' }),
    h('div', { class: 'file-row' },
      h('label', { class: 'btn btn-secondary', attrs: { for: fileInput.id } }, icon('upload'), h('span', { text: 'ファイルを選ぶ' })),
      fileInput, fileName),
    field('または貼り付け', ta),
    h('div', { class: 'form-row' },
      field('形式', fmtSel, { inline: true }),
      field('ジャンル', selectEl(GENRE_OPTS, genre, { onChange: (v) => { genre = v; } }), { inline: true }),
      button('取り込む', { variant: 'primary', iconName: 'import', onClick: submit })),
    out);
}

/* ---------- ブックマークレット ---------- */
function bookmarkletSection(ctx) {
  const box = h('div', {}, loadingEl('ブックマークレットを準備中…'));
  (async () => {
    try {
      const res = await get('/bookmarklet');
      if (!ctx.alive()) return;
      const code = res.code || '';
      if (!code) { mount(box, h('p', { class: 'muted', text: 'ブックマークレットを取得できませんでした。' })); return; }
      const link = h('a', {
        class: 'bookmarklet', href: code, draggable: true,
        attrs: { title: 'ブックマークバーへドラッグしてください', 'aria-label': 'X-trendに送る（ブックマークバーへドラッグして登録）' },
        on: { click: (e) => { e.preventDefault(); toast('このボタンはブックマークバーへドラッグして使います（クリックでは動きません）。'); } },
      }, icon('sparkle'), h('span', { text: 'X-trendに送る' }));
      mount(box,
        h('div', { class: 'bm-row' }, link,
          button('コードをコピー', { small: true, iconName: 'copy', onClick: () => copyText(code, 'ブックマークレットをコピーしました') })),
        h('p', { class: 'hint', text: 'ドラッグできない場合（スマホ等）：新しいブックマークを作り、URL欄にコピーしたコードを貼り付けてください。' }));
    } catch (err) {
      if (!ctx.alive()) return;
      mount(box, errorEl(err));
    }
  })();

  return sectionCard('ブックマークレット（おすすめ欄の取り込み）',
    h('ol', { class: 'steps' },
      h('li', { text: '下の「X-trendに送る」をブックマークバーへドラッグして登録します。' }),
      h('li', { text: '自分のブラウザで x.com を開き、「おすすめ」タブを表示します。' }),
      h('li', { text: '登録したブックマークを押すと、画面に表示された投稿がX-trendの取り込み画面に送られます。' }),
      h('li', { text: '内容を確認して「取り込む」を押します。件数が多いとJSONがコピーされるので、上の貼り付け欄に貼ってください。' })),
    h('p', { class: 'notice-inline notice-safe' }, icon('lock'),
      h('span', { text: 'Cookieや認証情報は読み取りません。画面に表示された投稿テキストのみを読み取ります。Xへの投稿・いいね等の操作も行いません。' })),
    box);
}

/* ---------- 収集・実行履歴 ---------- */
function collectSection(ctx, writable) {
  const runs = h('div', { class: 'runs', attrs: { 'aria-live': 'polite' } }, loadingEl('履歴を読み込み中…'));
  const loadRuns = async () => {
    try {
      const res = await get('/runs', { limit: 20 });
      if (!ctx.alive()) return;
      const items = Array.isArray(res.items) ? res.items : [];
      if (!items.length) {
        mount(runs, emptyEl({ title: '実行履歴はまだありません', body: writable ? '「今すぐ収集」を押すか、スケジュールの時刻になると記録されます。' : 'スケジュールの時刻になると記録されます。', iconName: 'play' }));
        return;
      }
      mount(runs, h('ul', { class: 'run-list' }, items.map(runItem)));
    } catch (err) {
      if (!ctx.alive()) return;
      mount(runs, errorEl(err, loadRuns));
    }
  };
  loadRuns();

  const next = (state.status?.nextRuns || []).filter((n) => n && n.at);
  const integ = state.status?.integrations || {};
  return sectionCard('自動収集',
    writable ? h('div', { class: 'form-row' },
      button('今すぐ収集', {
        variant: 'primary', iconName: 'play',
        onClick: async () => {
          try {
            const res = await apiPost('/jobs/run', { job: 'collect' });
            const r = res.run || {};
            const msg = r.message ? `：${r.message}` : '';
            toast(r.status === 'error' ? `収集に失敗しました${msg}` : r.status === 'skipped' ? `収集はスキップされました${msg}` : `収集が完了しました${msg}`,
              { type: r.status === 'error' ? 'error' : r.status === 'ok' ? 'success' : 'info', timeout: 8000 });
            refreshStatus();
            loadRuns();
          } catch (err) { toastError(err); }
        },
      }),
      button('', { iconName: 'refresh', ariaLabel: '履歴を再読み込み', title: '履歴を再読み込み', onClick: loadRuns })) : null,
    (state.status && !Object.values(integ).some(isConfigured))
      ? h('p', { class: 'hint', text: 'X API / Grok がまだ接続されていないため、自動収集では投稿が増えない場合があります（設定 → 接続状態）。' })
      : null,
    next.length ? h('p', { class: 'hint' }, '次回予定：', next.slice(0, 3).map((n, i) => h('span', {}, i ? '、' : '', `${JOB_LABELS[n.job] || n.job} ${fmtDateTime(n.at) || ''}`))) : null,
    h('h3', { class: 'sub-title', text: '実行履歴' }),
    runs);
}

export function runItem(r) {
  const counts = r.counts && typeof r.counts === 'object'
    ? Object.entries(r.counts).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${COUNT_LABELS[k] || k} ${typeof v === 'number' ? exactNum(v) : v}`).join(' ・ ')
    : '';
  return h('li', { class: `run run-${r.status}` },
    h('div', { class: 'run-head' },
      badge(RUN_STATUS_LABELS[r.status] || r.status || '不明', `status status-${r.status}`),
      h('strong', { text: JOB_LABELS[r.job] || r.job || 'ジョブ' }),
      h('span', { class: 'muted' }, timeEl(r.startedAt, { relative: true }))),
    r.message ? h('p', { class: 'run-msg', text: r.message }) : null,
    counts ? h('p', { class: 'hint', text: counts }) : null);
}
const COUNT_LABELS = { added: '追加', merged: '統合', skipped: 'スキップ', errors: 'エラー', fetched: '取得', posts: '投稿' };
