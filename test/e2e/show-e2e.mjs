// 配信番組サイト（/show/）の E2E。
//
// 実行方法（依存ゼロ方針のため playwright はリポジトリに入れない。dashboard-e2e.mjs と同じ）:
//   PW_DIR=/path/to/qa/node_modules node test/e2e/show-e2e.mjs
//   スクリーンショットの出力先は SHOTS_DIR（既定: OS の一時ディレクトリ/x-trend-show-shots）
//
// リポジトリ直下を `python3 -m http.server`（空きポート）で配信し、終了時に停止する。
// data/ は page.route で差し替える（リポジトリの data/ は読むだけ・変更しない）。
// 外部通信（Google Fonts・X 埋め込み・画像）はすべて page.route でモック／遮断する。

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'x-trend-show-shots');
mkdirSync(SHOTS, { recursive: true });

async function loadPlaywright() {
  const dirs = [process.env.PW_DIR, ...(process.env.NODE_PATH || '').split(path.delimiter)].filter(Boolean);
  for (const d of dirs) {
    try {
      const req = createRequire(pathToFileURL(path.join(d, 'noop.js')));
      return await import(pathToFileURL(req.resolve('playwright')).href);
    } catch { /* 次を試す */ }
  }
  return import('playwright');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

async function waitHttp(url, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

const results = [];
let failed = 0;
async function check(name, fn) {
  try {
    const info = await fn();
    results.push(`ok   ${name}${info ? ` — ${info}` : ''}`);
  } catch (err) {
    failed++;
    results.push(`FAIL ${name} — ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err}`);
  }
  console.log(results[results.length - 1]);
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4/5/hPwAHAgL/jg2v2QAAAABJRU5ErkJggg==', 'base64');
// 偽 widgets.js: ID 末尾が奇数なら埋め込み失敗（undefined）→ 自前の表示に戻ることを確かめる
const FAKE_WIDGETS = `
window.twttr = { ready: function (cb) { cb(window.twttr); }, widgets: { createTweet: function (id, el) {
  window.__embedCalls = (window.__embedCalls || []).concat([id]);
  return new Promise(function (resolve) { setTimeout(function () {
    if (/[13579]$/.test(id)) { resolve(undefined); return; }
    var d = document.createElement('div'); d.className = 'fake-tweet'; d.style.height = '180px'; d.textContent = 'FAKE EMBED ' + id; el.appendChild(d); resolve(d);
  }, 50); });
} } };`;

/**
 * data: { posts, reports, bookmarks } … 値が null なら 404、文字列ならそのまま（不正 JSON 用）、
 *       undefined（キーなし）なら 404。data 自体が undefined なら実ファイル（リポジトリの data/）
 */
async function setupRoutes(page, { data } = {}) {
  const external = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') {
      if (data !== undefined && url.pathname.startsWith('/data/')) {
        const key = { '/data/posts.json': 'posts', '/data/reports.json': 'reports', '/data/bookmarks.json': 'bookmarks' }[url.pathname];
        const v = key && data ? data[key] : null;
        if (v == null) return route.fulfill({ status: 404, body: 'not found' });
        return route.fulfill({ status: 200, contentType: 'application/json', body: typeof v === 'string' ? v : JSON.stringify(v) });
      }
      return route.continue();
    }
    external.push(url.href);
    if (url.href.startsWith('https://platform.twitter.com/widgets.js')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_WIDGETS });
    if (url.hostname === 'pbs.twimg.com' && /SAMPLE_ok_/.test(url.pathname)) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    return route.abort('blockedbyclient'); // Google Fonts など → システムの太字で表示
  });
  return external;
}

function watchConsole(page, bucket) {
  page.on('pageerror', (e) => bucket.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => { bucket.push(`dialog: ${d.message()}`); d.dismiss(); });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource/.test(t)) return; // 想定内: data/ の 404・遮断した外部リソース
    bucket.push(`console: ${t}`);
  });
}

/** メニュー（<details>）の中のボタンも押せるよう、先に開いてからクリック */
async function act(page, sel) {
  await page.evaluate((x) => { const el = document.querySelector(x); const d = el && el.closest('details'); if (d) d.open = true; }, sel);
  await page.click(sel);
}

const ready = (page) => page.waitForFunction(() => (window.__show && window.__show.ready) || !document.getElementById('error').hidden, null, { timeout: 15000 });
const sw = (page) => page.evaluate(() => document.documentElement.scrollWidth);
const live = (page) => page.evaluate(() => window.__show.weekState().live);
const curCue = (page) => page.evaluate(() => { const a = window.__show; const c = a.cues[a.weekState().live.index]; return c ? c.id : 'end'; });
const oaCue = (page) => page.$eval('#oa-stage', (e) => e.dataset.cue);
async function waitOnair(page, cue) {
  await page.waitForFunction((c) => { const s = document.getElementById('oa-stage'); return s && s.dataset.cue === c; }, cue, { timeout: 5000 });
}

async function main() {
  const pw = await loadPlaywright();
  const chromium = pw.chromium || (pw.default && pw.default.chromium);
  const port = await freePort();
  const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}/`;
  const show = `${base}show/`;
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'xshow-'));
  const errors = [];
  let browser = null;
  try {
    browser = await chromium.launch();
    await waitHttp(base);
    const sample = JSON.parse(readFileSync(path.join(ROOT, 'sample/show/posts.json'), 'utf8'));
    const sampleReports = JSON.parse(readFileSync(path.join(ROOT, 'sample/show/reports.json'), 'utf8'));
    const sampleBm = JSON.parse(readFileSync(path.join(ROOT, 'sample/show/bookmarks.json'), 'utf8'));
    const SAMPLE_404 = { posts: null, reports: null, bookmarks: null };

    const newCtx = (opts = {}) => browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', acceptDownloads: true, ...opts });
    const open = async (ctx, url, routeOpts = { data: SAMPLE_404 }) => {
      const page = await ctx.newPage();
      const external = await setupRoutes(page, routeOpts);
      watchConsole(page, errors);
      await page.goto(url);
      await ready(page);
      return { page, external };
    };

    // ---- 1. サンプル表示・ページ切替タブ
    await check('サンプル表示（data/ が無い）＋帯・話題のまとめ・ブックマーク枠', async () => {
      const ctx = await newCtx();
      const { page, external } = await open(ctx, show);
      assert(await page.isVisible('#sample-banner'), 'banner');
      assert((await page.textContent('#sample-banner')).includes('サンプル表示中'), 'banner text');
      assert((await page.getAttribute('.page-tabs a[aria-current="page"]', 'href')) === './', 'show tab current');
      assert(await page.$('.tcard[data-topic="d:d-hostcall"]'), 'ホストコールの話題');
      assert(await page.$('.tcard[data-topic="t:サンプル王子さんの引退"]'), 'topic: の話題');
      assert(await page.$('.tcard .badge-suggest'), '同じ話題かも？');
      assert(await page.isVisible('.bookmarks-sec'), 'bookmark section');
      const weekN = await page.$$eval('.bm-grid .bm-card, .bm-list li', (l) => l.length);
      assert(weekN === 4, `今週のブックマーク ${weekN}`);
      await page.click('[data-key="bm-all"]');
      const allN = await page.$$eval('.bm-grid .bm-card, .bm-list li', (l) => l.length);
      assert(allN === sampleBm.bookmarks.length, `すべて ${allN}`);
      assert((await page.textContent('.bookmarks-sec')).includes('ブクマで取り込み'), 'below_threshold の印');
      assert(await page.$('.tcard .badge-bm'), '★ブックマークの印');
      const ext = external.filter((u) => !u.startsWith('https://platform.twitter.com/widgets.js'));
      assert(!external.some((u) => /fonts\.(googleapis|gstatic)\.com/.test(u)), '外部フォントは読まない');
      assert(ext.length === 0, `外部通信: ${ext.join(', ')}`);
      await ctx.close();
      return `今週 ${weekN}件・すべて ${allN}件`;
    });

    await check('ページ切替タブ: ダッシュボード ⇄ 番組', async () => {
      const ctx = await newCtx();
      const page = await ctx.newPage();
      await setupRoutes(page, {});
      watchConsole(page, errors);
      await page.goto(base);
      await page.waitForFunction(() => window.__dashboard && window.__dashboard.ready, null, { timeout: 15000 });
      assert((await page.textContent('.site-header .page-tabs a[aria-current="page"]')) === 'ダッシュボード', 'dashboard current');
      await page.click('.site-header .page-tabs a[href="show/"]');
      await ready(page);
      assert(new URL(page.url()).pathname === '/show/', page.url());
      await page.click('.page-tabs a[href="../"]');
      await page.waitForFunction(() => window.__dashboard && window.__dashboard.ready, null, { timeout: 15000 });
      assert(new URL(page.url()).pathname === '/', page.url());
      await page.setViewportSize({ width: 360, height: 740 });
      const w = await sw(page);
      assert(w <= 360, `dashboard scrollWidth ${w}`);
      await page.screenshot({ path: path.join(SHOTS, 'dashboard-tabs-360.png'), clip: { x: 0, y: 0, width: 360, height: 220 } });
      await ctx.close();
    });

    // ---- 2. 編成 → 進行 → 映す用（同じブラウザの別タブ）
    const ctx = await newCtx();
    const { page } = await open(ctx, `${show}#plan`);
    let mainIds = [];
    await check('編成: メイン3（おすすめで埋める）→ 自動タイトル・コーナーへ入れる・台本', async () => {
      await page.click('[data-key="fill-main"]');
      mainIds = await page.$$eval('.slot.g-main', (l) => l.map((e) => e.dataset.topic));
      assert(mainIds.length === 3, `main ${mainIds.length}`);
      const names = await page.$$eval('.slot.g-main .slot-name', (l) => l.map((e) => e.lastChild.textContent));
      const title = await page.inputValue('[data-key="title"]');
      assert(title === `【週刊ヨルニュース】${names.join('／')}`, title);
      // カテゴリ別へ 2 件、雑談へ 1 件
      const cands = await page.$$eval('.candidates > .cand-grid .tcard', (l) => l.map((e) => e.dataset.topic));
      let n = 0;
      for (const id of cands) { if (n >= 2) break; const sel = `[data-key="to-category-${id}"]`; if (await page.$(sel)) { await act(page, sel); n++; } }
      await page.click('[data-filter="general"]');
      if (!(await page.$('.singles[open]'))) await page.click('[data-key="singles-toggle"]');
      const gen = await page.$$eval('.candidates .tcard, .candidates .srow', (l) => l.map((e) => e.dataset.topic));
      for (const id of gen) { const sel = `[data-key="to-chat-${id}"]`; if (await page.$(sel)) { await act(page, sel); break; } }
      await page.click('[data-filter="all"]');
      // 単発の投稿は折りたたみ（件数表示・展開・検索）
      const cnt = await page.textContent('.cand-count');
      assert(/まとまった話題 \d+件・単発の投稿 \d+件/.test(cnt), cnt);
      const singleNames = await page.$$eval('.singles .tcard-name', (l) => l.map((e) => e.textContent));
      assert(singleNames.length > 0, 'singles listed');
      assert(await page.$('.singles[open]'), 'singles open state kept');
      await page.fill('[data-key="topic-search"]', singleNames[0].slice(0, 6));
      await page.waitForFunction((q) => { const n = [...document.querySelectorAll('.singles .tcard-name')]; return n.length > 0 && n.every((e) => e.textContent.includes(q)); }, singleNames[0].slice(0, 6));
      await page.fill('[data-key="topic-search"]', '');
      await page.waitForTimeout(300);
      await page.click('[data-key="singles-toggle"]');
      const cat = await page.$$eval('.corner[data-corner="category"] .item', (l) => l.length);
      const chat = await page.$$eval('.corner[data-corner="chat"] .item', (l) => l.length);
      assert(cat === 2 && chat === 1, `category ${cat} chat ${chat}`);
      // 並べ替え
      const before = await page.$$eval('.slot.g-main', (l) => l.map((e) => e.dataset.topic));
      await page.click(`[data-key="main-down-${before[0]}"]`);
      const after = await page.$$eval('.slot.g-main', (l) => l.map((e) => e.dataset.topic));
      assert(after[1] === before[0] && after[0] === before[1], 'reorder');
      mainIds = after;
      // 台本（話すポイント）を入力 → 映す用には出ない
      await page.click(`.corner[data-corner="main"] .item[data-topic="${mainIds[0]}"] summary`);
      await page.fill(`[data-key="points-${mainIds[0]}"]`, 'ヒミツの話すポイント');
      await page.fill(`[data-key="q-${mainIds[0]}"]`, 'みんなはどう？');
      // タイトルを手で変えて → 自動に戻す
      await page.fill('[data-key="title"]', '手書きタイトル');
      await page.locator('[data-key="title"]').blur();
      await page.waitForSelector('[data-key="title-auto"]');
      await page.click('[data-key="title-auto"]');
      assert((await page.inputValue('[data-key="title"]')).startsWith('【週刊ヨルニュース】'), 'auto title back');
      await page.waitForTimeout(500); // 台本の保存（遅延）
      await page.screenshot({ path: path.join(SHOTS, 'plan-1280.png') });
      await page.screenshot({ path: path.join(SHOTS, 'plan-1280-full.png'), fullPage: true });
      const w = await sw(page);
      assert(w <= 1280, `scrollWidth ${w}`);
    });

    await check('編成: 話題の編集（名前・結合）・同じ話題かも？（まとめる/バラす）・個人URL', async () => {
      const sug = await page.$$eval('.candidates > .cand-grid .tcard .suggest-row', (l) => l.map((e) => e.closest('.tcard').dataset.topic));
      assert(sug.length >= 2, `suggestions ${sug.length}`);
      await page.click(`[data-key="accept-${sug[0]}"]`);
      assert(!(await page.$(`.tcard[data-topic="${sug[0]}"] .suggest-row`)), 'accepted');
      await page.click(`[data-key="split-${sug[1]}"]`);
      assert(!(await page.$(`.tcard[data-topic="${sug[1]}"]`)), 'split');
      // 名前変更
      await act(page, `[data-key="edit-${sug[0]}"]`);
      await page.waitForSelector('dialog.topic-dialog[open]');
      await page.fill('[data-key="dlg-name"]', '麺屋の行列');
      await page.locator('[data-key="dlg-name"]').press('Tab');
      await page.waitForFunction(() => document.querySelector('dialog.topic-dialog[open] #dlg-title')?.textContent === '麺屋の行列');
      await page.click('[data-key="dlg-close"]');
      assert(!(await page.$('dialog[open]')), 'dialog closed');
      assert((await page.textContent(`.tcard[data-topic="${sug[0]}"] .tcard-name`)) === '麺屋の行列', 'renamed');
      // 個人 URL（データにある 1 件・無い 1 件・不正 1 行・重複）
      const inData = sample.posts[sample.posts.length - 1];
      await page.fill('[data-key="personal-input"]', `${inData.url}\nhttps://twitter.com/foo/status/1888888888888888888?s=20\nこれはURLではない\n${inData.url}`);
      await page.click('[data-key="personal-add"]');
      const msg = await page.textContent('.personal [role="status"]');
      assert(msg.includes('2件追加') && msg.includes('リンクのみ 1件') && msg.includes('読み取れなかったもの 1件'), msg);
      await page.click('[data-filter="me"]');
      assert(await page.$('.tcard[data-topic="x:1888888888888888888"]'), 'link-only topic');
      assert((await page.textContent('.tcard[data-topic="x:1888888888888888888"]')).includes('自分で追加'), 'personal badge');
      await page.click('[data-filter="all"]');
    });

    let onair;
    let afterMain = '';
    await check('進行: 開始・読んだ（→）・飛ばす（S）・来週へ（L）・戻す（←）＋映す用が追従', async () => {
      const oaPage = await ctx.newPage();
      await oaPage.setViewportSize({ width: 1920, height: 1080 });
      await setupRoutes(oaPage, { data: SAMPLE_404 });
      watchConsole(oaPage, errors);
      await oaPage.goto(`${show}#onair`);
      await ready(oaPage);
      onair = oaPage;
      assert((await oaPage.$eval('#oa-stage', (e) => e.dataset.waiting)) === 'true', 'waiting screen');
      assert(await oaPage.isHidden('.sh-header'), 'header hidden on onair');
      await oaPage.screenshot({ path: path.join(SHOTS, 'onair-1920-waiting.png') });

      await page.goto(`${show}#live`);
      await ready(page);
      await page.click('[data-key="live-start"]');
      assert((await curCue(page)) === `main:${mainIds[0]}`, await curCue(page));
      await waitOnair(oaPage, `main:${mainIds[0]}`);
      await oaPage.waitForTimeout(300);
      await oaPage.screenshot({ path: path.join(SHOTS, 'onair-1920-titlecard.png') });
      await oaPage.waitForSelector('.oa-card', { state: 'detached', timeout: 5000 });
      await oaPage.screenshot({ path: path.join(SHOTS, 'onair-1920-news.png') });
      const oaText = await oaPage.textContent('#oa-stage');
      assert(!oaText.includes('ヒミツの話すポイント') && !oaText.includes('みんなはどう？'), 'メモは映さない');
      const liveText = await page.textContent('.live-main');
      assert(!liveText.includes('ヒミツの話すポイント') && !liveText.includes('視聴者への質問'), '進行には話すポイント・質問の欄を出さない');
      // 代表投稿は埋め込み（モック）が既定。映す用も埋め込みを試す（失敗時は自前の表示）
      await page.waitForSelector('.live-main .live-embed.is-loaded, .live-main .live-embed.is-failed', { timeout: 8000 });
      await oaPage.waitForSelector('.oa-embed.is-loaded, .oa-embed.is-failed', { timeout: 8000 });
      await page.screenshot({ path: path.join(SHOTS, 'live-1280.png') });
      await page.keyboard.press('s'); // メイン1 飛ばす
      await page.keyboard.press('l'); // メイン2 来週へ
      await waitOnair(oaPage, `main:${mainIds[2]}`);
      let st = await live(page);
      assert(st.status[`main:${mainIds[0]}`] === 'skipped' && st.status[`main:${mainIds[1]}`] === 'carried', JSON.stringify(st.status));
      let carried = await page.evaluate(() => window.__show.weekState().carriedOut.map((c) => c.topicId));
      assert(carried.includes(mainIds[1]), `carriedOut ${carried}`);
      await page.keyboard.press('ArrowLeft'); // 来週へを取り消し
      await waitOnair(oaPage, `main:${mainIds[1]}`);
      carried = await page.evaluate(() => window.__show.weekState().carriedOut.map((c) => c.topicId));
      assert(!carried.includes(mainIds[1]), 'uncarried');
      await page.keyboard.press('l');
      await page.click('[data-key="ctl-done"]'); // メイン3 読んだ（ボタン）
      assert(await page.$('.stamp'), '済スタンプ');
      st = await live(page);
      assert(st.status[`main:${mainIds[2]}`] === 'done', 'done by button');
      afterMain = await curCue(page);
      assert(afterMain.startsWith('category:'), afterMain);
      await waitOnair(oaPage, afterMain);
      // 入力欄の中ではキー操作しない
      const idx = (await live(page)).index;
      await page.goto(`${show}#plan`);
      await ready(page);
      await page.focus('[data-key="show-name"]');
      await page.keyboard.press('ArrowRight');
      assert((await live(page)).index === idx, 'no key action in plan');
      await page.goto(`${show}#live`);
      await ready(page);
      return `済 ${Object.values(st.status).filter((x) => x === 'done').length}`;
    });

    await check('リロードで状態復元（編成・進行・台本・来週へ）', async () => {
      const before = await live(page);
      await page.reload();
      await ready(page);
      const after = await live(page);
      assert(after.index === before.index && JSON.stringify(after.status) === JSON.stringify(before.status) && after.startedAt === before.startedAt, 'live');
      assert((await curCue(page)) === afterMain, await curCue(page));
      const sc = await page.evaluate((id) => window.__show.weekState().script[id], mainIds[0]);
      assert(sc && sc.points === 'ヒミツの話すポイント', JSON.stringify(sc));
      const carried = await page.evaluate(() => window.__show.weekState().carriedOut.map((c) => c.topicId));
      assert(carried.includes(mainIds[1]), 'carried kept');
      await onair.reload();
      await ready(onair);
      assert((await oaCue(onair)) === afterMain, 'onair restored');
    });

    await check('来週に回した話題が翌週の候補に出る', async () => {
      await page.goto(`${show}#plan`);
      await ready(page);
      const next = await page.evaluate(() => window.__show.nextWeekKey());
      await page.selectOption('#week-select', next);
      await page.waitForFunction((k) => window.__show.weekKey === k, next);
      const card = await page.$(`.tcard[data-topic="k:${mainIds[1]}"]`);
      assert(card, 'carried topic in next week');
      assert((await card.textContent()).includes('先週から持ち越し'), 'badge');
      // 映す用も週の切り替えに追従
      await onair.waitForFunction((k) => window.__show.weekKey === k, next, { timeout: 5000 });
      const cur = await page.evaluate(() => window.__show.weeks.find((w) => w.key < window.__show.weekKey).key);
      await page.selectOption('#week-select', cur);
      await page.waitForFunction((k) => window.__show.weekKey === k, cur);
    });

    await check('振り返り: 一覧とテキスト書き出し', async () => {
      await page.goto(`${show}#review`);
      await ready(page);
      const n = async (k) => page.$$eval(`.review-col[data-list="${k}"] li`, (l) => l.length);
      assert((await n('done')) === 1 && (await n('skipped')) === 1 && (await n('carried')) === 1, `${await n('done')}/${await n('skipped')}/${await n('carried')}`);
      const pub = await page.inputValue('[data-key="export-public"]');
      const full = await page.inputValue('[data-key="export-full"]');
      assert(pub.startsWith('【週刊ヨルニュース】') && pub.includes('00:00 メイン3トピック\n45:00 カテゴリ別ニュース') && !/オープニング|中休み|エンディング/.test(pub) && !pub.includes('ヒミツの話すポイント'), pub.slice(0, 120));
      assert(full.includes('ヒミツの話すポイント'), 'full has points');
      await page.screenshot({ path: path.join(SHOTS, 'review-1280.png'), fullPage: true });
    });

    await check('書き出し → 変更 → 読み込みで元に戻る・壊れたファイルは拒否', async () => {
      await page.goto(`${show}#plan`);
      await ready(page);
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-key="export"]')]);
      const file = path.join(tmp, 'export.json');
      await dl.saveAs(file);
      const exported = JSON.parse(readFileSync(file, 'utf8'));
      assert(exported.app === 'xtrend-show' && exported.v === 3, 'export format');
      // 変更: メインを全部外す
      for (const id of mainIds) { const b = await page.$(`[data-key="main-rm-${id}"]`); if (b) await b.click(); }
      assert((await page.$$('.slot.g-main')).length < 3, 'removed');
      // 壊れたファイル
      const bad = path.join(tmp, 'bad.json');
      writeFileSync(bad, '{ broken');
      await page.setInputFiles('#import-file', bad);
      await page.waitForSelector('.import-msg.is-error');
      // 正しいファイル
      await page.setInputFiles('#import-file', file);
      await page.waitForSelector('[data-key="import-yes"]');
      await page.click('[data-key="import-yes"]');
      await page.waitForFunction(() => document.querySelectorAll('.slot.g-main').length === 3);
      const after = await page.$$eval('.slot.g-main', (l) => l.map((e) => e.dataset.topic));
      assert(JSON.stringify(after) === JSON.stringify(mainIds.filter((id) => after.includes(id))) && after.length === 3, `${after}`);
    });

    await check('スマホ幅 375px（編成・進行）: 横スクロールなし', async () => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(`${show}#plan`);
      await ready(page);
      let w = await sw(page);
      assert(w <= 375, `plan scrollWidth ${w}`);
      await page.screenshot({ path: path.join(SHOTS, 'plan-375.png') });
      await page.screenshot({ path: path.join(SHOTS, 'plan-375-full.png'), fullPage: true });
      await page.goto(`${show}#live`);
      await ready(page);
      w = await sw(page);
      assert(w <= 375, `live scrollWidth ${w}`);
      await page.screenshot({ path: path.join(SHOTS, 'live-375.png') });
      await page.setViewportSize({ width: 1280, height: 800 });
    });

    await check('映す用: 1920×1080 にぴったり（雑談・終わり）', async () => {
      await page.goto(`${show}#live`);
      await ready(page);
      const cues = await page.evaluate(() => window.__show.cues.map((c) => c.id));
      assert(!cues.some((c) => /^(opening|break|review|ending)$/.test(c)), `旧コーナー ${cues}`);
      const last = cues[cues.length - 1];
      await page.click(`[data-key="prog-${last}"]`);
      await waitOnair(onair, last);
      await onair.waitForTimeout(2800);
      await onair.screenshot({ path: path.join(SHOTS, 'onair-1920-chat.png') });
      const box = await onair.$eval('#oa-stage', (e) => { const r = e.getBoundingClientRect(); return [r.width, r.height]; });
      assert(Math.round(box[0]) === 1920 && Math.round(box[1]) === 1080, `${box}`);
      await page.click('[data-key="ctl-done"]');
      await waitOnair(onair, 'end');
      await onair.screenshot({ path: path.join(SHOTS, 'onair-1920-end.png') });
      await onair.setViewportSize({ width: 960, height: 540 });
      await onair.waitForTimeout(300);
      const half = await onair.$eval('#oa-stage', (e) => Math.round(e.getBoundingClientRect().width));
      assert(half === 960, `scaled ${half}`);
      return `cues ${cues.length}`;
    });

    await check('整理: 片付け・削除 → トーストで元に戻す・タブから戻す・構成から外して元の枠へ・リロード後も保持', async () => {
      await page.goto(`${show}#plan`);
      await ready(page);
      const free = await page.$$eval('.candidates > .cand-grid .tcard', (l) => l.map((e) => e.dataset.topic));
      const a = free.find((id) => !mainIds.includes(id));
      // 片付け → トーストの「元に戻す」
      await act(page, `[data-key="shelve-${a}"]`);
      await page.waitForSelector('#toast:not([hidden]) [data-key="toast-undo"]');
      assert(!(await page.$(`.candidates > .cand-grid .tcard[data-topic="${a}"]`)), 'shelved hidden');
      assert((await page.textContent('[data-key="tab-shelf"]')).includes('（1）'), 'shelf count');
      await page.click('[data-key="toast-undo"]');
      await page.waitForSelector(`.candidates > .cand-grid .tcard[data-topic="${a}"]`);
      // 片付け → 片付けタブから戻す
      await act(page, `[data-key="shelve-${a}"]`);
      await page.click('[data-key="tab-shelf"]');
      await page.click(`[data-key="unshelve-${a}"]`);
      await page.click('[data-key="tab-list"]');
      await page.waitForSelector(`.candidates > .cand-grid .tcard[data-topic="${a}"]`);
      // 構成（メイン）に入っている話題を削除 → 枠から外れる → ゴミ箱から戻すと元の枠（2番目）へ
      const m = await page.$$eval('.slot.g-main', (l) => l.map((e) => e.dataset.topic));
      await page.click(`[data-key="main-edit-${m[1]}"]`);
      await page.waitForSelector('dialog.topic-dialog[open]');
      await page.click('[data-key="dlg-trash"]');
      await page.waitForFunction((id) => ![...document.querySelectorAll('.slot.g-main')].some((e) => e.dataset.topic === id), m[1]);
      assert(!(await page.$('dialog[open]')), 'dialog closed');
      // 削除はリロード後も保持
      await page.reload();
      await ready(page);
      assert((await page.textContent('[data-key="tab-trash"]')).includes('（1）'), 'trash kept after reload');
      await page.click('[data-key="tab-trash"]');
      await page.screenshot({ path: path.join(SHOTS, 'plan-trash-1280.png') });
      await page.click(`[data-key="untrash-${m[1]}"]`);
      await page.waitForFunction((ids) => JSON.stringify([...document.querySelectorAll('.slot.g-main')].map((e) => e.dataset.topic)) === JSON.stringify(ids), m);
      // 投稿単位の削除（ダイアログ）→ ゴミ箱の「すべて戻す」
      await page.click('[data-key="tab-list"]');
      await page.click(`[data-key="main-edit-${m[0]}"]`);
      await page.waitForSelector('dialog.topic-dialog[open]');
      const pid = await page.$eval('dialog[open] .post', (e) => e.dataset.id);
      await page.click(`[data-key="dlg-hide-${pid}"]`);
      await page.waitForFunction((id) => window.__show.saved.hiddenPosts.some((x) => x.id === id), pid);
      assert(!(await page.evaluate((id) => window.__show.topics.some((t) => t.postIds.includes(id)), pid)), 'hidden post removed from topics');
      await page.click('[data-key="dlg-close"]');
      await page.click('[data-key="tab-trash"]');
      await page.click('[data-key="trash-restore-all"]');
      await page.waitForFunction(() => window.__show.saved.hiddenPosts.length === 0 && window.__show.saved.trash.length === 0);
      await page.click('[data-key="tab-list"]');
      // 「済」（配信で読んだ）と「片付け」は別の言葉
      const txt = await page.textContent('.candidates');
      assert(!txt.includes('アーカイブ'), 'no ambiguous アーカイブ');
    });

    await check('候補カード: 主ボタン「番組に入れる」・「…」メニュー・詳細ビュー（全投稿・←→・Esc・投稿単位の操作）・構成パネルの折りたたみ保持', async () => {
      await page.goto(`${show}#plan`);
      await ready(page);
      const free = await page.$$eval('.candidates > .cand-grid .tcard', (l) => l.filter((e) => e.querySelector('.menu-put')).map((e) => e.dataset.topic)[0]);
      // カードのボタンは主ボタン＋ほか＋…だけ
      const btnCount = await page.$eval(`.tcard[data-topic="${free}"] .tcard-foot`, (f) => [...f.children].length);
      assert(btnCount <= 3, `foot children ${btnCount}`);
      // 主ボタンからカテゴリ別へ → 「入っています（外す）」表示
      await page.click(`[data-key="put-${free}"]`);
      assert(await page.isVisible(`[data-key="to-category-${free}"]`), 'menu opened');
      await page.click(`[data-key="to-category-${free}"]`);
      await page.waitForSelector(`.tcard[data-topic="${free}"] [data-key="card-rm-${free}"]`);
      await page.click(`[data-key="card-rm-${free}"]`);
      // 一般のバズにはメインの選択肢が無い
      const gen = await page.$$eval('.candidates > .cand-grid .tcard', (l) => l.filter((e) => e.querySelector('.sticker.g-general')).map((e) => e.dataset.topic));
      if (gen.length) assert(!(await page.$(`[data-key="to-main-${gen[0]}"]`)), 'general has no main');
      // 詳細ビュー: 帯の名前で開く → 投稿を全部 → 次へ（→）・前へ（←）→ Esc で閉じる
      const multi = await page.$$eval('.candidates > .cand-grid .tcard', (l) => l.filter((e) => e.querySelector('.tcard-more')).map((e) => e.dataset.topic));
      const t0 = multi[0];
      await page.click(`[data-key="others-${t0}"]`);
      await page.waitForSelector(`dialog.detail-dialog[open][data-topic="${t0}"]`);
      const n = await page.$$eval('dialog[open] .detail-post', (l) => l.length);
      const count = await page.evaluate((id) => window.__show.topicsById.get(id).postIds.length, t0);
      assert(n === count, `all posts ${n}/${count}`);
      await page.screenshot({ path: path.join(SHOTS, 'plan-detail-1280.png') });
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction((id) => { const d = document.querySelector('dialog.detail-dialog[open]'); return d && d.dataset.topic !== id; }, t0);
      await page.keyboard.press('ArrowLeft');
      await page.waitForSelector(`dialog.detail-dialog[open][data-topic="${t0}"]`);
      // 投稿単位: 話題から外す
      const pids = await page.$$eval('dialog[open] .detail-post', (l) => l.map((e) => e.dataset.id));
      await page.click(`[data-key="detail-detach-${pids[pids.length - 1]}"]`);
      await page.waitForFunction(([id, p]) => !window.__show.topicsById.get(id).postIds.includes(p), [t0, pids[pids.length - 1]]);
      assert(await page.$('dialog.detail-dialog[open]'), 'detail stays open');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('dialog[open]'));
      // 「…」→ 編集
      await page.click(`[data-key="more-${t0}"]`);
      await page.click(`[data-key="edit-${t0}"]`);
      await page.waitForSelector('dialog.topic-dialog[open]');
      await page.click('[data-key="dlg-close"]');
      // 単発の行をクリックで詳細ビュー
      if (await page.$('[data-key="singles-toggle"]')) {
        if (!(await page.$('.singles[open]'))) await page.click('[data-key="singles-toggle"]');
        const sid = await page.$eval('.single-list .srow', (e) => e.dataset.topic);
        await page.click(`.single-list [data-key="open-${sid}"]`);
        await page.waitForSelector(`dialog.detail-dialog[open][data-topic="${sid}"]`);
        await page.click('[data-key="detail-close"]');
        await page.click('[data-key="singles-toggle"]');
      }
      // 構成パネルをたたむ → リロードしても保持 → 開く
      await page.click('[data-key="side-toggle"]');
      assert(await page.$('.side.is-closed'), 'side closed');
      await page.reload();
      await ready(page);
      assert(await page.$('.side.is-closed'), 'side closed kept');
      const cols = await page.$$eval('.candidates > .cand-grid .tcard', (l) => new Set(l.slice(0, 6).map((e) => Math.round(e.getBoundingClientRect().left))).size);
      await page.screenshot({ path: path.join(SHOTS, 'plan-side-closed-1280.png') });
      await page.click('[data-key="side-toggle"]');
      assert(!(await page.$('.side.is-closed')), 'side open');
      const w = await page.$eval('.candidates > .cand-grid .tcard', (e) => Math.round(e.getBoundingClientRect().width));
      assert(w >= 360 && w <= 420, `card width ${w}`);
      return `詳細 ${n}件・カード幅 ${w}px・たたんだときの列数 ${cols}`;
    });

    await check('話題カードは X 埋め込み（モック）・失敗時は自前の表示・カード表示に切替（保持）', async () => {
      await page.goto(`${show}#plan`);
      await ready(page);
      await page.waitForSelector('.tcard.is-embed .embed-host.is-loaded .fake-tweet', { timeout: 8000 });
      const first = await page.evaluate(() => window.__embedCalls.length);
      const cards = await page.$$eval('.embed-host[data-embed-id]', (l) => l.length);
      assert(first < cards, `画面から遠いものはまだ読まない（${first}/${cards}）`);
      // 画面に近いものだけ生成されるので、下までスクロールして失敗（自前の表示に戻る）も確かめる
      for (let y = 0; y < 6000 && !(await page.$('.tcard.is-embed .embed-host.is-failed .embed-fallback .post')); y += 600) {
        await page.mouse.wheel(0, 600);
        await page.waitForTimeout(250);
      }
      await page.waitForSelector('.tcard.is-embed .embed-host.is-failed .embed-fallback .post', { state: 'attached', timeout: 8000 });

      const loaded = await page.$$eval('.tcard.is-embed .embed-host.is-loaded', (l) => l.length);
      const total = await page.$$eval('.tcard.is-embed', (l) => l.length);
      // 再描画（ボタン操作）しても読み込み済みの埋め込みは作り直さない
      const before = await page.evaluate(() => window.__embedCalls.length);
      await page.click('[data-filter="host"]');
      await page.click('[data-filter="all"]');
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => window.__embedCalls.length);
      await page.screenshot({ path: path.join(SHOTS, 'plan-embed-1280.png') });
      await page.click('[data-key="view-toggle"]');
      assert(!(await page.$('.tcard .embed-host')) && await page.$('.tcard.is-datacard'), 'card mode');
      await page.reload();
      await ready(page);
      assert(!(await page.$('.tcard .embed-host')), 'card mode kept');
      await page.click('[data-key="view-toggle"]');
      assert(await page.$('.tcard .embed-host'), 'embed mode back');
      return `埋め込み ${loaded}/${total}・再描画での追加生成 ${after - before}`;
    });
    await ctx.close();

    // ---- 3. BroadcastChannel が無い環境（storage イベントで追従）
    await check('BroadcastChannel なしでも storage イベントで追従', async () => {
      const c2 = await newCtx();
      await c2.addInitScript(() => { delete window.BroadcastChannel; });
      const { page: p1 } = await open(c2, `${show}#plan`);
      await p1.click('[data-key="fill-main"]');
      const { page: p2 } = await open(c2, `${show}#onair`);
      await p1.goto(`${show}#live`);
      await ready(p1);
      await p1.click('[data-key="live-start"]');
      await p1.keyboard.press('ArrowRight');
      const cue = await curCue(p1);
      await waitOnair(p2, cue);
      await c2.close();
    });

    // ---- 4. XSS・空データ・壊れたデータ
    const xssPosts = {
      generated_at: '2026-10-16T00:09:00+09:00',
      posts: [
        { id: '2110000000000000001', url: 'javascript:alert(1)', user: 'x<b>ss', ts: Math.floor(Date.parse('2026-10-15T00:00:00+09:00') / 1000), created_jst: '2026-10-15T00:00:00+09:00',
          metrics: { impression_count: 9000000 }, text: '<img src=x onerror="window.__xss=1"> <script>window.__xss=2</script> ホストの話', categories: ['ホスト'], matched_terms: ['topic:<img src=x onerror="window.__xss=3">'] },
        { id: '2110000000000000002', url: '', user: 'b', ts: Math.floor(Date.parse('2026-10-15T01:00:00+09:00') / 1000), metrics: {}, text: '数値なし', categories: ['キャバクラ'], matched_terms: [] },
      ],
    };
    await check('XSS: 本文・話題名・アカウント名のタグは文字のまま（編成・進行・映す用）', async () => {
      const c3 = await newCtx();
      const { page: p } = await open(c3, `${show}#plan`, { data: { posts: xssPosts, reports: '{bad', bookmarks: { bookmarks: 'bad' } } });
      assert(await p.isHidden('#sample-banner'), 'no sample banner');
      assert(!(await p.$('.bookmarks-sec')), '壊れた bookmarks.json は枠を出さない');
      const name = await p.textContent('.candidates .tcard-name');
      assert(name.includes('<img src=x onerror='), name);
      await p.click('[data-key="fill-main"]');
      const { page: oa } = await open(c3, `${show}#onair`, { data: { posts: xssPosts } });
      await p.goto(`${show}#live`);
      await ready(p);
      await p.click('[data-key="live-start"]');
      await oa.waitForSelector('.oa-headline');
      assert((await oa.textContent('.oa-post-text')).includes('<script>'), 'onair text');
      assert((await p.textContent('.live-main')).includes('<img src=x'), 'live text');
      assert(!(await p.$('.live-main img[src="x"]')) && !(await oa.$('img[src="x"]')), 'no injected img');
      const xss = (await p.evaluate(() => window.__xss)) ?? (await oa.evaluate(() => window.__xss));
      assert(xss === undefined, `xss ${xss}`);
      const hrefs = await p.$$eval('a[href]', (l) => l.map((a) => a.getAttribute('href')));
      assert(!hrefs.some((h) => /^javascript:/i.test(h)), 'javascript: link');
      await c3.close();
    });

    await check('空データ（posts が 0 件）・reports/bookmarks なし: 各画面が「該当なし」で動く', async () => {
      const c4 = await newCtx();
      const { page: p } = await open(c4, `${show}#plan`, { data: { posts: { generated_at: '2026-10-16T00:09:00+09:00', posts: [] } } });
      assert((await p.textContent('.candidates')).includes('該当なし'), 'empty candidates');
      assert(!(await p.$('.bookmarks-sec')), 'no bookmark section');
      assert(!(await p.$('[data-key="fill-main"]')), 'no suggestion');
      for (const r of ['live', 'review', 'onair']) {
        await p.goto(`${show}#${r}`);
        await ready(p);
      }
      await p.goto(`${show}#live`);
      await ready(p);
      await p.click('[data-key="live-start"]');
      for (let i = 0; i < 10; i++) await p.keyboard.press('Enter');
      assert((await p.textContent('.live-main')).includes('おつかれさまでした'), 'finished');
      await c4.close();
    });

    await check('壊れた保存値（localStorage）でも起動し、注意を出す', async () => {
      const c5 = await newCtx();
      await c5.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('xtrend-show', '{"broken'); sessionStorage.setItem('seeded', '1'); } } catch { /* */ } });
      const { page: p } = await open(c5, `${show}#plan`);
      const st = await p.textContent('#save-status');
      assert(st.includes('保存データを読めなかった'), st);
      assert(await p.$('.tcard'), 'candidates shown');
      await c5.close();
    });

    await check('チェックポイント: 記録後に増えた投稿・話題に NEW', async () => {
      const c8 = await newCtx();
      const p = await c8.newPage();
      watchConsole(p, errors);
      let data = { posts: sample, reports: sampleReports, bookmarks: sampleBm };
      await p.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname !== '127.0.0.1') return route.abort('blockedbyclient');
        const key = { '/data/posts.json': 'posts', '/data/reports.json': 'reports', '/data/bookmarks.json': 'bookmarks' }[url.pathname];
        if (key) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data[key]) });
        return route.continue();
      });
      await p.goto(`${show}#plan`);
      await ready(p);
      assert(!(await p.$('.badge-new')), 'no NEW before checkpoint');
      await p.click('[data-key="cp-preview"]');
      assert((await p.textContent('.cp-status')).includes('その後のデータ更新はまだありません'), 'same data');
      const extra = { ...sample.posts[0], id: '2110009999999999999', text: 'チェック後に増えた新しい話題の投稿です', user: 'sample_new', matched_terms: [], ts: sample.posts[0].ts - 60, url: '' };
      const extra2 = { ...sample.posts[0], id: '2110009999999999998', text: 'ラスソンの新しい動画が出た', user: 'sample_new2', matched_terms: [], ts: sample.posts[0].ts - 120, url: '' };
      data = { ...data, posts: { ...sample, generated_at: '2026-10-16T22:00:00+09:00', posts: [extra, extra2, ...sample.posts] } };
      await p.reload();
      await ready(p);
      const st = await p.textContent('.cp-status');
      assert(st.includes('新しい投稿 2件'), st);
      await p.click('[data-filter="new"]');
      const ids = await p.$$eval('.cand-grid .tcard', (l) => l.map((e) => e.dataset.topic));
      assert(ids.length === 2, `NEW filter ${ids}`);
      const newTopic = ids.find((id) => id !== 'd:d-hostcall');
      assert((await p.textContent(`.tcard[data-topic="${newTopic}"] .tcard-marks`)).includes('NEW'), 'new topic');
      assert((await p.textContent('.tcard[data-topic="d:d-hostcall"] .tcard-marks')).includes('NEW +1'), 'NEW +1 on existing topic');
      // 話題の編集ダイアログ（スクショ）
      await act(p, '[data-key="edit-d:d-hostcall"]');
      await p.waitForSelector('dialog.topic-dialog[open]');
      await p.screenshot({ path: path.join(SHOTS, 'plan-dialog-1280.png') });
      // 投稿を別の話題へ移す
      const pid = await p.$eval('dialog[open] .post', (e) => e.dataset.id);
      await p.selectOption(`[data-key="dlg-move-${pid}"]`, '__new');
      await p.waitForFunction((id) => window.__show.topicsById.has(`p:${id}`), pid);
      await c8.close();
      return st.replace(/\s+/g, ' ').slice(0, 80);
    });

    await check('動きを減らす設定: 済スタンプのアニメなし', async () => {
      const c6 = await newCtx({ reducedMotion: 'reduce' });
      const { page: p } = await open(c6, `${show}#live`);
      await p.click('[data-key="live-start"]');
      await p.click('[data-key="ctl-done"]');
      const cls = await p.$eval('.stamp', (e) => e.className);
      assert(!cls.includes('is-anim'), cls);
      await c6.close();
    });

    // ---- 5. 実データ（リポジトリの data/。読むだけ）
    if (existsSync(path.join(ROOT, 'data', 'posts.json'))) {
      for (const [w, h, route] of [[1280, 800, 'plan'], [1600, 900, 'plan'], [375, 812, 'plan'], [1280, 800, 'live'], [375, 812, 'live'], [1920, 1080, 'onair']]) {
        await check(`実データ data/ ${route} ${w}px`, async () => {
          const c7 = await newCtx({ viewport: { width: w, height: h } });
          const { page: p } = await open(c7, `${show}#${route}`, {});
          assert(await p.isHidden('#sample-banner'), 'sample banner shown with real data');
          if (route === 'plan') await p.click('[data-key="fill-main"]');
          const t0 = Date.now();
          await p.evaluate(() => window.__show.render());
          const renderMs = Date.now() - t0;
          const s = await sw(p);
          assert(s <= w, `scrollWidth ${s}`);
          await p.screenshot({ path: path.join(SHOTS, `real-${route}-${w}.png`) });
          const info = await p.evaluate(() => `投稿 ${window.__show.weekPostIds.length}・話題 ${window.__show.topics.length}・ブクマ ${window.__show.bookmarks ? window.__show.bookmarks.length : 'なし'}`);
          await c7.close();
          return `${info}・再描画 ${renderMs}ms`;
        });
      }
    }

    await check('コンソールエラー 0（想定内の 404/遮断ログを除く）', async () => {
      assert(errors.length === 0, errors.slice(0, 5).join(' / '));
    });
  } finally {
    if (browser) await browser.close();
    server.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\nshots: ${SHOTS}`);
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
