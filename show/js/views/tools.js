// 編成画面の「ツール」ダイアログ: 番組名・書き出し/読み込み・URL の追加・話題辞書・持ち越し・表示の切替。
import { GENRES, DEFAULT_DICT, SHOW_DEFAULTS } from '../config.js';
import { extractStatusIds, parseSaved, serializeSaved, statusUrl, genreOverrideList } from '../logic.js';
import { h, btn, field, downloadText, genreSticker } from '../dom.js';
import { feedbackCounts } from '../feedback.js';
import { BOT, GENRE_PRIORITY, DEFAULT_HOLD_TERMS } from '../config.js';
import { parseHoldTerms } from '../hold.js';

const splitList = (s) => s.split(/[,、，\n]/).map((x) => x.trim()).filter(Boolean);

export function toolsDialog(app) {
  const wk = app.weekState();
  const close = () => { app.ui.tools = false; app.render(); };
  const dlg = h('dialog', { class: 'tools-dialog', attrs: { 'data-modal': '', 'aria-labelledby': 'tools-title' }, dataset: { keep: 'tools' } });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.append(h('header', { class: 'tools-head' }, h('h2', { id: 'tools-title' }, 'ツール・設定'), btn('閉じる', close, 'btn btn-small btn-ghost', { 'data-key': 'tools-close' })));
  const body = h('div', { class: 'tools-body' });

  // 番組名・表示
  const nameInput = h('input', { class: 'input', type: 'text', value: app.saved.showName, maxLength: 60, dataset: { key: 'show-name' }, attrs: { autocomplete: 'off' } });
  nameInput.addEventListener('change', () => app.edit('番組名の変更', (w, s) => { s.showName = nameInput.value.trim() || SHOW_DEFAULTS.showName; }, { topics: false }));
  const isCard = app.ui.view === 'card';
  body.append(h('section', { class: 'tools-sec' }, h('h3', {}, '番組名と表示'),
    field('番組名', nameInput),
    h('div', { class: 'row' }, btn(isCard ? '埋め込み表示に切替' : 'カード表示に切替', () => app.setView(isCard ? 'embed' : 'card'), 'btn btn-small', { 'data-key': 'view-toggle', 'aria-pressed': String(isCard) }),
      h('span', { class: 'muted' }, isCard ? '今はカード表示（X の埋め込みを使わない軽い表示）' : '今は X の埋め込み表示（プレビュー・進行・映す用）'))));

  body.append(prioritySection(app));

  // 書き出し・読み込み
  const file = h('input', { type: 'file', accept: 'application/json,.json', class: 'sr-only', id: 'import-file', dataset: { key: 'import-file' } });
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    let text = '';
    try { text = await f.text(); } catch { app.ui.importMsg = { kind: 'error', text: 'ファイルを読めませんでした' }; app.render(); return; }
    const r = parseSaved(text);
    if (!r.ok) { app.ui.importMsg = { kind: 'error', text: `読み込めませんでした（${r.reason}）` }; app.ui.pendingImport = null; } else {
      app.ui.pendingImport = r.state;
      app.ui.importMsg = { kind: 'ok', text: `「${f.name}」：番組週 ${Object.keys(r.state.weeks).length}件・辞書 ${r.state.dict.length}件・ジャンル上書き ${Object.keys(r.state.genreOverrides).length}件${r.reason ? `（${r.reason}）` : ''}。今の内容をこのファイルで置き換えますか？` };
    }
    app.render();
  });
  const io = h('section', { class: 'tools-sec' }, h('h3', {}, '保存（書き出し・読み込み）'),
    h('p', { class: 'muted' }, `編成・メモ・進行・ジャンルの上書き（${genreOverrideList(app.saved).length}件）はこのブラウザに自動保存されます。別のパソコンへ移すときやバックアップは書き出してください。`),
    h('div', { class: 'row' },
      btn('書き出し（JSON）', () => downloadText(`show-${app.weekKey}.json`, serializeSaved(app.saved, Date.now())), 'btn btn-small', { 'data-key': 'export' }),
      h('label', { class: 'btn btn-small', attrs: { for: 'import-file' } }, '読み込み'), file));
  if (app.ui.importMsg) {
    io.append(h('p', { class: `import-msg is-${app.ui.importMsg.kind}`, attrs: { role: 'status' } }, app.ui.importMsg.text));
    if (app.ui.pendingImport) {
      io.append(h('div', { class: 'row' },
        btn('置き換える', () => { const s = app.ui.pendingImport; app.ui.pendingImport = null; app.ui.importMsg = { kind: 'ok', text: '読み込みました' }; app.replaceSaved(s); }, 'btn btn-small btn-red', { 'data-key': 'import-yes' }),
        btn('やめる', () => { app.ui.pendingImport = null; app.ui.importMsg = null; app.render(); }, 'btn btn-small btn-ghost', { 'data-key': 'import-no' })));
    }
  }
  body.append(io);

  // 自分で集めた投稿（URL）
  const ta = h('textarea', { class: 'input', rows: 3, placeholder: 'https://x.com/…/status/… を1行に1つずつ貼り付け', dataset: { key: 'personal-input' }, value: app.ui.personalDraft || '' });
  ta.addEventListener('input', () => { app.ui.personalDraft = ta.value; });
  const add = btn('受信箱に追加', () => {
    const r = extractStatusIds(ta.value);
    const before = new Set(wk.personal.map((p) => p.id));
    const added = r.ids.filter((x) => !before.has(x.id));
    app.ui.personalDraft = '';
    const found = added.filter((x) => app.postsById.has(x.id)).length;
    app.ui.personalMsg = r.ids.length || r.invalid.length
      ? `${added.length}件追加しました（データにあり ${found}件・リンクのみ ${added.length - found}件）${r.ids.length - added.length ? `・追加済み ${r.ids.length - added.length}件` : ''}${r.invalid.length ? `・読み取れなかったもの ${r.invalid.length}件：${r.invalid.slice(0, 3).join(' ')}` : ''}`
      : 'URL が見つかりませんでした';
    app.edit('URL の追加', (w) => { w.personal = [...w.personal, ...added.map((x) => ({ id: x.id, url: x.url, addedAt: Date.now() }))]; });
  }, 'btn btn-small', { 'data-key': 'personal-add' });
  const per = h('section', { class: 'tools-sec' }, h('h3', {}, '自分で集めた投稿（URL）'), field('X の投稿URL（複数行OK）', ta), h('div', { class: 'row' }, add));
  if (app.ui.personalMsg) per.append(h('p', { class: 'muted', attrs: { role: 'status' } }, app.ui.personalMsg));
  if (wk.personal.length) {
    per.append(h('ul', { class: 'mini-list' }, wk.personal.map((p) => {
      const post = app.postsById.get(p.id);
      return h('li', { dataset: { id: p.id } },
        h('span', { class: 'mini-text' }, post ? `@${post.user}：${post.text.slice(0, 40)}` : `リンクのみ（ID ${p.id}）`),
        h('a', { href: post ? statusUrl(p.id) : p.url, target: '_blank', rel: 'noopener noreferrer', class: 'btn btn-small btn-ghost' }, 'Xで開く'),
        btn('外す', () => app.edit('URL を外す', (w) => { w.personal = w.personal.filter((x) => x.id !== p.id); }), 'btn btn-small btn-ghost', { 'aria-label': `ID ${p.id} を外す` }));
    })));
  }
  body.append(per);

  body.append(botSection(app));

  // 持ち越し
  const fromPrev = app.visibleTopics.filter((t) => t.kind === 'carried');
  body.append(h('section', { class: 'tools-sec' }, h('h3', {}, '持ち越し'),
    h('p', { class: 'muted' }, `先週から ${fromPrev.length}件（「まとまり」に入っています）・来週へ回したもの ${wk.carriedOut.length}件`),
    wk.carriedOut.length ? h('ul', { class: 'mini-list' }, wk.carriedOut.map((c) => h('li', {},
      genreSticker(c.genre, { label: false, small: true }), h('span', { class: 'mini-text' }, c.name),
      h('span', { class: 'muted' }, c.via === 'plan' ? '（編成で）' : '（進行で）'),
      c.via === 'plan' ? btn('取り消す', () => app.edit('来週へを取り消す', (w) => { w.carriedOut = w.carriedOut.filter((x) => x.topicId !== c.topicId); }), 'btn btn-small btn-ghost') : null))) : null));

  // 話題辞書
  const dict = h('section', { class: 'tools-sec dict' }, h('h3', {}, '話題辞書'),
    h('p', { class: 'muted' }, '言葉（本文・根拠語）か関係者（店名・源氏名・@アカウント）が一致した投稿を、同じまとまりにします。「、」区切り。「夜職のみ」は夜職4カテゴリの投稿だけに当てます。'));
  const list = h('div', { class: 'dict-list' });
  app.saved.dict.forEach((e, i) => {
    const upd = (fn) => app.edit(`辞書「${e.name}」の変更`, (w, s) => { const x = s.dict.find((d) => d.id === e.id); if (x) fn(x); });
    const nm = h('input', { class: 'input input-sm', type: 'text', value: e.name, maxLength: 60, dataset: { key: `dict-name-${e.id}` }, attrs: { 'aria-label': '話題名' } });
    nm.addEventListener('change', () => upd((x) => { x.name = nm.value.trim() || x.name; }));
    const gs = h('select', { class: 'input input-sm', dataset: { key: `dict-genre-${e.id}` }, attrs: { 'aria-label': 'ジャンル' } }, GENRES.map((g) => h('option', { value: g.key, selected: g.key === e.genre }, g.label)));
    gs.addEventListener('change', () => upd((x) => { x.genre = gs.value; }));
    const ws = h('input', { class: 'input input-sm', type: 'text', value: e.words.join('、'), dataset: { key: `dict-words-${e.id}` }, attrs: { 'aria-label': '言葉' } });
    ws.addEventListener('change', () => upd((x) => { x.words = splitList(ws.value).slice(0, 50); }));
    const ps = h('input', { class: 'input input-sm', type: 'text', value: e.people.join('、'), placeholder: '店名・源氏名・@アカウント', dataset: { key: `dict-people-${e.id}` }, attrs: { 'aria-label': '関係者' } });
    ps.addEventListener('change', () => upd((x) => { x.people = splitList(ps.value).slice(0, 50); }));
    const no = h('input', { type: 'checkbox', checked: Boolean(e.nightOnly), dataset: { key: `dict-night-${e.id}` } });
    no.addEventListener('change', () => upd((x) => { x.nightOnly = no.checked; }));
    list.append(h('div', { class: 'dict-row', dataset: { dict: e.id } },
      h('span', { class: 'dict-no' }, String(i + 1)), nm, gs, ws, ps,
      h('label', { class: 'dict-night', title: '夜職4カテゴリの投稿にだけ当てる' }, no, h('span', {}, '夜職のみ')),
      btn('削除', () => app.edit(`辞書「${e.name}」の削除`, (w, s) => { s.dict = s.dict.filter((d) => d.id !== e.id); }), 'btn btn-small btn-ghost', { 'aria-label': `${e.name} を削除` })));
  });
  dict.append(list, h('div', { class: 'row' },
    btn('話題を追加', () => app.edit('辞書に追加', (w, s) => { s.dict = [...s.dict, { id: `u-${Date.now().toString(36)}`, name: '新しい話題', genre: 'night', words: [], people: [], nightOnly: true }]; }), 'btn btn-small', { 'data-key': 'dict-add' }),
    btn('最初の辞書に戻す', () => app.edit('辞書を最初に戻す', (w, s) => { s.dict = DEFAULT_DICT.map((e) => ({ ...e, words: [...e.words], people: [...e.people] })); }), 'btn btn-small btn-ghost', { 'data-key': 'dict-reset' })));
  body.append(dict);

  dlg.append(body);
  return dlg;
}

// ---------------------------------------------------------------- 段階3: ボット（Grok）連携

function fmtTime(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 「ボットに修正を送る」: 今の全修正を feedback/show-feedback.json の形で（ファイル保存 or GitHub に直接） */
function botSection(app) {
  const u = app.ui;
  const fb = app.buildFeedback();
  const n = feedbackCounts(fb);
  const sent = app.feedbackSent();
  const sec = h('section', { class: 'tools-sec bot-sec', dataset: { key: 'bot-sec' } }, h('h3', {}, 'ボット（Grok）に修正を送る'));
  const bi = app.bot;
  sec.append(h('p', { class: 'muted' }, bi
    ? `ボットの話題まとめ（data/show/topics.json）: ${bi.topics.length}件を読み込み済み${bi.generatedAt ? `（${bi.generatedAt} 作成）` : ''}。「Grok」の印が付いた話題です。`
    : 'ボットの話題まとめ（data/show/topics.json）はまだ届いていません（届けば自動で使います）。'));
  sec.append(h('p', {}, '編成で直したこと（ジャンルの変更・まとまりの名前や中身・削除）をボットに渡すと、次の収集から分類・まとめ方に反映されます。毎回「今の修正すべて」を送ります（何度送っても同じ内容）。'));
  sec.append(h('p', { class: 'fb-counts', dataset: { key: 'fb-counts' } },
    `ジャンルの変更 ${n.genres}件・話題の修正 ${n.topics}件・削除した話題 ${n.deleted}件・削除した投稿 ${n.posts}件`));
  sec.append(h('p', { class: 'muted', dataset: { key: 'fb-last' } }, sent ? `最後に送った日時：${fmtTime(sent.at)}（${sent.via === 'github' ? 'GitHub に保存' : 'ファイルで保存'}）` : 'まだ送っていません'));
  sec.append(h('div', { class: 'row' },
    btn('ファイルで保存（show-feedback.json）', () => {
      downloadText('show-feedback.json', `${JSON.stringify(app.buildFeedback(), null, 2)}\n`);
      app.markFeedbackSent('download');
    }, 'btn btn-small', { 'data-key': 'fb-download', title: 'トークン不要。保存したファイルをボットの担当者に渡すか、リポジトリの feedback/ に置いてください' })));

  // GitHub に直接保存（任意）
  const prefs = app.ghPrefs;
  const repo = h('input', { class: 'input input-sm', type: 'text', value: prefs.repo, dataset: { key: 'gh-repo' }, attrs: { autocomplete: 'off', spellcheck: 'false' } });
  const branch = h('input', { class: 'input input-sm', type: 'text', value: prefs.branch, dataset: { key: 'gh-branch' }, attrs: { autocomplete: 'off', spellcheck: 'false' } });
  // トークンは画面に出さない（保存済みでも入力欄は空。変えるときだけ入れる）
  const token = h('input', { class: 'input input-sm', type: 'password', value: '', placeholder: prefs.token ? '保存済み（変えるときだけ入力）' : 'github_pat_… を貼り付け', dataset: { key: 'gh-token' }, attrs: { autocomplete: 'off', spellcheck: 'false' } });
  const values = () => ({ repo: repo.value.trim(), branch: branch.value.trim(), token: token.value.trim() || app.ghPrefs.token });
  const msg = u.fbMsg ? h('p', { class: `import-msg is-${u.fbMsg.kind}`, attrs: { role: 'status' }, dataset: { key: 'fb-msg' } }, u.fbMsg.text,
    u.fbMsg.url ? h('a', { href: u.fbMsg.url, target: '_blank', rel: 'noopener noreferrer', class: 'fb-link' }, 'コミットを開く') : null) : null;
  const gh = h('details', { class: 'gh-box', open: Boolean(u.ghOpen) },
    h('summary', { on: { click: () => { u.ghOpen = !u.ghOpen; } } }, 'GitHub に直接保存（任意・トークンが必要）'),
    h('p', { class: 'muted' }, `保存先はリポジトリの ${BOT.feedbackPath} だけです（data/ には書きません）。`),
    h('div', { class: 'gh-grid' }, field('リポジトリ（持ち主/名前）', repo), field('ブランチ', branch)),
    field('トークン（fine-grained）', token, prefs.token ? '（保存済み）' : ''),
    h('p', { class: 'obs-warn' }, '⚠ トークンはこのパソコンのこのブラウザにだけ、暗号化せずに保存します（GitHub 以外へは送りません）。共用のパソコンでは使い終わったら「トークンを消す」を押してください。'),
    h('div', { class: 'row' },
      btn(u.fbBusy ? '保存中…' : 'GitHub に保存', () => app.sendFeedbackGitHub(values()), 'btn btn-small btn-red', { 'data-key': 'fb-github', disabled: Boolean(u.fbBusy) }),
      btn('設定だけ保存', () => { app.saveGhPrefs(values()); u.fbMsg = { kind: 'ok', text: '設定を保存しました' }; app.render(); }, 'btn btn-small', { 'data-key': 'gh-save' }),
      btn('トークンを消す', () => { app.saveGhPrefs({ ...values(), token: '' }); u.fbMsg = { kind: 'ok', text: 'トークンを消しました' }; app.render(); }, 'btn btn-small btn-ghost', { 'data-key': 'gh-forget', disabled: !prefs.token })),
    h('details', { class: 'obs-help' }, h('summary', {}, 'トークンの作り方'),
      h('ol', {},
        h('li', {}, 'GitHub にログイン → 右上のアイコン → Settings → Developer settings → Personal access tokens → Fine-grained tokens →「Generate new token」。'),
        h('li', {}, 'Token name は「番組サイトの書き戻し」など。Expiration（有効期限）は 90 日などを選ぶ（無期限にしない）。'),
        h('li', {}, `Repository access は「Only select repositories」で ${BOT.defaultRepo} の 1 つだけを選ぶ。`),
        h('li', {}, 'Permissions → Repository permissions →「Contents」を「Read and write」に。ほかは触らない（Metadata は自動で Read-only）。'),
        h('li', {}, '「Generate token」→ 表示された github_pat_… をコピーして、上の欄に貼り付け →「GitHub に保存」。'))));
  sec.append(gh);
  if (msg) sec.append(msg);
  return sec;
}

// ---------------------------------------------------------------- 優先ジャンル・保留する言葉

function prioritySection(app) {
  const s = app.saved;
  const sec = h('section', { class: 'tools-sec', dataset: { key: 'prio-sec' } }, h('h3', {}, '優先ジャンルと保留する言葉'));
  const label = (k) => (GENRES.find((g) => g.key === k) || {}).label || k;
  const sel = h('select', { class: 'input input-sm', dataset: { key: 'priority-genre' }, attrs: { 'aria-label': '優先ジャンル' } },
    [...GENRE_PRIORITY.order.map((k) => h('option', { value: k, selected: s.priorityGenre === k }, label(k))), h('option', { value: 'none', selected: s.priorityGenre === 'none' }, '優先しない')]);
  sel.addEventListener('change', () => app.setPriorityGenre(sel.value));
  sec.append(field('優先ジャンル', sel, `（その投稿を含む話題を、メイン候補のおすすめ・まとまり・受信箱で上に並べます。話題性スコア×${GENRE_PRIORITY.boost}）`));
  const ta = h('textarea', { class: 'input', rows: 3, value: s.holdTerms.join('、'), dataset: { key: 'hold-terms' }, placeholder: '例：ヒカル、YouTuber' });
  const held = (app.heldTopics || []).length + (app.heldPosts ? app.heldPosts.size : 0);
  sec.append(field('保留する言葉（「、」か改行で区切る）', ta, `（本文・アカウント・話題名に一致したものは「保留」フォルダへ。今週 ${held}件）`),
    h('p', { class: 'muted' }, '番組構成に手で入れた話題・手で作ったまとまり・自分で追加した投稿は保留しません。保留フォルダから 1 件ずつ戻すこともできます。'),
    h('div', { class: 'row' },
      btn('保留する言葉を保存', () => app.setHoldTerms(parseHoldTerms(ta.value)), 'btn btn-small', { 'data-key': 'hold-save' }),
      btn('最初の言葉に戻す', () => app.setHoldTerms([...DEFAULT_HOLD_TERMS]), 'btn btn-small btn-ghost', { 'data-key': 'hold-reset' }),
      s.holdExceptions.length ? btn(`戻した例外 ${s.holdExceptions.length}件をやめる`, () => app.edit('保留の例外をやめる', (w, x) => { x.holdExceptions = []; }), 'btn btn-small btn-ghost', { 'data-key': 'hold-clear-exceptions' }) : null));
  return sec;
}
