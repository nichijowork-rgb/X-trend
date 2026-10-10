// 設定（#/settings）
import { api, get, put, post as apiPost, del as apiDel, tokens } from '../api.js';
import { state, canWrite, refreshStatus, isConfigured } from '../state.js';
import {
  h, icon, mount, button, field, selectEl, toggle, sectionCard, pageHead, loadingEl, errorEl, badge,
  toast, toastError, confirmDialog, copyText, nextId, fmtDateTime, fmtBytes, exactNum, WEEKDAYS,
} from '../ui.js';

const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
const clone = (o) => JSON.parse(JSON.stringify(o ?? {}));
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** settings の欠けている部分を既定値で補う（表示用。保存は draft 全体を送る） */
function withDefaults(s) {
  const d = clone(s);
  d.keywords = d.keywords || {};
  d.keywords.nightlife = d.keywords.nightlife || [];
  d.keywords.general = d.keywords.general || [];
  d.excludeTerms = d.excludeTerms || [];
  d.targets = d.targets || {};
  d.targets.nightlifePerDay = d.targets.nightlifePerDay || { min: 30, max: 50 };
  d.targets.generalTopicsPerDay ??= 3;
  d.targets.generalPostsPerTopic ??= 5;
  d.schedule = d.schedule || {};
  d.schedule.timezone = d.schedule.timezone || 'Asia/Tokyo';
  d.schedule.collectTimes = d.schedule.collectTimes || [];
  d.schedule.dailyDigest = d.schedule.dailyDigest || { enabled: true, time: '23:30' };
  d.schedule.weeklyDigest = d.schedule.weeklyDigest || { enabled: true, weekday: 1, time: '10:00', postCount: 30 };
  d.schedule.autoBackup = d.schedule.autoBackup || { enabled: true, time: '04:00', keep: 14 };
  d.sources = d.sources || {};
  d.sources.xSearch = d.sources.xSearch || { enabled: true, maxPerQuery: 20 };
  d.sources.xHome = d.sources.xHome || { enabled: false, maxResults: 50 };
  d.sources.grok = d.sources.grok || { enabled: true, model: 'grok-4', useForSearch: true, useForSummary: true };
  d.budget = d.budget || { note: '未決定', xApiMonthlyReadCap: null };
  d.delivery = d.delivery || { method: 'none', webhookUrl: null };
  return d;
}

export async function render(root, ctx) {
  const head = pageHead('設定', 'キーワード・スケジュール・データソース・バックアップなどを管理します。');
  if (!canWrite()) {
    mount(root, head,
      h('p', { class: 'notice-inline notice-viewer' }, icon('lock'), h('span', { text: '閲覧専用です。設定の変更には管理者トークンが必要です。' })),
      h('div', { class: 'grid-2' }, h('div', { class: 'col' }, tokenSection()), h('div', { class: 'col' }, connectionSection())));
    return;
  }
  mount(root, head, loadingEl('設定を読み込み中…'));
  let settings;
  try {
    const res = await get('/settings');
    settings = res.settings;
  } catch (err) {
    if (!ctx.alive()) return;
    mount(root, head, errorEl(err, () => render(root, ctx)), tokenSection());
    return;
  }
  if (!ctx.alive()) return;

  let draft = withDefaults(settings);
  let dirty = false;
  const saveBar = h('div', { class: 'save-bar', hidden: true, attrs: { role: 'region', 'aria-label': '未保存の変更' } });
  const markDirty = () => { dirty = true; saveBar.hidden = false; };

  const errBox = h('p', { class: 'form-error', attrs: { role: 'alert' } });
  const saveBtn = button('変更を保存', {
    variant: 'primary',
    onClick: async () => {
      const problem = validate(draft);
      if (problem) { errBox.textContent = problem; return; }
      errBox.textContent = '';
      try {
        const res = await put('/settings', { settings: draft });
        settings = res.settings || draft;
        draft = withDefaults(settings);
        dirty = false;
        saveBar.hidden = true;
        toast('設定を保存しました', { type: 'success' });
        refreshStatus();
        build();
      } catch (err) { errBox.textContent = err.message; }
    },
  });
  mount(saveBar, h('span', { class: 'save-msg', text: '未保存の変更があります' }), errBox,
    h('div', { class: 'save-actions' },
      button('元に戻す', { onClick: () => { draft = withDefaults(settings); dirty = false; saveBar.hidden = true; errBox.textContent = ''; build(); } }),
      saveBtn));

  const body = h('div', { class: 'grid-2 settings-grid' });
  function build() {
    mount(body,
      h('div', { class: 'col' },
        keywordSection(draft, markDirty),
        targetSection(draft, markDirty),
        scheduleSection(draft, markDirty),
        sourceSection(draft, markDirty),
        undecidedSection(draft, markDirty)),
      h('div', { class: 'col' },
        connectionSection(),
        backupSection(ctx),
        shareSection(ctx),
        sampleSection(),
        tokenSection()));
  }
  build();
  mount(root, head, body, saveBar);

  const onBeforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onBeforeUnload);
  return () => {
    window.removeEventListener('beforeunload', onBeforeUnload);
    if (dirty) toast('設定の変更は保存されていません。', { type: 'error' });
  };
}

function validate(d) {
  const n = d.targets.nightlifePerDay;
  if (n.min !== null && n.max !== null && Number(n.min) > Number(n.max)) return '夜職の目標件数は「最小 ≦ 最大」にしてください。';
  for (const t of d.schedule.collectTimes) if (!TIME_RE.test(t)) return `収集時刻「${t}」は HH:MM 形式にしてください。`;
  for (const [label, t] of [['日次まとめ', d.schedule.dailyDigest.time], ['週次まとめ', d.schedule.weeklyDigest.time], ['自動バックアップ', d.schedule.autoBackup.time]]) {
    if (!TIME_RE.test(t || '')) return `${label}の時刻を HH:MM 形式で入力してください。`;
  }
  if (d.delivery.method === 'webhook' && d.delivery.webhookUrl && !/^https?:\/\//.test(d.delivery.webhookUrl)) return '配信先URLは http(s):// で始めてください。';
  return '';
}

/* ---------- 部品 ---------- */
function chipEditor(label, list, onChange, { placeholder = '追加する語', type = 'text', hint, validate } = {}) {
  const id = nextId('chip');
  const chips = h('ul', { class: 'chips', attrs: { 'aria-label': `${label}の一覧` } });
  const input = h('input', { type, class: 'input', id, attrs: { placeholder, autocomplete: 'off', enterkeyhint: 'done' } });
  const err = h('p', { class: 'form-error' });
  const draw = () => {
    mount(chips, list.length ? list.map((w, i) => h('li', { class: 'chip chip-edit' },
      h('span', { text: w }),
      h('button', { type: 'button', class: 'chip-x', attrs: { 'aria-label': `「${w}」を削除` }, on: { click: () => { list.splice(i, 1); onChange(); draw(); input.focus(); } } }, icon('close'))))
      : h('li', { class: 'muted chips-empty', text: '（未登録）' }));
  };
  const add = () => {
    const parts = input.value.split(/[,、\n]/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    for (const p of parts) {
      const msg = validate && validate(p);
      if (msg) { err.textContent = msg; return; }
      if (!list.includes(p)) list.push(p);
    }
    if (type === 'time') list.sort();
    err.textContent = '';
    input.value = '';
    onChange(); draw();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); add(); } });
  draw();
  return h('div', { class: 'field chip-field' },
    h('label', { attrs: { for: id }, text: label }),
    chips,
    h('div', { class: 'chip-add' }, input, button('追加', { small: true, iconName: 'plus', ariaLabel: `${label}に追加`, onClick: add })),
    hint ? h('p', { class: 'hint', text: hint }) : null,
    err);
}
function numInput(value, onChange, { min = 0, max = 100000, allowNull = false, placeholder } = {}) {
  const el = h('input', { type: 'number', class: 'input input-num', value: value ?? '', min, max, step: 1, inputMode: 'numeric', attrs: { placeholder } });
  el.addEventListener('input', () => {
    if (el.value === '') { onChange(allowNull ? null : min); return; }
    const n = Math.max(min, Math.min(max, Math.round(Number(el.value))));
    if (!Number.isNaN(n)) onChange(n);
  });
  return el;
}
function timeInput(value, onChange) {
  const el = h('input', { type: 'time', class: 'input input-time', value: value || '' });
  el.addEventListener('change', () => onChange(el.value));
  return el;
}
function configuredBadge(v) {
  return isConfigured(v) ? badge('接続済み', 'status status-ok') : badge('未設定', 'status status-none');
}

/* ---------- セクション ---------- */
function keywordSection(d, dirty) {
  return sectionCard('キーワード',
    h('p', { class: 'panel-desc', text: '収集・分類に使う語句です。Enter または「追加」で登録、×で削除します。' }),
    chipEditor('夜職キーワード', d.keywords.nightlife, dirty, { placeholder: '例：ホスト', hint: '業界把握の対象（1日30〜50件が目安）' }),
    chipEditor('一般キーワード', d.keywords.general, dirty, { placeholder: '例：新作スイーツ', hint: '空でも、バズ話題は自動で探します（Grok接続時）' }),
    chipEditor('除外語', d.excludeTerms, dirty, { placeholder: '例：ロイヤルホスト', hint: '含む投稿を収集・分類の段階で除外します（「興味なし」とは別の初期フィルタ）' }));
}

function targetSection(d, dirty) {
  const t = d.targets;
  return sectionCard('目標件数',
    h('div', { class: 'form-grid' },
      field('夜職 1日の最小', numInput(t.nightlifePerDay.min, (v) => { t.nightlifePerDay.min = v; dirty(); }, { max: 1000 })),
      field('夜職 1日の最大', numInput(t.nightlifePerDay.max, (v) => { t.nightlifePerDay.max = v; dirty(); }, { max: 1000 })),
      field('一般 1日のトピック数', numInput(t.generalTopicsPerDay, (v) => { t.generalTopicsPerDay = v; dirty(); }, { max: 50 })),
      field('一般 トピックあたり件数', numInput(t.generalPostsPerTopic, (v) => { t.generalPostsPerTopic = v; dirty(); }, { max: 100 }))));
}

function scheduleSection(d, dirty) {
  const s = d.schedule;
  const dd = s.dailyDigest, wd = s.weeklyDigest, ab = s.autoBackup;
  return sectionCard('スケジュール',
    h('p', { class: 'hint', text: `タイムゾーン：${s.timezone}` }),
    chipEditor('収集時刻', s.collectTimes, dirty, { type: 'time', placeholder: '09:00', validate: (v) => (TIME_RE.test(v) ? '' : 'HH:MM 形式で入力してください') }),
    h('div', { class: 'sched-block' },
      toggle('日次まとめ', dd.enabled, (v) => { dd.enabled = v; dirty(); }),
      h('div', { class: 'form-grid' }, field('作成時刻', timeInput(dd.time, (v) => { dd.time = v; dirty(); })))),
    h('div', { class: 'sched-block' },
      toggle('週次まとめ', wd.enabled, (v) => { wd.enabled = v; dirty(); }),
      h('div', { class: 'form-grid' },
        field('曜日', selectEl(WEEKDAYS.map((w, i) => [String(i), `${w}曜日`]), String(wd.weekday ?? 1), { onChange: (v) => { wd.weekday = Number(v); dirty(); } })),
        field('時刻', timeInput(wd.time, (v) => { wd.time = v; dirty(); })),
        field('件数', numInput(wd.postCount, (v) => { wd.postCount = v; dirty(); }, { min: 1, max: 500 })))),
    h('div', { class: 'sched-block' },
      toggle('自動バックアップ', ab.enabled, (v) => { ab.enabled = v; dirty(); }),
      h('div', { class: 'form-grid' },
        field('時刻', timeInput(ab.time, (v) => { ab.time = v; dirty(); })),
        field('保持数', numInput(ab.keep, (v) => { ab.keep = v; dirty(); }, { min: 1, max: 365 })))));
}

function sourceSection(d, dirty) {
  const x = d.sources.xSearch, home = d.sources.xHome, g = d.sources.grok;
  const integ = state.status?.integrations || {};
  return sectionCard('データソース',
    h('div', { class: 'sched-block' },
      h('div', { class: 'row-between' }, toggle('公式API検索', x.enabled, (v) => { x.enabled = v; dirty(); }), configuredBadge(integ.xSearch)),
      h('div', { class: 'form-grid' }, field('1検索あたり最大件数', numInput(x.maxPerQuery, (v) => { x.maxPerQuery = v; dirty(); }, { min: 10, max: 100 })))),
    h('div', { class: 'sched-block' },
      h('div', { class: 'row-between' }, toggle('公式ホームTL', home.enabled, (v) => { home.enabled = v; dirty(); }, { hint: '逆時系列のタイムラインです（おすすめ欄ではありません）' }), configuredBadge(integ.xHome)),
      h('div', { class: 'form-grid' }, field('最大件数', numInput(home.maxResults, (v) => { home.maxResults = v; dirty(); }, { min: 1, max: 100 })))),
    h('div', { class: 'sched-block' },
      h('div', { class: 'row-between' }, toggle('Grok（xAI）', g.enabled, (v) => { g.enabled = v; dirty(); }), configuredBadge(integ.grok)),
      h('div', { class: 'form-grid' },
        field('モデル', (() => { const el = h('input', { type: 'text', class: 'input', value: g.model || '', attrs: { placeholder: 'grok-4', autocomplete: 'off', spellcheck: 'false' } }); el.addEventListener('input', () => { g.model = el.value.trim(); dirty(); }); return el; })())),
      toggle('X検索に使う', g.useForSearch, (v) => { g.useForSearch = v; dirty(); }),
      toggle('まとめの要約に使う', g.useForSummary, (v) => { g.useForSummary = v; dirty(); })),
    h('p', { class: 'hint', text: 'おすすめ欄の取り込みは、取り込み画面のブックマークレットから行います。' }));
}

function connectionSection() {
  const integ = state.status?.integrations || {};
  const row = (label, v, desc) => h('li', { class: 'conn-row' },
    h('div', {}, h('strong', { text: label }), h('p', { class: 'hint', text: desc })), configuredBadge(v));
  return sectionCard('接続状態',
    h('ul', { class: 'conn-list' },
      row('X API 検索', integ.xSearch, 'X_BEARER_TOKEN'),
      row('X API ホームTL', integ.xHome, 'X_USER_ACCESS_TOKEN / X_USER_ID（逆時系列。おすすめではない）'),
      row('Grok（xAI）', integ.grok, 'XAI_API_KEY')),
    h('p', { class: 'hint', text: 'APIキー等の秘密情報はサーバーの環境変数でのみ設定します。この画面では値を扱わず、設定済みかどうかだけを表示します。' }),
    state.status?.version ? h('p', { class: 'hint', text: `バージョン ${state.status.version}` }) : null);
}

function undecidedSection(d, dirty) {
  const b = d.budget, dl = d.delivery;
  const capUndecided = b.xApiMonthlyReadCap === null || b.xApiMonthlyReadCap === undefined;
  const capBadge = badge(capUndecided ? '未決定' : '設定済み', capUndecided ? 'badge-undecided' : 'status status-ok');
  const delUndecided = !dl.method || dl.method === 'none';
  const note = h('textarea', { class: 'input', rows: 2, value: b.note ?? '', attrs: { placeholder: '未決定（例：Basicプラン、月◯円まで）' } });
  note.addEventListener('input', () => { b.note = note.value; dirty(); });
  const webhook = h('input', { type: 'url', class: 'input', value: dl.webhookUrl || '', attrs: { placeholder: 'https://…（任意）' } });
  webhook.addEventListener('input', () => { dl.webhookUrl = webhook.value.trim() || null; dirty(); });
  const webhookField = field('配信先URL', webhook, { hint: '配信方法を決めたら入力してください。' });
  webhookField.hidden = dl.method !== 'webhook';
  return sectionCard('未決定事項',
    h('p', { class: 'panel-desc', text: '決まっていない項目です。空欄のままでも利用できます（任意入力）。' }),
    h('div', { class: 'sub-head' }, h('h3', { class: 'sub-title', text: 'API契約・費用上限' }), capBadge),
    field('メモ', note),
    field('X API 月間読み取り上限（件）', numInput(b.xApiMonthlyReadCap, (v) => { b.xApiMonthlyReadCap = v; dirty(); }, { min: 0, max: 100000000, allowNull: true, placeholder: '未決定' }), { hint: '空欄 = 未決定' }),
    h('div', { class: 'sub-head' }, h('h3', { class: 'sub-title', text: '配信先' }), badge(delUndecided ? '未決定' : '設定済み', delUndecided ? 'badge-undecided' : 'status status-ok')),
    field('配信方法', selectEl([['none', 'アプリ内のみ（未決定）'], ['webhook', 'Webhook']], dl.method || 'none', {
      onChange: (v) => { dl.method = v; webhookField.hidden = v !== 'webhook'; dirty(); },
    })),
    webhookField);
}

function backupSection(ctx) {
  const autoList = h('div', { attrs: { 'aria-live': 'polite' } }, loadingEl('自動バックアップを確認中…'));
  const out = h('div', { class: 'result-area', attrs: { 'aria-live': 'polite' } });
  let mode = 'merge';

  const showRestored = (res) => {
    const r = res.restored || {};
    mount(out, h('div', { class: 'result result-ok', attrs: { role: 'status' } },
      h('p', { class: 'result-title', text: '復元しました' }),
      h('ul', { class: 'result-counts' },
        h('li', { text: `投稿 ${exactNum(r.posts ?? 0)}件` }), h('li', { text: `興味なし ${exactNum(r.dismissals ?? 0)}件` }),
        h('li', { text: `まとめ ${exactNum(r.digests ?? 0)}件` }), h('li', { text: `設定 ${r.settings ? '復元' : '変更なし'}` }))));
    refreshStatus();
  };

  const loadAuto = async () => {
    try {
      const res = await get('/backups');
      if (!ctx.alive()) return;
      const items = Array.isArray(res.items) ? res.items : [];
      mount(autoList, items.length
        ? h('ul', { class: 'backup-list' }, items.map((b) => h('li', { class: 'backup-row' },
          h('div', {}, h('span', { class: 'mono break', text: b.name }), h('p', { class: 'hint', text: `${fmtDateTime(b.createdAt) || ''} ・ ${fmtBytes(b.size)}` })),
          button('復元', {
            small: true, iconName: 'refresh', ariaLabel: `${b.name} から復元`,
            onClick: async () => {
              if (!await confirmDialog(`「${b.name}」から復元します。現在のデータはこのバックアップの内容で置き換わる場合があります。続けますか？`, { okLabel: '復元する', danger: true })) return;
              try { showRestored(await apiPost(`/backups/${encodeURIComponent(b.name)}/restore`)); toast('復元しました', { type: 'success' }); }
              catch (err) { toastError(err); }
            },
          }))))
        : h('p', { class: 'muted', text: '自動バックアップはまだありません（スケジュールの時刻に作成されます）。' }));
    } catch (err) {
      if (!ctx.alive()) return;
      mount(autoList, errorEl(err, loadAuto));
    }
  };
  loadAuto();

  const download = async () => {
    try {
      const res = await api('/backup', { raw: true });
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
      const name = m ? decodeURIComponent(m[1]) : `x-trend-backup-${new Date().toISOString().slice(0, 10)}.json`;
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: name, style: 'display:none' });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('バックアップをダウンロードしました', { type: 'success' });
    } catch (err) { toastError(err); }
  };

  const fileInput = h('input', { type: 'file', class: 'file-input', id: nextId('restore'), accept: '.json,application/json' });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    let backup;
    try { backup = JSON.parse(await f.text()); } catch { mount(out, h('p', { class: 'form-error', text: 'バックアップファイル（JSON）を読み取れませんでした。' })); return; }
    const msg = mode === 'replace'
      ? `「${f.name}」で現在のデータをすべて置き換えます。元に戻せません。続けますか？`
      : `「${f.name}」の内容を現在のデータに統合します。続けますか？`;
    if (!await confirmDialog(msg, { okLabel: mode === 'replace' ? '置き換えて復元' : '統合して復元', danger: mode === 'replace' })) return;
    mount(out, loadingEl('復元中…'));
    try { showRestored(await apiPost('/restore', { backup, mode })); }
    catch (err) { mount(out, h('p', { class: 'form-error', attrs: { role: 'alert' }, text: err.message })); }
  });

  const modeName = nextId('mode');
  const modeRadio = (v, label, hint) => {
    const id = nextId('m');
    const input = h('input', { type: 'radio', name: modeName, id, value: v, checked: v === mode });
    input.addEventListener('change', () => { if (input.checked) mode = v; });
    return h('label', { class: 'radio-row', attrs: { for: id } }, input, h('span', { class: 'radio-text' }, h('span', { text: label }), h('small', { class: 'hint', text: hint })));
  };

  return sectionCard('バックアップ',
    h('div', { class: 'form-row' },
      button('ダウンロード', { variant: 'primary', iconName: 'download', onClick: download }),
      button('今すぐ自動バックアップ', { iconName: 'play', onClick: async () => {
        try { const r = (await apiPost('/jobs/run', { job: 'backup' })).run || {}; toast(r.status === 'error' ? `失敗しました：${r.message || ''}` : 'バックアップを作成しました', { type: r.status === 'error' ? 'error' : 'success' }); loadAuto(); }
        catch (err) { toastError(err); }
      } })),
    h('h3', { class: 'sub-title', text: 'ファイルから復元' }),
    h('fieldset', { class: 'radio-group' }, h('legend', { class: 'sr-only', text: '復元方法' }),
      modeRadio('merge', '統合（merge）', '今のデータを残したまま追加・更新'),
      modeRadio('replace', '置き換え（replace）', '今のデータを消してバックアップの内容にする')),
    h('div', { class: 'file-row' },
      h('label', { class: 'btn btn-secondary', attrs: { for: fileInput.id } }, icon('upload'), h('span', { text: 'ファイルを選んで復元' })),
      fileInput),
    out,
    h('h3', { class: 'sub-title', text: '自動バックアップから復元' }),
    autoList);
}

function shareSection(ctx) {
  const box = h('div', {}, loadingEl());
  const load = async () => {
    try {
      const res = await get('/share');
      if (!ctx.alive()) return;
      if (!res.authRequired) {
        mount(box, h('p', { class: 'hint', text: 'ローカルモード（ADMIN_TOKEN 未設定）のため、共有リンクは不要です。このURLにアクセスできる人は誰でも閲覧・編集できます。' }));
        return;
      }
      if (!res.shareUrl) {
        mount(box, h('p', { class: 'muted', text: '共有リンクはまだありません。' }),
          button('共有リンクを発行', { variant: 'primary', iconName: 'link', onClick: rotate }));
        return;
      }
      const inp = h('input', { type: 'text', class: 'input mono', value: res.shareUrl, readOnly: true, attrs: { 'aria-label': '共有リンク' }, on: { focus: (e) => e.target.select() } });
      mount(box,
        inp,
        h('div', { class: 'form-row' },
          button('コピー', { iconName: 'copy', onClick: () => copyText(res.shareUrl, '共有リンクをコピーしました') }),
          button('再発行', { iconName: 'refresh', variant: 'danger-ghost', onClick: async () => {
            if (!await confirmDialog('共有リンクを再発行すると、今のリンクは使えなくなります。続けますか？', { okLabel: '再発行する', danger: true })) return;
            await rotate();
          } })),
        h('p', { class: 'hint', text: 'このリンクを開いた人は閲覧のみできます（編集・取り込みはできません）。' }));
    } catch (err) {
      if (!ctx.alive()) return;
      mount(box, errorEl(err, load));
    }
  };
  const rotate = async () => {
    try { await apiPost('/share/rotate'); toast('共有リンクを発行しました', { type: 'success' }); load(); }
    catch (err) { toastError(err); }
  };
  load();
  return sectionCard('共有リンク', box);
}

function sampleSection() {
  const s = state.status || {};
  return sectionCard('サンプルデータ',
    h('p', { class: 'panel-desc', text: `実データ ${exactNum(s.realPostCount ?? 0)}件 ・ サンプル ${exactNum(s.samplePostCount ?? 0)}件。サンプルは画面の確認用で、実データとは区別して表示されます。` }),
    h('div', { class: 'form-row' },
      button('サンプルを読み込む', { iconName: 'download', onClick: async () => {
        try { await apiPost('/sample/load'); toast('サンプルを読み込みました', { type: 'success' }); await refreshStatus(); rerender(); }
        catch (err) { toastError(err); }
      } }),
      button('サンプルを削除', { iconName: 'close', variant: 'danger-ghost', onClick: async () => {
        if (!await confirmDialog('サンプルデータを削除します（実データは消えません）。', { okLabel: '削除する', danger: true })) return;
        try { await apiDel('/sample'); toast('サンプルを削除しました', { type: 'success' }); await refreshStatus(); rerender(); }
        catch (err) { toastError(err); }
      } })));
}

function tokenSection() {
  const inp = h('input', { type: 'password', class: 'input', autocomplete: 'off', value: tokens.admin, attrs: { placeholder: '管理者トークン' } });
  const hasShare = !!tokens.share;
  return sectionCard('管理者トークン',
    h('p', { class: 'panel-desc', text: 'サーバーで ADMIN_TOKEN を設定している場合に、編集・取り込みに必要です。このブラウザ（localStorage）にのみ保存され、X-Admin-Token ヘッダで送信されます。' }),
    field('トークン', inp),
    h('div', { class: 'form-row' },
      button('保存', { variant: 'primary', onClick: async () => {
        tokens.admin = inp.value.trim();
        await refreshStatus();
        toast(state.status?.role === 'admin' ? '管理者として接続しました' : 'トークンを保存しました（権限は閲覧のみです）', { type: state.status?.role === 'admin' ? 'success' : 'info' });
        rerender();
      } }),
      tokens.admin ? button('消去', { onClick: async () => { tokens.admin = ''; await refreshStatus(); toast('管理者トークンを消去しました'); rerender(); } }) : null),
    hasShare ? h('p', { class: 'hint' }, '共有リンクのトークンも保存されています。 ',
      h('button', { type: 'button', class: 'link-btn', text: '共有トークンを消去', on: { click: async () => { tokens.share = ''; await refreshStatus(); toast('共有トークンを消去しました'); rerender(); } } })) : null);
}
