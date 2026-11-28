// 編成の「整理開始」（かんたん編成の上の帯から）。
// 押すと: ① 最新のデータを読み直す（ページは読み直さない）→ ② GitHub のトークンがあれば、ボットに整理をお願いする
//   （feedback/show-feedback.json を最新にしてから feedback/prepare-request.json を書く）→ data/show/status.json を見に行って待つ
//   （閉じても・リロードしても続く。板の上に小さく進み具合）→ 終わったらその commit の投稿・まとまり・下書きを読み、
// ③ 番組の流れの空いている所だけに下書きを入れる（1 回で元に戻せる）→ ④ まとめ。
// トークンが無い・お願いを書けない・ボットが失敗したときは、今あるデータ（新しい draft.json があればそれ、無ければサイトのおまかせ）で下書きを作る。
// 計算は prepare.js、GitHub の読み書きは feedback.js。文字はすべて textContent。
import { formatDateTime, parseTimestamp } from '../../../assets/js/core.js';
import {
  PREPARE, buildPrepareRequest, cancelRequest, parsePending, tooSoonMinutes, pollDelay, parseStatus, decide, statusLine, errorText, busyText,
  newRequestId, parseDraftFile, draftToPlan, autoFinished, hhmm,
} from '../prepare.js';
import { saveFeedbackToGitHub, putGitHubFile, getGitHubFile } from '../feedback.js';
import { autoDraftPlan, draftSummary } from '../board.js';
import { placedTopicIds, isFolderTopic } from '../folders.js';
import { setMainSlot, assignTopic } from '../logic.js';
import { h, btn } from '../dom.js';

// ================================================================ このブラウザに覚えること

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* 覚えられなくても動く */ } },
};
const loadPending = () => parsePending(store.get(PREPARE.pendingKey));
const savePending = (p) => store.set(PREPARE.pendingKey, p ? JSON.stringify(p) : null);
const lastRequested = () => Number(store.get(PREPARE.lastKey)) || null;
/** 確認用（E2E）: 見に行く間隔を短くする（localStorage xtrend-show-prepare-delays。ふだんは使わない） */
function pollDelays() {
  try { const o = JSON.parse(store.get('xtrend-show-prepare-delays') || 'null'); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}
const hasGitHub = (app) => Boolean(app.ghPrefs && app.ghPrefs.token);

// ================================================================ 上の帯のボタン・板の上の小さな知らせ

/** 「整理開始」ボタン（どちらのステップにも出す） */
export function seiriButton(app) {
  const s = app.ui.seiri;
  const running = Boolean(s && s.running);
  const gh = hasGitHub(app);
  const hint = gh ? 'ボット：GitHub を通してお願いします' : 'ボット：GitHub 未設定（今あるデータで下書きを作ります）';
  return h('button', {
    type: 'button', class: `btn btn-small bd-seiri${running ? ' is-running' : ''}`, dataset: { key: 'bd-seiri' },
    attrs: { title: `最新のデータを読み直して、まとまりと番組の流れの下書きまで用意します。${hint}`, 'aria-haspopup': 'dialog' },
    on: { click: () => { if (running) { s.open = true; app.render(); } else startSeiri(app); } },
  }, h('span', { class: `bd-seiri-dot${gh ? ' is-on' : ''}`, attrs: { 'aria-hidden': 'true' } }), running ? (s.waiting ? 'ボット整理中…' : '整理中…') : '整理開始');
}

/** ボットを待っている間、板の上に出す一行（押すとパネルを開く） */
export function seiriChip(app) {
  const s = app.ui.seiri;
  const a = app.ui.seiriAuto;
  if ((!s || !s.waiting) && a && a.done) {
    // ボットの自動整理が終わった（お願いしていないとき）→ 反映するか聞く
    return h('div', { class: 'sr-chip is-auto', dataset: { key: 'seiri-auto' }, attrs: { role: 'status' } },
      h('span', { class: 'sr-chip-dot', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'sr-chip-tx' }, `ボットの自動整理が終わりました${a.at ? `（${a.at}）` : ''}`),
      btn('反映する', () => applyAuto(app), 'btn btn-small btn-red', { 'data-key': 'seiri-auto-apply', title: '自動整理の投稿・まとまりを読み込み、番組の流れの空いている所だけに下書きを入れます' }),
      btn('✕', () => { store.set(PREPARE.autoSeenKey, a.status.requestId); app.ui.seiriAuto = null; app.render(); }, 'btn btn-small btn-ghost', { 'data-key': 'seiri-auto-dismiss', 'aria-label': '見送る' }));
  }
  if (!s || !(s.waiting || s.otherLine)) return null;
  const line = s.waiting ? s.chipLine || 'ボットにお願いしました（受け付けを待っています）' : s.otherLine;
  return h('button', {
    type: 'button', class: `sr-chip${s.waiting ? '' : ' is-info'}`, dataset: { key: 'seiri-chip' }, attrs: { 'aria-live': 'polite', title: '押すと進み具合を開きます' },
    on: { click: () => { s.open = true; app.render(); } },
  }, h('span', { class: 'sr-chip-dot', attrs: { 'aria-hidden': 'true' } }), line);
}

// ================================================================ 流れ

const timeText = (generatedAt, refTs) => (refTs ? formatDateTime(generatedAt, refTs) : '時刻不明');
const FROM = { bot: 'ボット', file: 'ボットの下書きファイル', auto: 'サイトのおまかせ' };

function newState(extra = {}) {
  return {
    open: true, running: true, cancelled: false, ended: null, ask: null, waiting: false, offerLocal: false,
    data: { state: 'run', text: '最新のデータを読み込み中…' }, bot: { state: 'wait', text: '' }, draft: { state: 'wait', text: '' },
    summary: null, newPosts: 0, status: null, chipLine: '', otherLine: '', dataResult: null, ...extra,
  };
}

/** 「整理開始」を始める（もう動いていればパネルを開くだけ） */
export async function startSeiri(app) {
  const u = app.ui;
  if (u.seiri && u.seiri.running) { u.seiri.open = true; app.render(); return; }
  const s = newState();
  u.seiri = s;
  app.render();
  const render = () => { if (u.seiri === s) app.render(); };

  // 1. 最新のデータ
  const before = app.ds ? app.ds.refTs : null;
  const r = await app.refreshData();
  s.dataResult = r;
  if (r.ok) {
    s.newPosts += r.added;
    s.data = { state: 'ok', text: `データ ${timeText(r.generatedAt, r.refTs)} 時点（前回から＋${r.added}件${before && r.refTs === before ? '・新しいデータはまだありません' : ''}）` };
  } else s.data = { state: 'ng', text: `読み込めませんでした（${r.reason}）。今あるデータで進めます` };
  render();
  if (s.cancelled) return endCancelled(app, s);

  // 2. ボットにお願い（GitHub を通す）
  if (!hasGitHub(app)) {
    s.bot = { state: 'skip', text: 'GitHub とつなぐと（［ツール…］→「GitHub に直接保存」）、ボットに最新の収集と Grok のまとめまでお願いできます' };
    return localDraft(app, s);
  }
  let force = false;
  const left = tooSoonMinutes(lastRequested(), Date.now());
  if (left) {
    const c = await ask(app, s, left);
    if (c === 'cancel') return endCancelled(app, s);
    if (c === 'local') { s.bot = { state: 'skip', text: 'ボットにはお願いせず、今あるデータで進めます' }; return localDraft(app, s); }
    force = true;
  }
  s.bot = { state: 'run', text: 'ボットへのお願いを書いています…' };
  render();
  const gh = app.ghPrefs;
  // 修正（feedback/show-feedback.json）を最新に
  const fb = app.buildFeedback();
  const fbText = `${JSON.stringify(fb, null, 2)}\n`;
  const w1 = await saveFeedbackToGitHub({ repo: gh.repo, branch: gh.branch, token: gh.token, content: fbText });
  if (s.cancelled) return endCancelled(app, s);
  if (!w1.ok) { s.bot = { state: 'ng', text: `ボットへのお願いを書けませんでした（${w1.message}）。今あるデータで進めます` }; return localDraft(app, s); }
  if (app.autoSend) app.autoSend.markSent(fbText);
  if (app.markFeedbackSent) app.markFeedbackSent('github');
  // お願い（feedback/prepare-request.json）
  const now = Date.now();
  const req = buildPrepareRequest({
    id: newRequestId(now), nowMs: now, force, week: app.week, range: app.range && app.range.start != null ? app.range : app.week,
    priorityGenre: app.saved.priorityGenre, placedIds: [...placedTopicIds(app.weekState())],
    manualTopics: app.topics.filter((t) => t.kind === 'manual').map((t) => ({ id: t.id, name: t.name, postIds: t.postIds })),
    feedbackGeneratedAt: fb.generated_at || null,
  });
  const w2 = await putGitHubFile({ repo: gh.repo, branch: gh.branch, token: gh.token, path: PREPARE.requestPath, content: `${JSON.stringify(req, null, 2)}\n`, message: `prepare: request ${req.id}` });
  if (s.cancelled) return endCancelled(app, s);
  if (!w2.ok) { s.bot = { state: 'ng', text: `ボットへのお願いを書けませんでした（${w2.message}）。今あるデータで進めます` }; return localDraft(app, s); }
  savePending({ id: req.id, requestedAt: now, force, request: req });
  store.set(PREPARE.lastKey, String(now));
  waitForBot(app, s, req.id);
}

/** ボットを待つ（閉じても・リロードしても続く） */
function waitForBot(app, s, id) {
  s.waiting = true;
  s.requestId = id;
  s.bot = { state: 'run', text: 'ボットにお願いしました。受け付けを待っています（数十分かかることがあります。閉じて作業を続けられます）' };
  s.chipLine = 'ボットにお願いしました（受け付けを待っています）';
  s.draft = { state: 'wait', text: 'ボットの結果を待っています。終わったら、空いている所だけに自動で入ります' };
  app.render();
  schedulePoll(app, s, 1500);
}

let pollTimer = null;
function schedulePoll(app, s, ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => { poll(app, s); }, ms);
}

async function poll(app, s) {
  if (app.ui.seiri !== s || !s.waiting) return;
  const pending = loadPending();
  if (!pending || pending.id !== s.requestId) { s.waiting = false; s.running = false; s.ended = s.ended || 'cancelled'; app.render(); return; }
  const gh = app.ghPrefs;
  const res = await getGitHubFile({ repo: gh.repo, ref: gh.branch, token: gh.token, path: PREPARE.statusPath });
  if (app.ui.seiri !== s || !s.waiting) return;
  const status = res.ok ? parseStatus(res.json) : null;
  const delays = pollDelays();
  const d = decide(status, pending, Date.now(), { delays, keepWaiting: s.keepWaiting });
  if (d.ours) {
    s.status = status;
    s.chipLine = statusLine(status, { ours: true, parseTs: parseTimestamp });
    s.bot = { state: 'run', text: s.chipLine, stage: status.stage };
  } else if (d.other) {
    s.bot = { ...s.bot, other: statusLine(status, { ours: false, parseTs: parseTimestamp }) };
  } else if (!res.ok && res.status !== 404) {
    s.bot = { ...s.bot, other: `進み具合を読めませんでした（${res.message}）。続けて見に行きます` };
  }
  if (d.action === 'noreply') {
    // 10 分たっても返事が無い: 待ち続けるか、今あるデータで下書きか（パネルを開いて聞く。見に行くのは続ける）
    s.noReply = true;
    s.keepWaiting = true;
    s.offerLocal = true;
    s.bot = { ...s.bot, state: 'ask', text: 'ボットから返事がありません（起動していない可能性があります）' };
    s.open = true;
  }
  if (d.action === 'wait' || d.action === 'noreply') {
    app.render();
    schedulePoll(app, s, pollDelay(Date.now() - pending.requestedAt, delays) || PREPARE.poll.later);
    return;
  }
  savePending(null);
  s.waiting = false;
  s.chipLine = '';
  if (d.action === 'done') return botDone(app, s, status);
  if (d.action === 'cancelled') { s.bot = { state: 'skip', text: 'ボットの整理を取り消しました' }; return endCancelled(app, s); }
  s.bot = { state: 'ng', text: d.action === 'giveup' ? '3 時間たってもボットの整理が終わりませんでした' : d.action === 'busy' ? busyText(status) : errorText(status) };
  s.draft = { state: 'wait', text: '「今あるデータで下書き」を押すと、サイトのおまかせ（新しい下書きファイルがあればそれ）で空いている所を埋めます' };
  s.offerLocal = true;
  s.running = false;
  s.ended = 'error';
  s.open = true;
  app.render();
}

/** ボットが終わった: その commit の投稿・まとまり・下書きを読んで入れる */
async function botDone(app, s, status) {
  s.noReply = false;
  s.offerLocal = false;
  const gh = app.ghPrefs;
  const ref = (status.result && status.result.commit) || gh.branch;
  s.bot = { state: 'run', text: 'ボットの整理が終わりました。結果を読み込んでいます…' };
  app.render();
  const get = (path) => getGitHubFile({ repo: gh.repo, ref, token: gh.token, path });
  const [posts, topics, draft] = await Promise.all([get(PREPARE.postsPath), get(PREPARE.topicsPath), get(PREPARE.draftPath)]);
  const applied = app.applyBotData({ postsRaw: posts.ok ? posts.json : null, topicsRaw: topics.ok ? topics.json : null });
  s.newPosts += applied.added || 0;
  const st = status.result || {};
  const failed = !posts.ok ? `投稿を読めませんでした（${posts.message}）` : applied.error || '';
  s.bot = {
    state: failed ? 'ng' : 'ok',
    text: failed ? `${failed}。読めた分で進めます`
      : `ボットの整理が終わりました（新しい投稿 ${st.newPosts != null ? st.newPosts : applied.added}件${applied.topics != null ? `・まとまり ${applied.topics}` : ''}）`,
  };
  const f = draft.ok ? parseDraftFile(draft.json, { weekKey: app.weekKey, nowMs: Date.now(), parseTs: parseTimestamp, requestId: status.requestId }) : null;
  finishDraft(app, s, f && f.ok ? f.draft : null, f && f.ok ? 'bot' : 'auto');
  s.open = true;
  app.render();
}

/** 今あるデータで下書き（新しい draft.json があればそれ、無ければサイトのおまかせ） */
function localDraft(app, s) {
  const r = s.dataResult;
  let draft = null;
  if (r && r.ok && r.draftRaw) {
    const f = parseDraftFile(r.draftRaw, { weekKey: app.weekKey, nowMs: Date.now(), parseTs: parseTimestamp });
    if (f.ok) draft = f.draft;
  }
  finishDraft(app, s, draft, draft ? 'file' : 'auto');
  if (app.ui.seiri === s) app.render();
}

function finishDraft(app, s, draft, source) {
  const week = app.weekState();
  const plan = draft
    ? draftToPlan(draft, { week, topicsById: app.topicsById, visibleIds: new Set(app.visibleTopics.map((t) => t.id)) })
    : autoDraftPlan({ week, topics: app.visibleTopics, pickIds: app.pickIds, priorityGenre: app.saved.priorityGenre });
  const from = FROM[source];
  const sum = draftSummary(plan);
  if (sum.filled) {
    app.edit('整理開始の下書き', (w) => {
      for (const m of plan.main) w.rundown = setMainSlot(w.rundown, m.id, m.slot).rundown;
      for (const id of plan.category) w.rundown = assignTopic(w.rundown, id, 'category') || w.rundown;
      for (const id of plan.chat) w.rundown = assignTopic(w.rundown, id, 'chat') || w.rundown;
    }, { toastText: `${sum.text}（${from}）`, render: false });
    s.draft = { state: 'ok', text: `${sum.text}（${from}${plan.skipped ? `・使えないもの ${plan.skipped}件は飛ばしました` : ''}）。入っていたものは動かしていません。` };
  } else s.draft = { state: 'skip', text: `${sum.text}（${from}）` };
  const groups = app.visibleTopics.filter((t) => isFolderTopic(t));
  const grok = groups.filter((t) => t.bot).length;
  s.summary = {
    text: `データ ${timeText(app.ds.generated_at, app.ds.refTs)} 時点・新着 ${s.newPosts}件・まとまり ${groups.length}（Grok ${grok}）・下書き：メイン ${plan.main.length}・カテゴリ別 ${plan.category.length}・雑談 ${plan.chat.length}`,
    from: `下書きのもと：${from}`,
  };
  s.offerLocal = false;
  s.running = false;
  s.ended = 'done';
}

function endCancelled(app, s) {
  s.running = false;
  s.waiting = false;
  s.chipLine = '';
  s.ended = 'cancelled';
  s.ask = null;
  for (const k of ['data', 'bot', 'draft']) if (s[k].state === 'run' || s[k].state === 'wait') s[k] = { ...s[k], state: 'skip', text: s[k].state === 'run' ? 'やめました' : '' };
  if (app.ui.seiri === s) app.render();
}

/** 「少し前にお願いしました」: それでも実行 → 'force' ／ 今あるデータで進める → 'local' ／ キャンセル → 'cancel' */
function ask(app, s, minutes) {
  return new Promise((resolve) => {
    s.ask = { minutes, resolve: (v) => { s.ask = null; resolve(v); app.render(); } };
    s.bot = { ...s.bot, state: 'ask', text: `少し前にボットにお願いしました（あと${minutes}分は続けてお願いしません）` };
    app.render();
  });
}

/** 「今あるデータで下書き」（ボットを待つのはやめる） */
function useLocal(app, s) {
  if (s.waiting) {
    clearTimeout(pollTimer);
    savePending(null);
    s.waiting = false;
    s.chipLine = '';
    s.bot = { state: 'skip', text: `${s.noReply ? 'ボットから返事がありませんでした' : s.bot.text}。今あるデータで進めます` };
  }
  s.noReply = false;
  s.offerLocal = false;
  s.running = true;
  localDraft(app, s);
}

async function cancelSeiri(app) {
  const s = app.ui.seiri;
  if (!s || !s.running) return;
  s.cancelled = true;
  if (s.ask) { s.ask.resolve('cancel'); return; }
  if (s.waiting) {
    clearTimeout(pollTimer);
    const pending = loadPending();
    savePending(null);
    s.waiting = false;
    endCancelled(app, s);
    s.bot = { state: 'skip', text: 'ボットに取り消しを送っています…' };
    app.render();
    const gh = app.ghPrefs;
    const req = pending && pending.request ? pending.request : null;
    const w = req && gh.token
      ? await putGitHubFile({ repo: gh.repo, branch: gh.branch, token: gh.token, path: PREPARE.requestPath, content: `${JSON.stringify(cancelRequest(req, Date.now()), null, 2)}\n`, message: `prepare: cancel ${req.id}` })
      : { ok: false, message: 'お願いの中身が見つかりません' };
    s.bot = { state: 'skip', text: w.ok ? 'ボットに取り消しを送りました' : `取り消しを送れませんでした（${w.message}）` };
    app.render();
    return;
  }
  app.render();
}

/**
 * ページを開いたとき: 待っているお願いがあれば、続けて見に行く。
 * お願いしていないときは、ときどき（5 分おき）status.json を見て、ボットの自動整理（auto-…）が終わっていたら「反映する」を出す
 */
export function resumeSeiri(app) {
  const pending = loadPending();
  if (pending && hasGitHub(app) && pollDelay(Date.now() - pending.requestedAt, pollDelays()) != null) {
    const s = newState({ open: false, data: { state: 'skip', text: '（前に始めた整理の続きです）' } });
    app.ui.seiri = s;
    waitForBot(app, s, pending.id);
  } else if (pending) savePending(null);
  idleCheck(app);
}

let idleTimer = null;
async function idleCheck(app) {
  clearTimeout(idleTimer);
  const next = () => { idleTimer = setTimeout(() => idleCheck(app), pollDelays().idle || PREPARE.poll.idle); };
  if (!hasGitHub(app) || (app.ui.seiri && app.ui.seiri.waiting) || document.hidden) { next(); return; }
  const gh = app.ghPrefs;
  const res = await getGitHubFile({ repo: gh.repo, ref: gh.branch, token: gh.token, path: PREPARE.statusPath });
  const status = res.ok ? parseStatus(res.json) : null;
  const prev = app.ui.seiriAuto;
  if (autoFinished(status, store.get(PREPARE.autoSeenKey))) app.ui.seiriAuto = { done: true, status, at: hhmm(status.finishedAt || status.updatedAt, parseTimestamp) };
  else app.ui.seiriAuto = null;
  // 自動整理が動いているあいだは、知らせだけ
  const s = app.ui.seiri;
  if (status && status.requestId && status.requestId.startsWith('auto-') && (status.state === 'running' || status.state === 'queued') && !(s && s.waiting)) {
    app.ui.seiri = s && s.running ? s : { ...(s || newState({ open: false, running: false, data: { state: 'skip', text: '' } })), otherLine: statusLine(status, { ours: false, parseTs: parseTimestamp }).replace('ほかの整理', '自動の整理') };
  } else if (s && s.otherLine && !s.running) app.ui.seiri = { ...s, otherLine: '' };
  if (JSON.stringify(prev) !== JSON.stringify(app.ui.seiriAuto) || (app.ui.seiri !== s)) app.render();
  next();
}

/** ボットの自動整理を反映する（お願いしたときと同じ: 投稿・まとまりを読み、空いている所だけに下書き） */
async function applyAuto(app) {
  const a = app.ui.seiriAuto;
  if (!a) return;
  store.set(PREPARE.autoSeenKey, a.status.requestId);
  app.ui.seiriAuto = null;
  const s = newState({ data: { state: 'skip', text: '（ボットの自動整理の結果を使います）' } });
  app.ui.seiri = s;
  await botDone(app, s, a.status);
}

// ================================================================ 進み具合のパネル（閉じても裏で進む。ボタンか板の上の知らせを押すとまた開く）

const MARK = { wait: '・', run: '…', ok: '✓', ng: '！', skip: '－', ask: '？' };

function stepRow(n, title, st, extra = null, key = '') {
  return h('li', { class: `sr-step is-${st.state}`, dataset: { key: `seiri-${key}`, state: st.state } },
    h('span', { class: 'sr-mark', attrs: { 'aria-hidden': 'true' } }, MARK[st.state] || '・'),
    h('div', { class: 'sr-body' }, h('b', { class: 'sr-title' }, `${n}. ${title}`), st.text ? h('p', { class: 'sr-text', dataset: { key: `seiri-${key}-text` } }, st.text) : null, extra));
}

/** 進み具合のパネル。opts.setStep(n): ステップを切り替える */
export function seiriPanel(app, opts = {}) {
  const s = app.ui.seiri;
  if (!s || !s.open) return null;
  const close = () => { s.open = false; app.render(); };
  const panel = h('section', { class: 'seiri-panel', dataset: { keep: 'seiri', key: 'seiri-panel', ended: s.ended || '' }, attrs: { role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'seiri-title' } });
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !s.ask) { e.stopPropagation(); close(); } });
  const status = s.running ? (s.waiting ? 'ボットを待っています' : '進めています…') : s.ended === 'cancelled' ? 'やめました' : s.ended === 'error' ? '止まりました' : '終わりました';
  panel.append(h('header', { class: 'sr-head' },
    h('h2', { id: 'seiri-title' }, '整理開始', h('small', { dataset: { key: 'seiri-status' } }, status)),
    s.running ? btn('キャンセル', () => cancelSeiri(app), 'btn btn-small btn-ghost', { 'data-key': 'seiri-cancel', title: s.waiting ? 'やめます（ボットにも取り消しを送ります）' : 'やめます' }) : null,
    btn('閉じる', close, 'btn btn-small btn-ghost', { 'data-key': 'seiri-close', title: s.running ? '閉じても裏で進みます（板の上の知らせか「整理開始」を押すとまた開きます）' : '閉じる' })));
  let botExtra = null;
  if (s.bot.state === 'run' && s.bot.stage) {
    const i = PREPARE.stages.indexOf(s.bot.stage);
    botExtra = h('ol', { class: 'sr-stages', attrs: { 'aria-label': 'ボットの作業' } }, PREPARE.stages.map((k, j) => h('li', { class: j < i ? 'is-done' : j === i ? 'is-now' : '', dataset: { key: `seiri-stage-${k}` } }, STAGE_SHORT[k])));
  }
  if (s.bot.other) botExtra = h('div', {}, botExtra, h('p', { class: 'sr-text muted', dataset: { key: 'seiri-other' } }, s.bot.other));
  if (s.ask) {
    botExtra = h('div', { class: 'row sr-ask' },
      btn('それでも実行', () => s.ask && s.ask.resolve('force'), 'btn btn-small btn-red', { 'data-key': 'seiri-force' }),
      btn('今あるデータで進める', () => s.ask && s.ask.resolve('local'), 'btn btn-small', { 'data-key': 'seiri-local' }));
  }
  let draftExtra = null;
  if (s.offerLocal) {
    draftExtra = h('div', { class: 'row sr-ask' },
      s.noReply && s.waiting ? btn('待ち続ける', () => { s.noReply = false; s.offerLocal = false; s.bot = { state: 'run', text: s.chipLine || 'ボットを待っています' }; app.render(); }, 'btn btn-small', { 'data-key': 'seiri-keep-waiting' }) : null,
      btn('今あるデータで下書き', () => useLocal(app, s), 'btn btn-small btn-red', { 'data-key': 'seiri-local-draft' }));
  }
  panel.append(h('ol', { class: 'sr-steps' },
    stepRow(1, '最新のデータを読み込む', s.data, null, 'data'),
    stepRow(2, 'ボット（収集・Grok のまとめ）', s.bot, botExtra, 'bot'),
    stepRow(3, '番組の流れの下書き（空いている所だけ）', s.draft, draftExtra, 'draft')));
  if (s.summary) {
    const go = (n) => () => { s.open = false; if (opts.setStep) opts.setStep(n); else app.render(); };
    panel.append(h('div', { class: 'sr-sum', dataset: { key: 'seiri-summary' } },
      h('p', { class: 'sr-sum-text', dataset: { key: 'seiri-summary-text' } }, s.summary.text),
      h('p', { class: 'muted', dataset: { key: 'seiri-from' } }, s.summary.from),
      h('div', { class: 'row' },
        btn('① 投稿・まとまりを見る', go(1), 'btn btn-small', { 'data-key': 'seiri-go-1' }),
        btn('② 番組の流れを見る', go(2), 'btn btn-small btn-red', { 'data-key': 'seiri-go-2' }))));
  }
  return panel;
}

const STAGE_SHORT = Object.freeze({ collect: '集める', metrics: '表示数', feedback: '修正', group: 'まとまり', draft: '下書き', push: '保存' });
