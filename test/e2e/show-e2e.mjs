// 配信番組サイト（/show/）の E2E。
//
// 実行方法（依存ゼロ方針のため playwright はリポジトリに入れない。dashboard-e2e.mjs と同じ）:
//   PW_DIR=/path/to/qa/node_modules node test/e2e/show-e2e.mjs
//   スクリーンショットの出力先は SHOTS_DIR（既定: OS の一時ディレクトリ/x-trend-show-shots）
//   OBS_REF_IMAGE=参考の配信画面（png/jpg/webp）を渡すと、オーバーレイを重ねた合成スクショも撮る
//   OBS WebSocket は page.routeWebSocket で偽の OBS に置き換える（本物の OBS には接続しない）
//
// リポジトリ直下を `python3 -m http.server`（空きポート）で配信し、終了時に停止する。
// data/ は page.route で差し替える（リポジトリの data/ は読むだけ・変更しない）。
// 外部通信（Google Fonts・X 埋め込み・画像）はすべて page.route でモック／遮断する。

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'x-trend-show-shots');
// 参考の配信画面の画像（任意）。あればオーバーレイ全部入りを重ねた合成スクショも撮る
const REF_IMAGE = process.env.OBS_REF_IMAGE || '';
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
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return; // 開発用: 名前に ONLY を含むものだけ（前のチェックに依存するものは単独では動かない）
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
 * data: { posts, reports, bookmarks, topics（data/show/topics.json） } … 値が null なら 404、文字列ならそのまま（不正 JSON 用）、
 *       undefined（キーなし）なら 404。data 自体が undefined なら実ファイル（リポジトリの data/）
 */
async function setupRoutes(page, { data } = {}) {
  const external = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') {
      if (data !== undefined && url.pathname.startsWith('/data/')) {
        const key = { '/data/posts.json': 'posts', '/data/reports.json': 'reports', '/data/bookmarks.json': 'bookmarks', '/data/show/topics.json': 'topics' }[url.pathname];
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
const ready = (page) => page.waitForFunction(() => (window.__show && window.__show.ready) || !document.getElementById('error').hidden, null, { timeout: 15000 });
const sw = (page) => page.evaluate(() => document.documentElement.scrollWidth);
const live = (page) => page.evaluate(() => window.__show.weekState().live);
const wk = (page) => page.evaluate(() => { const w = window.__show.weekState(); return { main: w.rundown.corners.find((c) => c.key === 'main').items, category: w.rundown.corners.find((c) => c.key === 'category').items, chat: w.rundown.corners.find((c) => c.key === 'chat').items, cand: w.mainCand }; });
const curCue = (page) => page.evaluate(() => { const a = window.__show; const c = a.cues[a.weekState().live.index]; return c ? c.id : 'end'; });
const oaCue = (page) => page.$eval('#oa-stage', (e) => e.dataset.cue);
async function waitOnair(page, cue) {
  await page.waitForFunction((c) => { const s = document.getElementById('oa-stage'); return s && s.dataset.cue === c; }, cue, { timeout: 5000 });
}
/** 検索（入力して結果が出るまで待つ） */
async function search(page, q) {
  await page.fill('[data-key="search"]', q);
  await page.waitForFunction((x) => window.__show.ui.rowsQuery === x, q);
}
/** フォルダを開く（左の木） */
async function folder(page, key) {
  await page.click(`[data-key="folder-${key}"]`);
  await page.waitForFunction((k) => window.__show.ui.folder === k && !window.__show.ui.query, key);
}
/** 一覧の行（表示中の行の要素） */
const rowSel = (key) => `.row-item[data-row-key="${key}"]`;
const rowKeys = (page) => page.evaluate(() => (window.__show.ui.rows || []).map((r) => r.key));
/** 右クリックメニューから */
async function ctx(page, sel, item) {
  await page.click(sel, { button: 'right' });
  await page.waitForSelector('.ctx-menu');
  await page.click(`.ctx-menu [data-key="${item}"]`);
}
/** マウスで実際にドラッグ（行 → ドロップ先） */
async function drag(page, fromSel, toSel) {
  const a = await page.locator(fromSel).first().boundingBox();
  const b = await page.locator(toSel).first().boundingBox();
  await page.mouse.move(a.x + Math.min(240, a.width / 2), a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + Math.min(240, a.width / 2) + 12, a.y + a.height / 2 + 8, { steps: 3 });
  await page.mouse.move(b.x + Math.min(80, b.width / 2), b.y + b.height / 2, { steps: 10 });
  const ghost = await page.$eval('.drag-ghost', (e) => e.textContent).catch(() => null);
  const over = await page.$eval('.is-drop-over', (e) => e.dataset.drop).catch(() => null);
  await page.mouse.up();
  await page.waitForTimeout(120);
  return { ghost, over };
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
    const sampleBm = JSON.parse(readFileSync(path.join(ROOT, 'sample/show/bookmarks.json'), 'utf8'));
    const SAMPLE_404 = { posts: null, reports: null, bookmarks: null };

    const newCtx = (opts = {}) => browser.newContext({ viewport: { width: 960, height: 1040 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', acceptDownloads: true, ...opts });
    const open = async (c, url, routeOpts = { data: SAMPLE_404 }) => {
      const page = await c.newPage();
      const external = await setupRoutes(page, routeOpts);
      watchConsole(page, errors);
      await page.goto(url);
      await ready(page);
      return { page, external };
    };

    // ---- 1. サンプル表示・フォルダの木
    await check('サンプル表示（data/ が無い）＋帯・フォルダの木（番組構成・まとまり・受信箱・★ブクマ・NEW・片付け・ゴミ箱）', async () => {
      const c = await newCtx();
      const { page, external } = await open(c, show);
      assert(await page.isVisible('#sample-banner'), 'banner');
      assert((await page.getAttribute('.page-tabs a[aria-current="page"]', 'href')) === './', 'show tab current');
      for (const k of ['slot:0', 'slot:1', 'slot:2', 'cand', 'corner:category', 'corner:chat', 'group:night', 'group:general', 'inbox', 'bookmarks', 'new', 'shelf', 'trash']) {
        assert(await page.$(`[data-key="folder-${k}"]`), `folder ${k}`);
      }
      assert((await page.textContent('.lp-title')).startsWith('受信箱'), 'default folder inbox');
      assert(await page.$('[data-key="folder-topic:d:d-hostcall"]'), '夜職の下にまとまり（ホストコール）');
      const bm = await page.$eval('[data-key="folder-bookmarks"] .tree-count', (e) => e.textContent);
      assert(bm === '3', `ブクマ ${bm}（今週 4 件のうち posts.json にあるもの）`);
      await folder(page, 'bookmarks');
      assert((await rowKeys(page)).length === 3, 'ブクマ（今週）');
      await page.click('[data-key="bm-toggle"]');
      const all = (await rowKeys(page)).length;
      assert(all === 5, `ブクマ（すべて）${all}`);
      const ext = external.filter((u) => !u.startsWith('https://platform.twitter.com/widgets.js'));
      assert(ext.length === 0, `外部通信: ${ext.join(', ')}`);
      await c.close();
      return `ブクマ ${bm}件`;
    });

    await check('ページ切替タブ: ダッシュボード ⇄ 番組', async () => {
      const c = await newCtx();
      const page = await c.newPage();
      await setupRoutes(page, {});
      watchConsole(page, errors);
      await page.goto(base);
      await page.waitForFunction(() => window.__dashboard && window.__dashboard.ready, null, { timeout: 15000 });
      await page.click('.site-header .page-tabs a[href="show/"]');
      await ready(page);
      assert(new URL(page.url()).pathname === '/show/', page.url());
      await page.click('.page-tabs a[href="../"]');
      await page.waitForFunction(() => window.__dashboard && window.__dashboard.ready, null, { timeout: 15000 });
      assert(new URL(page.url()).pathname === '/', page.url());
      await c.close();
    });

    // ---- 2. 編成（フォルダ型）。1 つのページで続けて操作する
    const cx = await newCtx();
    const { page } = await open(cx, `${show}#plan`);
    let mainId = null;
    await check('ドラッグ＆ドロップ（マウス）: 投稿→メイン候補・まとまり→メイン1・投稿→まとまり・Esc でキャンセル', async () => {
      // 受信箱の夜職の投稿 → メイン候補
      const first = (await rowKeys(page))[0];
      const r1 = await drag(page, rowSel(first), '.tree-node[data-drop="cand"]');
      assert(r1.ghost && r1.ghost.includes('1件'), `ghost ${r1.ghost}`);
      assert(r1.over === 'cand', `over ${r1.over}`);
      let w = await wk(page);
      assert(w.cand.length === 1 && w.cand[0] === `p:${first.slice(2)}`, JSON.stringify(w.cand));
      assert((await page.textContent('#toast')).includes('メイン候補'), 'toast');
      // まとまり（ホストコール）→ メイン1
      await folder(page, 'group:night');
      await drag(page, rowSel('t:d:d-hostcall'), '.tree-node[data-drop="slot:0"]');
      w = await wk(page);
      assert(w.main[0] === 'd:d-hostcall', JSON.stringify(w.main));
      mainId = 'd:d-hostcall';
      assert((await page.inputValue('[data-key="title"]')).includes('ホストコール'), '自動タイトル');
      assert((await page.textContent('[data-key="folder-slot:0"]')).includes('ホストコール'), 'メイン1 にまとまり名');
      // 投稿 → まとまり（受信箱の投稿をトー横へ）
      await folder(page, 'inbox');
      const p2 = (await rowKeys(page))[1];
      await drag(page, rowSel(p2), '.tree-node[data-drop="topic:d:d-toyoko"]');
      const moved = await page.evaluate((id) => window.__show.weekState().overrides.moves[id], p2.slice(2));
      assert(moved === 'd:d-toyoko', `moves ${moved}`);
      assert(!(await rowKeys(page)).includes(p2), '受信箱から消える');
      // Esc でキャンセル
      const p3 = (await rowKeys(page))[0];
      const a = await page.locator(rowSel(p3)).boundingBox();
      const b = await page.locator('.tree-node[data-drop="corner:chat"]').boundingBox();
      await page.mouse.move(a.x + 200, a.y + 20);
      await page.mouse.down();
      await page.mouse.move(a.x + 220, a.y + 30, { steps: 3 });
      await page.mouse.move(b.x + 40, b.y + 10, { steps: 5 });
      await page.keyboard.press('Escape');
      await page.mouse.up();
      assert(!(await page.$('.drag-ghost')), 'ghost removed');
      w = await wk(page);
      assert(w.chat.length === 0, 'cancelled');
      await page.screenshot({ path: path.join(SHOTS, 'plan-960-dnd.png') });
    });

    await check('元に戻す / やり直す（Ctrl+Z・Ctrl+Shift+Z・Ctrl+Y・ボタン）', async () => {
      const before = await wk(page);
      await page.focus('.vlist');
      await page.keyboard.press('Control+z'); // 投稿→まとまり を戻す
      await page.keyboard.press('Control+z'); // まとまり→メイン1 を戻す
      let w = await wk(page);
      assert(!w.main.includes('d:d-hostcall'), `undo main ${JSON.stringify(w.main)}`);
      await page.keyboard.press('Control+Shift+z');
      w = await wk(page);
      assert(w.main[0] === 'd:d-hostcall', 'redo main');
      await page.keyboard.press('Control+y');
      await page.click('[data-key="undo"]');
      await page.click('[data-key="redo"]');
      w = await wk(page);
      assert(JSON.stringify(w) === JSON.stringify(before), `${JSON.stringify(w)} vs ${JSON.stringify(before)}`);
    });

    await check('複数選択（Ctrl・Shift・チェック・Ctrl+A）→ 一括操作バーで「移動先…」（キーボードで選ぶ）', async () => {
      await folder(page, 'inbox');
      const keys = await rowKeys(page);
      await page.click(`${rowSel(keys[0])} .row-check`);
      await page.click(`${rowSel(keys[2])} .row-main`, { modifiers: ['Control'] });
      let n = await page.evaluate(() => window.__show.ui.sel.sel.size);
      assert(n === 2, `ctrl ${n}`);
      await page.click(`${rowSel(keys[4])} .row-main`, { modifiers: ['Shift'] });
      n = await page.evaluate(() => window.__show.ui.sel.sel.size);
      assert(n >= 3, `shift ${n}`);
      await page.click(`${rowSel(keys[5])} .row-check`);
      assert((await page.textContent('[data-key="bulk-count"]')).includes('件選択中'), 'bulk bar');
      await page.focus('.vlist');
      await page.keyboard.press('Control+a');
      n = await page.evaluate(() => window.__show.ui.sel.sel.size);
      assert(n === keys.length, `ctrl+a ${n}/${keys.length}`);
      // 3 件だけにして一括移動 → カテゴリ別（キーボード）。960px では普通のクリックはプレビューへ切り替わる
      await page.click(`${rowSel(keys[0])} .row-main`);
      assert(await page.isHidden('.list-pane'), '960: クリックでプレビューへ');
      await page.click('[data-key="preview-back"]');
      await page.click(`${rowSel(keys[1])} .row-check`);
      await page.click(`${rowSel(keys[2])} .row-check`);
      await page.click('[data-key="bulk-move"]');
      await page.waitForSelector('dialog.move-dialog[open]');
      await page.fill('[data-key="move-filter"]', 'カテゴリ');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => !document.querySelector('dialog.move-dialog[open]'));
      const w = await wk(page);
      assert(w.category.length === 3, JSON.stringify(w.category));
      assert(!(await rowKeys(page)).includes(keys[0]), '受信箱から消える');
      await page.screenshot({ path: path.join(SHOTS, 'plan-960-category.png') });
      // 番組構成の中の並べ替え（ドラッグ）
      await folder(page, 'corner:category');
      const ck = await rowKeys(page);
      const r = await drag(page, rowSel(ck[2]), rowSel(ck[0]));
      assert(r.over === 'corner:category#0', `over ${r.over}`);
      const w2 = await wk(page);
      assert(w2.category[0] === ck[2].slice(2), `reorder ${JSON.stringify(w2.category)}`);
    });

    await check('検索（本文・@アカウント・話題名・AND）→ 結果からドラッグ', async () => {
      await search(page, 'ラーメン 深夜');
      const keys = await rowKeys(page);
      const texts = await page.evaluate((ks) => ks.map((k) => window.__show.postsById.get(k.slice(2)).text), keys);
      assert(texts.every((t) => t.includes('ラーメン') && t.includes('深夜')), texts.join('/'));
      assert((await page.textContent('.lp-title')).startsWith('検索結果'), 'title');
      await search(page, '@sample_night_sakura77');
      assert((await rowKeys(page)).length === 4, '@アカウント');
      await search(page, 'ホストコール');
      assert((await rowKeys(page)).length >= 8, `まとまり名でも見つかる ${(await rowKeys(page)).length}`);
      // 結果をそのままドラッグ（雑談へ。まとまりの投稿ならまとまりごと入る）
      await search(page, '新作ゲーム');
      const k = (await rowKeys(page))[0];
      await drag(page, rowSel(k), '.tree-node[data-drop="corner:chat"]');
      const w = await wk(page);
      assert(w.chat.length === 1, JSON.stringify(w.chat));
      await search(page, '');
    });

    await check('新規まとまり（空のフォルダ）→ ドラッグで投稿を入れる → 名前変更（F2・ダブルクリック）・「まとまりにする」', async () => {
      await folder(page, 'inbox');
      await page.click('[data-key="new-group"]');
      await page.waitForSelector('dialog.name-dialog[open]');
      await page.fill('[data-key="name-input"]', '自作のフォルダ');
      await page.selectOption('[data-key="name-genre"]', 'kabuki');
      await page.click('[data-key="name-ok"]');
      await page.waitForFunction(() => window.__show.ui.folder.startsWith('topic:m:'));
      const tid = await page.evaluate(() => window.__show.ui.folder.slice(6));
      assert((await page.textContent('.lp-title')).includes('自作のフォルダ'), 'opened');
      await folder(page, 'inbox');
      const k = (await rowKeys(page))[0];
      await drag(page, rowSel(k), `.tree-node[data-drop="topic:${tid}"]`);
      const t = await page.evaluate((id) => { const x = window.__show.topicsById.get(id); return { n: x.postIds.length, genre: x.genre }; }, tid);
      assert(t.n === 1 && t.genre === 'kabuki', JSON.stringify(t));
      // F2 で名前変更（まとまりのフォルダを開いている状態）
      await folder(page, `topic:${tid}`);
      await page.focus('.vlist');
      await page.keyboard.press('F2');
      await page.waitForSelector('dialog.name-dialog[open]');
      await page.fill('[data-key="name-input"]', 'F2で変えた名前');
      await page.keyboard.press('Enter');
      await page.waitForFunction((id) => window.__show.topicsById.get(id).name === 'F2で変えた名前', tid);
      // ダブルクリックで名前変更（左の木）
      await page.dblclick(`[data-key="folder-topic:${tid}"]`);
      await page.waitForSelector('dialog.name-dialog[open]');
      await page.fill('[data-key="name-input"]', 'ダブルクリックの名前');
      await page.click('[data-key="name-ok"]');
      await page.waitForFunction((id) => window.__show.topicsById.get(id).name === 'ダブルクリックの名前', tid);
      // 選んだ 2 件を「まとまりにする」
      await folder(page, 'inbox');
      const ks = await rowKeys(page);
      await page.click(`${rowSel(ks[0])} .row-check`);
      await page.click(`${rowSel(ks[1])} .row-check`);
      await page.click('[data-key="bulk-group"]');
      await page.waitForSelector('dialog.name-dialog[open]');
      await page.fill('[data-key="name-input"]', '二件のまとまり');
      await page.click('[data-key="name-ok"]');
      await page.waitForFunction(() => window.__show.ui.folder.startsWith('topic:m:') && window.__show.ui.rows.length === 2);
    });

    await check('ジャンル変更（右クリック・一括・プレビュー）→ 投稿 ID で保存・リロード後も・書き出しに含まれる', async () => {
      await folder(page, 'inbox');
      const ks = await rowKeys(page);
      const k = ks.find((x) => x.startsWith('p:'));
      const id = k.slice(2);
      await ctx(page, `${rowSel(k)} .row-main`, 'ctx-genre-general');
      let g = await page.evaluate((i) => window.__show.saved.genreOverrides[i], id);
      assert(g && g.genre === 'general', JSON.stringify(g));
      // 一般のバズになったので、受信箱の夜職の並びから外れる（おすすめ外なら隠れる）
      await page.reload();
      await ready(page);
      g = await page.evaluate((i) => window.__show.saved.genreOverrides[i], id);
      assert(g && g.genre === 'general', 'kept after reload');
      // プレビューから元に戻す（キャバクラ等の元ジャンルへ）
      await page.fill('[data-key="search"]', '');
      await page.evaluate((i) => { window.__show.ui.query = window.__show.postsById.get(i).text.slice(0, 8); window.__show.render(); }, id);
      await page.waitForFunction((i) => window.__show.ui.rows.some((r) => r.id === i), id);
      await page.click(`${rowSel(k)} .row-main`);
      await page.waitForSelector('[data-key="pv-genre"]');
      const orig = await page.evaluate((i) => window.__show.origGenreOf(i), id);
      await page.selectOption('[data-key="pv-genre"]', orig);
      await page.waitForFunction((i) => !window.__show.saved.genreOverrides[i], id);
      // 一括でジャンル変更 → 書き出しに含まれる
      await page.evaluate(() => { window.__show.ui.query = ''; window.__show.ui.pane = 'list'; window.__show.render(); });
      await folder(page, 'inbox');
      const ks2 = await rowKeys(page);
      await page.click(`${rowSel(ks2[0])} .row-check`);
      await page.click(`${rowSel(ks2[1])} .row-check`);
      await page.click('[data-key="bulk-genre"]');
      await page.click('[data-key="bulk-genre-general"]');
      const n = await page.evaluate((ids) => ids.filter((i) => (window.__show.saved.genreOverrides[i] || {}).genre === 'general').length, [ks2[0].slice(2), ks2[1].slice(2)]);
      assert(n === 2, `general overrides ${n}`);
      await page.click('[data-key="tools-open"]');
      await page.waitForSelector('dialog.tools-dialog[open]');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-key="export"]')]);
      const file = path.join(tmp, 'export.json');
      await dl.saveAs(file);
      const ex = JSON.parse(readFileSync(file, 'utf8'));
      assert(ex.v === 4 && Object.keys(ex.genreOverrides).length >= 1, 'export has genreOverrides');
      await page.click('[data-key="tools-close"]');
      return `上書き ${Object.keys(ex.genreOverrides).length}件`;
    });

    await check('仕分けモード: 1/2/3/G/X/→/← と進捗、元に戻せる、Esc で終了', async () => {
      await folder(page, 'inbox');
      const total = (await rowKeys(page)).length;
      await page.click('[data-key="sort-start"]');
      await page.waitForSelector('dialog.sort-dialog[open]');
      let prog = await page.textContent('[data-key="sort-progress"]');
      assert(prog.includes(`1 / ${total}件`) && prog.includes(`残り ${total}件`), prog);
      await page.screenshot({ path: path.join(SHOTS, 'plan-960-sort.png') });
      const items = await page.evaluate(() => window.__show.ui.sort.items.map((i) => i.key));
      const chat0 = (await wk(page)).chat.length;
      await page.keyboard.press('2');
      let w = await wk(page);
      assert(w.category.includes(`p:${items[0].slice(2)}`) || w.category.length >= 4, 'key 2 → カテゴリ別');
      await page.keyboard.press('ArrowRight'); // 保留
      await page.keyboard.press('ArrowLeft');
      prog = await page.textContent('[data-key="sort-progress"]');
      assert(prog.includes(`2 / ${total}件`), prog);
      await page.keyboard.press('g'); // ジャンル（夜職⇄一般）
      const g = await page.evaluate((k) => window.__show.saved.genreOverrides[k.slice(2)], items[1]);
      assert(g && g.genre === 'general', `G ${JSON.stringify(g)}`);
      await page.keyboard.press('3'); // 雑談
      w = await wk(page);
      assert(w.chat.length === chat0 + 1, `key 3 ${JSON.stringify(w.chat)}`);
      await page.keyboard.press('x'); // いらない
      const shelved = await page.evaluate(() => window.__show.weekState().shelved.length);
      assert(shelved >= 1, 'X → 片付け');
      // 元に戻す（Ctrl+Z）は仕分けモード中も効く
      await page.keyboard.press('Control+z');
      assert((await page.evaluate(() => window.__show.weekState().shelved.length)) === shelved - 1, 'undo in sort');
      prog = await page.textContent('[data-key="sort-progress"]');
      assert(/残り \d+件/.test(prog), prog);
      // 1 = メイン候補（夜職のみ）
      await page.keyboard.press('1');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('dialog.sort-dialog[open]'));
      return prog;
    });

    await check('片付け・ゴミ箱（右クリック・Delete）→ お知らせの「元に戻す」・ゴミ箱から戻す', async () => {
      await folder(page, 'group:night');
      const ks = await rowKeys(page);
      const t = ks.find((k) => k !== `t:${mainId}`);
      await ctx(page, `${rowSel(t)} .row-main`, 'ctx-shelf');
      assert(!(await rowKeys(page)).includes(t), 'shelved');
      await page.click('[data-key="toast-undo"]');
      await page.waitForFunction((k) => window.__show.ui.rows.some((r) => r.key === k), t);
      await page.click(`${rowSel(t)} .row-main`);
      await page.focus('.vlist');
      await page.evaluate(() => { window.__show.ui.pane = 'list'; window.__show.render(); });
      await page.focus('.vlist');
      await page.keyboard.press('Delete');
      assert((await page.evaluate(() => window.__show.saved.trash.length)) === 1, 'trashed');
      await folder(page, 'trash');
      const tr = (await rowKeys(page))[0];
      assert(tr.startsWith('tr:'), tr);
      await ctx(page, `${rowSel(tr)} .row-main`, 'ctx-restore');
      assert((await page.evaluate(() => window.__show.saved.trash.length)) === 0, 'restored');
    });

    // 進行の準備: メイン2・メイン3・雑談
    await check('進行: 縦 1 列（進行バー・話題名・タイマー・下にボタン）・キー操作・映す用が追従・イベント発行', async () => {
      await folder(page, 'group:night');
      const ks = (await rowKeys(page)).filter((k) => k !== `t:${mainId}`);
      await ctx(page, `${rowSel(ks[0])} .row-main`, 'ctx-slot-1');
      await ctx(page, `${rowSel(ks[1])} .row-main`, 'ctx-slot-2');
      const w = await wk(page);
      assert(w.main.filter(Boolean).length === 3, JSON.stringify(w.main));
      const oa = await cx.newPage();
      await oa.setViewportSize({ width: 1920, height: 1080 });
      await setupRoutes(oa, { data: SAMPLE_404 });
      watchConsole(oa, errors);
      await oa.goto(`${show}#onair`);
      await ready(oa);
      await page.goto(`${show}#live`);
      await ready(page);
      await page.evaluate(() => { window.__evts = []; window.addEventListener('xtrend-show', (e) => window.__evts.push(e.detail)); });
      assert(await page.$('.lv-progress .lvp-seg'), 'progress bar');
      await page.click('[data-key="live-start"]');
      const c0 = await curCue(page);
      await waitOnair(oa, c0);
      assert((await page.textContent('[data-key="live-title"]')).length > 0, 'title');
      await page.screenshot({ path: path.join(SHOTS, 'live-960.png') });
      await page.keyboard.press('ArrowRight'); // 読んだ
      await page.keyboard.press('s');
      await page.keyboard.press('l');
      const st = await live(page);
      assert(Object.keys(st.status).length === 3, JSON.stringify(st.status));
      await page.keyboard.press('ArrowLeft'); // 来週へを取り消し
      await waitOnair(oa, await curCue(page));
      await page.keyboard.press('l'); // もう一度来週へ
      // 投稿カードの表示/非表示
      await page.click('[data-key="live-card"]');
      assert((await live(page)).cardVisible === false, 'card hidden');
      await oa.waitForSelector('.oa-split.is-nocard', { timeout: 5000 });
      const evts = await page.evaluate(() => window.__evts);
      assert(evts.length >= 4 && evts.some((e) => e.changed.includes('card') && e.state.cardVisible === false) && evts.some((e) => e.changed.includes('topic')), JSON.stringify(evts.map((e) => e.changed)));
      await page.click('[data-key="live-card"]');
      await oa.screenshot({ path: path.join(SHOTS, 'onair-1920.png') });
      await oa.close();
      return `イベント ${evts.length}件`;
    });

    await check('リロードで状態復元（フォルダ・メイン・進行）', async () => {
      const before = await live(page);
      const w0 = await wk(page);
      await page.reload();
      await ready(page);
      const after = await live(page);
      assert(after.index === before.index && JSON.stringify(after.status) === JSON.stringify(before.status), 'live');
      assert(JSON.stringify(await wk(page)) === JSON.stringify(w0), 'rundown');
    });

    await check('来週に回した話題が翌週の「まとまり」に出る', async () => {
      const carried = await page.evaluate(() => window.__show.weekState().carriedOut.map((c) => c.topicId));
      assert(carried.length >= 1, 'carried');
      await page.goto(`${show}#plan`);
      await ready(page);
      const next = await page.evaluate(() => window.__show.nextWeekKey());
      await page.selectOption('#week-select', next);
      await page.waitForFunction((k) => window.__show.weekKey === k, next);
      await folder(page, 'group:night');
      const ks = await rowKeys(page);
      assert(ks.includes(`t:k:${carried[0]}`), ks.join());
      const cur = await page.evaluate(() => window.__show.weeks.find((w) => w.key < window.__show.weekKey).key);
      await page.selectOption('#week-select', cur);
      await page.waitForFunction((k) => window.__show.weekKey === k, cur);
    });

    await check('振り返り: 一覧とテキスト書き出し（3 コーナー）', async () => {
      await page.goto(`${show}#review`);
      await ready(page);
      const pub = await page.inputValue('[data-key="export-public"]');
      assert(pub.includes('00:00 メイン3トピック') && pub.includes('ホストコール'), pub.slice(0, 200));
      await page.goto(`${show}#plan`);
      await ready(page);
    });

    await check('書き出し → 読み込み（壊れたファイルは拒否・置き換えも元に戻せる）', async () => {
      await page.click('[data-key="tools-open"]');
      await page.waitForSelector('dialog.tools-dialog[open]');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-key="export"]')]);
      const file = path.join(tmp, 'export2.json');
      await dl.saveAs(file);
      const bad = path.join(tmp, 'bad.json');
      writeFileSync(bad, '{ broken');
      await page.setInputFiles('#import-file', bad);
      await page.waitForSelector('.import-msg.is-error');
      // 変更してから読み込みで戻す
      await page.click('[data-key="tools-close"]');
      const w0 = await wk(page);
      await ctx(page, '[data-key="folder-slot:0"]', 'ctx-shelf');
      assert(JSON.stringify(await wk(page)) !== JSON.stringify(w0), 'changed');
      await page.click('[data-key="tools-open"]');
      await page.setInputFiles('#import-file', file);
      await page.waitForSelector('[data-key="import-yes"]');
      await page.click('[data-key="import-yes"]');
      await page.waitForFunction((x) => JSON.stringify((() => { const w = window.__show.weekState(); return { main: w.rundown.corners.find((c) => c.key === 'main').items, category: w.rundown.corners.find((c) => c.key === 'category').items, chat: w.rundown.corners.find((c) => c.key === 'chat').items, cand: w.mainCand }; })()) === x, JSON.stringify(w0));
      await page.click('[data-key="tools-close"]');
    });

    await check('画面幅: 960×1040（一覧⇄プレビュー）・1280×1400 と 1920×1080（3 列）・375（引き出し）で横スクロールなし', async () => {
      await folder(page, 'inbox');
      const k = (await rowKeys(page))[0];
      await page.click(`${rowSel(k)} .row-main`);
      await page.waitForSelector('.preview-pane .pv-body');
      assert(await page.isHidden('.list-pane'), '960: 一覧は隠れてプレビュー');
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SHOTS, 'plan-960-preview.png') });
      await page.click('[data-key="preview-back"]');
      assert(await page.isVisible('.list-pane'), '一覧へ戻る');
      await page.screenshot({ path: path.join(SHOTS, 'plan-960.png') });
      for (const [w, hh] of [[1280, 1400], [1920, 1080]]) {
        await page.setViewportSize({ width: w, height: hh });
        await page.evaluate(() => { window.__show.ui.pane = 'list'; window.__show.render(); });
        await page.click(`${rowSel(k)} .row-main`);
        await page.waitForTimeout(300);
        if (w >= 1400) assert(await page.isVisible('.list-pane') && await page.isVisible('.preview-pane'), `${w}: 3 列`);
        else assert(await page.isHidden('.list-pane') && await page.isVisible('.preview-pane'), `${w}: 一覧⇄プレビュー`);
        const s = await sw(page);
        assert(s <= w, `${w} scrollWidth ${s}`);
        await page.screenshot({ path: path.join(SHOTS, `plan-${w}.png`) });
      }
      await page.setViewportSize({ width: 375, height: 812 });
      await page.evaluate(() => { window.__show.ui.pane = 'list'; window.__show.render(); });
      let s = await sw(page);
      assert(s <= 375, `375 scrollWidth ${s}`);
      await page.screenshot({ path: path.join(SHOTS, 'plan-375.png') });
      await page.click('[data-key="tree-drawer"]');
      await page.waitForSelector('.plan2.is-drawer .tree-pane');
      await page.screenshot({ path: path.join(SHOTS, 'plan-375-drawer.png') });
      await folder(page, 'group:night');
      assert(!(await page.$('.plan2.is-drawer')), 'drawer closes');
      await page.goto(`${show}#live`);
      await ready(page);
      s = await sw(page);
      assert(s <= 375, `live 375 scrollWidth ${s}`);
      await page.screenshot({ path: path.join(SHOTS, 'live-375.png') });
      await page.setViewportSize({ width: 960, height: 1040 });
    });
    await cx.close();

    // ---- 3. BroadcastChannel が無い環境（storage イベントで追従）
    await check('BroadcastChannel なしでも storage イベントで追従', async () => {
      const c2 = await newCtx();
      await c2.addInitScript(() => { delete window.BroadcastChannel; });
      const { page: p1 } = await open(c2, `${show}#plan`);
      await folder(p1, 'group:night');
      await ctx(p1, `${rowSel('t:d:d-hostcall')} .row-main`, 'ctx-slot-0');
      const { page: p2 } = await open(c2, `${show}#onair`);
      await p1.goto(`${show}#live`);
      await ready(p1);
      await p1.click('[data-key="live-start"]');
      await p1.keyboard.press('ArrowRight');
      await waitOnair(p2, await curCue(p1));
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
    await check('XSS: 本文・まとまり名・アカウント名のタグは文字のまま（編成・進行・映す用）', async () => {
      const c3 = await newCtx();
      const { page: p } = await open(c3, `${show}#plan`, { data: { posts: xssPosts, bookmarks: { bookmarks: 'bad' } } });
      assert(!(await p.$('[data-key="folder-bookmarks"]')), '壊れた bookmarks.json はフォルダを出さない');
      await folder(p, 'group:night');
      const name = await p.textContent('.row-title.is-topic');
      assert(name.includes('<img src=x onerror='), name);
      await ctx(p, '.row-item .row-main', 'ctx-slot-0');
      await search(p, 'script');
      assert((await rowKeys(p)).length === 1, 'search 1');
      assert((await p.textContent('.row-item .row-title')).includes('<script>'), 'row text');
      await p.click('.row-item .row-main');
      await p.waitForSelector('.pv-body');
      const { page: oa } = await open(c3, `${show}#onair`, { data: { posts: xssPosts } });
      await p.goto(`${show}#live`);
      await ready(p);
      await p.click('[data-key="live-start"]');
      await oa.waitForSelector('.oa-headline');
      assert((await p.textContent('.live-main')).includes('<img src=x'), 'live text');
      assert(!(await p.$('img[src="x"]')) && !(await oa.$('img[src="x"]')), 'no injected img');
      const xss = (await p.evaluate(() => window.__xss)) ?? (await oa.evaluate(() => window.__xss));
      assert(xss === undefined, `xss ${xss}`);
      const hrefs = await p.$$eval('a[href]', (l) => l.map((a) => a.getAttribute('href')));
      assert(!hrefs.some((h) => /^javascript:/i.test(h)), 'javascript: link');
      await c3.close();
    });

    await check('空データ（posts が 0 件）・bookmarks なし: 各画面が動く', async () => {
      const c4 = await newCtx();
      const { page: p } = await open(c4, `${show}#plan`, { data: { posts: { generated_at: '2026-10-16T00:09:00+09:00', posts: [] } } });
      assert((await p.textContent('.list-pane')).includes('該当なし'), 'empty');
      assert(!(await p.$('[data-key="folder-bookmarks"]')), 'no bookmark folder');
      await p.click('[data-key="sort-start"]');
      assert((await p.textContent('#toast')).includes('ありません'), 'sort with nothing');
      for (const r of ['live', 'review', 'onair']) { await p.goto(`${show}#${r}`); await ready(p); }
      await p.goto(`${show}#live`);
      await ready(p);
      await p.click('[data-key="live-start"]');
      for (let i = 0; i < 6; i++) await p.keyboard.press('Enter');
      assert((await p.textContent('.live-main')).includes('終わりました'), 'finished');
      await c4.close();
    });

    await check('壊れた保存値（localStorage）でも起動し、注意を出す', async () => {
      const c5 = await newCtx();
      await c5.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('xtrend-show', '{"broken'); sessionStorage.setItem('seeded', '1'); } } catch { /* */ } });
      const { page: p } = await open(c5, `${show}#plan`);
      const st = await p.textContent('#save-status');
      assert(st.includes('保存データを読めなかった'), st);
      assert(await p.$('.row-item'), 'rows shown');
      await c5.close();
    });

    await check('保存データの移行（版 3 の編成がフォルダ型で読める）', async () => {
      const c9 = await newCtx();
      await c9.addInitScript(() => {
        try {
          if (sessionStorage.getItem('seeded')) return;
          localStorage.setItem('xtrend-show', JSON.stringify({ app: 'xtrend-show', v: 3, activeWeek: '2026-10-17', weeks: { '2026-10-17': { rundown: { corners: [{ key: 'main', min: 45, items: ['d:d-hostcall'] }, { key: 'category', min: 30, items: ['d:d-toyoko'] }, { key: 'chat', min: 15, items: [] }] } } } }));
          sessionStorage.setItem('seeded', '1');
        } catch { /* */ }
      });
      const { page: p } = await open(c9, `${show}#plan`);
      assert((await p.textContent('[data-key="folder-slot:0"]')).includes('ホストコール'), 'main1');
      assert((await p.textContent('[data-key="folder-corner:category"] .tree-count')) === '1', 'category');
      await c9.close();
    });

    await check('チェックポイント: 記録後に増えた投稿が NEW フォルダに出る', async () => {
      const c8 = await newCtx();
      const p = await c8.newPage();
      watchConsole(p, errors);
      let data = { posts: sample, bookmarks: sampleBm };
      await p.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname !== '127.0.0.1') return route.abort('blockedbyclient');
        const key = { '/data/posts.json': 'posts', '/data/bookmarks.json': 'bookmarks' }[url.pathname];
        if (key) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data[key]) });
        if (url.pathname.startsWith('/data/')) return route.fulfill({ status: 404, body: '' });
        return route.continue();
      });
      await p.goto(`${show}#plan`);
      await ready(p);
      assert((await p.textContent('[data-key="folder-new"] .tree-count')) === '0', 'no NEW');
      await p.click('[data-key="cp-menu"]');
      await p.click('[data-key="cp-preview"]');
      const extra = { ...sample.posts[0], id: '2110009999999999999', text: 'チェック後に増えた新しい投稿', user: 'sample_new', matched_terms: [], ts: sample.posts[0].ts - 60, url: '' };
      const extra2 = { ...sample.posts[0], id: '2110009999999999998', text: 'ラスソンの新しい動画が出た', user: 'sample_new2', matched_terms: [], ts: sample.posts[0].ts - 120, url: '' };
      data = { ...data, posts: { ...sample, generated_at: '2026-10-16T22:00:00+09:00', posts: [extra, extra2, ...sample.posts] } };
      await p.reload();
      await ready(p);
      assert((await p.textContent('[data-key="folder-new"] .tree-count')) === '2', 'NEW 2');
      await folder(p, 'new');
      assert((await rowKeys(p)).length === 2, 'rows');
      await c8.close();
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

    // ---- 4b. OBS 連動（段階2）。偽の OBS（routeWebSocket）で Hello/Identify/CallVendorRequest を往復し、
    //      受け取った emit_event を各パーツのページへ window の CustomEvent として配る（OBS のブラウザソースと同じ）
    await check('OBS 連動: パスワード違い→接続・CallVendorRequest(emit_event) でトピック帯/投稿カード/タイトル・後から開いたパーツ・テスト表示', async () => {
      const PASS = 'ob$-パス';
      const auth = { salt: 'c2FsdC12YWx1ZQ==', challenge: 'Y2hhbGxlbmdlLXZhbHVl' };
      const h64 = (x) => createHash('sha256').update(x).digest('base64');
      const expectAuth = h64(h64(PASS + auth.salt) + auth.challenge);
      const obs = { conns: 0, identify: [], requests: [], payloads: [], targets: [] };
      const c = await newCtx();
      const page = await c.newPage();
      await setupRoutes(page, { data: SAMPLE_404 });
      watchConsole(page, errors);
      let n = 0;
      await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:4455/, (ws) => {
        obs.conns++;
        ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.5.2', rpcVersion: 1, authentication: auth } }));
        ws.onMessage((raw) => {
          const m = JSON.parse(String(raw));
          if (m.op === 1) {
            obs.identify.push(m.d);
            if (m.d.authentication !== expectAuth) { ws.close({ code: 4009, reason: 'Authentication failed.' }); return; }
            ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
          } else if (m.op === 6) {
            obs.requests.push(m.d);
            ws.send(JSON.stringify({ op: 7, d: { requestType: m.d.requestType, requestId: m.d.requestId, requestStatus: { result: true, code: 100 } } }));
            const rd = m.d.requestData || {};
            if (m.d.requestType === 'CallVendorRequest' && rd.vendorName === 'obs-browser' && rd.requestType === 'emit_event') {
              const ev = rd.requestData;
              obs.payloads.push(ev.event_data);
              n++;
              const detail = n % 2 ? ev.event_data : JSON.stringify(ev.event_data); // オブジェクトと文字列の両方
              for (const t of obs.targets) t.evaluate(([name, d]) => window.dispatchEvent(new CustomEvent(name, { detail: d })), [ev.event_name, detail]).catch(() => {});
            }
          }
        });
      });
      await page.goto(`${show}#plan`);
      await ready(page);
      assert(await page.isHidden('#obs-pill'), '編成画面ではピルを出さない');
      // メイン 1・2 に話題を入れておく
      await folder(page, 'group:night');
      const ks = await rowKeys(page);
      await ctx(page, `${rowSel(ks[0])} .row-main`, 'ctx-slot-0');
      await ctx(page, `${rowSel(ks[1])} .row-main`, 'ctx-slot-1');
      await page.goto(`${show}#live`);
      await ready(page);
      assert((await page.textContent('#obs-pill')) === 'OBS：未接続', 'pill');
      // パスワード違い
      await page.click('#obs-pill');
      await page.waitForSelector('.obs-dialog[open]');
      assert((await page.textContent('.obs-warn')).includes('暗号化せずに保存'), '保存の注意');
      await page.fill('[data-key="obs-password"]', 'wrong');
      await page.click('[data-key="obs-connect"]');
      await page.waitForFunction(() => (document.querySelector('[data-key="obs-state"]') || {}).textContent?.includes('パスワードが違います'), null, { timeout: 5000 });
      assert((await page.getAttribute('#obs-pill', 'data-state')) === 'error', 'pill error');
      assert(await page.inputValue('[data-key="obs-password"]') === 'wrong', '入力は残る');
      await page.screenshot({ path: path.join(SHOTS, 'obs-dialog-error-960.png') });
      // 正しいパスワード
      await page.fill('[data-key="obs-password"]', PASS);
      await page.click('[data-key="obs-connect"]');
      await page.waitForFunction(() => document.getElementById('obs-pill').dataset.state === 'connected', null, { timeout: 5000 });
      const idf = obs.identify.at(-1);
      assert(idf.rpcVersion === 1 && idf.authentication === expectAuth, JSON.stringify(idf));
      assert((await page.textContent('[data-key="obs-state"]')).includes('5.5.2'), 'version');
      await page.screenshot({ path: path.join(SHOTS, 'obs-dialog-960.png') });
      const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('xtrend-show-obs')));
      assert(prefs.password === PASS && prefs.enabled === true && prefs.port === 4455, JSON.stringify(prefs));
      await page.click('[data-key="obs-close"]');
      await page.waitForFunction(() => !document.querySelector('.obs-dialog'));
      // パーツ（別のブラウザ＝BroadcastChannel は届かない。OBS 経由だけ）
      const oc = await newCtx();
      const openPart = async (q, w, hh) => {
        const p = await oc.newPage();
        await p.setViewportSize({ width: w, height: hh });
        await setupRoutes(p, { data: SAMPLE_404 });
        watchConsole(p, errors);
        await p.goto(`${show}overlay.html?${q}`);
        await p.waitForFunction(() => window.__overlay);
        obs.targets.push(p);
        return p;
      };
      const tb = await openPart('part=topicbar', 1300, 150);
      const cd = await openPart('part=card', 640, 760);
      const tt = await openPart('part=title', 1920, 1080);
      const curTopic = () => page.evaluate(() => { const a = window.__show; const cu = a.cues[a.weekState().live.index]; return cu && cu.kind === 'topic' ? a.topicsById.get(cu.topicId).name : null; });
      const tbName = (p) => p.evaluate(() => { const e = document.querySelector('.tb'); return e && !e.hidden ? document.querySelector('.tb-name').textContent : null; });
      assert((await tbName(tb)) === null, '開始前はトピック帯なし');
      await page.click('[data-key="live-start"]');
      const t0 = await curTopic();
      assert(t0, '最初は話題');
      await tb.waitForFunction((x) => document.querySelector('.tb-name')?.textContent === x && !document.querySelector('.tb').hidden, t0, { timeout: 5000 });
      // タイトル: 大きく出て数秒で消える
      const corner0 = await page.evaluate(() => document.querySelector('.lh-corner').textContent);
      await tt.waitForFunction(() => !document.querySelector('.tt').hidden, null, { timeout: 5000 });
      const ttText = await tt.textContent('.tt-name');
      assert(corner0.includes(ttText), `${ttText} / ${corner0}`);
      await tt.screenshot({ path: path.join(SHOTS, 'obs-live-title.png'), omitBackground: true });
      // 投稿カード: 表示 → 隠す → 出す
      await cd.waitForSelector('.cd[data-visible="true"]', { timeout: 5000 });
      assert((await cd.textContent('.cd-user')).startsWith('@'), 'user');
      await page.click('[data-key="live-card"]');
      await cd.waitForSelector('.cd[data-visible="false"]', { timeout: 5000 });
      await page.click('[data-key="live-card"]');
      await cd.waitForSelector('.cd[data-visible="true"]', { timeout: 5000 });
      await tt.waitForFunction(() => document.querySelector('.tt').hidden, null, { timeout: 7000 });
      // 次の話題へ → トピック帯が切り替わる
      await page.keyboard.press('ArrowRight');
      const t1 = await curTopic();
      assert(t1 && t1 !== t0, `${t0} → ${t1}`);
      await tb.waitForFunction((x) => document.querySelector('.tb-name')?.textContent === x, t1, { timeout: 5000 });
      // 後から開いたパーツは再送（5 秒おき）で追いつく
      const late = await openPart('part=topicbar&motion=off', 1300, 150);
      const tLate = Date.now();
      await late.waitForFunction((x) => document.querySelector('.tb-name')?.textContent === x && !document.querySelector('.tb').hidden, t1, { timeout: 8000 });
      const lateMs = Date.now() - tLate;
      // 送ったもの: CallVendorRequest / obs-browser / emit_event、seq は増えるだけ（再送は同じ seq）
      assert(obs.requests.every((r) => r.requestType === 'CallVendorRequest' && r.requestData.vendorName === 'obs-browser' && r.requestData.requestType === 'emit_event' && r.requestData.requestData.event_name === 'xtrend-show'), 'request shape');
      const seqs = obs.payloads.map((x) => x.seq);
      assert(seqs.every((x, i) => i === 0 || x >= seqs[i - 1]) && new Set(obs.payloads.map((x) => x.sid)).size === 1, JSON.stringify(seqs));
      assert(seqs.length > new Set(seqs).size, '再送あり');
      // テスト表示
      await page.click('#obs-pill');
      await page.waitForSelector('.obs-dialog[open]');
      await page.click('[data-key="obs-test"]');
      await tb.waitForFunction(() => document.querySelector('.tb-name')?.textContent.startsWith('テスト表示'), null, { timeout: 5000 });
      // XSS: パーツは文字のまま表示
      const evil = '<img src=x onerror="window.__xss=1">';
      const bad = { v: 1, type: 'state', sid: 'evil', seq: 1, at: Date.now() + 60000, show: { name: evil, title: evil }, live: { started: true, finished: false, index: 0, total: 1 },
        corner: { key: 'main', name: evil, sub: evil, color: 'x" onmouseover="1', n: 1, of: 1 }, topic: { id: 'e', name: evil, genre: '<b>', color: 'main', stats: {} }, next: { name: evil, corner: evil },
        card: { visible: true, post: { id: 'e', user: evil, text: evil, metrics: { impression_count: 1 }, thumb: 'https://evil.example/x.png' } }, title: { id: 'e', text: evil, sub: evil, color: 'main', at: Date.now() + 60000, duration: 4000 }, effect: null };
      for (const p of [late, cd, tt]) await p.evaluate((d) => window.dispatchEvent(new CustomEvent('xtrend-show', { detail: JSON.stringify(d) })), bad);
      await late.waitForFunction(() => window.__overlay.last && window.__overlay.last.sid === 'evil');
      assert((await late.textContent('.tb-name')) === evil, 'tb text');
      assert((await cd.textContent('.cd-text')) === evil, 'card text');
      for (const p of [late, cd, tt]) {
        assert(!(await p.$('#stage img:not(.cd-img)')), 'no injected img');
        assert(await p.evaluate(() => window.__xss === undefined), 'xss');
      }
      assert(await cd.evaluate(() => document.querySelector('.cd-img').hidden), 'pbs 以外の画像は出さない');
      await oc.close();
      await c.close();
      return `接続 ${obs.conns} 回・送信 ${obs.payloads.length} 件（seq ${seqs[0]}〜${seqs.at(-1)}）・後から開いたパーツ ${lateMs}ms で追いつく`;
    });

    await check('OBS セットアップガイド（#obs-setup）: パーツの URL・推奨サイズ・参考配置図、横スクロールなし', async () => {
      for (const [w, hh] of [[960, 1040], [375, 812]]) {
        const c = await newCtx({ viewport: { width: w, height: hh } });
        const { page } = await open(c, `${show}#obs-setup`);
        for (const k of ['topicbar', 'card', 'title']) {
          const u = new URL(await page.inputValue(`[data-key="url-${k}"]`));
          assert(u.pathname === '/show/overlay.html' && u.searchParams.get('part') === k, u.href);
        }
        assert((await page.$$('.setup-box')).length >= 7, 'figure');
        assert(await page.isVisible('#obs-pill'), 'pill');
        const s2 = await sw(page);
        assert(s2 <= w, `scrollWidth ${s2}`);
        await page.screenshot({ path: path.join(SHOTS, `obs-setup-${w}.png`), fullPage: true });
        await c.close();
      }
    });

    await check('オーバーレイのパーツ（見本・背景透明）を推奨サイズで撮る＋?scale・?motion=off', async () => {
      const c = await newCtx();
      for (const [k, w, hh] of [['topicbar', 1300, 150], ['card', 640, 760], ['title', 1920, 1080], ['all', 1920, 1080]]) {
        const p = await c.newPage();
        await p.setViewportSize({ width: w, height: hh });
        await setupRoutes(p, { data: SAMPLE_404 });
        watchConsole(p, errors);
        await p.goto(`${show}overlay.html?part=${k}&demo=1&motion=off`);
        await p.waitForFunction(() => window.__overlay && window.__overlay.received === 1);
        const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
        assert(bg === 'rgba(0, 0, 0, 0)', `透明 ${bg}`);
        assert(await p.evaluate(() => document.documentElement.classList.contains('no-motion')), 'motion=off');
        await p.screenshot({ path: path.join(SHOTS, `overlay-${k}-${w}x${hh}.png`), omitBackground: true });
        await p.close();
      }
      // ?scale=2（小さなソース枠でも拡大）
      const p = await c.newPage();
      await p.setViewportSize({ width: 650, height: 75 });
      await p.goto(`${show}overlay.html?part=topicbar&demo=1&scale=2`);
      const tf = await p.$eval('#stage', (e) => e.style.transform);
      assert(tf === 'scale(1)', tf);
      if (REF_IMAGE && existsSync(REF_IMAGE)) {
        // 参考の配信画面に全部入りを重ねる（data: URI の背景。CSP の img-src data: で許可済み）
        const ext = path.extname(REF_IMAGE).slice(1).replace('jpg', 'jpeg');
        const uri = `data:image/${ext};base64,${readFileSync(REF_IMAGE).toString('base64')}`;
        const q = await c.newPage();
        await q.setViewportSize({ width: 1920, height: 1080 });
        await setupRoutes(q, { data: SAMPLE_404 });
        await q.goto(`${show}overlay.html?part=all&demo=1&motion=off`);
        await q.waitForFunction(() => window.__overlay && window.__overlay.received === 1);
        await q.evaluate((u) => { document.body.style.setProperty('background', `url("${u}") 0 0 / 100% 100% no-repeat`, 'important'); document.body.style.height = '1080px'; }, uri);
        await q.screenshot({ path: path.join(SHOTS, 'overlay-composite-1920.png') });
        await q.evaluate(() => { document.querySelector('.tt').hidden = true; });
        await q.screenshot({ path: path.join(SHOTS, 'overlay-composite-notitle-1920.png') });
      }
      await c.close();
      return REF_IMAGE ? '合成スクショあり' : '合成スクショなし（OBS_REF_IMAGE 未指定）';
    });

    // ---- 4d. 演出（段階4）。偽の OBS（認証なし）で emit_event を受け、fx パーツへ配る
    await check('演出: パレット（開閉の保存）・ボタンと Shift+1〜6 で emit_event に effect・fx パーツで出て消える・再送や同じ id で二重に出ない・連打・感謝バナー（Enter・XSS）・音は既定で鳴らさない', async () => {
      const obs = { payloads: [], targets: [] };
      const c = await newCtx();
      const page = await c.newPage();
      await setupRoutes(page, { data: SAMPLE_404 });
      watchConsole(page, errors);
      await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:4455/, (ws) => {
        ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.5.2', rpcVersion: 1 } }));
        ws.onMessage((raw) => {
          const m = JSON.parse(String(raw));
          if (m.op === 1) ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
          if (m.op === 6) {
            ws.send(JSON.stringify({ op: 7, d: { requestType: m.d.requestType, requestId: m.d.requestId, requestStatus: { result: true, code: 100 } } }));
            const ev = m.d.requestData.requestData;
            obs.payloads.push(ev.event_data);
            for (const t of obs.targets) t.evaluate(([name, d]) => window.dispatchEvent(new CustomEvent(name, { detail: d })), [ev.event_name, ev.event_data]).catch(() => {});
          }
        });
      });
      await page.goto(`${show}#live`);
      await ready(page);
      await page.click('#obs-pill');
      await page.click('[data-key="obs-connect"]');
      await page.waitForFunction(() => document.getElementById('obs-pill').dataset.state === 'connected', null, { timeout: 5000 });
      await page.click('[data-key="obs-close"]');
      // パーツ（別のブラウザ）。AudioContext を作ったら数える
      const oc = await newCtx();
      await oc.addInitScript(() => {
        window.__ac = 0;
        const A = window.AudioContext;
        if (A) window.AudioContext = class extends A { constructor(...a) { super(...a); window.__ac++; } };
      });
      const openFx = async (q) => {
        const p = await oc.newPage();
        await p.setViewportSize({ width: 1920, height: 1080 });
        await setupRoutes(p, { data: SAMPLE_404 });
        watchConsole(p, errors);
        await p.goto(`${show}overlay.html?${q}`);
        await p.waitForFunction(() => window.__overlay);
        return p;
      };
      const fx = await openFx('part=fx');
      obs.targets.push(fx);
      const effects = () => obs.payloads.map((x) => x.effect).filter(Boolean);
      // パレット: 閉じている → 開く（保存）
      assert(!(await page.$('[data-key="fx-confetti"]')), '既定は閉じている');
      await page.click('[data-key="fx-toggle"]');
      await page.waitForSelector('[data-key="fx-confetti"]');
      assert(await page.evaluate(() => localStorage.getItem('xtrend-show-fx-open')) === '1', '開閉の保存');
      await page.screenshot({ path: path.join(SHOTS, 'fx-palette-960.png') });
      // ボタン → emit_event の effect → fx パーツで出て、一定時間で消える
      await page.click('[data-key="fx-confetti"]');
      await fx.waitForSelector('.fx-item[data-kind="confetti"]', { timeout: 5000 });
      const conf = await fx.$$eval('.fx-conf', (x) => x.length);
      assert(conf >= 50, `紙吹雪 ${conf}`);
      const ce = effects().find((e) => e.kind === 'confetti');
      assert(ce && typeof ce.id === 'string' && Number.isFinite(ce.at) && ce.params && Object.keys(ce.params).length === 0, JSON.stringify(ce));
      await fx.waitForSelector('.fx-item[data-kind="confetti"]', { state: 'detached', timeout: 6000 });
      // キー（Shift+3 = 神回！）
      await page.keyboard.press('Shift+Digit3');
      await fx.waitForSelector('.fx-item[data-kind="kami"] .fx-stamp', { timeout: 5000 });
      assert((await fx.textContent('.fx-item[data-kind="kami"] .fx-stamp')) === '神回！', 'kami');
      // 連打（同じ演出の 1 秒以内）は 1 回だけ
      await page.click('[data-key="fx-clap"]');
      await page.click('[data-key="fx-clap"]');
      await page.keyboard.press('Shift+Digit1');
      await fx.waitForSelector('.fx-item[data-kind="clap"]', { timeout: 5000 });
      await page.waitForTimeout(300);
      const clapIds = new Set(effects().filter((e) => e.kind === 'clap').map((e) => e.id));
      assert(clapIds.size === 1, `連打 ${clapIds.size}`);
      // 再送（5 秒おき）と、同じ effect の別送り手・新しい時刻でも二重に出ない
      const firedBefore = await fx.evaluate(() => window.__overlay.fired.length);
      await page.waitForTimeout(5600);
      const last = obs.payloads.at(-1);
      await fx.evaluate((d) => window.dispatchEvent(new CustomEvent('xtrend-show', { detail: { ...d, sid: 'other', seq: 1, at: Date.now() } })), { ...last, effect: effects().at(-1) });
      await page.waitForTimeout(200);
      const firedAfter = await fx.evaluate(() => window.__overlay.fired);
      assert(firedAfter.length === firedBefore && new Set(firedAfter).size === firedAfter.length, `二重 ${firedBefore} → ${firedAfter.length}`);
      assert(obs.payloads.length > new Set(obs.payloads.map((x) => x.seq)).size, '再送あり');
      // 感謝バナー: 名前・金額 → Enter（入力中は Shift+数字は効かない）
      const evil = '<b>太字</b>&amp;';
      await page.fill('[data-key="fx-name"]', evil);
      await page.fill('[data-key="fx-amount"]', '<i>500</i>');
      const n0 = effects().length;
      await page.focus('[data-key="fx-name"]');
      await page.keyboard.press('Shift+Digit2');
      await page.waitForTimeout(300);
      assert(effects().length === n0, '入力欄では演出キーは効かない（文字が入るだけ）');
      await page.fill('[data-key="fx-name"]', evil);
      await page.keyboard.press('Enter');
      await fx.waitForSelector('.fx-item[data-kind="thanks"] .fx-thanks-main', { timeout: 5000 });
      assert((await fx.textContent('.fx-thanks-main')) === `${evil}さん ありがとう！`, await fx.textContent('.fx-thanks-main'));
      assert((await fx.textContent('.fx-thanks-amount')) === '<i>500</i>', 'amount');
      assert(!(await fx.$('.fx-banner b, .fx-banner i')), 'タグは文字のまま');
      assert((await live(page)).index === 0, 'Enter で「読んだ」にならない');
      // 直接届いた長い・危ない名前も制限・文字のまま
      const bad = { ...last, sid: 'evil', seq: 1, at: Date.now() + 2000, effect: { id: 'evil-1', kind: 'thanks', at: Date.now(), params: { name: '<img src=x onerror="window.__xss=1">'.repeat(3), amount: 'x'.repeat(100) } } };
      await page.waitForTimeout(1100);
      const fx2 = await openFx('part=fx&motion=off');
      await fx2.evaluate((d) => window.dispatchEvent(new CustomEvent('xtrend-show', { detail: JSON.stringify(d) })), bad);
      await fx2.waitForSelector('.fx-item[data-kind="thanks"]');
      const t2 = await fx2.evaluate(() => ({ main: document.querySelector('.fx-thanks-main').textContent, amount: document.querySelector('.fx-thanks-amount').textContent, img: !!document.querySelector('.fx img'), xss: window.__xss, calm: document.querySelector('.fx-item').classList.contains('is-calm') }));
      assert(!t2.img && t2.xss === undefined && [...t2.main].length <= 20 + 'さん ありがとう！'.length && t2.amount.length === 12 && t2.calm, JSON.stringify(t2));
      // 音: 既定は AudioContext を作らない／?sound=on なら作る
      assert(await fx.evaluate(() => window.__ac) === 0 && await fx.evaluate(() => window.__overlay.audio) === false, '既定で音なし');
      const fx3 = await openFx('part=fx&sound=on');
      await fx3.evaluate((d) => window.dispatchEvent(new CustomEvent('xtrend-show', { detail: d })), { ...last, sid: 'snd', seq: 1, at: Date.now(), effect: { id: 'snd-1', kind: 'kami', at: Date.now(), params: {} } });
      await fx3.waitForSelector('.fx-item[data-kind="kami"]');
      assert(await fx3.evaluate(() => window.__ac) === 1, 'sound=on');
      // 同時に 3 つまで（受け手）
      const fx4 = await openFx('part=fx');
      const now = Date.now();
      for (const [i, k] of ['clap', 'confetti', 'kami', 'eh', 'fire'].entries()) {
        await fx4.evaluate((d) => window.dispatchEvent(new CustomEvent('xtrend-show', { detail: d })), { ...last, sid: 'max', seq: i + 1, at: now + i, effect: { id: `max-${i}`, kind: k, at: now, params: {} } });
      }
      assert(await fx4.$$eval('.fx-item', (x) => x.length) === 3, '同時 3 つ');
      await oc.close();
      await c.close();
      return `effect 付きの送信 ${effects().length}件（再送を含む）・出した演出 ${new Set(effects().map((e) => e.id)).size} 回`;
    });

    await check('演出: 進行画面 375 幅で横スクロールなし・セットアップガイドに演出の説明・合成スクショ（紙吹雪・神回・感謝バナー）', async () => {
      const c = await newCtx({ viewport: { width: 375, height: 812 } });
      const { page } = await open(c, `${show}#live`);
      await page.click('[data-key="fx-toggle"]');
      await page.waitForSelector('[data-key="fx-thanks"]');
      const s2 = await sw(page);
      assert(s2 <= 375, `scrollWidth ${s2}`);
      await page.screenshot({ path: path.join(SHOTS, 'fx-palette-375.png') });
      await page.goto(`${show}#obs-setup`);
      await ready(page);
      assert((await page.textContent('.setup-fx')).includes('OBS で音声を制御') && (await page.textContent('.setup-fx')).includes('Stream Deck'), 'guide');
      assert(await page.$('[data-key="url-fx"]'), 'fx の URL');
      await c.close();
      if (REF_IMAGE && existsSync(REF_IMAGE)) {
        const ext = path.extname(REF_IMAGE).slice(1).replace('jpg', 'jpeg');
        const uri = `data:image/${ext};base64,${readFileSync(REF_IMAGE).toString('base64')}`;
        const c2 = await newCtx({ viewport: { width: 1920, height: 1080 } });
        for (const [k, wait] of [['confetti', 900], ['kami', 700], ['thanks', 900]]) {
          const q = await c2.newPage();
          await setupRoutes(q, { data: SAMPLE_404 });
          await q.goto(`${show}overlay.html?part=all&demo=1&fx=${k}&name=${encodeURIComponent('みお')}&amount=${encodeURIComponent('¥10,000')}`);
          await q.waitForSelector(`.fx-item[data-kind="${k}"]`);
          await q.evaluate((u) => { document.body.style.setProperty('background', `url("${u}") 0 0 / 100% 100% no-repeat`, 'important'); document.body.style.height = '1080px'; document.querySelector('.tt').hidden = true; }, uri);
          await q.waitForTimeout(wait);
          await q.screenshot({ path: path.join(SHOTS, `fx-composite-${k}-1920.png`) });
          await q.close();
        }
        await c2.close();
      }
    });

    // ---- 4c. Grok ボット連携（段階3）。サンプルには sample/show/topics.json（ボットの話題まとめ）と show_pick がある
    const RAMEN = 'g:sample-ramen-2026w42';
    const SAKURA = 'g:sample-sakura-2026w42';
    await check('Grok: ボットの話題が並ぶ（印・要確認・リード文）・show_pick の理由・手作業が優先（名前・メイン・リロード後も）・進行のリード文', async () => {
      const c = await newCtx();
      const { page } = await open(c, show);
      const botIds = await page.evaluate(() => window.__show.topics.filter((t) => t.kind === 'bot').map((t) => t.id).sort());
      assert(JSON.stringify(botIds) === JSON.stringify([RAMEN, SAKURA]), JSON.stringify(botIds));
      const sakura = await page.evaluate((id) => { const t = window.__show.topicsById.get(id); return { n: t.postIds.length, genre: t.genre, low: t.bot.low }; }, SAKURA);
      assert(sakura.n === 4 && sakura.genre === 'night' && sakura.low, `週の外・無い id は使わない ${JSON.stringify(sakura)}`);
      await folder(page, 'group:night');
      await page.waitForSelector(`[data-key="folder-topic:${RAMEN}"] .tree-bot:not(.is-low)`);
      assert(await page.$(`[data-key="folder-topic:${SAKURA}"] .tree-bot.is-low`), '要確認の印（木）');
      const meta = await page.textContent(`${rowSel(`t:${SAKURA}`)} .row-meta`);
      assert(meta.includes('Grok') && meta.includes('要確認'), meta);
      await page.click(`${rowSel(`t:${SAKURA}`)} .row-main`);
      await page.waitForSelector('[data-key="pv-bot-check"]');
      await page.click('.pv-script summary');
      const lead = await page.inputValue('[data-key="pv-lead"]');
      assert(lead.startsWith('同じキャストさんの出勤'), lead);
      assert(await page.isVisible('.lead-mark-line'), 'Grok のまとめの印');
      await page.screenshot({ path: path.join(SHOTS, 'bot-preview-960.png') });
      // show_pick（雑談おすすめ）の理由が行とプレビューに出る（960 幅は一覧⇄プレビューの切替なので一覧へ戻す）
      await page.click('[data-key="preview-back"]');
      await search(page, '猫が布団');
      const pk = (await rowKeys(page)).find((k) => k.startsWith('p:'));
      const pmeta = await page.textContent(`${rowSel(pk)} .row-meta`);
      assert(pmeta.includes('雑談おすすめ：（サンプル）ペットの話は誰でも話しやすい'), pmeta);
      await page.click(`${rowSel(pk)} .row-main`);
      await page.waitForSelector('[data-key="pv-pick"]');
      assert((await page.evaluate(() => [...window.__show.recommended])).length >= 2, 'recommended');
      await page.click('[data-key="preview-back"]');
      await search(page, ''); // 検索の反映（少し遅れて描き直す）を待ってから
      // 手作業が優先: 名前を変える・メイン1に入れる → リロードしても残る
      await folder(page, `topic:${RAMEN}`);
      await page.dblclick(`[data-key="folder-topic:${RAMEN}"]`);
      await page.waitForSelector('dialog.name-dialog[open]');
      await page.fill('[data-key="name-input"]', '自分で付けた名前');
      await page.click('[data-key="name-ok"]');
      await page.waitForFunction((id) => window.__show.topicsById.get(id).name === '自分で付けた名前', RAMEN);
      await folder(page, 'group:night');
      await ctx(page, `${rowSel(`t:${RAMEN}`)} .row-main`, 'ctx-slot-0');
      await page.reload();
      await ready(page);
      const after = await page.evaluate((id) => ({ name: window.__show.topicsById.get(id).name, main: window.__show.weekState().rundown.corners[0].items[0] }), RAMEN);
      assert(after.name === '自分で付けた名前' && after.main === RAMEN, JSON.stringify(after));
      // 進行: リード文は Grok のまとめ（印つき）
      await page.goto(`${show}#live`);
      await ready(page);
      await page.click('[data-key="live-start"]');
      await page.waitForSelector('.live-lead .lead-mark');
      assert((await page.textContent('.live-lead')).includes('麺屋サンプル'), 'lead');
      await page.screenshot({ path: path.join(SHOTS, 'bot-live-960.png') });
      await c.close();
    });

    await check('Grok: topics.json が無い・壊れていても従来どおり', async () => {
      for (const topics of [null, '{壊れた', JSON.stringify({ topics: 'x' })]) {
        const c = await newCtx();
        const { page } = await open(c, show, { data: { posts: sample, bookmarks: sampleBm, topics } });
        assert(await page.isHidden('#sample-banner'), 'data');
        const n = await page.evaluate(() => [window.__show.bot, window.__show.topics.filter((t) => t.kind === 'bot').length]);
        assert(n[0] === null && n[1] === 0, JSON.stringify(n));
        assert(await page.$('[data-key="folder-topic:d:d-hostcall"]'), 'dict');
        await c.close();
      }
      // data/ 側の topics.json も読む
      const c = await newCtx();
      const ids = sample.posts.filter((p) => p.text.includes('シャンパンタワー')).map((p) => p.id);
      const { page } = await open(c, show, { data: { posts: sample, bookmarks: sampleBm, topics: { topics: [{ id: 'tower-w42', name: 'タワーの話（Grok）', genre: 'ホスト', post_ids: ids, confidence: 0.9 }] } } });
      const t = await page.evaluate(() => { const x = window.__show.topicsById.get('g:tower-w42'); return x && [x.name, x.postIds.length]; });
      assert(t && t[0] === 'タワーの話（Grok）' && t[1] === ids.length, JSON.stringify(t));
      await c.close();
    });

    await check('ボットに修正を送る: ファイル保存（今の全修正・何度でも同じ）と最後に送った日時', async () => {
      const c = await newCtx();
      const { page } = await open(c, show);
      // 修正: ボットの話題の名前・投稿のジャンル・話題の削除
      await page.evaluate((id) => window.__show.edit('名前', (w) => { w.overrides.renames[id] = '直した名前'; }), RAMEN);
      await search(page, '猫が布団');
      const pk = (await rowKeys(page)).find((k) => k.startsWith('p:'));
      await page.click(`${rowSel(pk)} .row-main`);
      await page.selectOption('[data-key="pv-genre"]', 'night');
      await page.waitForFunction(() => Object.keys(window.__show.saved.genreOverrides).length === 1);
      await page.evaluate(() => { window.__show.ui.pane = 'list'; window.__show.render(); });
      await search(page, '');
      await folder(page, 'group:night');
      await ctx(page, `${rowSel(`t:${SAKURA}`)} .row-main`, 'ctx-trash');
      await page.waitForFunction((id) => window.__show.saved.trash.some((x) => x.topicId === id), SAKURA);
      await page.click('[data-key="tools-open"]');
      await page.waitForSelector('dialog.tools-dialog[open]');
      assert((await page.textContent('[data-key="fb-last"]')).includes('まだ送っていません'), 'last');
      const counts = await page.textContent('[data-key="fb-counts"]');
      assert(counts.includes('ジャンルの変更 1件') && counts.includes('削除した話題 1件'), counts);
      const get = async (name) => {
        const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-key="fb-download"]')]);
        assert(dl.suggestedFilename() === 'show-feedback.json', dl.suggestedFilename());
        const f = path.join(tmp, name);
        await dl.saveAs(f);
        return JSON.parse(readFileSync(f, 'utf8'));
      };
      const a = await get('fb1.json');
      const b = await get('fb2.json');
      const strip = (x) => JSON.stringify({ ...x, generated_at: '' });
      assert(strip(a) === strip(b), '冪等');
      assert(a.week === '2026-10-17' && /\+09:00$/.test(a.generated_at), `${a.week} ${a.generated_at}`);
      assert(a.genre_overrides.length === 1 && a.genre_overrides[0].genre === '夜職その他' && a.genre_overrides[0].was[0] === 'その他', JSON.stringify(a.genre_overrides));
      const r = a.topic_edits.find((x) => x.topic_id === 'sample-ramen-2026w42');
      assert(r && r.source === 'bot' && r.name === '直した名前' && r.edits.includes('rename') && r.post_ids.length === 4, JSON.stringify(r));
      const d = a.topic_edits.find((x) => x.topic_id === 'sample-sakura-2026w42');
      assert(d && d.deleted === true, JSON.stringify(d));
      assert(a.removed_posts.length === 4 && a.removed_posts.every((x) => x.reason === 'trash'), JSON.stringify(a.removed_posts));
      await page.waitForFunction(() => document.querySelector('[data-key="fb-last"]').textContent.includes('ファイルで保存'));
      await page.screenshot({ path: path.join(SHOTS, 'bot-tools-960.png') });
      await c.close();
    });

    await check('GitHub に保存（API はモック）: GET→PUT・409 で取り直して再試行・401 は日本語のエラー・トークンは画面/URL に出ない', async () => {
      const SECRET = 'github_pat_E2E_SECRET_0123456789';
      const c = await newCtx();
      const page = await c.newPage();
      await setupRoutes(page, { data: SAMPLE_404 });
      watchConsole(page, errors);
      const reqs = [];
      let mode = 'conflict';
      let n = 0;
      await page.route('https://api.github.com/**', async (route) => {
        const r = route.request();
        reqs.push({ method: r.method(), url: r.url(), auth: r.headers().authorization, body: r.postData() ? JSON.parse(r.postData()) : null });
        n++;
        const cors = { 'access-control-allow-origin': '*' };
        if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, PUT' } });
        if (mode === 'unauth') return route.fulfill({ status: 401, headers: cors, contentType: 'application/json', body: '{"message":"Bad credentials"}' });
        if (r.method() === 'GET') return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ sha: n < 3 ? 'sha-old' : 'sha-new' }) });
        if (r.method() === 'PUT' && n < 3) return route.fulfill({ status: 409, headers: cors, contentType: 'application/json', body: '{"message":"conflict"}' });
        return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ commit: { html_url: 'https://github.com/nichijowork-rgb/X-trend/commit/abc' } }) });
      });
      await page.goto(show);
      await ready(page);
      await page.click('[data-key="tools-open"]');
      await page.waitForSelector('dialog.tools-dialog[open]');
      await page.click('.gh-box > summary');
      assert((await page.inputValue('[data-key="gh-repo"]')) === 'nichijowork-rgb/X-trend', 'default repo');
      assert((await page.inputValue('[data-key="gh-branch"]')) === 'claude/x-scraper-nightlife-tool-sb26pq', 'default branch');
      await page.fill('[data-key="gh-token"]', SECRET);
      await page.click('[data-key="fb-github"]');
      await page.waitForFunction(() => (document.querySelector('[data-key="fb-msg"]') || {}).textContent?.includes('GitHub に保存しました'), null, { timeout: 5000 });
      const api = reqs.filter((x) => x.method !== 'OPTIONS');
      assert(JSON.stringify(api.map((x) => x.method)) === '["GET","PUT","GET","PUT"]', JSON.stringify(api.map((x) => x.method)));
      assert(api[0].url === 'https://api.github.com/repos/nichijowork-rgb/X-trend/contents/feedback/show-feedback.json?ref=claude%2Fx-scraper-nightlife-tool-sb26pq', api[0].url);
      assert(api.every((x) => x.auth === `Bearer ${SECRET}` && !x.url.includes(SECRET) && /\/contents\/feedback\/show-feedback\.json/.test(x.url)), 'auth/url');
      const put = api[3].body;
      assert(put.sha === 'sha-new' && put.branch === 'claude/x-scraper-nightlife-tool-sb26pq' && /^feedback: show edits /.test(put.message), JSON.stringify({ ...put, content: '…' }));
      const fb = JSON.parse(Buffer.from(put.content, 'base64').toString('utf8'));
      assert(fb.week && Array.isArray(fb.topic_edits) && Array.isArray(fb.genre_overrides), 'content');
      assert(await page.$('[data-key="fb-msg"] a[href="https://github.com/nichijowork-rgb/X-trend/commit/abc"]'), 'commit link');
      assert((await page.textContent('[data-key="fb-last"]')).includes('GitHub に保存'), 'last');
      // トークンは画面・URL・入力欄に出ない（保存済みと表示するだけ）
      const leak = await page.evaluate((s) => document.documentElement.outerHTML.includes(s) || [...document.querySelectorAll('input, textarea')].some((i) => i.value.includes(s)) || location.href.includes(s), SECRET);
      assert(!leak, 'token leaked');
      assert((await page.getAttribute('[data-key="gh-token"]', 'placeholder')).includes('保存済み'), 'placeholder');
      await page.screenshot({ path: path.join(SHOTS, 'bot-github-960.png') });
      // 401
      mode = 'unauth';
      await page.click('[data-key="fb-github"]');
      await page.waitForFunction(() => (document.querySelector('[data-key="fb-msg"]') || {}).textContent?.includes('トークンが正しくない'), null, { timeout: 5000 });
      assert(!(await page.textContent('[data-key="fb-msg"]')).includes(SECRET), 'token in error');
      // トークンを消す
      await page.click('[data-key="gh-forget"]');
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('xtrend-show-github')));
      assert(stored.token === '' && stored.repo === 'nichijowork-rgb/X-trend', JSON.stringify(stored));
      // 375 幅で横スクロールなし
      await page.setViewportSize({ width: 375, height: 812 });
      await page.waitForTimeout(200);
      const w = await page.evaluate(() => document.querySelector('dialog.tools-dialog').scrollWidth <= document.querySelector('dialog.tools-dialog').clientWidth && document.documentElement.scrollWidth <= 375);
      assert(w, 'no horizontal scroll at 375');
      await page.screenshot({ path: path.join(SHOTS, 'bot-tools-375.png') });
      await c.close();
    });

    // ---- 5. 実データ（リポジトリの data/。読むだけ）。今週（約 960 件）の 10/31 配信の週で確認
    if (existsSync(path.join(ROOT, 'data', 'posts.json'))) {
      await check('実データ: 1 操作の速さ（受信箱の表示・選択・移動・元に戻す・検索）', async () => {
        const c7 = await newCtx();
        const { page: p } = await open(c7, `${show}#plan`, {});
        const wkKey = await p.evaluate(() => (window.__show.weeks.find((w) => w.key === '2026-10-31') || window.__show.weeks[1] || window.__show.weeks[0]).key);
        await p.selectOption('#week-select', wkKey);
        await p.waitForFunction((k) => window.__show.weekKey === k, wkKey);
        const n = await p.evaluate(() => window.__show.weekPostIds.length);
        const t = await p.evaluate(async () => {
          const a = window.__show;
          const ms = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
          const out = {};
          out.render = ms(() => a.render());
          a.ui.generalAll = true;
          out.allRows = ms(() => a.render());
          out.rows = a.ui.rows.length;
          a.ui.query = 'キャバ';
          out.search = ms(() => a.render());
          a.ui.query = '';
          out.select = ms(() => { a.ui.sel = { sel: new Set([a.ui.rows[0].key]), anchor: 0 }; a.render(); });
          // 編集 1 回（話題の作り直し＋保存＋再描画）と元に戻す
          out.edit = ms(() => a.edit('計測', (w) => { w.mainCand = [...w.mainCand]; }));
          out.undo = ms(() => a.undo());
          return out;
        });
        // 移動（ドロップと同じ処理）と元に戻す
        const k = (await rowKeys(p))[0];
        const t1 = Date.now();
        await ctx(p, `${rowSel(k)} .row-main`, 'ctx-category');
        const moveMs = Date.now() - t1;
        const t2 = Date.now();
        await p.click('[data-key="undo"]');
        const undoMs = Date.now() - t2;
        const f = (x) => `${x.toFixed(1)}ms`;
        assert(t.render < 120 && t.select < 120, JSON.stringify(t));
        await c7.close();
        return `今週 ${n}件（すべて表示 ${t.rows}行）: 描画 ${f(t.render)}・全件表示 ${f(t.allRows)}・検索 ${f(t.search)}・選択 ${f(t.select)}・編集 ${f(t.edit)}・元に戻す ${f(t.undo)}（画面操作込み: 右クリック移動 ${moveMs}ms・元に戻すボタン ${undoMs}ms）`;
      });
      for (const [w, hh, route] of [[960, 1040, 'plan'], [1280, 1400, 'plan'], [1920, 1080, 'plan'], [375, 812, 'plan'], [960, 1040, 'live'], [375, 812, 'live'], [1920, 1080, 'onair']]) {
        await check(`実データ data/ ${route} ${w}×${hh}`, async () => {
          const c7 = await newCtx({ viewport: { width: w, height: hh } });
          const { page: p } = await open(c7, `${show}#${route}`, {});
          assert(await p.isHidden('#sample-banner'), 'sample banner shown with real data');
          const wkKey = await p.evaluate(() => (window.__show.weeks.find((x) => x.key === '2026-10-31') || window.__show.weeks[0]).key);
          if (route !== 'onair') {
            await p.selectOption('#week-select', wkKey);
            await p.waitForFunction((k) => window.__show.weekKey === k, wkKey);
          }
          if (route === 'plan' && w >= 1280) {
            const k = (await rowKeys(p))[0];
            if (k) await p.click(`${rowSel(k)} .row-main`);
            await p.waitForTimeout(300);
          }
          const s = await sw(p);
          assert(s <= w, `scrollWidth ${s}`);
          await p.screenshot({ path: path.join(SHOTS, `real-${route}-${w}x${hh}.png`) });
          const info = await p.evaluate(() => `投稿 ${window.__show.weekPostIds.length}・まとまり ${window.__show.topics.filter((t) => t.postIds.length > 1).length}`);
          await c7.close();
          return info;
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
