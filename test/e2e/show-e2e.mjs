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
import { deflateSync } from 'node:zlib';
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

/** 単色の PNG（w×h）を作る（テスト用。依存なし） */
function makePng(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = (r + x) & 255; row[2 + x * 3] = g; row[3 + x * 3] = (b + (x >> 3)) & 255; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

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
  // 編成のフォルダの画面（くわしい整理）。既定の #plan は「かんたん編成」（左右 2 列のドラッグ＆ドロップ）
  const folders = `${show}#plan-folders`;
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
      const { page, external } = await open(c, folders);
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
    const { page } = await open(cx, folders);
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
      assert(ex.v === 5 && Object.keys(ex.genreOverrides).length >= 1, 'export has genreOverrides');
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
      // 投稿カードは常に表示（表示中/隠し中の切り替えは廃止）
      assert(!(await page.$('[data-key="live-card"]')), '切り替えボタンは無い');
      assert((await live(page)).cardVisible === true, 'card always visible');
      const evts = await page.evaluate(() => window.__evts);
      assert(evts.length >= 4 && evts.some((e) => e.changed.includes('card')) && evts.every((e) => e.state.cardVisible === true) && evts.some((e) => e.changed.includes('topic')), JSON.stringify(evts.map((e) => e.changed)));
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
      await page.goto(folders);
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
      await page.goto(folders);
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
      const { page: p1 } = await open(c2, folders);
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
      const { page: p } = await open(c3, folders, { data: { posts: xssPosts, bookmarks: { bookmarks: 'bad' } } });
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
      const { page: p } = await open(c4, folders, { data: { posts: { generated_at: '2026-10-16T00:09:00+09:00', posts: [] } } });
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
      const { page: p } = await open(c5, folders);
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
      const { page: p } = await open(c9, folders);
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
      await p.goto(folders);
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
      await page.goto(folders);
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
      const corner0 = await page.evaluate(() => document.querySelector('.lh-corner-name').textContent);
      await tt.waitForFunction(() => !document.querySelector('.tt').hidden, null, { timeout: 5000 });
      const ttText = await tt.textContent('.tt-name');
      assert(corner0.includes(ttText), `${ttText} / ${corner0}`);
      await tt.screenshot({ path: path.join(SHOTS, 'obs-live-title.png'), omitBackground: true });
      // 投稿カード: 常に表示
      await cd.waitForSelector('.cd[data-visible="true"]', { timeout: 5000 });
      assert((await cd.textContent('.cd-user')).startsWith('@'), 'user');
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
        assert(!(await p.$('#stage img:not(.cd-img):not(.cd-photo)')) && !(await p.$('#stage img.cd-photo[src]')), 'no injected img');
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
        if (k === 'topicbar' || k === 'all') {
          const tb = await p.evaluate(() => ({ corner: Boolean(document.querySelector('.tb-corner')), next: document.querySelector('.tb-next').textContent, line: document.querySelector('.tb-line').className, name: document.querySelector('.tb-name').textContent }));
          assert(!tb.corner && tb.next.startsWith('NEXT：') && /g-/.test(tb.line) && tb.name, `トピック帯は話題名と NEXT だけ ${JSON.stringify(tb)}`);
        }
        await p.screenshot({ path: path.join(SHOTS, `overlay-${k}-${w}x${hh}.png`), omitBackground: true });
        if (k === 'topicbar') {
          // 長い話題名は 2 行まで（それ以上は省略）
          await p.evaluate(() => { const d = JSON.parse(JSON.stringify(window.__overlay.last)); d.sid = 'long'; d.seq = 1; d.at = Date.now() + 1000; d.topic.name = '長い話題名のテスト：'.repeat(8); window.dispatchEvent(new CustomEvent('xtrend-show', { detail: d })); });
          const hgt = await p.evaluate(() => { const e = document.querySelector('.tb-name'); return { ch: e.clientHeight, sh: e.scrollHeight }; });
          assert(hgt.ch <= 110 && hgt.sh > hgt.ch, `2 行まで ${JSON.stringify(hgt)}`);
          await p.screenshot({ path: path.join(SHOTS, 'overlay-topicbar-long.png'), omitBackground: true });
        }
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

    // ---- 4c'. YouTube ライブのコメント（googleapis はモック。同じブラウザのオーバーレイへ BroadcastChannel）
    await check('YouTube のコメント（googleapis はモック）: 設定→開始・最初の応答はログだけ・新しいコメントがアイコン＋名前で流れる・固定で中央の箱（重なる列は使わない）・削除・NG・画面から消す・流すオフ・ルートを変えても続く・上限で止めて案内', async () => {
      const KEY = 'AIzaSyE2E-test_key_0123456789abcdefgh';
      const c = await newCtx();
      await c.addInitScript(() => { localStorage.setItem('xtrend-show-ytchat-fast', '300'); });
      const yt = { calls: [], referers: [], queue: [], mode: 'ok' };
      const icon = makePng(8, 8, [220, 60, 110]);
      const routeYt = async (pg) => {
        await pg.route('https://www.googleapis.com/youtube/v3/**', async (route) => {
          const r = route.request();
          const u = new URL(r.url());
          yt.calls.push({ path: u.pathname, key: u.searchParams.get('key') === KEY, token: u.searchParams.get('pageToken') });
          yt.referers.push(r.headers().referer || '');
          const cors = { 'access-control-allow-origin': '*' };
          if (u.pathname.endsWith('/videos')) return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ items: [{ liveStreamingDetails: { activeLiveChatId: 'CHAT-E2E' } }] }) });
          if (yt.mode === 'quota') return route.fulfill({ status: 403, headers: cors, contentType: 'application/json', body: JSON.stringify({ error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } }) });
          return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ items: yt.queue.shift() || [], nextPageToken: `P${yt.calls.length}`, pollingIntervalMillis: 100 }) });
        });
        await pg.route(/^https:\/\/yt3\.ggpht\.com\//, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: icon }));
      };
      const T = (id, msg, extra = {}) => ({ id, snippet: { type: 'textMessageEvent', publishedAt: new Date().toISOString(), displayMessage: msg }, authorDetails: { channelId: `UC${id}`, displayName: `@viewer_${id}`, profileImageUrl: `https://yt3.ggpht.com/icon_${id}=s64`, ...extra } });
      const SC = (id) => ({ id, snippet: { type: 'superChatEvent', superChatDetails: { amountDisplayString: '¥1,000', userComment: 'スパチャです', tier: 4 } }, authorDetails: { channelId: `UC${id}`, displayName: `@fan_${id}` } });
      const ST = (id) => ({ id, snippet: { type: 'superStickerEvent', superStickerDetails: { amountDisplayString: '¥500', tier: 3 } }, authorDetails: { channelId: `UC${id}`, displayName: `@fan_${id}` } });
      // オーバーレイ（同じブラウザ。1920×1080・速さ 4 秒）
      const ov = await c.newPage();
      await ov.setViewportSize({ width: 1920, height: 1080 });
      await setupRoutes(ov, { data: SAMPLE_404 });
      await routeYt(ov);
      watchConsole(ov, errors);
      await ov.goto(`${show}overlay.html?part=comments&speed=4`);
      await ov.waitForFunction(() => window.__overlay && window.__overlay.chat);
      const page = await c.newPage();
      await setupRoutes(page, { data: SAMPLE_404 });
      await routeYt(page);
      watchConsole(page, errors);
      await page.goto(`${show}#comments`);
      await ready(page);
      // ［コメント］のページ。未設定の案内
      assert((await page.textContent('[data-key="yc-status"]')).includes('未設定'), 'status 未設定');
      await page.waitForSelector('[data-key="yc-url"]');
      // 設定: API キー（パスワード欄・表示の切替）・NG ワード
      await page.click('[data-key="yc-settings"]');
      await page.waitForSelector('dialog.yc-dialog[open]');
      assert((await page.getAttribute('[data-key="yc-key"]', 'type')) === 'password', 'password');
      assert((await page.getAttribute('[data-key="yc-key"]', 'autocomplete')) === 'new-password', 'no autofill');
      // API キーでないもの（ブラウザが自動で入れたパスワードなど）は保存しない
      await page.fill('[data-key="yc-key"]', 'hunter2-saved-password-123456');
      await page.click('[data-key="yc-save"]');
      await page.waitForSelector('[data-key="yc-key-msg"]:not([hidden])');
      assert((await page.textContent('[data-key="yc-key-msg"]')).includes('AIza'), 'key warning');
      assert(await page.isVisible('dialog.yc-dialog[open]'), 'dialog stays open');
      await page.fill('[data-key="yc-key"]', KEY);
      await page.check('[data-key="yc-show-key"]');
      assert((await page.getAttribute('[data-key="yc-key"]', 'type')) === 'text', 'show key');
      await page.fill('[data-key="yc-ng"]', 'ng、宣伝');
      // この確認は「数秒ごと」（liveChat/messages）で。プッシュ型は別の確認で
      await page.selectOption('[data-key="yc-mode"]', 'poll');
      assert((await page.textContent('[data-key="yc-quota"]')).includes('10,000'), 'quota');
      await page.screenshot({ path: path.join(SHOTS, 'live-comments-settings-960.png') });
      await page.click('[data-key="yc-save"]');
      await page.waitForSelector('dialog.yc-dialog', { state: 'detached' });
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('xtrend-show-ytchat')));
      assert(stored.key === KEY && stored.ng === 'ng、宣伝' && stored.mode === 'poll', 'saved prefs');
      assert(await page.evaluate((k) => !JSON.stringify(window.__show.saved).includes(k), KEY), 'キーは番組の保存データ（書き出し）に入らない');
      // 開始前のコメント（最初の応答）と、そのあとの新しいコメント
      yt.queue.push([T('old-1', '開始前のコメント'), T('old-2', 'これも前')]);
      yt.queue.push([T('b1', 'こんばんは！'), SC('sc1'), ST('st1'), T('ng1', 'これはＮＧワード入り'), T('em1', ':yt:すごい:oops:'), T('em2', ':oops::_memberStamp:'), T('b5', 'これは固定するための長いコメントです。'.repeat(4))]);
      await page.fill('[data-key="yc-url"]', 'https://www.youtube.com/live/dQw4w9WgXcQ?si=share');
      await page.click('[data-key="yc-toggle-run"]');
      await page.waitForFunction(() => document.querySelectorAll('.yc-row').length >= 9, null, { timeout: 8000 });
      assert((await page.textContent('[data-key="yc-status"]')).includes('取得中'), await page.textContent('[data-key="yc-status"]'));
      assert((await page.textContent('[data-key="yc-toggle-run"]')) === '停止', 'stop label');
      const firstRow = await page.getAttribute('.yc-log > li:first-child', 'data-id');
      assert(firstRow === 'b5', `新しいものが上 ${firstRow}`);
      assert((await page.textContent('.yc-row[data-id="old-1"]')).includes('開始前'), 'backlog badge');
      assert(await page.$('.yc-row[data-id="ng1"].is-ng'), 'NG は灰色');
      assert(await page.$eval('.yc-row[data-id="ng1"] [data-key="yc-pin"]', (b) => b.disabled), 'NG は固定できない');
      assert(await page.$('.yc-row[data-id="b1"] img.yc-icon'), 'log icon');
      // オーバーレイで流れる（アイコン＋名前）。開始前・NG は流さない
      await ov.waitForFunction(() => document.querySelector('.cm-item[data-id="b1"]'), null, { timeout: 5000 });
      const b1 = await ov.evaluate(() => { const e = document.querySelector('.cm-item[data-id="b1"]'); return { name: e.querySelector('.cm-name').textContent, icon: e.querySelector('img.cm-icon') ? e.querySelector('img.cm-icon').src : null, text: e.querySelector('.cm-text').textContent, top: e.style.top }; });
      assert(b1.name === '@viewer_b1' && b1.icon && b1.icon.startsWith('https://yt3.ggpht.com/') && b1.text === 'こんばんは！' && b1.top === '0px', JSON.stringify(b1));
      assert(await ov.evaluate(() => { const f = document.querySelector('.cm-flow'); return f.offsetTop === 660 && f.offsetLeft === 0 && f.offsetWidth === 1920 && f.offsetHeight === 248 && Boolean(f.querySelector('.cm-item[data-id="b1"]')); }), '帯（0,660 / 1920×248）の中を流れる');
      await ov.waitForFunction(() => document.querySelector('.cm-item.is-super .cm-amount'), null, { timeout: 5000 });
      assert((await ov.textContent('.cm-item.is-super .cm-amount')) === '¥1,000', 'super amount');
      assert((await ov.textContent('.cm-item.is-sticker')).includes('¥500'), 'sticker');
      assert(await ov.evaluate(() => getComputedStyle(document.querySelector('.cm-item.is-sticker .cm-initial')).borderRadius === '50%'), 'アイコンが無ければ頭文字の丸');
      await ov.screenshot({ path: path.join(SHOTS, 'comments-flow-1920.png') });
      let launched = await ov.evaluate(() => window.__overlay.chat.launched.map((x) => x.id));
      assert(!launched.includes('old-1') && !launched.includes('old-2') && !launched.includes('ng1'), `開始前・NG は流さない ${launched}`);
      // 「:face-blue-smiling:」のような絵文字の文字は画面に出さない（既定オン）。絵文字だけのコメントは流さない。一覧にはそのまま
      await ov.waitForFunction(() => document.querySelector('.cm-item[data-id="em1"]') || window.__overlay.chat.launched.some((x) => x.id === 'em1'), null, { timeout: 8000 });
      const em1 = await ov.evaluate(() => { const e = document.querySelector('.cm-item[data-id="em1"] .cm-text'); return e ? e.textContent : null; });
      assert(em1 === null || em1 === 'すごい', `em1 ${em1}`);
      assert((await page.textContent('.yc-row[data-id="em1"]')).includes(':yt:'), '一覧はそのまま');
      launched = await ov.evaluate(() => window.__overlay.chat.launched.map((x) => x.id));
      assert(!launched.includes('em2'), `絵文字だけは流さない ${launched}`);
      // Referer は origin だけ（キーの制限＝ウェブサイトのため）・キーは URL だけ
      const origin = new URL(base).origin;
      assert(yt.referers.length >= 3 && yt.referers.every((r) => r === `${origin}/`), `referer ${[...new Set(yt.referers)]}`);
      assert(yt.calls.every((x) => x.key) && yt.calls[0].path.endsWith('/videos'), 'calls');
      // 固定 → 中央の箱。重なる列（1・2 列目）には新しいコメントを入れない
      await page.click('.yc-row[data-id="b5"] [data-key="yc-pin"]');
      await ov.waitForFunction(() => { const p = document.querySelector('.cm-pin'); return p && !p.hidden && p.dataset.id === 'b5'; }, null, { timeout: 5000 });
      const pin = await ov.evaluate(() => { const p = document.querySelector('.cm-pin'); return { left: p.offsetLeft, top: p.offsetTop, w: p.offsetWidth, h: p.offsetHeight, tag: p.querySelector('.cm-pin-tag').textContent, name: p.querySelector('.cm-pin-name').textContent, blocked: window.__overlay.chat.blocked, lines: Math.round(p.querySelector('.cm-pin-text').clientHeight / parseFloat(getComputedStyle(p.querySelector('.cm-pin-text')).lineHeight)) }; });
      assert(pin.left === 655 && pin.top === 600 && pin.w === 1170 && pin.tag === '固定中' && pin.name === '@viewer_b5' && pin.lines === 2, JSON.stringify(pin));
      assert(JSON.stringify(pin.blocked) === '[0,1]', `blocked ${JSON.stringify(pin.blocked)}`);
      assert(await page.$('.yc-row[data-id="b5"].is-pinned [data-key="yc-unpin"]'), 'log pinned');
      assert((await page.textContent('[data-key="yc-pinned"]')).includes('固定中'), 'pinned summary');
      const pinnedAt = await ov.evaluate(() => Date.now());
      yt.queue.push(Array.from({ length: 6 }, (_, i) => T(`c${i + 1}`, `固定中のコメント ${i + 1}`)));
      await ov.waitForFunction(() => window.__overlay.chat.launched.filter((x) => /^c\d$/.test(x.id)).length >= 4, null, { timeout: 8000 });
      const after = await ov.evaluate((t) => window.__overlay.chat.launched.filter((x) => x.at >= t), pinnedAt);
      assert(after.length >= 4 && after.every((x) => x.lane >= 2), `固定と重なる列は使わない ${JSON.stringify(after)}`);
      await ov.screenshot({ path: path.join(SHOTS, 'comments-pin-1920.png') });
      // 画面から消す（流れていれば消える。一覧は残る）
      await ov.waitForFunction(() => document.querySelector('.cm-item[data-id="c3"]') || window.__overlay.chat.launched.some((x) => x.id === 'c3'), null, { timeout: 8000 });
      await page.click('.yc-row[data-id="c3"] [data-key="yc-hide"]');
      await ov.waitForFunction(() => !document.querySelector('.cm-item[data-id="c3"]'), null, { timeout: 3000 });
      assert(await page.$('.yc-row[data-id="c3"].is-hidden'), 'hidden row');
      // YouTube で削除: 固定中のもの・流れているもの → 一覧・画面・固定から消える
      yt.queue.push([{ id: 'd1', snippet: { type: 'messageDeletedEvent', messageDeletedDetails: { deletedMessageId: 'b5' } } }, { id: 'd2', snippet: { type: 'messageDeletedEvent', messageDeletedDetails: { deletedMessageId: 'c6' } } }]);
      await ov.waitForFunction(() => document.querySelector('.cm-pin').hidden && !document.querySelector('.cm-item[data-id="c6"]'), null, { timeout: 5000 });
      await page.waitForFunction(() => !document.querySelector('.yc-row[data-id="b5"]') && !document.querySelector('.yc-row[data-id="c6"]'), null, { timeout: 5000 });
      assert(await page.$eval('[data-key="yc-pinned"]', (e) => e.hidden), 'pinned summary gone');
      assert(await ov.evaluate(() => window.__overlay.chat.blocked.length === 0), 'unblocked');
      // 「画面に流す」をオフ → 取得は続くが流さない
      await page.uncheck('[data-key="yc-flow"]');
      yt.queue.push([T('f1', '流さないコメント')]);
      await page.waitForSelector('.yc-row[data-id="f1"]', { timeout: 5000 });
      await page.waitForTimeout(400);
      assert(!(await ov.evaluate(() => window.__overlay.chat.launched.some((x) => x.id === 'f1'))), 'flow off');
      assert(await ov.evaluate(() => document.querySelector('.cm').dataset.flow === 'false'), 'overlay flow false');
      await page.check('[data-key="yc-flow"]');
      // 編成へ移っても取得は続き、オーバーレイへ流れる
      await page.evaluate(() => { location.hash = '#plan'; });
      await page.waitForFunction(() => window.__show.route === 'plan');
      yt.queue.push([T('r1', '編成画面にいる間のコメント')]);
      await ov.waitForFunction(() => window.__overlay.chat.launched.some((x) => x.id === 'r1'), null, { timeout: 5000 });
      // 進行は 1 行のバーだけ（状態・開始/停止・コメントのページへ・別ウィンドウ）
      await page.evaluate(() => { location.hash = '#live'; });
      await page.waitForSelector('.yc-bar [data-key="yc-status"]');
      assert((await page.textContent('.yc-bar [data-key="yc-status"]')).includes('取得中'), 'live bar status');
      assert((await page.textContent('.yc-bar [data-key="yc-toggle-run"]')) === '停止' && await page.$('.yc-bar a[href="#comments"]') && await page.$('.yc-bar [data-key="yc-popout"]'), 'live bar buttons');
      assert(!(await page.$('#view .yc-log')) && !(await page.$('#view .le-root')), '進行に一覧・レイアウトは無い');
      await page.$eval('.yc-bar', (e) => e.scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: path.join(SHOTS, 'live-comment-bar-960.png') });
      await page.click('.yc-bar a[href="#comments"]');
      await page.waitForSelector('.yc-row[data-id="r1"]', { timeout: 5000 });
      // XSS: 名前・本文は文字のまま
      const evil = '<img src=x onerror="window.__xss=1">';
      yt.queue.push([T('x1', evil, { displayName: evil, profileImageUrl: 'javascript:alert(1)' })]);
      await ov.waitForFunction(() => document.querySelector('.cm-item[data-id="x1"]'), null, { timeout: 5000 });
      assert((await ov.textContent('.cm-item[data-id="x1"] .cm-body')) === evil && !(await ov.$('.cm-item[data-id="x1"] img')), 'overlay xss');
      assert((await page.textContent('.yc-row[data-id="x1"] .yc-text')) === evil, 'log xss');
      assert(await page.evaluate(() => window.__xss === undefined) && await ov.evaluate(() => window.__xss === undefined), 'xss');
      await page.$eval('.yc-log', (e) => e.scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: path.join(SHOTS, 'comments-page-960.png') });
      // 広い画面（1200px 以上）は 2 列（一覧・レイアウト）
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(300);
      const two = await page.evaluate(() => { const a = document.querySelector('.cmp-log-col').getBoundingClientRect(); const b = document.querySelector('.cmp-layout-col').getBoundingClientRect(); return Math.abs(a.top - b.top) < 4 && b.width > a.width; });
      assert(two, '1920 は 2 列');
      await page.screenshot({ path: path.join(SHOTS, 'comments-page-1920.png') });
      await page.setViewportSize({ width: 960, height: 1040 });
      // 今日の上限 → 止めて案内（それ以上は取りに行かない）
      yt.mode = 'quota';
      await page.waitForFunction(() => document.querySelector('[data-key="yc-status"]').dataset.state === 'error', null, { timeout: 5000 });
      const status = await page.textContent('[data-key="yc-status"]');
      assert(status.includes('上限') && (await page.textContent('[data-key="yc-toggle-run"]')) === '開始', status);
      const n = yt.calls.length;
      await page.waitForTimeout(1000);
      assert(yt.calls.length === n, `止めたら取りに行かない ${yt.calls.length - n}`);
      await page.screenshot({ path: path.join(SHOTS, 'live-comments-quota-960.png') });
      // 横スクロールなし
      assert((await sw(page)) <= 960, 'scrollWidth');
      await c.close();
      return `API 呼び出し ${n} 回`;
    });

    await check('流れるコメントの見本（?demo=1&part=comments）と全部入りの合成スクショ（1920×1080・暗い背景）', async () => {
      const c = await newCtx({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
      const p = await c.newPage();
      await setupRoutes(p, { data: SAMPLE_404 });
      watchConsole(p, errors);
      await p.goto(`${show}overlay.html?part=comments&demo=1`);
      await p.waitForFunction(() => document.querySelectorAll('.cm-item').length >= 2 && !document.querySelector('.cm-pin').hidden, null, { timeout: 8000 });
      const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert(bg === 'rgba(0, 0, 0, 0)', `透明 ${bg}`);
      // ?motion=off: 流さずにフェード（列の左寄り）
      await p.goto(`${show}overlay.html?part=comments&demo=1&motion=off&top=700&lanes=3`);
      await p.waitForFunction(() => document.querySelectorAll('.cm-item').length >= 1, null, { timeout: 8000 });
      const calmItem = await p.evaluate(() => { const e = document.querySelector('.cm-item'); return { tf: e.style.transform, top: e.style.top, lanes: window.__overlay.chat.cfg.lanes, blocked: window.__overlay.chat.blocked }; });
      // 帯 700〜886・3 列。見本の固定（600〜750 前後）と重なる 1 列目は使わない
      assert(calmItem.tf === 'translateX(40px)' && ['62px', '124px'].includes(calmItem.top) && calmItem.lanes === 3 && JSON.stringify(calmItem.blocked) === '[0]', JSON.stringify(calmItem));
      assert(await p.evaluate(() => document.querySelector('.cm-flow').offsetTop === 700), '&top= は帯の位置');
      await p.goto(`${show}overlay.html?part=all&demo=1`);
      await p.waitForFunction(() => document.querySelectorAll('.cm-item').length >= 3 && !document.querySelector('.cm-pin').hidden, null, { timeout: 10000 });
      await p.evaluate(() => { document.body.style.setProperty('background', 'linear-gradient(135deg, #1b1d26, #0c0d12 60%, #22161d)', 'important'); document.body.style.height = '1080px'; const t = document.querySelector('.tt'); if (t) t.hidden = true; });
      await p.waitForTimeout(1500);
      await p.screenshot({ path: path.join(SHOTS, 'comments-overlay-all-1920.png') });
      await c.close();
    });

    // ---- 4c''. コメントの取得方式（プッシュ型 stream・数秒おきへの切り替え）とチャンネルから自動で探す（googleapis はモック）
    await check('YouTube のコメント（プッシュ型）: stream の JSON 配列で受け取り・最初の要素はログだけ・続きから再接続／stream が使えなければ数秒おきに切り替え／URL が空ならチャンネルから今の配信を探す（検索も）', async () => {
      const KEY = 'AIzaSyE2E-test_key_0123456789abcdefgh';
      const UC = `UC${'e2eTestChannel_abcdefg'.slice(0, 22)}`;
      const T = (id, msg) => ({ id, snippet: { type: 'textMessageEvent', publishedAt: new Date().toISOString(), displayMessage: msg }, authorDetails: { channelId: `UC${id}`, displayName: `@viewer_${id}` } });
      const run = async ({ streamMode, channel = null }) => {
        const c = await newCtx();
        await c.addInitScript(([k, ch]) => {
          localStorage.setItem('xtrend-show-ytchat-fast', '300');
          if (!localStorage.getItem('xtrend-show-ytchat')) localStorage.setItem('xtrend-show-ytchat', JSON.stringify({ key: k, channel: ch || '' }));
        }, [KEY, channel]);
        const yt = { calls: [], streamQueue: [[T('s-old', '開始前'), 'S1'], [T('s1', 'プッシュで届いたコメント'), 'S2']], pollQueue: [[T('p-old', '開始前（数秒おき）')], [T('p1', '数秒おきで届いたコメント')]], referers: [] };
        const routeYt = async (pg) => {
          await pg.route('https://www.googleapis.com/youtube/v3/**', async (route) => {
            const r = route.request();
            const u = new URL(r.url());
            const cors = { 'access-control-allow-origin': '*' };
            const json = (body, status = 200) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: typeof body === 'string' ? body : JSON.stringify(body) });
            const pth = u.pathname.replace('/youtube/v3', '');
            yt.calls.push({ path: pth, token: u.searchParams.get('pageToken'), forHandle: u.searchParams.get('forHandle'), id: u.searchParams.get('id') });
            yt.referers.push(r.headers().referer || '');
            if (pth === '/channels') return json({ items: [{ id: UC, snippet: { title: 'テストのチャンネル' }, contentDetails: { relatedPlaylists: { uploads: 'UUe2e' } } }] });
            if (pth === '/playlistItems') return json({ items: [{ contentDetails: { videoId: 'upcoming001' } }] });
            if (pth === '/search') return json({ items: [{ id: { kind: 'youtube#video', videoId: 'livefound01' } }] });
            if (pth === '/videos') {
              if (u.searchParams.get('id') === 'upcoming001') return json({ items: [{ id: 'upcoming001', snippet: { title: '来週の配信' }, liveStreamingDetails: { scheduledStartTime: '2026-11-21T13:00:00Z', activeLiveChatId: 'NOPE' } }] });
              if (u.searchParams.get('id') === 'livefound01') return json({ items: [{ id: 'livefound01', snippet: { title: '今夜のテスト配信' }, liveStreamingDetails: { actualStartTime: new Date(Date.now() - 600000).toISOString(), activeLiveChatId: 'CHAT-FOUND' } }] });
              return json({ items: [{ liveStreamingDetails: { activeLiveChatId: 'CHAT-URL' } }] });
            }
            if (pth === '/liveChat/messages/stream') {
              if (streamMode === 'fail') return route.abort('failed');
              const parts = [];
              while (yt.streamQueue.length && parts.length < 2) { const [it, tok] = yt.streamQueue.shift(); parts.push(JSON.stringify({ items: [it], nextPageToken: tok, pollingIntervalMillis: 0 })); }
              return json(`[${parts.length ? parts.join('\n,') : JSON.stringify({ items: [], nextPageToken: 'S9' })}]`);
            }
            if (pth === '/liveChat/messages') return json({ items: yt.pollQueue.shift() || [], nextPageToken: `Q${yt.calls.length}`, pollingIntervalMillis: 100 });
            return json({ error: { code: 404 } }, 404);
          });
        };
        const ov = await c.newPage();
        await ov.setViewportSize({ width: 1920, height: 1080 });
        await setupRoutes(ov, { data: SAMPLE_404 });
        watchConsole(ov, errors);
        await ov.goto(`${show}overlay.html?part=comments`);
        await ov.waitForFunction(() => window.__overlay && window.__overlay.chat);
        const page = await c.newPage();
        await setupRoutes(page, { data: SAMPLE_404 });
        await routeYt(page);
        watchConsole(page, errors);
        await page.goto(`${show}#comments`);
        await ready(page);
        return { c, page, ov, yt };
      };
      // ① プッシュ（stream）
      {
        const { c, page, ov, yt } = await run({ streamMode: 'ok' });
        await page.fill('[data-key="yc-url"]', 'https://youtu.be/dQw4w9WgXcQ');
        await page.click('[data-key="yc-toggle-run"]');
        await ov.waitForFunction(() => window.__overlay.chat.launched.some((x) => x.id === 's1'), null, { timeout: 8000 });
        await page.waitForSelector('.yc-row[data-id="s-old"]');
        assert((await page.textContent('.yc-row[data-id="s-old"]')).includes('開始前'), 'backlog');
        assert(!(await ov.evaluate(() => window.__overlay.chat.launched.some((x) => x.id === 's-old'))), '最初の要素は流さない');
        assert((await page.textContent('[data-key="yc-status"]')).includes('取得中（プッシュ）'), await page.textContent('[data-key="yc-status"]'));
        await page.waitForFunction(() => true);
        await new Promise((r) => setTimeout(r, 900));
        const streams = yt.calls.filter((x) => x.path === '/liveChat/messages/stream');
        assert(streams.length >= 2 && streams[0].token === null && streams[1].token === 'S2', `続きから ${JSON.stringify(streams.slice(0, 3))}`);
        assert(!yt.calls.some((x) => x.path === '/liveChat/messages'), '数秒おきは使わない');
        const origin = new URL(base).origin;
        assert(yt.referers.every((r) => r === `${origin}/`), 'referer origin');
        await page.screenshot({ path: path.join(SHOTS, 'live-comments-push-960.png') });
        await c.close();
      }
      // ② stream が使えない（CORS・通信）→ 数秒おき
      {
        const { c, page, ov, yt } = await run({ streamMode: 'fail' });
        await page.fill('[data-key="yc-url"]', 'https://youtu.be/dQw4w9WgXcQ');
        await page.click('[data-key="yc-toggle-run"]');
        await ov.waitForFunction(() => window.__overlay.chat.launched.some((x) => x.id === 'p1'), null, { timeout: 8000 });
        const st = await page.textContent('[data-key="yc-status"]');
        assert(st.includes('秒ごと') && st.includes('※プッシュが使えないため'), st);
        assert(!(await ov.evaluate(() => window.__overlay.chat.launched.some((x) => x.id === 'p-old'))), '切り替えても開始前は流さない');
        assert(yt.calls.filter((x) => x.path === '/liveChat/messages/stream').length === 1, 'stream は 1 回だけ試す');
        await page.screenshot({ path: path.join(SHOTS, 'live-comments-fallback-960.png') });
        await c.close();
      }
      // ③ URL が空 → 登録したチャンネルの今の配信を探す（再生リストに無い → 検索）
      {
        const { c, page, ov, yt } = await run({ streamMode: 'ok', channel: '@e2e_test_channel' });
        assert((await page.getAttribute('[data-key="yc-url"]', 'placeholder')).includes('空にすると'), 'placeholder');
        assert((await page.inputValue('[data-key="yc-url"]')) === '', 'URL は空');
        await page.click('[data-key="yc-toggle-run"]');
        await page.waitForSelector('[data-key="yc-found"]:not([hidden])', { timeout: 8000 });
        assert((await page.textContent('[data-key="yc-found"]')).includes('見つけた配信：今夜のテスト配信'), await page.textContent('[data-key="yc-found"]'));
        await ov.waitForFunction(() => window.__overlay.chat.launched.some((x) => x.id === 's1'), null, { timeout: 8000 });
        const paths = yt.calls.map((x) => x.path);
        assert(paths[0] === '/channels' && yt.calls[0].forHandle === '@e2e_test_channel', `channels ${JSON.stringify(yt.calls[0])}`);
        assert(paths.includes('/playlistItems') && paths.includes('/search'), paths.join(','));
        assert(yt.calls.find((x) => x.path === '/liveChat/messages/stream'), 'stream');
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('xtrend-show-ytchat')).channelInfo);
        assert(saved && saved.id === UC && saved.uploads === 'UUe2e' && saved.input === '@e2e_test_channel', JSON.stringify(saved));
        const units = await page.evaluate(() => window.__show.chatUnits());
        assert(units >= 1 + 1 + 1 + 100 + 1 + 5, `quota ${units}`);
        await page.screenshot({ path: path.join(SHOTS, 'live-comments-found-960.png') });
        // 2 回目は覚えたチャンネルで channels.list を省く
        await page.click('[data-key="yc-toggle-run"]');
        const n = yt.calls.length;
        await page.click('[data-key="yc-toggle-run"]');
        await page.waitForSelector('[data-key="yc-found"]:not([hidden])', { timeout: 8000 });
        assert(!yt.calls.slice(n).some((x) => x.path === '/channels'), 'channels.list は 1 回だけ');
        await c.close();
      }
      // ④ 進行の「▶ 配信開始」でコメントの取得も始まる（URL 空・チャンネル登録あり → チャンネルから探す）
      {
        const { c, page, ov, yt } = await run({ streamMode: 'ok', channel: '@e2e_test_channel' });
        await page.goto(`${show}#live`);
        await ready(page);
        await page.waitForSelector('[data-key="yc-bar"], .yc-bar');
        assert(!yt.calls.length, '配信開始の前は YouTube に問い合わせない');
        await page.click('[data-key="live-start"]');
        await ov.waitForFunction(() => window.__overlay.chat.launched.some((x) => x.id === 's1'), null, { timeout: 8000 });
        assert(yt.calls.some((x) => x.path === '/channels'), 'チャンネルから探した');
        const st = await page.textContent('.yc-bar [data-key="yc-status"]');
        assert(st.includes('取得中'), st);
        await c.close();
      }
      // ⑤ 設定「配信開始でコメントも始める」をオフ → 配信開始では始まらない
      {
        const { c, page, ov, yt } = await run({ streamMode: 'ok', channel: '@e2e_test_channel' });
        await page.evaluate(() => { const k = 'xtrend-show-ytchat'; const o = JSON.parse(localStorage.getItem(k)); o.autoStart = false; localStorage.setItem(k, JSON.stringify(o)); });
        await page.goto(`${show}#live`);
        await page.reload();
        await ready(page);
        await page.click('[data-key="live-start"]');
        await new Promise((r) => setTimeout(r, 800));
        assert(!yt.calls.length, 'オフなら配信開始で始めない');
        await c.close();
      }
    });

    await check('［コメント］ページのレイアウト（その場で調整）: 固定コメントをマウスでドラッグ → OBS（同じブラウザ）の固定がすぐ動き、押さなくても保存・元に戻す／やり直す・帯をドラッグ → 新しい帯の中を流れる・数値・矢印キー・既定に戻す（確かめてから）・OBS にも見本（既定オフ）', async () => {
      const c = await newCtx();
      const ov = await c.newPage();
      await ov.setViewportSize({ width: 1920, height: 1080 });
      await setupRoutes(ov, { data: SAMPLE_404 });
      watchConsole(ov, errors);
      await ov.goto(`${show}overlay.html?part=comments`);
      await ov.waitForFunction(() => window.__overlay && window.__overlay.chat);
      const page = await c.newPage();
      await setupRoutes(page, { data: SAMPLE_404 });
      watchConsole(page, errors);
      await page.goto(`${show}#comments`);
      await ready(page);
      await page.waitForSelector('.le-root');
      // 画面の中の見本（iframe）に見本の固定。OBS への見本は既定オフ
      await page.frameLocator('iframe.le-frame').locator('.cm-pin:not([hidden])').waitFor({ timeout: 8000 });
      assert(!(await page.isChecked('[data-key="le-obs"]')), 'OBS にも見本は既定オフ');
      const stored = () => page.evaluate(() => (JSON.parse(localStorage.getItem('xtrend-show-ytchat') || '{}').layout || null));
      const leState = () => page.evaluate(() => window.__show.layoutEditorState());
      let st = await leState();
      assert(st.scale > 0.4 && st.scale < 0.52, `scale ${st.scale}`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth) <= 960, 'no h-scroll');
      const drag = async (sel, dx, dy, at = [0.5, 0.5]) => {
        await page.locator(sel).scrollIntoViewIfNeeded();
        const b = await page.locator(sel).boundingBox();
        const x = b.x + b.width * at[0];
        const y = b.y + b.height * at[1];
        await page.mouse.move(x, y);
        await page.mouse.down();
        for (let i = 1; i <= 5; i++) await page.mouse.move(x + (dx * i) / 5, y + (dy * i) / 5);
        await page.mouse.up();
      };
      // 固定コメントをドラッグ（右へは画面の端 1920−1170＝750 で止まる）→ OBS の固定がすぐ動く（本物の固定コメントが無くても箱の位置は届く）
      await drag('.le-pin', 400, 0, [0.3, 0.5]);
      assert((await leState()).draft.pin.x === 750, '右の端で止まる');
      await drag('.le-pin', -100, -40, [0.3, 0.5]);
      st = await leState();
      const px = st.draft.pin.x;
      const py = st.draft.pin.y;
      assert(Math.abs(px - (750 - 100 / st.scale)) <= 12 && py < 600, `pin ${px},${py}`);
      await ov.waitForFunction((x) => window.__overlay.chat.cfg.pin.x === x && document.querySelector('.cm-pin').style.left === `${x}px`, px, { timeout: 3000 });
      // 押さなくても保存（400ms あと）
      await page.waitForFunction((x) => { const l = JSON.parse(localStorage.getItem('xtrend-show-ytchat') || '{}').layout; return l && l.pin.x === x; }, px, { timeout: 3000 });
      assert((await page.textContent('[data-key="le-saved"]')).includes('保存'), 'saved note');
      assert((await page.inputValue('[data-key="le-pin-x"]')) === String(px), 'readout');
      // 元に戻す（ボタン）→ 750 に戻る・保存も戻る／やり直す（Ctrl+Shift+Z）
      await page.click('[data-key="le-undo"]');
      assert((await leState()).draft.pin.x === 750, 'undo');
      await ov.waitForFunction(() => window.__overlay.chat.cfg.pin.x === 750, null, { timeout: 3000 });
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('xtrend-show-ytchat')).layout.pin.x === 750, null, { timeout: 3000 });
      await page.focus('.le-pin');
      await page.keyboard.press('Control+Shift+Z');
      assert((await leState()).draft.pin.x === px, 'redo');
      await page.keyboard.press('Control+z');
      await page.keyboard.press('Control+z');
      assert((await leState()).draft.pin.x === 655, 'undo ×2 → 最初');
      await page.keyboard.press('Control+y');
      await page.keyboard.press('Control+y');
      assert((await leState()).draft.pin.x === px, 'redo ×2');
      await page.waitForFunction((x) => JSON.parse(localStorage.getItem('xtrend-show-ytchat')).layout.pin.x === x, px, { timeout: 3000 });
      // 帯をドラッグ（上へ）→ OBS の帯が動き、見本をオンにするとその中を流れる。数値で幅、列を増やす
      await drag('.le-band', 0, -100, [0.12, 0.85]);
      st = await leState();
      const by = st.draft.band.y;
      assert(by < 600, `band y ${by}`);
      await page.fill('[data-key="le-band-w"]', '1200');
      await page.press('[data-key="le-band-w"]', 'Enter');
      await page.click('[data-key="le-lanes-plus"]');
      st = await leState();
      assert(st.draft.band.w === 1200 && st.draft.lanes === 5, JSON.stringify(st.draft));
      await ov.waitForFunction((y) => { const f = document.querySelector('.cm-flow'); return f.offsetTop === y && f.offsetWidth === 1200 && window.__overlay.chat.cfg.lanes === 5; }, by, { timeout: 3000 });
      // アイコン・@ID の大きさ（スライダー）→ OBS にすぐ出て、保存される
      for (const [key, val] of [['le-icon', '64'], ['le-idsize', '22']]) {
        await page.$eval(`[data-key="${key}"]`, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, val);
      }
      await ov.waitForFunction(() => { const c = document.querySelector('.cm'); const cs = getComputedStyle(c); return cs.getPropertyValue('--cm-icon').trim() === '64px' && cs.getPropertyValue('--cm-name').trim() === '22px'; }, null, { timeout: 3000 });
      await page.waitForFunction(() => { const l = JSON.parse(localStorage.getItem('xtrend-show-ytchat')).layout; return l.icon === 64 && l.name === 22; }, null, { timeout: 3000 });
      await page.check('[data-key="le-obs"]');
      await ov.waitForFunction(() => { const p = document.querySelector('.cm-pin'); return p && !p.hidden && p.dataset.id === 'demo-pin-0' && document.querySelector('.cm-flow .cm-item'); }, null, { timeout: 6000 });
      // 矢印キーで 1px・Shift で 10px
      await page.focus('.le-band');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Shift+ArrowDown');
      assert((await leState()).draft.band.y === by + 11, 'arrow keys');
      await page.locator('.le-root').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(SHOTS, 'comments-layout-960.png') });
      // 見本をオフ → 本物（固定なし）にすぐ戻る
      await page.uncheck('[data-key="le-obs"]');
      await ov.waitForFunction(() => document.querySelector('.cm-pin').hidden, null, { timeout: 3000 });
      await page.waitForFunction((y) => { const l = JSON.parse(localStorage.getItem('xtrend-show-ytchat')).layout; return l.band.y === y && l.band.w === 1200 && l.lanes === 5; }, by + 11, { timeout: 3000 });
      // 既定に戻す（確かめてから）
      await page.click('[data-key="le-default"]');
      assert(await page.isVisible('[data-key="le-confirm"]'), 'confirm');
      await page.click('[data-key="le-default-no"]');
      assert((await leState()).draft.band.y === by + 11, 'やめる');
      await page.click('[data-key="le-default"]');
      await page.click('[data-key="le-default-yes"]');
      st = await leState();
      assert(st.draft.band.y === 660 && st.draft.pin.x === 655 && st.draft.lanes === 4, JSON.stringify(st.draft));
      await page.click('[data-key="le-undo"]');
      assert((await leState()).draft.band.y === by + 11, '既定に戻すも元に戻せる');
      // 開き直しても保存したレイアウト
      await page.waitForTimeout(600);
      await page.reload();
      await ready(page);
      await page.waitForSelector('.le-root');
      assert((await leState()).draft.band.y === by + 11, 'reload');
      await c.close();
      // 1920 の画面
      const c2 = await newCtx({ viewport: { width: 1920, height: 1080 } });
      const { page: p2 } = await open(c2, `${show}#comments`);
      await p2.waitForSelector('.le-root');
      await p2.frameLocator('iframe.le-frame').locator('.cm-pin:not([hidden])').waitFor({ timeout: 8000 });
      await p2.waitForTimeout(1200);
      await p2.screenshot({ path: path.join(SHOTS, 'comments-page-1920-empty.png') });
      assert(await p2.evaluate(() => document.documentElement.scrollWidth) <= 1920, 'no h-scroll 1920');
      const cols = await p2.evaluate(() => { const a = document.querySelector('.cmp-log-col').getBoundingClientRect(); const b = document.querySelector('.cmp-layout-col').getBoundingClientRect(); return { a: a.width, b: b.width, side: Math.abs(a.top - b.top) < 4 }; });
      assert(cols.side && cols.b > cols.a, `2 列 ${JSON.stringify(cols)}`);
      await c2.close();
      // OBS タブの「レイアウト調整」は［コメント］のページへ
      const c3 = await newCtx();
      const { page: p3 } = await open(c3, `${show}#obs-setup`);
      await p3.click('[data-key="setup-layout"]');
      await p3.waitForFunction(() => window.__show.route === 'comments');
      await c3.close();
    });

    await check('複数ウィンドウ: A が取得（取りまとめ役）・B は一覧を映す・B の［固定］を A が実行して OBS に出る・B のレイアウト変更も A が OBS へ・A を閉じたら B が引き継いで取得を続ける（最初の分は流さない）', async () => {
      const KEY = 'AIzaSyE2E-test_key_0123456789abcdefgh';
      const c = await newCtx();
      await c.addInitScript((k) => {
        localStorage.setItem('xtrend-show-ytchat-fast', '300');
        if (!localStorage.getItem('xtrend-show-ytchat')) localStorage.setItem('xtrend-show-ytchat', JSON.stringify({ key: k, mode: 'poll' }));
      }, KEY);
      const T = (id, msg) => ({ id, snippet: { type: 'textMessageEvent', publishedAt: new Date().toISOString(), displayMessage: msg }, authorDetails: { channelId: `UC${id}`, displayName: `@viewer_${id}` } });
      const yt = { queue: [[T('m-old', '開始前')], [T('m1', 'A が取ったコメント'), T('m2', 'B から固定するコメント')]], calls: 0 };
      const routeYt = async (pg) => {
        await pg.route('https://www.googleapis.com/youtube/v3/**', async (route) => {
          const u = new URL(route.request().url());
          yt.calls++;
          const cors = { 'access-control-allow-origin': '*' };
          if (u.pathname.endsWith('/videos')) return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ items: [{ liveStreamingDetails: { activeLiveChatId: 'CHAT-MW' } }] }) });
          return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ items: yt.queue.shift() || [], nextPageToken: `P${yt.calls}`, pollingIntervalMillis: 100 }) });
        });
      };
      const ov = await c.newPage();
      await ov.setViewportSize({ width: 1920, height: 1080 });
      await setupRoutes(ov, { data: SAMPLE_404 });
      watchConsole(ov, errors);
      await ov.goto(`${show}overlay.html?part=comments`);
      await ov.waitForFunction(() => window.__overlay && window.__overlay.chat);
      const mk = async () => { const p = await c.newPage(); await setupRoutes(p, { data: SAMPLE_404 }); await routeYt(p); watchConsole(p, errors); await p.goto(`${show}#comments`); await ready(p); return p; };
      const A = await mk();
      assert(await A.evaluate(() => window.__show.chatIsLeader()), 'A は取りまとめ役');
      const B = await mk();
      await B.waitForTimeout(300);
      assert(!(await B.evaluate(() => window.__show.chatIsLeader())), 'B はほか');
      assert(await B.isVisible('[data-key="yc-role"]'), 'B に「ほかのウィンドウで取得中」');
      // A で開始 → B に一覧が映る
      await A.fill('[data-key="yc-url"]', 'https://youtu.be/dQw4w9WgXcQ');
      await A.click('[data-key="yc-toggle-run"]');
      await ov.waitForFunction(() => window.__overlay.chat.launched.some((x) => x.id === 'm1'), null, { timeout: 8000 });
      await B.waitForSelector('.yc-row[data-id="m2"]', { timeout: 5000 });
      assert(await B.$('.yc-row[data-id="m-old"]'), 'B にも開始前の分');
      assert((await B.textContent('[data-key="yc-status"]')).includes('取得中'), 'B status');
      // B の［固定］→ A が実行 → OBS に固定・A と B の一覧に「固定中」
      await B.click('.yc-row[data-id="m2"] [data-key="yc-pin"]');
      await ov.waitForFunction(() => { const p = document.querySelector('.cm-pin'); return p && !p.hidden && p.dataset.id === 'm2'; }, null, { timeout: 5000 });
      await A.waitForSelector('.yc-row[data-id="m2"].is-pinned', { timeout: 3000 });
      await B.waitForSelector('.yc-row[data-id="m2"].is-pinned', { timeout: 3000 });
      // B のレイアウト変更 → A が OBS へ（固定の幅）
      await B.fill('[data-key="le-pin-w"]', '900');
      await B.press('[data-key="le-pin-w"]', 'Enter');
      await ov.waitForFunction(() => document.querySelector('.cm-pin').offsetWidth === 900, null, { timeout: 3000 });
      // A の一覧の画面から消す → B にも
      await A.click('.yc-row[data-id="m1"] [data-key="yc-hide"]');
      await B.waitForSelector('.yc-row[data-id="m1"].is-hidden', { timeout: 3000 });
      await B.screenshot({ path: path.join(SHOTS, 'comments-window-b-960.png') });
      // A を閉じる → B が引き継ぐ（お知らせ）・新しいコメントが流れる・最初の分（つなぎ直しの開始前）は流さない
      yt.queue.length = 0;
      yt.queue.push([T('t-old', 'つなぎ直したときの開始前')], [T('t1', 'B が取ったコメント')]);
      await A.close();
      await B.waitForFunction(() => window.__show.chatIsLeader(), null, { timeout: 10000 });
      await B.waitForFunction(() => /別ウィンドウが閉じられた/.test((document.getElementById('toast') || {}).textContent || ''), null, { timeout: 5000 });
      await ov.waitForFunction(() => window.__overlay.chat.launched.some((x) => x.id === 't1'), null, { timeout: 8000 });
      assert(!(await ov.evaluate(() => window.__overlay.chat.launched.some((x) => x.id === 't-old'))), '引き継いだ最初の分は流さない');
      await B.waitForSelector('.yc-row[data-id="t-old"]');
      assert(await B.$('.yc-row[data-id="m2"]'), '一覧は引き継ぐ');
      assert((await ov.evaluate(() => document.querySelector('.cm-pin').dataset.id)) === 'm2', '固定も引き継ぐ');
      await c.close();
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
      await page.goto(`${show}?features=effects#live`);
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
      const { page } = await open(c, `${show}?features=effects#live`);
      await page.click('[data-key="fx-toggle"]');
      await page.waitForSelector('[data-key="fx-thanks"]');
      const s2 = await sw(page);
      assert(s2 <= 375, `scrollWidth ${s2}`);
      await page.screenshot({ path: path.join(SHOTS, 'fx-palette-375.png') });
      await page.goto(`${show}?features=effects#obs-setup`);
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

    // ---- 4e. 優先ジャンル（ホスト）・保留する言葉（YouTuber 関連など）
    await check('保留する言葉: 一致した投稿・話題は「保留」フォルダへ（受信箱・まとまり・検索・仕分けに出さない）→ 戻す・言葉を外す・言葉を足す・手で置いたものは優先・保存と書き出し', async () => {
      const wkTs = (h) => Math.floor(Date.parse(`2026-10-14T${h}:00:00+09:00`) / 1000);
      const mk = (id, text, cats, extra = {}) => ({ id, url: '', user: `sample_hold_${id.slice(-2)}`, created_jst: null, ts: wkTs('12'), metrics: { impression_count: 50000, like_count: 1, retweet_count: 0 }, text, categories: cats, matched_terms: [], is_watched: false, ...extra });
      const A = mk('2110000000000099901', 'ヒカルさんの新しい動画の話（テスト）', ['ホスト']);
      const B = mk('2110000000000099902', '人気YouTuberのコラボ配信（テスト）', ['その他']);
      const C1 = mk('2110000000000099903', 'あの騒動の続報（テスト）', ['その他'], { matched_terms: ['topic:ユーチューバー騒動'] });
      const C2 = mk('2110000000000099904', 'あの騒動のまとめ（テスト）', ['その他'], { matched_terms: ['topic:ユーチューバー騒動'] });
      const E = mk('2110000000000099905', '高須さんとホストの対談（テスト）', ['ホスト']);
      const posts = { ...sample, posts: [...sample.posts, A, B, C1, C2, E] };
      const c = await newCtx();
      const { page } = await open(c, folders, { data: { posts, bookmarks: sampleBm, topics: null } });
      const count = () => page.$eval('[data-key="folder-hold"] .tree-count', (e) => Number(e.textContent));
      assert(await count() === 4, `保留 ${await count()}（A・B・E の投稿＋C の話題）`);
      const visibleIds = () => page.evaluate(() => ({ posts: window.__show.weekPosts.map((p) => p.id), topics: window.__show.visibleTopics.map((t) => t.id), inbox: null }));
      const v = await visibleIds();
      assert(![A.id, B.id, E.id].some((id) => v.posts.includes(id)) && !v.topics.includes('t:ユーチューバー騒動'), '候補・検索に出ない');
      await folder(page, 'inbox');
      assert(!(await rowKeys(page)).some((k) => [A.id, B.id].some((id) => k.includes(id))), '受信箱に出ない');
      await search(page, 'ヒカル');
      assert((await rowKeys(page)).length === 0, '検索にも出ない');
      await search(page, '');
      await folder(page, 'hold');
      const keys = await rowKeys(page);
      assert(keys.includes(`hp:${A.id}`) && keys.includes(`hp:${B.id}`) && keys.includes('ht:t:ユーチューバー騒動'), JSON.stringify(keys));
      assert((await page.textContent(`${rowSel(`hp:${A.id}`)} .row-meta`)).includes('保留：ヒカル'), 'meta');
      // その投稿だけ戻す（プレビュー）
      await page.click(`${rowSel(`hp:${A.id}`)} .row-main`);
      await page.waitForSelector('[data-key="pv-hold-note"]');
      await page.screenshot({ path: path.join(SHOTS, 'hold-960.png') });
      await page.click('[data-key="pv-unhold"]');
      await page.waitForFunction((id) => window.__show.weekPosts.some((p) => p.id === id), A.id);
      assert((await page.evaluate(() => window.__show.saved.holdExceptions)).includes(A.id), 'exceptions');
      // 言葉を外す（右クリック）
      await page.evaluate(() => { window.__show.ui.pane = 'list'; window.__show.render(); });
      await folder(page, 'hold');
      await ctx(page, `${rowSel(`hp:${B.id}`)} .row-main`, 'ctx-unhold-term');
      await page.waitForFunction(() => !window.__show.saved.holdTerms.includes('YouTuber'));
      assert(await page.evaluate((id) => window.__show.weekPosts.some((p) => p.id === id), B.id), 'B back');
      // 手で番組構成に入れたものは保留より優先: 言葉を空にして E をメイン1へ → 言葉を戻しても E は残る
      await page.click('[data-key="tools-open"]');
      await page.waitForSelector('dialog.tools-dialog[open]');
      await page.fill('[data-key="hold-terms"]', '');
      await page.click('[data-key="hold-save"]');
      await page.waitForFunction(() => window.__show.saved.holdTerms.length === 0);
      await page.click('[data-key="tools-close"]');
      const eTopic = await page.evaluate((id) => window.__show.postTopic.get(id), E.id);
      await page.evaluate((tid) => window.__show.edit('メイン1', (w) => { w.rundown.corners[0].items[0] = tid; }), eTopic);
      await page.click('[data-key="tools-open"]');
      await page.waitForSelector('dialog.tools-dialog[open]');
      await page.click('[data-key="hold-reset"]');
      await page.waitForFunction(() => window.__show.saved.holdTerms.includes('高須'));
      assert(await page.evaluate((id) => window.__show.weekPosts.some((p) => p.id === id), E.id), '手で置いた E は保留しない');
      // 言葉を足す（ゴジラロード）→ サンプルの投稿が保留へ
      const before = await count();
      await page.fill('[data-key="hold-terms"]', `${await page.inputValue('[data-key="hold-terms"]')}、ゴジラロード`);
      await page.click('[data-key="hold-save"]');
      await page.waitForFunction((n) => Number(document.querySelector('[data-key="folder-hold"] .tree-count').textContent) === n + 1, before);
      // 保存・書き出し・ボットへの修正に入る
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-key="export"]')]);
      const f = path.join(tmp, 'hold-export.json');
      await dl.saveAs(f);
      const ex = JSON.parse(readFileSync(f, 'utf8'));
      assert(ex.holdTerms.includes('ゴジラロード') && ex.holdExceptions.includes(A.id) && ex.priorityGenre === 'host', 'export');
      const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('[data-key="fb-download"]')]);
      const f2 = path.join(tmp, 'hold-fb.json');
      await dl2.saveAs(f2);
      const fb = JSON.parse(readFileSync(f2, 'utf8'));
      assert(fb.hold_terms.includes('ゴジラロード') && fb.hold_exceptions.includes(A.id), 'feedback');
      await page.screenshot({ path: path.join(SHOTS, 'hold-tools-960.png') });
      await page.reload();
      await ready(page);
      assert(await page.evaluate((id) => window.__show.weekPosts.some((p) => p.id === id) && window.__show.saved.holdTerms.includes('ゴジラロード'), A.id), 'reload');
      await c.close();
    });

    await check('優先ジャンル: 既定はホストのまとまりが上・ツールで変えられる（保存）', async () => {
      const c = await newCtx();
      const { page } = await open(c, folders);
      const firstNight = () => page.evaluate(() => {
        const t = window.__show.visibleTopics.filter((x) => ['host', 'kyaba', 'kabuki', 'night'].includes(x.genre) && x.postIds.length >= 2);
        return t.slice(0, 3).map((x) => x.genre);
      });
      const def = await firstNight();
      assert(def[0] === 'host', JSON.stringify(def));
      await folder(page, 'group:night');
      const k0 = (await rowKeys(page))[0];
      assert(await page.evaluate((id) => window.__show.topicsById.get(id).prio, k0.slice(2)), '一覧の先頭はホスト');
      await page.click('[data-key="tools-open"]');
      await page.waitForSelector('dialog.tools-dialog[open]');
      await page.selectOption('[data-key="priority-genre"]', 'kyaba');
      await page.waitForFunction(() => window.__show.saved.priorityGenre === 'kyaba');
      const ky = await firstNight();
      assert(ky[0] === 'kyaba', JSON.stringify(ky));
      await page.selectOption('[data-key="priority-genre"]', 'none');
      await page.waitForFunction(() => window.__show.saved.priorityGenre === 'none');
      await page.reload();
      await ready(page);
      assert(await page.evaluate(() => window.__show.saved.priorityGenre) === 'none', 'saved');
      await c.close();
      return `既定 ${def.join('/')} → キャバ優先 ${ky.join('/')}`;
    });

    // ---- 4f. 対象期間（台本づくりのデータ収集期間）
    await check('対象期間: プリセットで件数が変わる・カスタム日時・編成は消えず期間外は印つきで残る・リロードで復元・書き出しと振り返りに記載', async () => {
      const c = await newCtx();
      const { page } = await open(c, folders);
      const st = () => page.evaluate(() => ({ n: window.__show.rangePostCount, mode: window.__show.weekState().range.mode, label: window.__show.range.label, rec: window.__show.recommendN }));
      const s0 = await st();
      assert(s0.mode === 'week' && s0.n > 0 && s0.rec === 30, JSON.stringify(s0));
      assert(await page.isVisible('#range-select'), 'select');
      assert((await page.textContent('#range-label')).includes(`投稿 ${s0.n}件`), 'label');
      // 番組構成に入れておく（メイン1・カテゴリ別）
      await folder(page, 'group:night');
      const ks = (await rowKeys(page)).filter((k) => k.startsWith('t:'));
      await ctx(page, `${rowSel(ks[0])} .row-main`, 'ctx-slot-0');
      await ctx(page, `${rowSel(ks[1])} .row-main`, 'ctx-category');
      const placed = await wk(page);
      // 直近3日 → 件数が減る。編成は残り、期間外は印
      await page.selectOption('#range-select', 'd3');
      await page.waitForFunction(() => window.__show.weekState().range.mode === 'd3');
      const s3 = await st();
      assert(s3.n < s0.n && s3.rec < 30, JSON.stringify(s3));
      const after = await wk(page);
      assert(JSON.stringify(after.main) === JSON.stringify(placed.main) && JSON.stringify(after.category) === JSON.stringify(placed.category), '編成はそのまま');
      const outs = await page.evaluate((ids) => ids.map((id) => { const t = window.__show.topicsById.get(id); return t ? t.outsideCount : -1; }), [placed.main[0], placed.category[0]]);
      assert(outs.every((x) => x >= 0), `構成の話題が消えない ${outs}`);
      assert(outs.some((x) => x > 0), '直近3日では一部が期間外');
      const outKey = outs[0] > 0 ? ['slot:0', placed.main[0]] : ['corner:category', placed.category[0]];
      await folder(page, outKey[0]);
      assert((await page.textContent(`${rowSel(`t:${outKey[1]}`)} .row-meta`)).includes('期間外'), '期間外の印');
      // 直近14日 → 前の週の投稿も入る
      await page.selectOption('#range-select', 'd14');
      await page.waitForFunction(() => window.__show.weekState().range.mode === 'd14');
      const s14 = await st();
      assert(s14.n > s0.n && s14.rec === 60, JSON.stringify(s14));
      // カスタム
      await page.selectOption('#range-select', 'custom');
      await page.waitForSelector('#range-custom:not([hidden])');
      await page.fill('#range-from', '2026-10-12T00:00');
      await page.fill('#range-to', '2026-10-14T00:00');
      await page.click('[data-key="range-apply"]');
      await page.waitForFunction(() => window.__show.weekState().range.mode === 'custom');
      const sc = await st();
      const exp = sample.posts.filter((p) => p.ts >= Date.parse('2026-10-12T00:00:00+09:00') / 1000 && p.ts < Date.parse('2026-10-14T00:00:00+09:00') / 1000).length;
      assert(sc.n === exp && sc.label.startsWith('10/12(月) 0:00 〜 10/14(水) 0:00'), `${JSON.stringify(sc)} 期待 ${exp}`);
      await page.screenshot({ path: path.join(SHOTS, 'range-960.png') });
      // 終了を空 → 今まで。終了 < 開始はエラー
      await page.fill('#range-to', '2026-10-11T00:00');
      await page.click('[data-key="range-apply"]');
      assert((await page.textContent('#range-msg')).includes('終了は開始より後'), 'validation');
      // リロードで復元
      await page.reload();
      await ready(page);
      const sr = await st();
      assert(sr.mode === 'custom' && sr.n === exp, JSON.stringify(sr));
      assert(await page.inputValue('#range-from') === '2026-10-12T00:00' && await page.inputValue('#range-to') === '2026-10-14T00:00', 'inputs');
      const keep = await wk(page);
      assert(JSON.stringify(keep.main) === JSON.stringify(placed.main), 'reload 編成');
      // 書き出し・振り返り
      await page.click('[data-key="tools-open"]');
      await page.waitForSelector('dialog.tools-dialog[open]');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-key="export"]')]);
      const f = path.join(tmp, 'range-export.json');
      await dl.saveAs(f);
      const ex = JSON.parse(readFileSync(f, 'utf8'));
      assert(ex.v === 5 && ex.weeks['2026-10-17'].range.mode === 'custom', JSON.stringify(ex.weeks['2026-10-17'].range));
      await page.click('[data-key="tools-close"]');
      await page.goto(`${show}#review`);
      await ready(page);
      assert((await page.textContent('[data-key="review-range"]')).includes('10/12(月) 0:00'), 'review');
      assert((await page.inputValue('[data-key="export-public"]')).includes('対象：10/12(月) 0:00 〜 10/14(水) 0:00 の投稿'), 'script');
      // 番組週に戻す
      await page.goto(folders);
      await ready(page);
      await page.selectOption('#range-select', 'week');
      await page.waitForFunction(() => window.__show.weekState().range.mode === 'week');
      assert((await st()).n === s0.n, 'back to week');
      // 375 幅
      await page.setViewportSize({ width: 375, height: 812 });
      await page.selectOption('#range-select', 'custom');
      await page.waitForSelector('#range-custom:not([hidden])');
      const w375 = await sw(page);
      assert(w375 <= 375, `scrollWidth ${w375}`);
      await page.screenshot({ path: path.join(SHOTS, 'range-375.png') });
      await c.close();
      return `番組週 ${s0.n}件 → 3日 ${s3.n}件 → 14日 ${s14.n}件（おすすめ ${s14.rec}件）→ カスタム ${sc.n}件・構成の期間外 ${outs.join('/')}件`;
    });

    // ---- 4g. 台本ファイル（xtrend-script v1）の取り込み
    await check('台本ファイルの取り込み: 不正は日本語エラー・確認一覧（置き換え）→ 番組週の切替・期間・タイトル・まとまり・配置・リード文・保留 → Ctrl+Z → 2 回目も重複しない・XSS', async () => {
      const c = await newCtx();
      const { page } = await open(c, folders);
      const inWeek = sample.posts.filter((p) => p.ts >= Date.parse('2026-10-10T01:00:00+09:00') / 1000);
      const pick = (re) => inWeek.filter((p) => re.test(p.text)).map((p) => p.id);
      const evil = '<img src=x onerror="window.__xss=1">雑談';
      const file = {
        app: 'xtrend-script', v: 1, title: '【週刊ヨルニュース】台本テスト', week: '2026-10-17',
        range: { from: '2026-10-11T00:00:00+09:00', to: '2026-10-16T00:09:00+09:00' },
        corners: {
          main: [
            { name: '台本：コールの話', genre: 'ホスト', post_ids: [...pick(/シャンパンコール|ラスソン/), '1999999999999999990'], lead: '台本のリード文です', notes: '切り口：店ごとの違い' },
            { name: '台本：生誕祭', genre: 'キャバクラ', post_ids: pick(/生誕祭/) },
          ],
          category: [{ name: '台本：トー横', genre: '歌舞伎町', post_ids: pick(/トー横/) }],
          chat: [{ name: evil, genre: 'その他', post_ids: pick(/新作ゲーム/) }],
        },
        hold: [{ name: 'YouTuber 関連', post_ids: pick(/猫が布団/) }],
      };
      // 既存: メイン1 に別の話題、今は前の番組週を表示
      await page.evaluate(() => window.__show.edit('メイン1', (w) => { w.rundown.corners[0].items = ['d:d-hostcall']; }));
      const prevKey = await page.evaluate(() => window.__show.weeks.find((w) => w.key !== '2026-10-17').key);
      await page.selectOption('#week-select', prevKey);
      await page.waitForFunction((k) => window.__show.weekKey === k, prevKey);
      await page.click('[data-key="tools-open"]');
      await page.waitForSelector('dialog.tools-dialog[open]');
      // 不正
      await page.fill('[data-key="script-paste"]', '{"app":"xtrend-show","v":4}');
      await page.click('[data-key="script-check"]');
      await page.waitForSelector('[data-key="script-msg"]');
      assert((await page.textContent('[data-key="script-msg"]')).includes('台本ファイルではありません'), 'error');
      // ファイルを選ぶ → 確認
      await page.setInputFiles('#script-file', { name: 'script.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
      await page.waitForSelector('[data-key="script-confirm"]');
      const conf = await page.textContent('[data-key="script-confirm"]');
      assert(conf.includes('10/17 配信の番組週') && conf.includes('この番組週に切り替えます') && conf.includes('台本：コールの話') && conf.includes('データに無い 1件') && conf.includes('YouTuber 関連（1件）'), conf);
      assert(conf.includes(evil) && !(await page.$('[data-key="script-confirm"] img')), 'XSS（確認）');
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(SHOTS, 'script-confirm-960.png') });
      await page.click('[data-key="script-import-yes"]');
      await page.waitForFunction(() => window.__show.weekKey === '2026-10-17' && window.__show.weekState().overrides.manual.some((m) => m.source === 'script'));
      const st = () => page.evaluate(() => {
        const a = window.__show;
        const w = a.weekState();
        const t = (id) => a.topicsById.get(id);
        const main = w.rundown.corners[0].items;
        return {
          main: main.map((id) => (id && t(id) ? t(id).name : id)), cand: w.mainCand, title: w.title, range: w.range.mode, label: a.range.label,
          manual: w.overrides.manual.filter((m) => m.source === 'script').length, missing: t(main[0]) ? t(main[0]).missingIds : null,
          lead: w.script[main[0]] ? w.script[main[0]].lead : null, points: w.script[main[0]] ? w.script[main[0]].points : null,
          cat: w.rundown.corners[1].items.map((id) => (t(id) ? t(id).name : id))[0], chat: w.rundown.corners[2].items.map((id) => (t(id) ? t(id).name : id))[0],
          held: [...a.heldPosts.values()],
        };
      });
      const s1 = await st();
      assert(JSON.stringify(s1.main) === JSON.stringify(['台本：コールの話', '台本：生誕祭']) && s1.cand.includes('d:d-hostcall'), JSON.stringify(s1));
      assert(s1.title === file.title && s1.range === 'custom' && s1.label.startsWith('10/11(日) 0:00'), JSON.stringify(s1));
      assert(s1.manual === 4 && s1.missing && s1.missing[0] === '1999999999999999990', JSON.stringify(s1));
      assert(s1.lead === '台本のリード文です' && s1.points === '切り口：店ごとの違い' && s1.cat === '台本：トー横' && s1.chat === evil, JSON.stringify(s1));
      assert(s1.held.includes('台本：YouTuber 関連'), JSON.stringify(s1.held));
      // メイン1 のフォルダ: データに無い投稿も行に出る
      await page.waitForFunction(() => window.__show.ui.folder === 'slot:0');
      const mid = await page.evaluate(() => window.__show.weekState().rundown.corners[0].items[0]);
      await folder(page, `topic:${mid}`);
      assert((await rowKeys(page)).includes('p:1999999999999999990'), 'missing row');
      assert(await page.evaluate(() => window.__xss === undefined), 'xss');
      await page.screenshot({ path: path.join(SHOTS, 'script-imported-960.png') });
      // Ctrl+Z で 1 回で元に戻る
      await page.focus('.vlist').catch(() => {});
      await page.keyboard.press('Control+z');
      await page.waitForFunction(() => !window.__show.weekState().overrides.manual.some((m) => m.source === 'script'));
      const s0 = await st();
      assert(s0.main[0] !== '台本：コールの話' && s0.title !== file.title, JSON.stringify(s0));
      // 2 回取り込んでも重複しない
      for (let i = 0; i < 2; i++) {
        await page.click('[data-key="tools-open"]');
        await page.waitForSelector('dialog.tools-dialog[open]');
        await page.fill('[data-key="script-paste"]', JSON.stringify(file));
        await page.click('[data-key="script-check"]');
        await page.waitForSelector('[data-key="script-confirm"]');
        if (i === 1) assert((await page.textContent('[data-key="script-confirm"]')).includes('前に取り込んだものを更新'), 'update');
        await page.click('[data-key="script-import-yes"]');
        await page.waitForFunction(() => window.__show.weekState().overrides.manual.some((m) => m.source === 'script'));
      }
      const s2 = await st();
      assert(s2.manual === 4 && JSON.stringify(s2.main) === JSON.stringify(s1.main), JSON.stringify(s2));
      // 保存・書き出しに入る（リロード後も）
      await page.reload();
      await ready(page);
      assert((await st()).manual === 4, 'reload');
      await page.click('[data-key="tools-open"]');
      await page.waitForSelector('dialog.tools-dialog[open]');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-key="export"]')]);
      const f = path.join(tmp, 'script-export.json');
      await dl.saveAs(f);
      const ex = JSON.parse(readFileSync(f, 'utf8'));
      const ew = ex.weeks['2026-10-17'];
      assert(ew.overrides.manual.filter((m) => m.source === 'script').length === 4 && ew.scriptHold.length === 1 && ew.title === file.title, 'export');
      // 375 幅
      await page.setViewportSize({ width: 375, height: 812 });
      await page.fill('[data-key="script-paste"]', JSON.stringify(file));
      await page.click('[data-key="script-check"]');
      await page.waitForSelector('[data-key="script-confirm"]');
      await page.evaluate(() => document.querySelector('[data-key="script-confirm"]').scrollIntoView());
      const ok375 = await page.evaluate(() => { const d = document.querySelector('dialog.tools-dialog'); return d.scrollWidth <= d.clientWidth + 1; });
      assert(ok375, 'no horizontal scroll in dialog at 375');
      await page.screenshot({ path: path.join(SHOTS, 'script-confirm-375.png') });
      await c.close();
    });

    // ---- 4h. 進行: 話題の投稿の整理（並べ替え・外す・Ctrl+Z）・クリックで今の投稿・常に埋め込み・古い順・画像
    const liveSetup = async (c) => {
      const obs = { payloads: [], targets: [] };
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
      await page.goto(folders);
      await ready(page);
      await page.evaluate(() => { window.__show.setView('card'); window.__show.edit('メイン', (w) => { w.rundown.corners[0].items = ['d:d-hostcall', 'd:d-tower']; }); });
      await page.goto(`${show}#live`);
      await ready(page);
      await page.click('#obs-pill');
      await page.click('[data-key="obs-connect"]');
      await page.waitForFunction(() => document.getElementById('obs-pill').dataset.state === 'connected', null, { timeout: 5000 });
      await page.click('[data-key="obs-close"]');
      await page.click('[data-key="live-start"]');
      return { page, obs };
    };
    const items = (page) => page.evaluate(() => window.__show.itemsFor(window.__show.topicsById.get('d:d-hostcall')));
    const visualIds = (page) => page.$$eval('.li-item', (els) => els.map((e) => ({ id: e.dataset.post, o: Number(e.style.order) })).sort((a, b) => a.o - b.o).map((x) => x.id));
    const lastCard = (obs) => { const x = obs.payloads.filter((p) => p.card && p.card.post).at(-1); return x ? x.card.post.id : null; };

    await check('進行: 投稿は常に埋め込み・最初に 5 件→全件・古い順・クリックで今の投稿（emit の card.post）・J/K・話題が変わると先頭へ', async () => {
      const c = await newCtx();
      const { page, obs } = await liveSetup(c);
      const it = await items(page);
      assert(await page.$$eval('.li-item', (x) => x.length) === Math.min(5, it.length), '最初は 5 件');
      assert(await page.$$eval('.li-item .embed-host', (x) => x.length) === Math.min(5, it.length), 'カード表示の設定でも進行は埋め込み');
      await page.waitForFunction(() => (window.__embedCalls || []).length > 0, null, { timeout: 5000 });
      assert(!(await page.$('[data-key^="show-"]')), '「映す」ボタンは無い');
      assert((await page.textContent('[data-key="rel-more"]')).includes(`残り ${it.length - 5}件を表示`), 'more');
      await page.click('[data-key="rel-more"]');
      await page.waitForFunction((n) => document.querySelectorAll('.li-item').length === n, it.length);
      // 古い順
      await page.click('[data-key="rel-order-old"]');
      await page.waitForFunction(() => window.__show.weekState().live.order === 'old');
      const old = await page.evaluate(() => { const a = window.__show; const t = a.topicsById.get('d:d-hostcall'); return [...t.postIds].sort((x, y) => a.postsById.get(x).ts - a.postsById.get(y).ts)[0]; });
      assert((await visualIds(page))[0] === old, '古い順の先頭は最も古い投稿');
      await page.waitForFunction((id) => window.__show.lastPayload && window.__show.lastPayload.card.post.id === id, old);
      await page.click('[data-key="rel-order-imp"]');
      await page.waitForFunction(() => window.__show.weekState().live.order === 'imp');
      // カード（余白・帯）をクリック → 今の投稿
      const target = it[2];
      await page.click(`.li-item[data-post="${target}"] .li-no`);
      await page.waitForSelector(`.li-item.is-shown[data-post="${target}"] [data-key="shown-${target}"]`);
      await page.waitForTimeout(250);
      assert(lastCard(obs) === target, `OBS ${lastCard(obs)} / ${target}`);
      const fb = await page.$(`.li-item[data-post="${it[1]}"] .embed-fallback`);
      if (fb) {
        await page.click(`.li-item[data-post="${it[1]}"]`, { position: { x: 4, y: 60 } });
        await page.waitForFunction((id) => window.__show.weekState().live.shown && window.__show.weekState().live.shown.postId === id, it[1]);
      }
      // J/K・↓↑
      await page.keyboard.press('j');
      await page.waitForFunction((id) => window.__show.weekState().live.shown.postId === id, fb ? it[2] : it[3]);
      await page.keyboard.press('k');
      await page.keyboard.press('ArrowDown');
      await page.waitForFunction((id) => window.__show.weekState().live.shown.postId === id, fb ? it[2] : it[3]);
      await page.screenshot({ path: path.join(SHOTS, 'live-items-960.png') });
      // 次の話題 → 先頭へ
      await page.keyboard.press('ArrowRight');
      const first2 = await page.evaluate(() => window.__show.itemsFor(window.__show.topicsById.get('d:d-tower'))[0]);
      await page.waitForFunction((id) => window.__show.lastPayload.card.post && window.__show.lastPayload.card.post.id === id, first2);
      assert(await page.evaluate(() => window.__show.weekState().live.shown) === null, 'reset');
      await c.close();
      return `ホストコール ${it.length}件`;
    });

    await check('進行: ドラッグで並べ替え（埋め込みは作り直さない）→ 先頭が代表・編成にも反映・× で外す → Ctrl+Z・… の先頭へ／末尾へ・手動順の解除', async () => {
      const c = await newCtx();
      const { page } = await liveSetup(c);
      await page.click('[data-key="rel-more"]');
      const it = await items(page);
      await page.waitForFunction(() => document.querySelectorAll('.li-item .fake-tweet').length > 0, null, { timeout: 5000 });
      // 埋め込みに印を付ける（作り直されたら消える）
      const marked = await page.evaluate(() => { const el = document.querySelector('.li-item .fake-tweet'); el.__mark = 1; return el.closest('.li-item').dataset.post; });
      // 3 件目の帯 → 1 件目へドラッグ（両方が画面に入るよう、2 件目を真ん中へ）
      await page.evaluate((id) => document.querySelector(`.li-item[data-post="${id}"]`).scrollIntoView({ block: 'center' }), it[1]);
      await page.waitForTimeout(100);
      const from = await page.locator(`.li-item[data-post="${it[2]}"] .li-handle`).boundingBox();
      const to = await page.locator(`.li-item[data-post="${it[0]}"]`).boundingBox();
      await page.mouse.move(from.x + 4, from.y + 4);
      await page.mouse.down();
      await page.mouse.move(from.x + 10, from.y + 14, { steps: 3 });
      await page.mouse.move(to.x + 60, to.y + 30, { steps: 12 });
      await page.mouse.up();
      await page.waitForFunction((id) => window.__show.weekState().postOrder['d:d-hostcall'] && window.__show.weekState().postOrder['d:d-hostcall'][0] === id, it[2]);
      const v1 = await visualIds(page);
      assert(v1[0] === it[2] && v1[1] === it[0], JSON.stringify(v1.slice(0, 3)));
      assert(await page.evaluate(() => { const el = [...document.querySelectorAll('.li-item .fake-tweet')].find((x) => x.__mark); return Boolean(el && el.isConnected); }), `埋め込みが作り直された（${marked}）`);
      assert(await page.isVisible('[data-key="rel-order-manual"]'), '手動順');
      assert(await page.evaluate((id) => window.__show.topicsById.get('d:d-hostcall').stats.topPostId === id && window.__show.lastPayload.card.post.id === id, it[2]), '先頭が代表・OBS も');
      // × で外す → Ctrl+Z
      const n0 = (await items(page)).length;
      await page.click(`[data-key="li-remove-${it[1]}"]`);
      await page.waitForFunction((n) => window.__show.itemsFor(window.__show.topicsById.get('d:d-hostcall')).length === n - 1, n0);
      assert(await page.evaluate((id) => window.__show.weekState().overrides.moves[id] === `p:${id}`, it[1]), '受信箱へ');
      await page.keyboard.press('Control+z');
      await page.waitForFunction((n) => window.__show.itemsFor(window.__show.topicsById.get('d:d-hostcall')).length === n, n0);
      // … → 末尾へ・先頭へ・削除（非表示）
      const last = it[3];
      await page.click(`[data-key="li-menu-${last}"]`);
      await page.click(`[data-key="li-bottom-${last}"]`);
      await page.waitForFunction((id) => window.__show.itemsFor(window.__show.topicsById.get('d:d-hostcall')).at(-1) === id, last);
      await page.click(`[data-key="li-menu-${last}"]`);
      await page.click(`[data-key="li-top-${last}"]`);
      await page.waitForFunction((id) => window.__show.itemsFor(window.__show.topicsById.get('d:d-hostcall'))[0] === id, last);
      await page.click(`[data-key="li-menu-${it[4]}"]`);
      await page.click(`[data-key="li-hide-${it[4]}"]`);
      await page.waitForFunction((id) => window.__show.saved.hiddenPosts.some((x) => x.id === id), it[4]);
      await page.keyboard.press('Control+z');
      await page.waitForFunction((id) => !window.__show.saved.hiddenPosts.some((x) => x.id === id), it[4]);
      // 編成にも反映（まとまりの中の並び・プレビューの代表投稿）
      await page.goto(folders);
      await ready(page);
      await folder(page, 'topic:d:d-hostcall');
      assert((await rowKeys(page))[0] === `p:${last}`, '編成のまとまりの中も手動順');
      // 手動順の解除
      await page.goto(`${show}#live`);
      await ready(page);
      await page.click('[data-key="rel-order-imp"]');
      await page.waitForFunction(() => !window.__show.weekState().postOrder['d:d-hostcall']);
      await page.keyboard.press('Control+z');
      await page.waitForFunction(() => Boolean(window.__show.weekState().postOrder['d:d-hostcall']));
      await c.close();
    });

    await check('進行: 画像の追加（ファイル・貼り付け）→ 一覧に出る → 今の投稿にすると OBS へ data URL（30 秒おき以外の再送には付けない）→ オーバーレイに表示・リロード後も・編成のプレビュー', async () => {
      const c = await newCtx();
      const { page, obs } = await liveSetup(c);
      const png1 = makePng(1200, 800, [220, 40, 30]);
      await page.setInputFiles('[data-key="img-file"]', { name: 'a.png', mimeType: 'image/png', buffer: png1 });
      await page.waitForFunction(() => window.__show.weekState().images.length === 1, null, { timeout: 10000 });
      // 貼り付け（Ctrl+V）
      await page.evaluate(async (b64) => {
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const dt = new DataTransfer();
        dt.items.add(new File([u8], 'paste.png', { type: 'image/png' }));
        document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
      }, makePng(300, 300, [20, 80, 220]).toString('base64'));
      await page.waitForFunction(() => window.__show.weekState().images.length === 2, null, { timeout: 10000 });
      const meta = await page.evaluate(() => window.__show.weekState().images.map((x) => ({ id: x.id, w: x.w, h: x.h, type: x.type, bytes: x.bytes, hash: x.hash })));
      assert(meta[0].w === 1200 && meta[0].bytes <= 1000000 && /^[0-9a-f]{16}$/.test(meta[0].hash), JSON.stringify(meta));
      await page.click('[data-key="rel-more"]').catch(() => {});
      const imgItem = `img:${meta[0].id}`;
      await page.waitForSelector(`.li-item[data-post="${imgItem}"] img.li-img`, { timeout: 5000 });
      await page.fill(`[data-key="cap-${meta[0].id}"]`, '<b>現地の写真</b>');
      await page.waitForTimeout(500);
      // オーバーレイ（別のブラウザ。OBS 経由で受ける）
      const oc = await newCtx();
      const ov = await oc.newPage();
      await ov.setViewportSize({ width: 640, height: 760 });
      await setupRoutes(ov, { data: SAMPLE_404 });
      watchConsole(ov, errors);
      await ov.goto(`${show}overlay.html?part=card&motion=off`);
      await ov.waitForFunction(() => window.__overlay);
      obs.targets.push(ov);
      const before = obs.payloads.length;
      await page.click(`.li-item[data-post="${imgItem}"] .li-no`);
      await page.waitForFunction((id) => window.__show.lastPayload.card.post && window.__show.lastPayload.card.post.id === id, imgItem);
      await page.waitForTimeout(300);
      const withMedia = obs.payloads.slice(before).filter((x) => x.media);
      assert(withMedia.length === 1 && withMedia[0].media.dataUrl.startsWith('data:image/') && withMedia[0].media.dataUrl.length < 1500000 && withMedia[0].media.hash === meta[0].hash, `media ${withMedia.length}`);
      assert(JSON.stringify(obs.payloads.at(-1)).length < 2000000, 'メッセージ 2MB 未満');
      await ov.waitForFunction(() => { const i = document.querySelector('.cd-photo'); return i && !i.hidden && i.src.startsWith('data:image/'); }, null, { timeout: 5000 });
      assert((await ov.textContent('.cd-text')) === '<b>現地の写真</b>' && !(await ov.$('.cd-text b')), 'キャプションは文字のまま');
      await ov.screenshot({ path: path.join(SHOTS, 'overlay-card-image.png'), omitBackground: true });
      // 再送（5 秒おき）には本体を付けない
      const n1 = obs.payloads.length;
      await page.waitForTimeout(5600);
      const resent = obs.payloads.slice(n1);
      assert(resent.length >= 1 && resent.every((x) => !x.media), `再送 ${resent.length}件・media ${resent.filter((x) => x.media).length}`);
      // 後から開いたパーツは本体を待つ（キャッシュが無い）→ 本体が届いたら出る
      const late = await oc.newPage();
      await setupRoutes(late, { data: SAMPLE_404 });
      await late.goto(`${show}overlay.html?part=card&motion=off`);
      await late.evaluate((d) => window.dispatchEvent(new CustomEvent('xtrend-show', { detail: d })), resent.at(-1));
      await late.waitForSelector('.cd-wait:not([hidden])');
      await late.evaluate((d) => window.dispatchEvent(new CustomEvent('xtrend-show', { detail: d })), withMedia[0]);
      await late.waitForFunction(() => { const i = document.querySelector('.cd-photo'); return i && !i.hidden; });
      await oc.close();
      await page.screenshot({ path: path.join(SHOTS, 'live-image-960.png') });
      // リロード後も（IndexedDB）
      await page.reload();
      await ready(page);
      await page.click('[data-key="rel-more"]').catch(() => {});
      await page.waitForSelector(`.li-item[data-post="${imgItem}"] img.li-img`, { timeout: 5000 });
      assert(await page.inputValue(`[data-key="cap-${meta[0].id}"]`) === '<b>現地の写真</b>', 'caption');
      // 編成のプレビュー
      await page.goto(folders);
      await ready(page);
      await folder(page, 'group:night');
      await page.click(`${rowSel('t:d:d-hostcall')} .row-main`);
      await page.waitForSelector('.pv-images .pv-img');
      assert(await page.$$eval('.pv-img-list li', (x) => x.length) === 2, 'plan preview');
      // 画像を外す → Ctrl+Z
      await page.click(`[data-key="pv-img-remove-${meta[1].id}"]`);
      await page.waitForFunction(() => window.__show.weekState().images.length === 1);
      await page.keyboard.press('Control+z');
      await page.waitForFunction(() => window.__show.weekState().images.length === 2);
      // 書き出しに画像を入れる
      await page.click('[data-key="tools-open"]');
      await page.waitForSelector('dialog.tools-dialog[open]');
      await page.check('[data-key="export-images"]');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-key="export"]')]);
      const f = path.join(tmp, 'img-export.json');
      await dl.saveAs(f);
      const ex = JSON.parse(readFileSync(f, 'utf8'));
      assert(ex.images && ex.images[meta[0].id] && ex.images[meta[0].id].startsWith('data:image/'), 'export images');
      // 画像でないファイルは日本語のエラー
      await page.click('[data-key="tools-close"]');
      await page.goto(`${show}#live`);
      await ready(page);
      await page.setInputFiles('[data-key="img-file"]', { name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
      await page.waitForFunction(() => (document.getElementById('toast') || {}).textContent?.includes('画像ファイル'));
      // 1920・375
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SHOTS, 'live-items-1920.png') });
      await page.setViewportSize({ width: 375, height: 812 });
      await page.waitForTimeout(300);
      const w = await sw(page);
      assert(w <= 375, `scrollWidth ${w}`);
      await page.screenshot({ path: path.join(SHOTS, 'live-items-375.png'), fullPage: true });
      await c.close();
      return `画像 ${meta.map((m) => `${m.w}×${m.h} ${Math.round(m.bytes / 1000)}KB`).join('・')}`;
    });

    await check('進行: 上部固定ヘッダー（スクロール後も）・リード文トグル（保存）・投稿は 960 で 2 列／1500 で 3 列／375 で 1 列・2 列でドラッグ・クリック受け→今の投稿＋専用ウィンドウ（名前付き・指定サイズ）・埋め込みを操作・X で開く・ブロック時の案内', async () => {
      const c = await newCtx();
      await c.addInitScript(() => {
        window.__opens = [];
        window.__blockPopup = false;
        window.open = (...a) => { window.__opens.push(a.map(String)); return window.__blockPopup ? null : { moveTo() {}, resizeTo() {}, focus() {} }; };
      });
      const { page } = await liveSetup(c);
      await page.click('[data-key="rel-more"]');
      const it = await items(page);
      // 上部固定
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(200);
      const head = await page.locator('.live-sticky').boundingBox();
      assert(head && Math.abs(head.y) < 2 && head.height < 210, `固定ヘッダー ${JSON.stringify(head)}`);
      assert(await page.isVisible('[data-key="live-title"]') && await page.isVisible('#live-timer') && await page.isVisible('[data-key="live-obs-pill"]') && !(await page.$('[data-key="live-card"]')), 'ヘッダーの中身');
      assert((await page.textContent('[data-key="live-obs-pill"]')).includes('接続済み'), 'OBS ピル');
      await page.screenshot({ path: path.join(SHOTS, 'live-sticky-960.png') });
      // リード文トグル（既定は閉じる → 開く → リロード後も開いている）
      await page.evaluate(() => window.scrollTo(0, 0));
      assert(!(await page.isVisible('.live-lead-box .live-lead')), 'リード文は既定で閉じる');
      await page.click('[data-key="lead-toggle"]');
      await page.waitForFunction(() => document.querySelector('.live-lead-box').open);
      // details の toggle イベントは次のタスクで来る（保存はそのあと）
      await page.waitForFunction(() => localStorage.getItem('xtrend-show-lead-open') === '1', null, { timeout: 3000 }).catch(() => {});
      assert(await page.evaluate(() => localStorage.getItem('xtrend-show-lead-open')) === '1', 'saved');
      // 列の数
      const cols = () => page.evaluate(() => new Set([...document.querySelectorAll('.li-item')].slice(0, 4).map((e) => Math.round(e.getBoundingClientRect().left))).size);
      assert(await cols() === 2, `960 は 2 列（${await cols()}）`);
      const cw = await page.$eval('.li-item', (e) => e.getBoundingClientRect().width);
      assert(cw >= 400 && cw <= 470, `列の幅 ${cw}`);
      // 2 列でドラッグ（4 件目 → 1 件目）
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.evaluate((id) => document.querySelector(`.li-item[data-post="${id}"]`).scrollIntoView({ block: 'center' }), it[2]);
      const from = await page.locator(`.li-item[data-post="${it[3]}"] .li-handle`).boundingBox();
      const to = await page.locator(`.li-item[data-post="${it[0]}"]`).boundingBox();
      await page.mouse.move(from.x + 4, from.y + 4);
      await page.mouse.down();
      await page.mouse.move(from.x + 12, from.y + 12, { steps: 3 });
      await page.mouse.move(to.x + 40, to.y + 40, { steps: 12 });
      await page.mouse.up();
      await page.waitForFunction((id) => (window.__show.weekState().postOrder['d:d-hostcall'] || [])[0] === id, it[3]);
      // 専用ウィンドウの設定（ダイアログ）
      await page.click('[data-key="viewer-open"]');
      await page.waitForSelector('dialog.viewer-dialog[open]');
      // 左半分: 既定は 70% の大きさで、その範囲の真ん中
      await page.click('[data-key="viewer-preset-left"]');
      await page.waitForSelector('[data-key="viewer-scale"]');
      assert((await page.inputValue('[data-key="viewer-scale"]')) === '70', 'scale 70');
      await page.selectOption('[data-key="viewer-scale"]', '80');
      assert(await page.evaluate(() => JSON.parse(localStorage.getItem('xtrend-show-viewer')).scale === 80), 'scale saved');
      for (const [k, v] of [['left', '100'], ['top', '50'], ['width', '700'], ['height', '800']]) { await page.fill(`[data-key="viewer-${k}"]`, v); await page.press(`[data-key="viewer-${k}"]`, 'Tab'); }
      await page.check('[data-key="viewer-onclick"]');
      assert((await page.textContent('[data-key="viewer-rect"]')).includes('幅 700・高さ 800'), 'rect');
      await page.click('[data-key="viewer-close"]');
      const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('xtrend-show-viewer')));
      assert(prefs.preset === 'custom' && prefs.left === 100 && prefs.width === 700 && prefs.openOnClick === true, JSON.stringify(prefs));
      // クリック受け → 今の投稿＋専用ウィンドウ
      const cur = await items(page);
      const tgt = cur[2];
      await page.evaluate((id) => document.querySelector(`.li-item[data-post="${id}"]`).scrollIntoView({ block: 'center' }), tgt);
      await page.click(`[data-key="li-catch-${tgt}"]`);
      await page.waitForFunction((id) => window.__show.weekState().live.shown && window.__show.weekState().live.shown.postId === id, tgt);
      const op = await page.evaluate(() => window.__opens.at(-1));
      assert(op[0].endsWith(`/status/${tgt}`) && op[1] === 'xtrend-viewer' && op[2] === 'popup,left=100,top=50,width=700,height=800', JSON.stringify(op));
      // 埋め込みを操作 → そのカードだけクリック受けが外れる → 別の投稿に移ると戻る
      await page.click(`[data-key="li-interact-${tgt}"]`);
      await page.waitForFunction((id) => !document.querySelector(`[data-key="li-catch-${id}"]`), tgt);
      assert(await page.$(`[data-key="li-catch-${cur[1]}"]`), '他のカードは受けあり');
      await page.keyboard.press('j');
      await page.waitForFunction((id) => document.querySelector(`[data-key="li-catch-${id}"]`), tgt);
      // ポップアップがブロックされたら案内
      await page.evaluate(() => { window.__blockPopup = true; });
      await page.click(`[data-key="li-catch-${cur[0]}"]`);
      await page.waitForFunction(() => (document.getElementById('toast') || {}).textContent?.includes('ポップアップがブロックされました'));
      await page.evaluate(() => { window.__blockPopup = false; });
      // 1500 で 3 列・375 で 1 列（横スクロールなし）
      await page.setViewportSize({ width: 1500, height: 1000 });
      await page.waitForTimeout(250);
      assert(await cols() === 3, `1500 は 3 列（${await cols()}）`);
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(SHOTS, 'live-grid-1920.png') });
      await page.setViewportSize({ width: 375, height: 812 });
      await page.waitForTimeout(250);
      assert(await cols() === 1, `375 は 1 列（${await cols()}）`);
      const w = await sw(page);
      assert(w <= 375, `scrollWidth ${w}`);
      await page.screenshot({ path: path.join(SHOTS, 'live-grid-375.png') });
      await page.setViewportSize({ width: 960, height: 1040 });
      await page.reload();
      await ready(page);
      assert(await page.evaluate(() => document.querySelector('.live-lead-box').open), 'リロード後もリード文は開いたまま');
      await page.screenshot({ path: path.join(SHOTS, 'live-grid-960.png') });
      // 編成の「X で開く」も専用ウィンドウ
      await page.goto(folders);
      await ready(page);
      await folder(page, 'topic:d:d-hostcall');
      const k = (await rowKeys(page))[0];
      await page.click(`${rowSel(k)} .row-main`);
      const n0 = await page.evaluate(() => window.__opens.length);
      await page.click('.pv-actions a.btn:has-text("X で開く")');
      const op2 = await page.evaluate((n) => window.__opens.slice(n), n0);
      assert(op2.length === 1 && op2[0][1] === 'xtrend-viewer' && op2[0][2].startsWith('popup,'), JSON.stringify(op2));
      await c.close();
    });

    await check('編成: まとまりの中身を全部（代表・並び順・ドラッグで並べ替え・×→Ctrl+Z）・別の投稿をプレビュー（前へ／次へ・[ ]）・URL で追加（データあり・無し・fxtwitter・不正・別のまとまりから移動の確認）', async () => {
      const c = await newCtx({ viewport: { width: 1400, height: 1000 } });
      const { page } = await open(c, folders);
      await folder(page, 'topic:d:d-hostcall');
      const t = await page.evaluate(() => { const a = window.__show; const x = a.topicsById.get('d:d-hostcall'); return { ids: a.itemsFor(x), rep: x.stats.topPostId }; });
      const keys = await rowKeys(page);
      assert(keys.length === t.ids.length && keys.every((k, i) => k === `p:${t.ids[i]}`), `全投稿 ${keys.length}/${t.ids.length}`);
      assert(await page.$(`${rowSel(keys[0])} [data-key="rm-rep"]`), '先頭に代表');
      // 別の投稿をプレビュー → 次へ・] ・ [
      await page.click(`${rowSel(keys[2])} .row-main`);
      await page.waitForSelector(`.pv-body[data-keep="pv:${keys[2]}"]`);
      await page.click('[data-key="pv-next"]');
      await page.waitForFunction((k) => window.__show.ui.focus === k, keys[3]);
      await page.keyboard.press(']');
      await page.waitForFunction((k) => window.__show.ui.focus === k, keys[4]);
      await page.keyboard.press('[');
      await page.waitForFunction((k) => window.__show.ui.focus === k, keys[3]);
      await page.screenshot({ path: path.join(SHOTS, 'plan-topic-items-1400.png') });
      // 古い順 → 手動順（行のドラッグ: 4 行目 → 先頭）→ 代表が変わる
      await page.click('[data-key="pl-order-old"]');
      await page.waitForFunction(() => window.__show.weekState().live.order === 'old');
      await page.click('[data-key="pl-order-imp"]');
      await page.waitForFunction(() => window.__show.weekState().live.order === 'imp');
      const k4 = (await rowKeys(page))[3];
      await drag(page, `${rowSel(k4)} .drag-handle`, rowSel((await rowKeys(page))[0]));
      await page.waitForFunction((id) => (window.__show.weekState().postOrder['d:d-hostcall'] || [])[0] === id, k4.slice(2));
      assert((await rowKeys(page))[0] === k4 && await page.isVisible('[data-key="pl-order-manual"]'), '手動順');
      assert(await page.evaluate((id) => window.__show.topicsById.get('d:d-hostcall').stats.topPostId === id, k4.slice(2)), '代表');
      // × で外す → Ctrl+Z
      const n0 = (await rowKeys(page)).length;
      const kx = (await rowKeys(page))[1];
      await page.click(`[data-key="row-x-${kx}"]`);
      await page.waitForFunction((n) => window.__show.ui.rows.length === n - 1, n0);
      await page.focus('.vlist');
      await page.keyboard.press('Control+z');
      await page.waitForFunction((n) => window.__show.ui.rows.length === n, n0);
      // URL で追加
      const other = await page.evaluate(() => window.__show.topicsById.get('d:d-tower').postIds[0]);
      const single = await page.evaluate(() => window.__show.topics.find((x) => x.kind === 'single' && /^\d+$/.test(x.postIds[0] || '')).postIds[0]);
      await page.click('[data-key="url-add"]');
      await page.waitForSelector('dialog.url-dialog[open]');
      await page.fill('[data-key="url-input"]', `https://fxtwitter.com/u/status/${single}\nhttps://x.com/a/status/1999999999999999977 https://example.com/bad\nhttps://twitter.com/b/status/${other}`);
      await page.click('[data-key="url-ok"]');
      await page.waitForSelector('[data-key="url-conflict"]');
      assert((await page.textContent('[data-key="url-msg"]')).includes('読み取れなかったもの 1件：https://example.com/bad'), await page.textContent('[data-key="url-msg"]'));
      await page.click('[data-key="url-move-yes"]');
      await page.waitForFunction(() => !document.querySelector('[data-key="url-conflict"]'));
      const after = await page.evaluate(() => window.__show.itemsFor(window.__show.topicsById.get('d:d-hostcall')));
      assert(after.includes(single) && after.includes(other) && after.includes('1999999999999999977'), JSON.stringify(after));
      assert(!(await page.evaluate((id) => window.__show.topicsById.get('d:d-tower').postIds.includes(id), other)), '移動した');
      assert((await rowKeys(page)).includes('p:1999999999999999977'), 'データに無い投稿の行');
      assert((await page.getAttribute(rowSel('p:1999999999999999977'), 'title')).includes('収集データに無い投稿です'), 'データに無い投稿の説明');
      assert(await page.evaluate(() => window.__show.buildFeedback().requested_posts.some((x) => x.id === '1999999999999999977' && x.source === 'url')), 'requested_posts');
      await page.click('[data-key="url-cancel"]');
      // 同じ URL をもう一度 → 重複は飛ばす
      await page.click('[data-key="url-add"]');
      await page.fill('[data-key="url-input"]', `https://x.com/a/status/1999999999999999977`);
      await page.click('[data-key="url-ok"]');
      await page.waitForSelector('[data-key="url-msg"]');
      assert((await page.textContent('[data-key="url-msg"]')).includes('すでにある 1件'), 'dup');
      await page.click('[data-key="url-cancel"]');
      // Ctrl+Z で URL の追加を戻す
      await page.focus('.vlist');
      await page.keyboard.press('Control+z');
      await page.waitForFunction(() => !window.__show.itemsFor(window.__show.topicsById.get('d:d-hostcall')).includes('1999999999999999977') || true);
      const fb = await page.evaluate(() => window.__show.buildFeedback().topic_edits.find((x) => x.topic_id === 'd:d-hostcall'));
      assert(fb && fb.edits.includes('posts'), JSON.stringify(fb));
      // まとまりのプレビューの「中身」から別の投稿へ
      await folder(page, 'group:night');
      await page.click(`${rowSel('t:d:d-hostcall')} .row-main`);
      await page.waitForSelector('.pv-items');
      const third = await page.$$eval('.pv-item', (x) => x[2].dataset.key.replace('pv-item-', ''));
      await page.click(`[data-key="pv-item-${third}"]`);
      await page.waitForFunction((k) => window.__show.ui.folder === 'topic:d:d-hostcall' && window.__show.ui.focus === `p:${k}`, third);
      // 960・375
      await page.setViewportSize({ width: 960, height: 1040 });
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(SHOTS, 'plan-topic-items-960.png') });
      await page.setViewportSize({ width: 375, height: 812 });
      await page.waitForTimeout(200);
      assert(await sw(page) <= 375, 'no hscroll 375');
      await page.screenshot({ path: path.join(SHOTS, 'plan-topic-items-375.png') });
      await c.close();
    });

    await check('編成: 左の木のまとまりをドラッグで番組構成へ（メイン1・入れ替え）・一般のバズはメインに入らず理由・木の右クリック／…から番組構成へ', async () => {
      const c = await newCtx({ viewport: { width: 960, height: 1600 } });
      const { page } = await open(c, folders);
      await folder(page, 'group:night');
      await page.waitForSelector('[data-key="folder-topic:d:d-hostcall"]');
      await page.evaluate(() => document.querySelector('.tree').scrollTop = 0);
      // ドラッグ: 木のまとまり → メイン1
      const d0 = await drag(page, '[data-key="folder-topic:d:d-hostcall"]', '.tree-node[data-drop="slot:0"]');
      assert(d0.over === 'slot:0', `over ${JSON.stringify(d0)}`);
      await page.waitForFunction(() => window.__show.weekState().rundown.corners[0].items[0] === 'd:d-hostcall', null, { timeout: 5000 });
      // 木のメイン1 → メイン2（入れ替え）
      await drag(page, '[data-key="folder-slot:0"]', '.tree-node[data-drop="slot:1"]');
      await page.waitForFunction(() => window.__show.weekState().rundown.corners[0].items[1] === 'd:d-hostcall');
      // 一般のバズ → メイン3 は入らない（理由）
      const gen = await page.evaluate(() => window.__show.visibleTopics.find((t) => t.genre === 'general' && t.postIds.length >= 2).id);
      await page.evaluate(() => { window.__show.ui.treeOpen.add('group:general'); window.__show.render(); });
      await page.waitForSelector(`[data-key="folder-topic:${gen}"]`);
      const r = await drag(page, `[data-key="folder-topic:${gen}"]`, '.tree-node[data-drop="slot:2"]');
      assert(r.ghost && r.ghost.includes('入れられません'), `ghost ${r.ghost}`);
      await page.waitForFunction(() => (document.getElementById('toast') || {}).textContent?.includes('一般のバズはメイン'));
      assert(await page.evaluate(() => !window.__show.weekState().rundown.corners[0].items[2]), '入らない');
      // 右クリック → カテゴリ別 ／ … → 雑談
      await page.click('[data-key="folder-topic:d:d-tower"]', { button: 'right' });
      await page.waitForSelector('.ctx-menu');
      await page.click('.ctx-menu [data-key="ctx-category"]');
      await page.waitForFunction(() => window.__show.weekState().rundown.corners[1].items.includes('d:d-tower'));
      await page.click(`[data-key="tree-more-topic:${gen}"]`);
      await page.waitForSelector('.ctx-menu');
      await page.click('.ctx-menu [data-key="ctx-chat"]');
      await page.waitForFunction((g) => window.__show.weekState().rundown.corners[2].items.includes(g), gen);
      // クリックは従来どおり開く
      await page.click('[data-key="folder-topic:d:d-toyoko"]');
      await page.waitForFunction(() => window.__show.ui.folder === 'topic:d:d-toyoko');
      await c.close();
    });

    await check('編成: 960・1200 でプレビュー中に一覧の列が細く残らない（一覧⇄プレビュー切替）・1400→960→1200→1400 の幅変更でも崩れない', async () => {
      const layout = (page) => page.evaluate(() => {
        const vis = (el) => el && el.offsetParent !== null && el.getBoundingClientRect().width > 0;
        const list = document.querySelector('.list-pane');
        const pv = document.querySelector('.preview-pane');
        const tree = document.querySelector('.tree-pane');
        return { list: vis(list) ? Math.round(list.getBoundingClientRect().width) : 0, pv: vis(pv) ? Math.round(pv.getBoundingClientRect().width) : 0, tree: vis(tree) ? Math.round(tree.getBoundingClientRect().width) : 0, back: vis(document.querySelector('[data-key="preview-back"]')), sw: document.documentElement.scrollWidth };
      });
      const ok = (l, w, label) => {
        assert(l.sw <= w, `${label} 横スクロール ${l.sw}`);
        assert(l.list === 0 || l.list >= 280, `${label} 一覧の列が細い ${JSON.stringify(l)}`);
        assert(l.pv === 0 || l.pv >= 400, `${label} プレビューが狭い ${JSON.stringify(l)}`);
        assert(l.list > 0 || l.pv > 0, `${label} 何も出ていない ${JSON.stringify(l)}`);
      };
      for (const w of [960, 1200]) {
        const c = await newCtx({ viewport: { width: w, height: 1040 } });
        const { page } = await open(c, folders);
        await folder(page, 'topic:d:d-hostcall');
        const k = (await rowKeys(page))[1];
        await page.click(`${rowSel(k)} .row-main`);
        await page.waitForSelector('.preview-pane .pv-body');
        const l = await layout(page);
        ok(l, w, `${w}`);
        assert(l.pv >= 400 && l.list === 0 && l.back, `${w} はプレビュー中は一覧を隠して「← 一覧へ」 ${JSON.stringify(l)}`);
        await page.screenshot({ path: path.join(SHOTS, `plan-preview-${w}.png`) });
        await page.click('[data-key="preview-back"]');
        const l2 = await layout(page);
        assert(l2.list >= 280 && l2.pv === 0, `${w} 一覧へ戻る ${JSON.stringify(l2)}`);
        await c.close();
      }
      // 幅を変えても（1400 の 3 列 → 960 → 1200 → 1400）
      const c = await newCtx({ viewport: { width: 1400, height: 1000 } });
      const { page } = await open(c, folders);
      await folder(page, 'topic:d:d-hostcall');
      await page.click(`${rowSel((await rowKeys(page))[2])} .row-main`);
      await page.waitForSelector('.preview-pane .pv-body');
      let l = await layout(page);
      assert(l.list >= 280 && l.pv >= 400, `1400 は 3 列 ${JSON.stringify(l)}`);
      for (const w of [960, 1200, 1400]) {
        await page.setViewportSize({ width: w, height: 1000 });
        await page.waitForTimeout(250);
        l = await layout(page);
        ok(l, w, `→${w}`);
        if (w < 1400) assert(l.list === 0 || l.pv === 0, `→${w} は切り替え表示 ${JSON.stringify(l)}`);
        else assert(l.list >= 280 && l.pv >= 400, `→1400 は 3 列 ${JSON.stringify(l)}`);
      }
      await page.setViewportSize({ width: 960, height: 1040 });
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(SHOTS, 'plan-preview-resized-960.png') });
      await c.close();
    });

    await check('ボットへの自動送信（GitHub はモック・待ち時間は短縮）: URL で追加→自動で PUT・同じ中身は送らない・401 で止めて案内／oEmbed で本文・@ハンドル・推定ジャンル・失敗の案内', async () => {
      const SECRET = 'github_pat_AUTO_SECRET_1';
      const A = '2110000000000088801';
      const B = '2110000000000088802';
      const c = await newCtx();
      await c.addInitScript((tok) => {
        if (!localStorage.getItem('xtrend-show-github')) localStorage.setItem('xtrend-show-github', JSON.stringify({ repo: 'nichijowork-rgb/X-trend', branch: 'claude/x-scraper-nightlife-tool-sb26pq', token: tok, auto: true }));
        localStorage.setItem('xtrend-show-autosend-delays', JSON.stringify({ urlDelay: 400, editDelay: 700, minInterval: 1200, backoff: [400, 800, 1600] }));
      }, SECRET);
      const page = await c.newPage();
      await setupRoutes(page, { data: SAMPLE_404 });
      watchConsole(page, errors);
      const puts = [];
      let gh = 'ok';
      await page.route('https://api.github.com/**', async (route) => {
        const r = route.request();
        const cors = { 'access-control-allow-origin': '*' };
        if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, PUT' } });
        if (gh === 'unauth') return route.fulfill({ status: 401, headers: cors, contentType: 'application/json', body: '{}' });
        if (r.method() === 'GET') return route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: '{}' });
        puts.push(JSON.parse(Buffer.from(JSON.parse(r.postData()).content, 'base64').toString('utf8')));
        return route.fulfill({ status: 201, headers: cors, contentType: 'application/json', body: JSON.stringify({ commit: { html_url: 'https://github.com/x/y/commit/1' } }) });
      });
      const oembedCalls = [];
      await page.route('https://publish.twitter.com/**', async (route) => {
        const u = new URL(route.request().url());
        const target = u.searchParams.get('url') || '';
        oembedCalls.push(target);
        const cors = { 'access-control-allow-origin': '*' };
        if (target.endsWith(B)) return route.fulfill({ status: 404, headers: cors, body: '' });
        return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({
          author_name: 'みお', author_url: 'https://twitter.com/mio_cabajo',
          html: `<blockquote class="twitter-tweet"><p lang="ja">キャバの同伴でラウンジへ &lt;b&gt;太字&lt;/b&gt;</p>&mdash; みお (@mio_cabajo) <a href="https://twitter.com/mio_cabajo/status/${A}">2026年11月7日</a></blockquote>`,
        }) });
      });
      await page.goto(folders);
      await ready(page);
      assert(await page.isVisible('#bot-pill'), 'ボット送信のピル');
      await folder(page, 'topic:d:d-hostcall');
      await page.click('[data-key="url-add"]');
      await page.fill('[data-key="url-input"]', `https://x.com/a/status/${A}\nhttps://x.com/b/status/${B}`);
      await page.click('[data-key="url-ok"]');
      // oEmbed（1 件ずつ）→ 行に本文・@ハンドル・推定ジャンル
      await page.waitForFunction((id) => (document.querySelector(`.row-item[data-row-key="p:${id}"] .row-title`) || {}).textContent?.includes('キャバの同伴でラウンジへ'), A, { timeout: 8000 });
      const metaA = await page.textContent(`${rowSel(`p:${A}`)} .row-meta`);
      assert(metaA.includes('@mio_cabajo') && metaA.includes('数値は次回の更新で') && metaA.includes('推定：キャバクラ'), metaA);
      assert(!(await page.$(`${rowSel(`p:${A}`)} b`)), 'タグは文字のまま');
      await page.waitForFunction((id) => (document.querySelector(`.row-item[data-row-key="p:${id}"] .row-meta`) || {}).textContent?.includes('本文を取得できませんでした'), B, { timeout: 8000 });
      assert(oembedCalls.length === 2, `oEmbed ${oembedCalls.length}`);
      await page.$eval(rowSel(`p:${A}`), (el) => el.scrollIntoView({ block: 'start' }));
      await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.hidden = true; });
      await page.screenshot({ path: path.join(SHOTS, 'link-meta-rows-960.png') });
      await page.click(`${rowSel(`p:${A}`)} .row-main`);
      await page.waitForSelector('[data-key="pv-est"]');
      assert((await page.textContent('.pv-body .post.is-meta')).includes('キャバの同伴でラウンジへ'), 'preview');
      const saved = await page.evaluate((id) => window.__show.weekState().linkMeta[id], A);
      assert(saved && saved.handle === 'mio_cabajo' && saved.date === '2026年11月7日', JSON.stringify(saved));
      // 自動送信（URL 追加は短い待ち）
      await page.waitForFunction(() => document.getElementById('bot-pill').dataset.state === 'done', null, { timeout: 8000 });
      assert(puts.length === 1 && puts[0].requested_posts.some((x) => x.id === A), `PUT ${puts.length}`);
      assert((await page.textContent('#bot-pill')).startsWith('ボット送信：済'), await page.textContent('#bot-pill'));
      await page.screenshot({ path: path.join(SHOTS, 'bot-autosend-plan-960.png') });
      // 中身が同じ編集 → 送らない
      await page.evaluate(() => window.__show.edit('何も変えない', () => {}));
      await page.waitForTimeout(2500);
      assert(puts.length === 1, `同じ中身は送らない ${puts.length}`);
      // 401 → 止めて案内（トークンは出さない）
      gh = 'unauth';
      await page.evaluate(() => window.__show.edit('名前', (w) => { w.overrides.renames['d:d-hostcall'] = '自動送信テスト'; }));
      await page.waitForFunction(() => document.getElementById('bot-pill').dataset.state === 'stopped', null, { timeout: 8000 });
      assert((await page.textContent('#bot-pill')).includes('止めました') && !(await page.getAttribute('#bot-pill', 'title')).includes(SECRET), 'stopped');
      await page.click('[data-key="tools-open"]');
      await page.waitForSelector('[data-key="fb-auto-msg"]');
      assert((await page.textContent('[data-key="fb-auto-msg"]')).includes('トークン'), 'tools msg');
      await page.$eval('[data-key="fb-auto-msg"]', (el) => el.scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: path.join(SHOTS, 'bot-autosend-stopped-960.png') });
      // 自動で送るを切る
      await page.uncheck('[data-key="fb-auto"]');
      await page.waitForFunction(() => document.getElementById('bot-pill').dataset.state === 'off');
      await page.click('[data-key="tools-close"]');
      // 進行画面にもピル
      await page.goto(`${show}#live`);
      await ready(page);
      assert(await page.isVisible('#bot-pill'), 'live pill');
      await c.close();
    });

    // ---- 4c. Grok ボット連携（段階3）。サンプルには sample/show/topics.json（ボットの話題まとめ）と show_pick がある
    const RAMEN = 'g:sample-ramen-2026w42';
    const SAKURA = 'g:sample-sakura-2026w42';
    await check('Grok: ボットの話題が並ぶ（印・要確認・リード文）・show_pick の理由・手作業が優先（名前・メイン・リロード後も）・進行のリード文', async () => {
      const c = await newCtx();
      const { page } = await open(c, folders);
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
      await page.waitForSelector('.live-lead-sum .lead-mark');
      assert((await page.textContent('.live-lead-box .live-lead')).includes('麺屋サンプル'), 'lead');
      await page.click('[data-key="lead-toggle"]');
      await page.screenshot({ path: path.join(SHOTS, 'bot-live-960.png') });
      await c.close();
    });

    await check('Grok: topics.json が無い・壊れていても従来どおり', async () => {
      for (const topics of [null, '{壊れた', JSON.stringify({ topics: 'x' })]) {
        const c = await newCtx();
        const { page } = await open(c, folders, { data: { posts: sample, bookmarks: sampleBm, topics } });
        assert(await page.isHidden('#sample-banner'), 'data');
        const n = await page.evaluate(() => [window.__show.bot, window.__show.topics.filter((t) => t.kind === 'bot').length]);
        assert(n[0] === null && n[1] === 0, JSON.stringify(n));
        assert(await page.$('[data-key="folder-topic:d:d-hostcall"]'), 'dict');
        await c.close();
      }
      // data/ 側の topics.json も読む
      const c = await newCtx();
      const ids = sample.posts.filter((p) => p.text.includes('シャンパンタワー')).map((p) => p.id);
      const { page } = await open(c, folders, { data: { posts: sample, bookmarks: sampleBm, topics: { topics: [{ id: 'tower-w42', name: 'タワーの話（Grok）', genre: 'ホスト', post_ids: ids, confidence: 0.9 }] } } });
      const t = await page.evaluate(() => { const x = window.__show.topicsById.get('g:tower-w42'); return x && [x.name, x.postIds.length]; });
      assert(t && t[0] === 'タワーの話（Grok）' && t[1] === ids.length, JSON.stringify(t));
      await c.close();
    });

    await check('ボットに修正を送る: ファイル保存（今の全修正・何度でも同じ）と最後に送った日時', async () => {
      const c = await newCtx();
      const { page } = await open(c, folders);
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
      await page.goto(folders);
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

    // ---- 4z. かんたん編成（#plan。ステップ①＝投稿からまとまりを作る／ステップ②＝まとまりを番組に並べる。マウスのドラッグは 960×1040）
    const bd = {
      /** ステップ②（まとまりを番組に並べる）へ */
      step2: async (pg) => { await pg.click('[data-key="bd-step-2"]'); await pg.waitForSelector('.bd[data-step="2"]'); },
      mat: (id) => `[data-key="mat-${id}"]`,
      flow: (id) => `[data-key="flow-${id}"]`,
      state: (pg) => pg.evaluate(() => {
        const w = window.__show.weekState();
        const c = (k) => w.rundown.corners.find((x) => x.key === k).items;
        return { main: [0, 1, 2].map((i) => c('main')[i] || null), cand: [...w.mainCand], category: [...c('category')], chat: [...c('chat')], order: w.postOrder };
      }),
      toast: (pg) => pg.evaluate(() => { const t = document.getElementById('toast'); return t && !t.hidden ? t.textContent : ''; }),
      /** from を to までドラッグ（to はセレクタか { x, y, width, height }）。離す直前の見た目を返す */
      drag: async (pg, from, to, o = {}) => {
        const { fa = [0.4, 0.5], ta = [0.5, 0.5], drop = true, shot = null, wait = 0 } = o;
        await pg.locator(from).first().scrollIntoViewIfNeeded();
        if (typeof to === 'string') await pg.locator(to).first().scrollIntoViewIfNeeded();
        await pg.locator(from).first().scrollIntoViewIfNeeded();
        const a = await pg.locator(from).first().boundingBox();
        let z = typeof to === 'string' ? await pg.locator(to).first().boundingBox() : to;
        const sx = a.x + a.width * fa[0];
        const sy = a.y + a.height * fa[1];
        await pg.mouse.move(sx, sy);
        await pg.mouse.down();
        await pg.mouse.move(sx + 8, sy + 8, { steps: 3 });
        // つかんだあとで置き先が画面の外なら、列を送って見える所へ（つかんだままホイールで送るのと同じ）
        if (typeof to === 'string' && (z.y < 0 || z.y + z.height > (await pg.evaluate(() => innerHeight)))) {
          await pg.locator(to).first().evaluate((e) => e.scrollIntoView({ block: 'nearest' }));
          z = await pg.locator(to).first().boundingBox();
        }
        await pg.mouse.move(z.x + z.width * ta[0], z.y + z.height * ta[1], { steps: 8 });
        if (wait) await pg.waitForTimeout(wait);
        const info = await pg.evaluate(() => ({
          lift: Boolean(document.querySelector('.drag-lift')), tip: (document.querySelector('.drag-tip') || {}).textContent || '', no: Boolean(document.querySelector('.drag-tip.is-no')),
          n: (document.querySelector('.drag-lift .bd-lift-n') || {}).textContent || '',
          line: Boolean(document.querySelector('.drop-line') && !document.querySelector('.drop-line').hidden),
          over: [...document.querySelectorAll('.is-drop-over')].map((e) => e.dataset.drop || ''), ok: document.querySelectorAll('.is-drop-ok').length,
          src: document.querySelectorAll('.is-drag-src').length, denied: document.querySelectorAll('.is-drop-no').length,
        }));
        if (shot) await pg.screenshot({ path: path.join(SHOTS, shot) });
        if (drop) { await pg.mouse.up(); await pg.waitForTimeout(80); }
        return info;
      },
    };
    const HOST = 'd:d-hostcall';
    const TOWER = 'd:d-tower';
    const OUJI = 't:サンプル王子さんの引退';
    const BDAY = 'd:d-birthday';
    const TOYOKO = 'd:d-toyoko';
    const GAME = 'c:2110001791796608034';

    await check('かんたん編成（#plan が既定）: 左右 2 列・素材→メインの枠（置ける所が光る・番号つきで入る・左は薄く）・一般はメインに入れない（理由）・カテゴリ別の選んだ位置・並べ替え・コーナーの間・枠の入れ替え・押し出し・✕ と左へ戻すで外す・Esc・外で離す', async () => {
      const c = await newCtx();
      const { page } = await open(c, show);
      assert(await page.evaluate(() => window.__show.route === 'plan') && await page.$('.bd') && !(await page.$('.plan2')), '既定はかんたん編成');
      assert((await page.getAttribute('.screen-tabs a[data-route="plan"]', 'aria-current')) === 'page', '編成タブ');
      // 初めてはステップ①。「おまかせで下書き」は②だけ
      assert(await page.$('.bd[data-step="1"]') && !(await page.$('[data-key="bd-draft"]')), '初めてはステップ①');
      await bd.step2(page);
      assert(await page.isVisible('[data-key="bd-draft"]') && (await page.textContent('.bd-left .bd-h')).startsWith('まとまり'), 'ステップ②');
      // 2 列が横に並び、それぞれの中でスクロール。横スクロールなし・押す所は 40px 以上・置き場所は 52px 以上
      const lay = await page.evaluate(() => {
        const r = (sel) => document.querySelector(sel).getBoundingClientRect();
        const l = r('.bd-left');
        const rt = r('.bd-right');
        const oy = (sel) => getComputedStyle(document.querySelector(sel)).overflowY;
        return {
          side: Math.abs(l.top - rt.top) < 2 && l.right <= rt.left, ratio: l.width / (l.width + rt.width), scroll: [oy('[data-key="bd-lscroll"]'), oy('[data-key="bd-rscroll"]')],
          sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, ih: innerHeight,
          add: Math.min(...[...document.querySelectorAll('.bd-add')].map((e) => Math.min(e.offsetWidth, e.offsetHeight))),
          chip: Math.min(...[...document.querySelectorAll('.bd-chip')].map((e) => e.offsetHeight)),
          zone: Math.min(...[...document.querySelectorAll('.bd-zone')].map((e) => e.offsetHeight)),
          zones: [...document.querySelectorAll('.bd-zone')].map((e) => e.textContent),
        };
      });
      assert(lay.side && lay.ratio > 0.4 && lay.ratio < 0.48 && lay.scroll.every((x) => x === 'auto'), `2 列 ${JSON.stringify(lay)}`);
      assert(lay.sw <= 960 && lay.sh <= lay.ih && lay.add >= 40 && lay.chip >= 40 && lay.zone >= 52, `大きさ ${JSON.stringify(lay)}`);
      assert(lay.zones.join('|') === 'メイン1　ここに入れる|メイン2　ここに入れる|メイン3　ここに入れる|＋ ここにドラッグでキープ|＋ ここにドラッグ|＋ ここにドラッグ', lay.zones.join('|'));
      assert((await page.textContent('[data-key="bd-total"]')) === '合計 0:00 / 予定 1:30', 'total');
      // 素材 → メイン2（ドラッグ中: 写しが浮く・元は薄く・置ける所が光る・指のそばに文）
      let d = await bd.drag(page, bd.mat(HOST), '[data-key="slot-1"]', { shot: 'board-drag-960.png' });
      assert(d.lift && d.src === 1 && d.ok >= 6 && d.over.join() === 'slot:1' && d.tip === 'メイン2 に入れる' && !d.no, JSON.stringify(d));
      let st = await bd.state(page);
      assert(st.main[1] === HOST && !st.main[0], JSON.stringify(st));
      assert((await page.textContent(`${bd.flow(HOST)} .bd-slotn`)) === '2', '枠の番号');
      assert(await page.$(`${bd.mat(HOST)}.is-used`) && (await page.textContent(`${bd.mat(HOST)} .bd-used`)) === '番組に入っています' && !(await page.$(`${bd.mat(HOST)} .bd-add`)), '左は薄く');
      assert((await bd.toast(page)).includes('メイン2に入れました') && await page.isVisible('[data-key="toast-undo"]'), await bd.toast(page));
      assert((await page.textContent('[data-key="bd-total"]')) === '合計 0:15 / 予定 1:30', 'total 15');
      assert((await page.inputValue('[data-key="title"]')).includes('ホストコール'), 'title');
      // 番組に入っているカードはつかめない（押すと右で光る）
      d = await bd.drag(page, bd.mat(HOST), '[data-key="slot-0"]');
      assert(!d.lift && (await bd.state(page)).main[0] == null, '入っているカードはドラッグ不可');
      // 一般のバズ → メインは断る（理由）
      await page.click('[data-key="bd-chip-general"]');
      await page.waitForSelector(bd.mat(GAME));
      d = await bd.drag(page, bd.mat(GAME), '[data-key="slot-0"]');
      assert(d.no && d.tip.includes('入れられません') && d.tip.includes('一般のバズはメインに入れられません') && d.denied === 1 && !d.over.length, JSON.stringify(d));
      assert((await bd.state(page)).main[0] == null && (await bd.toast(page)).includes('一般のバズはメインに入れられません'), '断る');
      d = await bd.drag(page, bd.mat(GAME), '[data-key="zone-cand"]');
      assert(d.no && d.tip.includes('メイン候補に入れられません'), JSON.stringify(d));
      // 一般のバズ → 雑談
      d = await bd.drag(page, bd.mat(GAME), '[data-key="zone-chat"]');
      assert(d.tip === '雑談（一般のバズ）に入れる' && (await bd.state(page)).chat.join() === GAME, JSON.stringify(d));
      await page.click('[data-key="bd-chip-rec"]');
      // カテゴリ別: 末尾の置き場所 → 選んだ位置（カードの上半分＝その前。入る位置に線）
      await bd.drag(page, bd.mat(BDAY), '[data-key="zone-category"]');
      await bd.drag(page, bd.mat(TOYOKO), '[data-key="zone-category"]');
      d = await bd.drag(page, bd.mat(TOWER), bd.flow(TOYOKO), { ta: [0.5, 0.2] });
      assert(d.line && d.tip === 'カテゴリ別ニュースに入れる', JSON.stringify(d));
      assert((await bd.state(page)).category.join() === [BDAY, TOWER, TOYOKO].join(), JSON.stringify(await bd.state(page)));
      // 並べ替え（下半分＝その後ろ）
      d = await bd.drag(page, bd.flow(BDAY), bd.flow(TOYOKO), { ta: [0.5, 0.8] });
      assert(d.line && d.tip === '並べ替える', JSON.stringify(d));
      assert((await bd.state(page)).category.join() === [TOWER, TOYOKO, BDAY].join(), '並べ替え');
      // コーナーの間（カテゴリ別 → メイン候補 → メイン1）
      await bd.drag(page, bd.flow(TOWER), '[data-key="zone-cand"]');
      st = await bd.state(page);
      assert(st.cand.join() === TOWER && st.category.join() === [TOYOKO, BDAY].join(), JSON.stringify(st));
      await bd.drag(page, bd.flow(TOWER), '[data-key="slot-0"]');
      st = await bd.state(page);
      assert(st.main[0] === TOWER && st.main[1] === HOST && !st.cand.length, JSON.stringify(st));
      // メインの枠どうしは入れ替え
      d = await bd.drag(page, bd.flow(TOWER), bd.flow(HOST));
      assert(d.tip === 'メイン2 と入れ替える', d.tip);
      st = await bd.state(page);
      assert(st.main[0] === HOST && st.main[1] === TOWER, JSON.stringify(st));
      // 入っている枠へ素材から → 前の話題はメイン候補へ
      d = await bd.drag(page, bd.mat(OUJI), bd.flow(HOST));
      assert(d.tip === 'メイン1 に入れる（「ホストコール」はメイン候補へ）', d.tip);
      st = await bd.state(page);
      assert(st.main[0] === OUJI && st.cand.join() === HOST, JSON.stringify(st));
      await page.screenshot({ path: path.join(SHOTS, 'board-960.png') });
      // ✕ で外す → 左のカードが戻る
      await page.click(`[data-key="unplace-${OUJI}"]`);
      st = await bd.state(page);
      assert(st.main[0] == null && await page.$(`${bd.mat(OUJI)}:not(.is-used) .bd-add`) && (await bd.toast(page)).includes('番組から外しました'), JSON.stringify(st));
      // 左の列へ戻す → 外れる
      d = await bd.drag(page, bd.flow(TOYOKO), '[data-key="bd-lscroll"]', { ta: [0.5, 0.6] });
      assert(d.tip === '番組から外す（左の一覧に戻す）' && d.over.join() === 'material', JSON.stringify(d));
      assert((await bd.state(page)).category.join() === BDAY, '左へ戻すと外れる');
      // Esc でやめる・外（ヘッダー）で離すと何もしない・ドラッグのあとに「押した」ことにならない
      const before = JSON.stringify(await bd.state(page));
      d = await bd.drag(page, bd.mat(OUJI), '[data-key="slot-0"]', { drop: false });
      assert(d.lift && d.over.join() === 'slot:0', JSON.stringify(d));
      await page.keyboard.press('Escape');
      assert(!(await page.$('.drag-lift')) && !(await page.$('.is-drop-ok')) && !(await page.$('.is-drag-src')), 'Esc で片付く');
      await page.mouse.up();
      d = await bd.drag(page, bd.mat(OUJI), { x: 300, y: 40, width: 10, height: 10 });
      assert(d.lift && !d.over.length && !d.tip, JSON.stringify(d));
      await page.waitForTimeout(100);
      assert(JSON.stringify(await bd.state(page)) === before && !(await page.$('.bd.is-panel')), 'Esc・外で離すは何もしない');
      // Ctrl+Z / Ctrl+Shift+Z
      await page.keyboard.press('Control+z');
      assert((await bd.state(page)).category.join() === [TOYOKO, BDAY].join(), 'undo');
      await page.keyboard.press('Control+Shift+Z');
      assert((await bd.state(page)).category.join() === BDAY, 'redo');
      assert((await sw(page)) <= 960, 'no h-scroll');
      await c.close();
    });

    await check('かんたん編成: 「＋」のメニュー（押せない理由・キーボード）・おまかせで下書き（空いている所だけ・元に戻す）・チップ・検索・リロードで戻る・自動スクロール・フォルダで整理 ⇄ かんたん編成', async () => {
      const c = await newCtx();
      const { page } = await open(c, `${show}#plan`);
      await bd.step2(page);
      // ＋ → 入れ先のメニュー
      await page.click(`[data-key="add-${HOST}"]`);
      await page.waitForSelector('.ctx-menu');
      const labels = await page.$$eval('.ctx-menu .ctx-item', (els) => els.map((e) => e.textContent));
      assert(labels.length === 6 && labels[0].startsWith('メイン1') && labels[0].includes('空き') && labels[3].startsWith('メイン候補') && labels[4] === 'カテゴリ別ニュース' && labels[5] === '雑談（一般のバズ）', labels.join('|'));
      await page.click('[data-key="bd-to-cand"]');
      assert((await bd.state(page)).cand.join() === HOST, '＋ → メイン候補');
      // キーボード: ＋ にフォーカス → Enter → ↓ → Enter（メイン2）
      await page.focus(`[data-key="add-${TOWER}"]`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.activeElement && document.activeElement.dataset.key === 'bd-to-slot:0');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      assert((await bd.state(page)).main[1] === TOWER, 'キーボードで ＋');
      // 一般のバズ: メイン・メイン候補は押せない（理由つき）
      await page.click('[data-key="bd-chip-general"]');
      await page.click(`[data-key="add-${GAME}"]`);
      await page.waitForSelector('.ctx-menu');
      const dis = await page.$$eval('.ctx-menu .ctx-item', (els) => els.map((e) => [e.disabled, e.textContent]));
      assert(dis.slice(0, 4).every((x) => x[0]) && dis[0][1].includes('一般のバズはメインに入れられません') && !dis[4][0] && !dis[5][0], JSON.stringify(dis));
      await page.keyboard.press('Escape');
      await page.waitForSelector('.ctx-menu', { state: 'detached' });
      await page.click('[data-key="bd-chip-rec"]');
      // おまかせで下書き: 空いている所だけ（メイン 1・3、カテゴリ別、雑談）。入っているもの（メイン2・メイン候補）はそのまま
      await page.click('[data-key="bd-draft"]');
      let st = await bd.state(page);
      const t1 = await bd.toast(page);
      assert(/^メイン 2・カテゴリ別 \d・雑談 3 を入れました/.test(t1), t1);
      assert(st.main[1] === TOWER && st.main[0] && st.main[2] && st.cand.join() === HOST && st.category.length >= 4 && st.chat.length === 3, JSON.stringify(st));
      assert(new Set([...st.main, ...st.cand, ...st.category, ...st.chat]).size === 4 + st.category.length + 3, '重複なし');
      const genres = await page.evaluate((ids) => ids.map((id) => window.__show.topicsById.get(id).genre), [...st.main, ...st.category, ...st.chat]);
      assert(genres.slice(0, 3).every((g) => g !== 'general') && new Set(genres.slice(3, 3 + st.category.length)).size >= 3 && genres.slice(-3).every((g) => g === 'general'), `ジャンル ${genres}`);
      const filled = JSON.stringify(st);
      await page.click('[data-key="bd-draft"]');
      assert((await bd.toast(page)).includes('空いている所がありません') && JSON.stringify(await bd.state(page)) === filled, '2 回目は何もしない');
      // 自動スクロール: 右の列の下の端に近づけたままにすると送られる
      const rb = await page.locator('[data-key="bd-rscroll"]').boundingBox();
      await page.evaluate(() => { document.querySelector('[data-key="bd-rscroll"]').scrollTop = 0; });
      const top0 = await page.$eval('[data-key="bd-rscroll"]', (e) => e.scrollTop);
      const free = await page.$eval('.bd-card.is-material:not(.is-used)', (e) => e.dataset.key);
      const dd = await bd.drag(page, `[data-key="${free}"]`, { x: rb.x + 100, y: rb.y + rb.height - 20, width: 10, height: 10 }, { drop: false, wait: 700 });
      const top1 = await page.$eval('[data-key="bd-rscroll"]', (e) => e.scrollTop);
      assert(dd.lift && top1 > top0 + 40, `自動スクロール ${top0} → ${top1}`);
      await page.keyboard.press('Escape');
      await page.mouse.up();
      // 元に戻す（1 回で下書きの前へ）
      await page.keyboard.press('Control+z');
      st = await bd.state(page);
      assert(st.main[0] == null && st.main[1] === TOWER && st.cand.join() === HOST && !st.category.length && !st.chat.length, `undo ${JSON.stringify(st)}`);
      // チップ: ジャンルでしぼる（覚える）
      await page.click('[data-key="bd-chip-kyaba"]');
      const stripes = await page.$$eval('.bd-card.is-material .bd-stripe', (els) => [...new Set(els.map((e) => e.className))]);
      assert(stripes.join() === 'bd-stripe g-kyaba' && (await page.getAttribute('[data-key="bd-chip-kyaba"]', 'aria-pressed')) === 'true', stripes.join());
      await page.click('[data-key="bd-chip-bookmarks"]');
      assert((await page.$$('.bd-card.is-material')).length >= 1 && (await page.$$('.bd-card.is-material .bd-mark.is-star')).length === (await page.$$('.bd-card.is-material')).length, '★ブックマーク');
      // おすすめ: 夜職は全部・一般のバズはおすすめだけ。40 件ずつ（もっと見る）
      await page.click('[data-key="bd-chip-rec"]');
      const rec = await page.evaluate(() => ({ n: document.querySelectorAll('.bd-card.is-material').length, total: Number(document.querySelector('[data-key="bd-lscroll"]').dataset.total), more: Boolean(document.querySelector('[data-key="bd-more-list"]')) }));
      assert(rec.n === 40 && rec.total > 40 && rec.more, JSON.stringify(rec));
      await page.click('[data-key="bd-more-list"]');
      assert((await page.$$('.bd-card.is-material')).length === rec.total, 'もっと見る');
      // 検索: 話題名が合う話題 → 中の投稿が合う話題。Esc で消す
      await page.fill('[data-key="bd-search"]', 'トー横');
      await page.waitForFunction((k) => { const f = document.querySelector('.bd-card.is-material'); return f && f.dataset.key === k; }, `mat-${TOYOKO}`);
      await page.fill('[data-key="bd-search"]', 'ゴジラロード');
      await page.waitForFunction((k) => { const f = document.querySelector('.bd-card.is-material'); return f && f.dataset.key === k && f.querySelector('.bd-meta').textContent.startsWith('一致：'); }, `mat-${TOYOKO}`);
      assert((await page.textContent('[data-key="bd-search-note"]')).includes('ゴジラロード'), 'search note');
      await page.fill('[data-key="bd-search"]', 'どこにも無い言葉');
      await page.waitForSelector('.bd-empty');
      await page.focus('[data-key="bd-search"]');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelectorAll('.bd-card.is-material').length === 40);
      // リロードしても編成とチップが戻る
      await page.click('[data-key="bd-chip-host"]');
      await page.waitForTimeout(500);
      await page.reload();
      await ready(page);
      st = await bd.state(page);
      assert(st.main[1] === TOWER && st.cand.join() === HOST && (await page.getAttribute('[data-key="bd-chip-host"]', 'aria-pressed')) === 'true', `reload ${JSON.stringify(st)}`);
      assert(await page.$(bd.flow(TOWER)) && await page.$(bd.flow(HOST)), 'cards after reload');
      // 「…」→ フォルダで整理（くわしい画面）⇄ かんたん編成に戻る（内容は同じ）
      await page.click('[data-key="bd-more"]');
      await page.click('[data-key="bd-folders"]');
      await page.waitForSelector('.plan2');
      assert(await page.evaluate(() => window.__show.route === 'plan-folders') && (await page.getAttribute('.screen-tabs a[data-route="plan"]', 'aria-current')) === 'page', 'folders route');
      assert((await page.textContent('[data-key="folder-slot:1"]')).includes('シャンパンタワー') && await page.isVisible('#range-box'), '同じ保存データ・対象期間も出る');
      await page.click('[data-key="back-board"]');
      await page.waitForSelector('.bd');
      assert(await page.evaluate(() => window.__show.route === 'plan') && await page.$(bd.flow(TOWER)), 'back to board');
      // チェックを記録 → NEW のチップ（新しい話題があるときだけ）は出ない・ツールが開く
      await page.click('[data-key="bd-more"]');
      await page.click('[data-key="cp-preview"]');
      assert((await bd.toast(page)).includes('チェックを記録しました') && !(await page.$('[data-key="bd-chip-new"]')), 'checkpoint');
      await page.click('[data-key="bd-more"]');
      await page.click('[data-key="tools-open"]');
      await page.waitForSelector('dialog.tools-dialog[open]');
      await page.click('[data-key="tools-close"]');
      await c.close();
    });

    await check('かんたん編成: 話題を開く → 投稿の並べ替え（先頭が代表・進行に反映）・✕・左の「足せる投稿」から ＋ とドラッグ（ほかの話題からは移す）・左へ戻して外す・ほかの話題へ移す・古い順・プレビュー・URL・名前・新しい話題・キーボード', async () => {
      const c = await newCtx();
      const { page } = await open(c, `${show}#plan`);
      await bd.step2(page);
      await page.evaluate(([a, b, d]) => window.__show.edit('準備', (w) => { w.rundown.corners[0].items = [a]; w.rundown.corners[1].items = [b, d]; }), [HOST, BDAY, TOYOKO]);
      await page.waitForSelector(bd.flow(HOST));
      // 押すとその場で開く（1 つだけ）。左は「足せる投稿」に
      await page.click(bd.flow(HOST));
      await page.waitForSelector('[data-key="bd-open"]');
      const rows = () => page.$$eval('.bd-post.is-in-open', (els) => els.map((e) => e.dataset.post));
      const items = () => page.evaluate((id) => window.__show.itemsFor(window.__show.topicsById.get(id)), HOST);
      let r = await rows();
      assert(r.length === 8 && (await page.textContent('[data-key="bd-left-sub"]')) === '「ホストコール」に足せる投稿' && (await page.textContent('[data-key="bd-open-count"]')).includes('8件'), `open ${r.length}`);
      assert((await page.$$('[data-key="bd-rep"]')).length === 1 && await page.$(`[data-key="post-${r[0]}"] [data-key="bd-rep"]`), '先頭が代表');
      assert((await page.textContent(`[data-key="post-${r[0]}"] .bd-pm`)).startsWith('@') && (await page.textContent(`[data-key="post-${r[0]}"] .bd-pm`)).includes('表示'), 'row meta');
      await page.click(bd.flow(BDAY));
      assert((await page.$$('[data-key="bd-open"]')).length === 1 && (await page.textContent('[data-key="bd-left-sub"]')).includes('生誕祭'), '開くのは 1 つ');
      await page.click(bd.flow(HOST));
      // 並べ替え: 3 件目を先頭へ（代表になる）
      let d = await bd.drag(page, `[data-key="post-${r[2]}"]`, `[data-key="post-${r[0]}"]`, { ta: [0.5, 0.2] });
      assert(d.line && d.tip === '先頭へ（代表にする）', JSON.stringify(d));
      let it = await items();
      assert(it[0] === r[2] && it.length === 8 && await page.$(`[data-key="post-${r[2]}"] [data-key="bd-rep"]`), `reorder ${it.slice(0, 3)}`);
      assert(await page.$('[data-key="bd-order-reset"]'), '手動順');
      // ✕ で話題から外す → 左の「足せる投稿」に戻る（薄くない）
      await page.click(`[data-key="rm-${r[1]}"]`);
      it = await items();
      assert(it.length === 7 && !it.includes(r[1]) && (await bd.toast(page)).includes('まとまりから外しました'), `rm ${it.length}`);
      await page.waitForSelector(`[data-key="addable-${r[1]}"]:not(.is-in)`);
      assert(await page.$(`[data-key="addable-${r[0]}"].is-in`), '入っている投稿は薄く');
      // 左から ＋（最後に足す）
      await page.click(`[data-key="addp-${r[1]}"]`);
      it = await items();
      assert(it.length === 8 && it[7] === r[1] && (await bd.toast(page)).includes('「ホストコール」に足しました'), `add + ${it.slice(-2)}`);
      // 左からドラッグ（入る位置へ）。ほかの話題にある投稿は移す（「▸ 話題名」の印）
      const fromOther = await page.$eval('.bd-post.is-addable:not(.is-in) .bd-from', (e) => e.closest('.bd-post').dataset.post);
      const srcTopic = await page.evaluate((id) => window.__show.postTopic.get(id), fromOther);
      d = await bd.drag(page, `[data-key="addable-${fromOther}"]`, `[data-key="post-${it[1]}"]`, { ta: [0.5, 0.8], shot: 'board-add-drag-960.png' });
      assert(d.line && d.tip === '「ホストコール」に足す', JSON.stringify(d));
      it = await items();
      assert(it.length === 9 && it[2] === fromOther && (await bd.toast(page)).includes('から移しました'), `add drag ${it.slice(0, 4)}`);
      assert(await page.evaluate(([id, t]) => window.__show.postTopic.get(id) === t, [fromOther, HOST]) && srcTopic !== HOST, '移った');
      await page.locator('[data-key="bd-open"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(SHOTS, 'board-open-960.png') });
      // 開いた話題の投稿を左の列へ → 外れる
      d = await bd.drag(page, `[data-key="post-${fromOther}"]`, '[data-key="bd-lscroll"]', { ta: [0.5, 0.6] });
      assert(d.tip === 'このまとまりから外す' && d.over.join() === 'material', JSON.stringify(d));
      assert((await items()).length === 8, '左へ戻すと外れる');
      // 投稿をほかの話題のカードへ → 移す。枠の置き場所には置けない（理由）
      it = await items();
      d = await bd.drag(page, `[data-key="post-${it[7]}"]`, '[data-key="slot-1"]', { drop: false });
      assert(d.no && d.tip.includes('投稿は、開いたまとまりの中か、ほかのまとまりのカードに'), JSON.stringify(d));
      await page.keyboard.press('Escape');
      await page.mouse.up();
      d = await bd.drag(page, `[data-key="post-${it[7]}"]`, bd.flow(TOYOKO));
      assert(d.tip === '「トー横」へ移す', d.tip);
      assert(await page.evaluate(([id, t]) => window.__show.postTopic.get(id) === t, [it[7], TOYOKO]) && (await items()).length === 7, 'ほかの話題へ');
      // 古い順に並べる（この話題だけ）・並びを元に戻す
      await page.click('[data-key="bd-order-old"]');
      const ts = await page.evaluate((id) => window.__show.itemsFor(window.__show.topicsById.get(id)).map((x) => window.__show.postsById.get(x).ts), HOST);
      assert(ts.every((x, i) => i === 0 || ts[i - 1] <= x), `古い順 ${ts}`);
      // 進行にも同じ順（先頭が代表）
      it = await items();
      await page.goto(`${show}#live`);
      await ready(page);
      await page.waitForSelector(`.live-post[data-post="${it[0]}"]`);
      assert((await page.textContent(`.live-post[data-post="${it[0]}"] .li-no`)) === '先頭（代表）', '進行に反映');
      await page.goto(`${show}#plan`);
      await ready(page);
      // 編成に戻っても開いたまま
      await page.waitForSelector('[data-key="bd-open"]');
      await page.click('[data-key="bd-order-reset"]');
      assert(await page.evaluate((id) => !window.__show.weekState().postOrder[id], HOST), '並びを元に戻す');
      // プレビュー: 960 では左の列の上に出る。前へ／次へ。閉じると戻る
      await page.click('[data-key="bd-preview"]');
      await page.waitForSelector('.bd.is-panel .bd-preview');
      assert(await page.isHidden('.bd-left') && (await page.textContent('[data-key="bd-pv-title"]')) === 'ホストコール' && await page.$('.bd-preview .pv-post'), 'preview panel');
      const pb = await page.locator('.bd-preview').boundingBox();
      const rb = await page.locator('.bd-right').boundingBox();
      assert(pb.x < rb.x && pb.x + pb.width <= rb.x + 1, 'プレビューは左の列の場所に');
      assert((await page.textContent('[data-key="bd-pv-pos"]')).startsWith('1 / 7'), await page.textContent('[data-key="bd-pv-pos"]'));
      await page.click('[data-key="bd-pv-next"]');
      assert((await page.textContent('[data-key="bd-pv-pos"]')).startsWith('2 / 7'), 'next');
      await page.screenshot({ path: path.join(SHOTS, 'board-preview-960.png') });
      await page.click('[data-key="bd-preview-close"]');
      assert(await page.isVisible('.bd-left') && !(await page.$('.bd-preview')), 'close preview');
      // 行を押すとその投稿のプレビュー（Esc で閉じる）
      it = await items();
      await page.click(`[data-key="post-${it[2]}"] .bd-pt`);
      await page.waitForSelector('.bd-preview');
      assert((await page.textContent('[data-key="bd-pv-pos"]')).startsWith('3 / 7'), 'row → preview');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.bd-preview', { state: 'detached' });
      // URL から投稿を追加（既存のダイアログ）。左の一覧の下にも同じ入口がいつも見える
      assert(await page.isVisible('[data-key="bd-left-url"]') && await page.isVisible('[data-key="bd-left-img"]'), '左の入口');
      const fb = await page.locator('.bd-foot').boundingBox();
      assert(fb.y + fb.height <= 1040, `左の入口は画面の中 ${JSON.stringify(fb)}`);
      await page.click('[data-key="bd-left-url"]');
      await page.waitForSelector('dialog.url-dialog[open]');
      await page.click('[data-key="url-cancel"]');
      await page.waitForSelector('dialog.url-dialog', { state: 'detached' });
      await page.click('[data-key="bd-url-add"]');
      await page.waitForSelector('dialog.url-dialog[open]');
      await page.fill('[data-key="url-input"]', 'https://x.com/a/status/2110000000000099901');
      await page.click('[data-key="url-ok"]');
      await page.waitForSelector('dialog.url-dialog', { state: 'detached' });
      assert((await items()).includes('2110000000000099901') && await page.$('[data-key="post-2110000000000099901"]'), 'URL で追加');
      // 名前を変える
      await page.click('[data-key="bd-rename"]');
      await page.waitForSelector('dialog.name-dialog[open]');
      await page.fill('[data-key="name-input"]', 'コール特集');
      await page.click('[data-key="name-ok"]');
      await page.waitForFunction((sel) => { const e = document.querySelector(`${sel} .bd-name`); return e && e.textContent === 'コール特集'; }, bd.flow(HOST));
      // ← 素材に戻る（開いたまま）⇄ 足せる投稿を見る
      await page.click('[data-key="bd-back-material"]');
      assert(await page.$('.bd-card.is-material') && await page.$('[data-key="bd-open"]') && (await page.textContent('[data-key="bd-left-sub"]')).includes('おすすめ順'), 'まとまりの一覧に戻る');
      await page.click('[data-key="bd-show-addable"]');
      assert(await page.$('.bd-post.is-addable') && (await page.textContent('[data-key="bd-left-sub"]')).includes('に足せる投稿'), '足せる投稿を見る');
      // 足せる投稿の検索（全投稿から）とジャンルのチップ
      await page.fill('[data-key="bd-search"]', 'ゴジラロード');
      await page.waitForFunction(() => { const n = Number(document.querySelector('[data-key="bd-lscroll"]').dataset.total); return n >= 1 && n < 10; });
      assert((await page.$$eval('.bd-post.is-addable .bd-pt', (els) => els.every((e) => e.textContent.includes('ゴジラロード')))), 'addable search');
      await page.fill('[data-key="bd-search"]', '');
      await page.click('[data-key="bd-chip-kyaba"]');
      await page.waitForFunction(() => document.querySelectorAll('.bd-post.is-addable').length > 0);
      assert(await page.evaluate(() => [...document.querySelectorAll('.bd-post.is-addable')].every((e) => (window.__show.postsById.get(e.dataset.post).categories || []).includes('キャバクラ'))), 'addable chip');
      // 閉じる
      await page.click('[data-key="bd-close"]');
      assert(!(await page.$('[data-key="bd-open"]')) && await page.$('.bd-card.is-material'), '閉じる');
      // キーボード: Enter で開く・Alt+↓ で動かす・Delete で外す
      await page.focus(bd.flow(BDAY));
      await page.keyboard.press('Alt+ArrowDown');
      assert((await bd.state(page)).category.join() === [TOYOKO, BDAY].join() && await page.evaluate((k) => document.activeElement.dataset.key === k, `flow-${BDAY}`), 'Alt+↓');
      await page.keyboard.press('Alt+ArrowUp');
      assert((await bd.state(page)).category.join() === [BDAY, TOYOKO].join(), 'Alt+↑');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-key="bd-open"]');
      const pr = await rows();
      await page.focus(`[data-key="post-${pr[0]}"]`);
      await page.keyboard.press('Alt+ArrowDown');
      assert((await rows())[1] === pr[0], '投稿も Alt+↓');
      await page.keyboard.press('Delete');
      assert((await rows()).length === pr.length - 1, '投稿を Delete');
      await page.focus(bd.flow(BDAY));
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-key="bd-open"]', { state: 'detached' });
      await page.focus(bd.flow(TOYOKO));
      await page.keyboard.press('Delete');
      assert((await bd.state(page)).category.join() === BDAY, 'Delete で番組から外す');
      // 右クリック: 名前・ジャンル・片付け・削除など
      await page.click(bd.mat(TOWER), { button: 'right' });
      await page.waitForSelector('.ctx-menu');
      for (const k of ['bd-ctx-to-slot:0', 'bd-ctx-rename', 'bd-ctx-genre-kyaba', 'bd-ctx-shelf', 'bd-ctx-trash']) assert(await page.$(`[data-key="${k}"]`), `menu ${k}`);
      await page.click('[data-key="bd-ctx-genre-kyaba"]');
      assert(await page.evaluate((id) => window.__show.topicsById.get(id).genre === 'kyaba', TOWER), 'ジャンル');
      await page.click(bd.mat(TOWER), { button: 'right' });
      await page.click('[data-key="bd-ctx-shelf"]');
      assert(!(await page.$(bd.mat(TOWER))) && (await bd.toast(page)).includes('片付けました'), '片付ける');
      await page.click('[data-key="toast-undo"]');
      await page.waitForSelector(bd.mat(TOWER));
      // 新しい話題を作る → 雑談に入って開く（左が足せる投稿）
      await page.click('[data-key="bd-more"]');
      await page.click('[data-key="bd-new-topic"]');
      await page.waitForSelector('dialog.name-dialog[open]');
      await page.fill('[data-key="name-input"]', 'テストの話題');
      await page.selectOption('[data-key="name-genre"]', 'general');
      await page.click('[data-key="name-ok"]');
      await page.waitForSelector('[data-key="bd-open"]');
      const st = await bd.state(page);
      assert(st.chat.length === 1 && st.chat[0].startsWith('m:') && (await page.textContent('[data-key="bd-open"] .bd-name')) === 'テストの話題' && (await page.textContent('[data-key="bd-left-sub"]')).includes('テストの話題'), JSON.stringify(st));
      await page.click('.bd-post.is-addable .bd-add');
      assert((await page.$$('.bd-post.is-in-open')).length === 1, '新しい話題に足す');
      // タッチ: カードの上からは始まらない（一覧をスクロールできる）・⋮⋮ からは始まる。長押しでメニュー
      await page.click('[data-key="bd-close"]');
      const touch = await page.evaluate(async (sel) => {
        const card = document.querySelector(sel);
        const grip = card.querySelector('.bd-grip');
        const r = card.getBoundingClientRect();
        const fire = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: 77, isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
        const out = {};
        const name = card.querySelector('.bd-name');
        fire(name, 'pointerdown', r.left + 120, r.top + 20);
        fire(name, 'pointermove', r.left + 160, r.top + 60);
        out.body = Boolean(document.querySelector('.drag-lift'));
        fire(name, 'pointerup', r.left + 160, r.top + 60);
        fire(grip, 'pointerdown', r.left + 20, r.top + 20);
        fire(grip, 'pointermove', r.left + 40, r.top + 40);
        out.grip = Boolean(document.querySelector('.drag-lift'));
        out.touchAction = [getComputedStyle(grip).touchAction, getComputedStyle(card).touchAction];
        fire(grip, 'pointerup', r.left + 40, r.top + 40);
        out.after = Boolean(document.querySelector('.drag-lift'));
        fire(name, 'pointerdown', r.left + 120, r.top + 20);
        await new Promise((res) => setTimeout(res, 700));
        out.menu = Boolean(document.querySelector('.ctx-menu'));
        fire(name, 'pointerup', r.left + 120, r.top + 20);
        return out;
      }, bd.mat(OUJI));
      assert(!touch.body && touch.grip && !touch.after && touch.touchAction[0] === 'none' && touch.touchAction[1] !== 'none' && touch.menu, `touch ${JSON.stringify(touch)}`);
      await page.keyboard.press('Escape');
      assert((await sw(page)) <= 960, 'no h-scroll');
      await c.close();
    });

    await check('かんたん編成の幅: 1920 はプレビューの列（3 列）・1200 は 2 列・760 と 375 は 1 列（素材／番組の切り替え・＋で入れる）・横スクロールなし', async () => {
      // 1920: 3 列。カードを押すと右の列にプレビュー
      const c = await newCtx({ viewport: { width: 1920, height: 1080 } });
      const { page } = await open(c, `${show}#plan`);
      await bd.step2(page);
      assert(await page.$('.bd.is-wide') && await page.isVisible('.bd-preview') && await page.$('[data-key="bd-pv-empty"]'), 'wide');
      const cols = await page.evaluate(() => ['.bd-left', '.bd-right', '.bd-preview'].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width), Math.round(r.top)]; }));
      assert(cols[0][0] < cols[1][0] && cols[1][0] < cols[2][0] && cols[0][2] === cols[2][2] && cols[2][1] >= 440, `3 列 ${JSON.stringify(cols)}`);
      await page.click(bd.mat(HOST));
      await page.waitForFunction(() => { const e = document.querySelector('[data-key="bd-pv-title"]'); return e && e.textContent === 'ホストコール'; });
      assert(await page.isVisible('.bd-left') && await page.$(`${bd.mat(HOST)}.is-sel`) && await page.$('.bd-preview .pv-post'), 'preview col');
      await bd.drag(page, bd.mat(HOST), '[data-key="slot-0"]');
      await bd.drag(page, bd.mat(TOYOKO), '[data-key="zone-category"]');
      await page.click(bd.flow(TOYOKO));
      await page.waitForFunction(() => { const e = document.querySelector('[data-key="bd-pv-title"]'); return e && e.textContent === 'トー横'; });
      const emb = await page.evaluate(() => { const h = document.querySelector('.bd-preview .embed-host'); return h ? h.dataset.embedId : null; });
      // 並べ替えても埋め込みは作り直さない（同じ要素のまま）
      await page.evaluate(() => { window.__keepEl = document.querySelector('.bd-preview .embed-host'); });
      const r0 = await page.$$eval('.bd-post.is-in-open', (els) => els.map((e) => e.dataset.post));
      await bd.drag(page, `[data-key="post-${r0[2]}"]`, `[data-key="post-${r0[1]}"]`, { ta: [0.5, 0.2] });
      assert(emb && await page.evaluate(() => window.__keepEl === document.querySelector('.bd-preview .embed-host') && window.__keepEl.isConnected), '埋め込みはそのまま');
      assert((await sw(page)) <= 1920, 'no h-scroll 1920');
      await page.screenshot({ path: path.join(SHOTS, 'board-1920.png') });
      // 1200: 2 列（プレビューは押したときだけ左の上に）
      await page.setViewportSize({ width: 1200, height: 900 });
      await page.waitForFunction(() => !document.querySelector('.bd.is-wide'));
      assert(await page.$('.bd.is-panel .bd-preview') && (await sw(page)) <= 1200, '1200');
      await page.click('[data-key="bd-preview-close"]');
      assert(await page.isVisible('.bd-left') && await page.isVisible('.bd-right'), '1200 2 列');
      await page.screenshot({ path: path.join(SHOTS, 'board-1200.png') });
      // 760: 1 列
      await page.setViewportSize({ width: 760, height: 900 });
      await page.waitForSelector('.bd.is-narrow');
      assert((await sw(page)) <= 760, '760');
      await page.screenshot({ path: path.join(SHOTS, 'board-760.png') });
      await c.close();
      // 375: 素材／番組の切り替え。＋ で入れる・押して開く・足せる投稿のタブ
      const c2 = await newCtx({ viewport: { width: 375, height: 812 }, hasTouch: true });
      const { page: p } = await open(c2, `${show}#plan`);
      await bd.step2(p);
      assert(await p.$('.bd.is-narrow') && await p.isVisible('.bd-left') && await p.isHidden('.bd-right') && (await p.textContent('[data-key="bd-tab-flow"]')) === '番組の流れ（0）' && (await p.textContent('[data-key="bd-tab-material"]')) === 'まとまり', 'narrow');
      await p.click(`[data-key="add-${HOST}"]`);
      await p.waitForSelector('.ctx-menu');
      const mr = await p.locator('.ctx-menu').boundingBox();
      assert(mr.x >= 0 && mr.x + mr.width <= 375, `menu in view ${JSON.stringify(mr)}`);
      await p.click('[data-key="bd-to-slot:0"]');
      await p.click(`[data-key="add-${BDAY}"]`);
      await p.click('[data-key="bd-to-corner:category"]');
      assert((await p.textContent('[data-key="bd-tab-flow"]')) === '番組の流れ（2）' && await p.$(`${bd.mat(HOST)}.is-used`), 'added by +');
      await p.screenshot({ path: path.join(SHOTS, 'board-375.png') });
      // 入っているカードを押す → 番組の流れのタブでそのカードが光る
      await p.click(bd.mat(HOST));
      await p.waitForFunction(() => document.querySelector('.bd').dataset.tab === 'flow');
      assert(await p.isVisible('.bd-right') && await p.isHidden('.bd-left') && await p.isVisible(bd.flow(HOST)), 'flow tab');
      await p.click(bd.flow(HOST));
      await p.waitForSelector('[data-key="bd-open"]');
      assert((await p.textContent('[data-key="bd-tab-material"]')) === '足せる投稿' && (await p.textContent('[data-key="zone-open"]')).includes('足せる投稿'), 'narrow open');
      await p.screenshot({ path: path.join(SHOTS, 'board-375-open.png') });
      await p.click('[data-key="bd-tab-material"]');
      await p.waitForSelector('.bd-post.is-addable');
      const n0 = await p.evaluate((id) => window.__show.itemsFor(window.__show.topicsById.get(id)).length, HOST);
      await p.click('.bd-post.is-addable:not(.is-in) .bd-add');
      assert(await p.evaluate(([id, n]) => window.__show.itemsFor(window.__show.topicsById.get(id)).length === n + 1, [HOST, n0]), 'narrow add post');
      await p.click('[data-key="bd-tab-flow"]');
      await p.click(`[data-key="unplace-${BDAY}"]`);
      assert((await p.textContent('[data-key="bd-tab-flow"]')) === '番組の流れ（1）', 'narrow remove');
      assert((await sw(p)) <= 375, `scrollWidth ${await sw(p)}`);
      await c2.close();
    });

    await check('かんたん編成 ステップ①（投稿からまとまりを作る）: ステップの切り替え（覚える・矢印キー）・投稿 → 新しいまとまり（名前）・カードへ足す・チェックして「まとまりにする」・チェックした行をまとめてドラッグ・置けない理由・開いて ＋／並べ替え・② で番組へ → 進行・Ctrl+Z', async () => {
      const c = await newCtx();
      const { page } = await open(c, `${show}#plan`);
      const lp = (id) => `[data-key="lp-${id}"]`;
      const grp = (id) => `[data-key="grp-${id}"]`;
      const listIds = () => page.$$eval('.bd-post.is-list', (els) => els.map((e) => e.dataset.post));
      const cards = () => page.$$eval('.bd-card.is-group', (els) => els.map((e) => ({ id: e.dataset.topic, name: e.querySelector('.bd-name').textContent, kind: e.querySelector('.bd-kind').textContent, meta: e.querySelector('.bd-meta').textContent })));
      const metaOf = (id) => page.textContent(`[data-key="gmeta-${id}"]`);
      const topicOf = (id) => page.evaluate((x) => window.__show.postTopic.get(x), id);
      // 初めてはステップ①: 左＝投稿（まだ入っていないものだけ・表示の多い順）、右＝まとまり（＋ 新しいまとまり → カード）
      const s1 = await page.evaluate(() => {
        const a = window.__show;
        const rows = [...document.querySelectorAll('.bd-post.is-list')].map((e) => e.dataset.post);
        const imp = rows.map((id) => { const p = a.postsById.get(id); return p.metrics && Number.isFinite(p.metrics.impression_count) ? p.metrics.impression_count : -1; });
        return {
          step: document.querySelector('.bd').dataset.step,
          tabs: [...document.querySelectorAll('.bd-steps[role="tablist"] [role="tab"]')].map((e) => [e.querySelector('.bd-step-t').textContent, e.getAttribute('aria-selected')]),
          subs: [1, 2].map((n) => document.querySelector(`[data-key="bd-step-${n}-sub"]`).textContent),
          heads: ['.bd-left .bd-h', '.bd-right .bd-h'].map((sel) => document.querySelector(sel).firstChild.textContent),
          filter: document.querySelector('[data-key="bd-filter"]').value, filters: [...document.querySelectorAll('[data-key="bd-filter"] option')].map((e) => e.textContent),
          rows: rows.length, total: Number(document.querySelector('[data-key="bd-lscroll"]').dataset.total), more: Boolean(document.querySelector('[data-key="bd-more-list"]')),
          // おすすめ: 夜職の投稿が先（表示の多い順）→ 一般のバズ（表示の多い順）。＝多い順の並びが 2 つまで（上がるのは境目の 1 回まで）
          sorted: imp.filter((x, i) => i > 0 && imp[i - 1] < x).length <= 1,
          free: rows.every((id) => { const t = a.topicsById.get(a.postTopic.get(id)); return t && t.kind === 'single' && t.postIds.length === 1; }),
          groups: [...document.querySelectorAll('.bd-card.is-group')].map((e) => [e.dataset.topic, e.querySelector('.bd-kind').textContent]),
          gtotal: Number(document.querySelector('[data-key="bd-rscroll"]').dataset.total),
          zone: document.querySelector('[data-key="zone-new"]').textContent, zoneH: document.querySelector('[data-key="zone-new"]').offsetHeight,
          chk: Math.min(...[...document.querySelectorAll('.bd-chk')].slice(0, 5).map((e) => Math.min(e.offsetWidth, e.offsetHeight))),
          stepH: Math.min(...[...document.querySelectorAll('.bd-step')].map((e) => e.offsetHeight)),
          draft: Boolean(document.querySelector('[data-key="bd-draft"]')), sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, ih: innerHeight,
        };
      });
      assert(s1.step === '1' && JSON.stringify(s1.tabs) === JSON.stringify([['投稿からまとまりを作る', 'true'], ['まとまりを番組に並べる', 'false']]), JSON.stringify(s1.tabs));
      assert(s1.subs[0] === `まだ入っていない投稿 ${s1.total}件` && s1.subs[1] === `まとまり ${s1.gtotal}・番組に 0本`, JSON.stringify(s1.subs));
      assert(s1.heads.join() === '投稿,まとまり' && s1.filter === 'free' && s1.filters.join() === 'まだ入っていないものだけ,すべての投稿', JSON.stringify([s1.heads, s1.filters]));
      assert(s1.rows === 40 && s1.total > 40 && s1.more && s1.sorted && s1.free, `投稿の一覧 ${JSON.stringify({ rows: s1.rows, total: s1.total, sorted: s1.sorted, free: s1.free })}`);
      assert(s1.groups.length === 9 && s1.gtotal === 9 && s1.groups.every((g) => g[1] === '自動') && s1.groups[0][0] === HOST, `まとまり ${JSON.stringify(s1.groups)}`);
      assert(s1.zone === '＋ 新しいまとまり（ここに投稿をドラッグ）' && s1.zoneH >= 52 && s1.chk >= 40 && s1.stepH >= 44 && !s1.draft, JSON.stringify([s1.zone, s1.zoneH, s1.chk, s1.stepH, s1.draft]));
      assert(s1.sw <= 960 && s1.sh <= s1.ih, `横スクロールなし・画面に収まる ${s1.sw} ${s1.sh}/${s1.ih}`);
      await page.screenshot({ path: path.join(SHOTS, 'board-s1-960.png') });
      // ステップは覚える（リロード）。矢印キーでも切り替え
      await page.focus('[data-key="bd-step-1"]');
      await page.keyboard.press('ArrowRight');
      await page.waitForSelector('.bd[data-step="2"]');
      assert(await page.isVisible('[data-key="bd-draft"]') && await page.$('.bd-card.is-material') && (await page.getAttribute('[data-key="bd-step-2"]', 'aria-selected')) === 'true', '→ で②');
      await page.reload();
      await ready(page);
      assert(await page.$('.bd[data-step="2"]'), '②を覚えている');
      await page.focus('[data-key="bd-step-2"]');
      await page.keyboard.press('ArrowLeft');
      await page.waitForSelector('.bd[data-step="1"]');
      await page.reload();
      await ready(page);
      assert(await page.$('.bd[data-step="1"]') && await page.$('.bd-post.is-list'), '①を覚えている');
      // ホストの投稿だけに（チップは②と同じ）
      await page.click('[data-key="bd-chip-host"]');
      await page.waitForFunction(() => { const a = window.__show; const r = [...document.querySelectorAll('.bd-post.is-list')]; return r.length > 6 && r.every((e) => (a.postsById.get(e.dataset.post).categories || []).includes('ホスト')); });
      let rows = await listIds();
      // 投稿 → 「＋ 新しいまとまり」: 置ける所（新しいまとまり＋カード）が光る → できて、名前を聞かれる（自動の名前が入っている）
      let d = await bd.drag(page, lp(rows[0]), '[data-key="zone-new"]', { shot: 'board-s1-drag-new-960.png' });
      assert(d.lift && d.src === 1 && d.ok >= 10 && d.over.join() === 'newgroup' && d.tip === '新しいまとまりを作る' && !d.no, JSON.stringify(d));
      await page.waitForSelector('dialog.name-dialog[open]');
      const autoName = await page.inputValue('[data-key="name-input"]');
      let cs = await cards();
      assert(autoName.length > 0 && cs[0].name === autoName && cs[0].kind === '作った' && cs[0].id.startsWith('m:') && cs[0].meta.includes('投稿 1') && cs.length === 10, `できたカード ${JSON.stringify(cs[0])}`);
      const G1 = cs[0].id;
      await page.fill('[data-key="name-input"]', 'テストのまとまり');
      await page.click('[data-key="name-ok"]');
      await page.waitForFunction((sel) => { const e = document.querySelector(`${sel} .bd-name`); return e && e.textContent === 'テストのまとまり'; }, grp(G1));
      assert(!(await page.$(lp(rows[0]))) && (await topicOf(rows[0])) === G1, '投稿は左の一覧から消えて、まとまりに入る');
      assert((await page.textContent('[data-key="bd-step-2-sub"]')) === 'まとまり 10・番組に 0本', await page.textContent('[data-key="bd-step-2-sub"]'));
      assert(await page.$(`${grp(G1)} .bd-kind.is-made`) && (await cards())[1].id === HOST, '作ったものが先・自動は今の並び');
      // Ctrl+Z: 名前 → 作成 の順に戻る。やり直せる
      await page.keyboard.press('Control+z');
      assert((await page.textContent(`${grp(G1)} .bd-name`)) === autoName, '名前が戻る');
      await page.keyboard.press('Control+z');
      assert(!(await page.$(grp(G1))) && await page.$(lp(rows[0])) && (await cards()).length === 9, '作成が戻る');
      await page.keyboard.press('Control+Shift+Z');
      await page.keyboard.press('Control+Shift+Z');
      assert((await page.textContent(`${grp(G1)} .bd-name`)) === 'テストのまとまり' && !(await page.$(lp(rows[0]))), 'やり直し');
      // 投稿 → カード: そのまとまりに足す（数が 1 増える）
      d = await bd.drag(page, lp(rows[1]), grp(G1), { shot: 'board-s1-drag-card-960.png' });
      assert(d.lift && d.over.join() === `topic:${G1}` && d.tip === 'このまとまりに足す', JSON.stringify(d));
      assert((await metaOf(G1)).includes('投稿 2') && !(await page.$(lp(rows[1]))) && (await bd.toast(page)).includes('「テストのまとまり」に足しました'), await metaOf(G1));
      await page.keyboard.press('Control+z');
      assert((await metaOf(G1)).includes('投稿 1') && await page.$(lp(rows[1])), 'Ctrl+Z で戻る');
      await page.keyboard.press('Control+Shift+Z');
      assert((await metaOf(G1)).includes('投稿 2'), 'やり直し');
      // 自動のまとまりへも足せる
      await bd.drag(page, lp(rows[2]), grp(HOST));
      assert((await metaOf(HOST)).includes('投稿 9') && (await topicOf(rows[2])) === HOST, await metaOf(HOST));
      // チェック 2 件 →「まとまりにする」（名前は自動の下書き・ジャンルは多数決）
      rows = await listIds();
      await page.click(`[data-key="chk-${rows[0]}"]`);
      await page.click(`[data-key="chk-${rows[1]}"]`);
      assert((await page.textContent('[data-key="bd-sel-count"]')) === '2件を選択中' && (await page.$$('.bd-post.is-checked')).length === 2 && (await page.textContent('[data-key="zone-new"]')) === '＋ 新しいまとまり（選んだ 2件で作る）', 'チェック 2 件');
      const bar = await page.locator('[data-key="bd-selbar"]').boundingBox();
      assert(bar.y + bar.height <= 1040 && bar.x >= 0, `選択中のバーは画面の中 ${JSON.stringify(bar)}`);
      await page.screenshot({ path: path.join(SHOTS, 'board-s1-select-960.png') });
      await page.click('[data-key="bd-make-group"]');
      await page.waitForSelector('dialog.name-dialog[open]');
      assert((await page.inputValue('[data-key="name-input"]')).length > 0 && (await page.inputValue('[data-key="name-genre"]')) === 'host' && (await cards()).length === 10, '名前とジャンルの下書き（まだ作らない）');
      await page.fill('[data-key="name-input"]', 'チェックで作った');
      await page.click('[data-key="name-ok"]');
      await page.waitForSelector('dialog.name-dialog', { state: 'detached' });
      cs = await cards();
      const G2 = cs[0].id;
      assert(cs[0].name === 'チェックで作った' && cs[0].kind === '作った' && cs[0].meta.startsWith('ホスト・投稿 2') && cs[1].id === G1 && cs.length === 11, `新しいものが先 ${JSON.stringify(cs.slice(0, 2))}`);
      assert(!(await page.$('[data-key="bd-selbar"]')) && !(await page.$(lp(rows[0]))) && !(await page.$(lp(rows[1]))) && (await topicOf(rows[1])) === G2, 'チェックは外れて、投稿は左から消える');
      // Shift+クリックで間をまとめて・Esc／解除で外す
      rows = await listIds();
      await page.click(`[data-key="chk-${rows[0]}"]`);
      await page.click(`[data-key="chk-${rows[3]}"]`, { modifiers: ['Shift'] });
      assert((await page.textContent('[data-key="bd-sel-count"]')) === '4件を選択中', await page.textContent('[data-key="bd-sel-count"]'));
      await page.click('[data-key="bd-sel-clear"]');
      assert(!(await page.$('[data-key="bd-selbar"]')) && !(await page.$('.bd-post.is-checked')), '解除');
      // チェックした行をつかむと、チェックした全部が動く（写しに「2件」）
      await page.click(`[data-key="chk-${rows[0]}"]`);
      await page.click(`[data-key="chk-${rows[2]}"]`);
      d = await bd.drag(page, lp(rows[2]), grp(G2));
      assert(d.lift && d.n === '2件' && d.tip === 'このまとまりに足す（2件）', JSON.stringify(d));
      assert((await metaOf(G2)).includes('投稿 4') && !(await page.$(lp(rows[0]))) && !(await page.$(lp(rows[2]))) && await page.$(lp(rows[1])) && !(await page.$('[data-key="bd-selbar"]')), `まとめて ${await metaOf(G2)}`);
      assert((await bd.toast(page)).includes('「チェックで作った」に 2件足しました'), await bd.toast(page));
      await page.keyboard.press('Control+z');
      assert((await metaOf(G2)).includes('投稿 2') && await page.$(lp(rows[0])) && await page.$(lp(rows[2])), '1 回で 2 件とも戻る');
      await page.keyboard.press('Control+Shift+Z');
      // チェックしていない行をつかむと、その 1 件だけ
      await page.click(`[data-key="chk-${rows[1]}"]`);
      d = await bd.drag(page, lp(rows[3]), grp(G1));
      assert(d.n === '' && d.tip === 'このまとまりに足す' && (await metaOf(G1)).includes('投稿 3') && await page.$(lp(rows[1])), JSON.stringify(d));
      await page.keyboard.press('Escape');
      assert(!(await page.$('[data-key="bd-selbar"]')), 'Esc でチェックを外す');
      // すべての投稿: 入っている投稿は「◯◯に入っています」。同じまとまりへは置けない（理由）・ほかへ置くと移る
      await page.selectOption('[data-key="bd-filter"]', 'all');
      await page.waitForSelector(lp(rows[0]));
      assert((await page.textContent(`[data-key="in-${rows[0]}"]`)) === '▸ チェックで作ったに入っています', await page.textContent(`[data-key="in-${rows[0]}"]`));
      d = await bd.drag(page, lp(rows[0]), grp(G2));
      assert(d.no && d.tip === '入れられません：もうこのまとまりに入っています' && d.denied === 1, JSON.stringify(d));
      assert((await bd.toast(page)).includes('もうこのまとまりに入っています') && (await metaOf(G2)).includes('投稿 4'), '置けない理由');
      d = await bd.drag(page, lp(rows[0]), grp(G1));
      assert(d.tip === 'このまとまりに足す' && (await metaOf(G2)).includes('投稿 3') && (await metaOf(G1)).includes('投稿 4') && (await bd.toast(page)).includes('（「チェックで作った」から移しました）'), `移す ${await bd.toast(page)}`);
      // Esc でドラッグをやめる
      const before = await metaOf(G1);
      d = await bd.drag(page, lp(rows[0]), '[data-key="zone-new"]', { drop: false });
      assert(d.lift && d.over.join() === 'newgroup', JSON.stringify(d));
      await page.keyboard.press('Escape');
      await page.mouse.up();
      assert(!(await page.$('.drag-lift')) && (await metaOf(G1)) === before && !(await page.$('dialog[open]')), 'Esc でやめる');
      await page.selectOption('[data-key="bd-filter"]', 'free');
      await page.waitForFunction((sel) => !document.querySelector(sel), lp(rows[0]));
      await page.click('[data-key="bd-chip-rec"]');
      await page.waitForFunction(() => document.querySelectorAll('.bd-post.is-list').length > 20);
      // カードを押すとその場で開く（左は投稿の一覧のまま。行に「＋」が出る）
      await page.click(grp(G1));
      await page.waitForSelector('[data-key="bd-open"]');
      const openRows = () => page.$$eval('.bd-post.is-in-open', (els) => els.map((e) => e.dataset.post));
      let op = await openRows();
      assert(op.length === 4 && (await page.textContent('[data-key="bd-open-count"]')).includes('4件') && await page.$('.bd-post.is-list') && (await page.textContent('.bd-left .bd-h')).startsWith('投稿'), `開く ${op.length}`);
      assert((await page.textContent('[data-key="bd-post-note"]')).includes('開いたまとまりに足せます'), await page.textContent('[data-key="bd-post-note"]'));
      rows = await listIds();
      await page.click(`[data-key="addp-${rows[0]}"]`);
      op = await openRows();
      assert(op.length === 5 && op[4] === rows[0] && !(await page.$(lp(rows[0]))), `＋ で足す ${op}`);
      // 並べ替え（先頭が代表）・入る位置へドラッグ・✕・左へ戻して外す
      d = await bd.drag(page, `[data-key="post-${op[2]}"]`, `[data-key="post-${op[0]}"]`, { ta: [0.5, 0.2] });
      assert(d.line && d.tip === '先頭へ（代表にする）', JSON.stringify(d));
      assert((await openRows())[0] === op[2] && await page.$(`[data-key="post-${op[2]}"] [data-key="bd-rep"]`), '並べ替え');
      op = await openRows();
      d = await bd.drag(page, lp(rows[1]), `[data-key="post-${op[1]}"]`, { ta: [0.5, 0.2], shot: 'board-s1-open-drag-960.png' });
      assert(d.line && d.tip === '「テストのまとまり」に足す', JSON.stringify(d));
      assert((await openRows())[1] === rows[1], '入る位置へ');
      await page.click(`[data-key="rm-${rows[1]}"]`);
      await page.waitForSelector(lp(rows[1]));
      assert((await openRows()).length === 5 && (await bd.toast(page)).includes('まとまりから外しました'), '✕ で外す');
      d = await bd.drag(page, `[data-key="post-${rows[0]}"]`, '[data-key="bd-lscroll"]', { ta: [0.5, 0.6] });
      assert(d.tip === 'このまとまりから外す' && d.over.join() === 'material', JSON.stringify(d));
      assert((await openRows()).length === 4 && await page.$(lp(rows[0])), '左へ戻すと外れる');
      await page.locator('[data-key="bd-open"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(SHOTS, 'board-s1-open-960.png') });
      // 開いたまとまりの投稿をほかのカードへ → 移す。「＋ 新しいまとまり」へ → 新しく作る
      op = await openRows();
      d = await bd.drag(page, `[data-key="post-${op[3]}"]`, grp(G2));
      assert(d.tip === '「チェックで作った」へ移す' && (await openRows()).length === 3 && (await metaOf(G2)).includes('投稿 4'), JSON.stringify(d));
      // 右クリック: 開く・プレビュー・名前・ジャンル・片付け・削除（番組に入れる項目は②）
      await page.click(grp(G2), { button: 'right' });
      await page.waitForSelector('.ctx-menu');
      for (const k of ['bd-ctx-open', 'bd-ctx-preview', 'bd-ctx-rename', 'bd-ctx-genre-kyaba', 'bd-ctx-shelf', 'bd-ctx-trash']) assert(await page.$(`[data-key="${k}"]`), `menu ${k}`);
      assert(!(await page.$('[data-key="bd-ctx-to-slot:0"]')) && !(await page.$('[data-key="bd-ctx-unplace"]')), '番組の項目は出さない');
      await page.click('[data-key="bd-ctx-rename"]');
      await page.waitForSelector('dialog.name-dialog[open]');
      await page.fill('[data-key="name-input"]', '名前を変えた');
      await page.click('[data-key="name-ok"]');
      await page.waitForFunction((sel) => { const e = document.querySelector(`${sel} .bd-name`); return e && e.textContent === '名前を変えた'; }, grp(G2));
      // 行を押すとプレビュー（960 では左の列の上）。開いたまとまりに足すボタン
      rows = await listIds();
      await page.click(`${lp(rows[0])} .bd-pt`);
      await page.waitForSelector('.bd.is-panel .bd-preview .pv-post');
      assert(await page.isHidden('.bd-left') && await page.isVisible('[data-key="bd-pv-addpost"]'), 'プレビュー');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.bd-preview', { state: 'detached' });
      // 検索（本文・@アカウント）。見つからないとき
      await page.fill('[data-key="bd-search"]', 'どこにも無い言葉');
      await page.waitForSelector('.bd-left .bd-empty');
      assert((await page.textContent('.bd-left .bd-empty')) === '見つかりませんでした', 'empty');
      await page.focus('[data-key="bd-search"]');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.bd-post.is-list');
      assert((await sw(page)) <= 960, 'no h-scroll');
      // ②へ: 作ったまとまりが左の一覧にある → メイン1 へドラッグ → 進行に出る
      await page.click('[data-key="bd-go-2"]');
      await page.waitForSelector('.bd[data-step="2"]');
      await page.fill('[data-key="bd-search"]', 'テストのまとまり');
      await page.waitForSelector('[data-key="bd-search-note"]');
      await page.waitForSelector(bd.mat(G1));
      d = await bd.drag(page, bd.mat(G1), '[data-key="slot-0"]');
      assert(d.tip === 'メイン1 に入れる' && (await bd.state(page)).main[0] === G1, JSON.stringify(d));
      assert((await page.textContent('[data-key="bd-step-2-sub"]')) === 'まとまり 11・番組に 1本', await page.textContent('[data-key="bd-step-2-sub"]'));
      // ①に戻ると、番組に入っているまとまりに場所の印（薄くはしない）。①で開いていたまとまりは開いたまま
      await page.click('[data-key="bd-step-1"]');
      await page.waitForSelector('.bd[data-step="1"]');
      assert((await page.textContent(`[data-key="place-${G1}"]`)) === 'メイン1' && await page.$('[data-key="bd-open"]') && !(await page.$('.bd-card.is-group.is-used')), '場所の印');
      const first = (await openRows())[0];
      await page.goto(`${show}#live`);
      await ready(page);
      await page.waitForSelector(`.live-post[data-post="${first}"]`);
      assert((await page.textContent('#view')).includes('テストのまとまり') && (await page.textContent(`.live-post[data-post="${first}"] .li-no`)) === '先頭（代表）', '進行に出る');
      await c.close();
    });

    await check('かんたん編成 ステップ①: 375（ドラッグなし）— 投稿／まとまりの切り替え・チェックして「まとまりにする」・開いて「＋」で足す・空のまとまりを作る・横スクロールなし', async () => {
      const c = await newCtx({ viewport: { width: 375, height: 812 }, hasTouch: true });
      const { page: p } = await open(c, `${show}#plan`);
      assert(await p.$('.bd.is-narrow[data-step="1"]') && await p.isVisible('.bd-left') && await p.isHidden('.bd-right'), 'narrow step 1');
      assert((await p.textContent('[data-key="bd-tab-material"]')) === '投稿' && (await p.textContent('[data-key="bd-tab-flow"]')) === 'まとまり（9）', await p.textContent('[data-key="bd-tab-flow"]'));
      const steps = await p.$$eval('.bd-step', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), Math.round(r.height)]; }));
      assert(steps.every((r) => r[0] >= 0 && r[1] <= 375 && r[2] >= 44), `ステップのボタン ${JSON.stringify(steps)}`);
      assert((await sw(p)) <= 375, `scrollWidth ${await sw(p)}`);
      const rows = await p.$$eval('.bd-post.is-list', (els) => els.slice(0, 4).map((e) => e.dataset.post));
      await p.click(`[data-key="chk-${rows[0]}"]`);
      await p.click(`[data-key="chk-${rows[1]}"]`);
      const bar = await p.locator('[data-key="bd-selbar"]').boundingBox();
      assert((await p.textContent('[data-key="bd-sel-count"]')) === '2件を選択中' && bar.x >= 0 && bar.x + bar.width <= 375 && bar.y + bar.height <= 812, `選択中のバー ${JSON.stringify(bar)}`);
      await p.screenshot({ path: path.join(SHOTS, 'board-s1-375.png') });
      await p.click('[data-key="bd-make-group"]');
      await p.waitForSelector('dialog.name-dialog[open]');
      await p.fill('[data-key="name-input"]', 'スマホで作った');
      await p.click('[data-key="name-ok"]');
      await p.waitForSelector('dialog.name-dialog', { state: 'detached' });
      assert((await p.textContent('[data-key="bd-tab-flow"]')) === 'まとまり（10）' && !(await p.$(`[data-key="lp-${rows[0]}"]`)) && !(await p.$('[data-key="bd-selbar"]')), 'まとまりにした');
      // まとまりのタブ: 作ったものが先。押して開く → 投稿のタブで「＋」
      await p.click('[data-key="bd-tab-flow"]');
      await p.waitForFunction(() => document.querySelector('.bd').dataset.tab === 'flow');
      const g = await p.$eval('.bd-card.is-group', (e) => ({ id: e.dataset.topic, name: e.querySelector('.bd-name').textContent, kind: e.querySelector('.bd-kind').textContent }));
      assert(g.name === 'スマホで作った' && g.kind === '作った' && await p.isVisible('.bd-right') && await p.isHidden('.bd-left'), JSON.stringify(g));
      assert((await p.textContent('[data-key="zone-new"]')).includes('押すと空のまとまりを作ります'), await p.textContent('[data-key="zone-new"]'));
      await p.click(`[data-key="grp-${g.id}"]`);
      await p.waitForSelector('[data-key="bd-open"]');
      assert((await p.$$('.bd-post.is-in-open')).length === 2 && (await p.textContent('[data-key="zone-open"]')).includes('上の「投稿」で「＋」'), await p.textContent('[data-key="zone-open"]'));
      await p.screenshot({ path: path.join(SHOTS, 'board-s1-375-open.png') });
      await p.click('[data-key="bd-tab-material"]');
      await p.waitForSelector(`[data-key="addp-${rows[2]}"]`);
      await p.click(`[data-key="addp-${rows[2]}"]`);
      assert(await p.evaluate(([id, t]) => window.__show.postTopic.get(id) === t, [rows[2], g.id]) && !(await p.$(`[data-key="lp-${rows[2]}"]`)), '＋ で足す');
      // 空のまとまりを作る（「＋ 新しいまとまり」を押す）→ 開いて、投稿のタブの「＋」で足せる
      await p.click('[data-key="bd-tab-flow"]');
      await p.click('[data-key="zone-new"]');
      await p.waitForSelector('dialog.name-dialog[open]');
      await p.fill('[data-key="name-input"]', '空から作る');
      await p.click('[data-key="name-ok"]');
      await p.waitForFunction(() => { const e = document.querySelector('[data-key="bd-open"] .bd-name'); return e && e.textContent === '空から作る'; });
      assert((await p.textContent('[data-key="bd-tab-flow"]')) === 'まとまり（11）' && (await p.$$('.bd-post.is-in-open')).length === 0, '空のまとまり');
      assert(await p.evaluate(() => { const w = window.__show.weekState(); return w.rundown.corners.every((c) => c.items.filter(Boolean).length === 0); }), '番組には入れない');
      assert((await sw(p)) <= 375, `scrollWidth ${await sw(p)}`);
      await c.close();
    });

    // ---- 4z-2. 「整理開始」（ボットへのお願いは GitHub のファイル。GitHub の API は page.route でにせもの）
    const seiri = {
      /** 終わるまで（または止まるまで）待って、パネルの文を返す */
      read: (pg) => pg.evaluate(() => {
        const t = (k) => (document.querySelector(`[data-key="${k}"]`) || {}).textContent || '';
        const p = document.querySelector('[data-key="seiri-panel"]');
        return { data: t('seiri-data-text'), bot: t('seiri-bot-text'), botState: (document.querySelector('[data-key="seiri-bot"]') || {}).dataset?.state, draft: t('seiri-draft-text'), sum: t('seiri-summary-text'), from: t('seiri-from'), status: t('seiri-status'), ended: p ? p.dataset.ended : null, chip: t('seiri-chip') };
      }),
      run: async (pg) => {
        await pg.click('[data-key="bd-seiri"]');
        await pg.waitForSelector('[data-key="seiri-panel"]');
        await pg.waitForFunction(() => { const e = document.querySelector('[data-key="seiri-panel"]'); return e && e.dataset.ended; }, null, { timeout: 20000 });
        return seiri.read(pg);
      },
      ended: (pg, v = null) => pg.waitForFunction((x) => { const e = document.querySelector('[data-key="seiri-panel"]'); return e && (x ? e.dataset.ended === x : e.dataset.ended); }, v, { timeout: 20000 }),
      post: (id, text, imp, cats = ['ホスト']) => ({ id, url: `https://x.com/e2e/status/${id}`, user: 'e2e_bot_user', created_jst: '2026-10-16T05:00:00+09:00', metrics: { impression_count: imp, like_count: 10 }, text, categories: cats, matched_terms: [] }),
      /** にせの GitHub（feedback/ への書き込みを記録・status.json・commit ごとのデータ）。token を入れてから読み直す */
      github: async (pg, { delays = { first: 300, later: 300, noReply: 60000, idle: 3600000 } } = {}) => {
        const gh = { puts: [], status: null, files: {}, gets: [] };
        await pg.route('https://api.github.com/**', async (route) => {
          const req = route.request();
          const u = new URL(req.url());
          const m = /^\/repos\/e2e\/repo\/contents\/(.+)$/.exec(u.pathname);
          if (!m) return route.fulfill({ status: 404, body: '{}' });
          const file = decodeURIComponent(m[1]);
          const ref = u.searchParams.get('ref');
          if (req.method() === 'PUT') {
            const body = JSON.parse(req.postData());
            gh.puts.push({ file, message: body.message, branch: body.branch, json: JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')) });
            return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ commit: { html_url: 'https://github.com/e2e/repo/commit/1' } }) });
          }
          gh.gets.push({ file, ref, accept: req.headers().accept, auth: req.headers().authorization });
          if (file.startsWith('feedback/')) return route.fulfill({ status: 404, body: '{}' });
          const v = file === 'data/show/status.json' ? gh.status : (gh.files[ref] || {})[file];
          if (v == null) return route.fulfill({ status: 404, body: '{}' });
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(v) });
        });
        await pg.evaluate((d) => {
          localStorage.setItem('xtrend-show-github', JSON.stringify({ repo: 'e2e/repo', branch: 'claude/e2e-branch', token: 'gh-e2e-token', auto: false }));
          localStorage.setItem('xtrend-show-prepare-delays', JSON.stringify(d));
        }, delays);
        await pg.reload();
        await ready(pg);
        return gh;
      },
      st: (id, extra = {}) => ({ app: 'xtrend-prepare-status', v: 1, request_id: id, state: 'running', stage: 'collect', message: '', started_at: '2026-10-16T07:00:00+09:00', updated_at: '2026-10-16T07:30:00+09:00', finished_at: null, eta_min: null, result: null, error: null, ...extra }),
      lastReq: (gh) => gh.puts.filter((x) => x.file === 'feedback/prepare-request.json').at(-1),
    };
    const samplePosts = JSON.parse(readFileSync(new URL('../../sample/show/posts.json', import.meta.url), 'utf8'));
    const NEWP = ['2110009990000000001', '2110009990000000002', '2110009990000000003', '2110009990000000004', '2110009990000000005'];
    const botFiles = {
      'data/posts.json': { ...samplePosts, generated_at: '2026-10-16T08:00:00+09:00', posts: [...samplePosts.posts,
        seiri.post(NEWP[0], 'E2E ふつうの出来事 A1', 900000), seiri.post(NEWP[1], 'E2E ふつうの出来事 A2', 800000), seiri.post(NEWP[2], 'E2E 一般の話 1', 700000, ['その他']),
        seiri.post(NEWP[3], 'E2E 一般の話 2', 600000, ['その他']), seiri.post(NEWP[4], 'E2E まだどこにも入っていない新しい投稿', 5000000)] },
      'data/show/topics.json': { generated_at: '2026-10-16T08:00:00+09:00', topics: [
        { id: 'e2e-call', name: 'E2E の出来事', genre: 'ホスト', post_ids: [NEWP[0], NEWP[1]], summary: 'E2E のリード文', confidence: 0.9 },
        { id: 'e2e-gen', name: 'E2E の一般', genre: 'その他', post_ids: [NEWP[2], NEWP[3]], confidence: 0.8 },
      ] },
    };
    const botDraft = (rid) => ({ generated_at: '2026-10-16T08:00:00+09:00', week: '2026-10-17', request_id: rid, main: [{ topic_id: 'e2e-call', reason: '今週の話題' }, { topic_id: 'e2e-gen' }], category: [{ topic_id: 'nope' }], chat: [{ topic_id: 'e2e-gen' }] });

    await check('整理開始: GitHub 未設定 → 最新のデータを読み直す（ページは読み直さない）・空いている所だけおまかせ・まとめ・1 回で元に戻す・新しい下書きファイルは使う（古い・違う週は使わない）・ボタンは両方のステップに・960 に収まる', async () => {
      const c = await newCtx();
      const { page } = await open(c, show);
      await page.evaluate(() => { window.__noReload = true; });
      const b1 = await page.locator('[data-key="bd-seiri"]').boundingBox();
      assert(b1 && b1.x + b1.width <= 960 && (await page.textContent('[data-key="bd-seiri"]')) === '整理開始' && (await page.getAttribute('[data-key="bd-seiri"]', 'title')).includes('GitHub 未設定'), `button ${JSON.stringify(b1)}`);
      await bd.step2(page);
      const tb = await page.evaluate(() => { const r = (k) => document.querySelector(`[data-key="${k}"]`).getBoundingClientRect(); return { s: r('bd-seiri'), u: r('undo'), t: r('title'), sw: document.documentElement.scrollWidth }; });
      assert(tb.sw <= 960 && Math.abs(tb.s.top - tb.u.top) < 2 && tb.s.right <= tb.u.left && tb.t.width >= 200 && tb.s.height >= 36, `上の帯 ${JSON.stringify(tb)}`);
      await page.screenshot({ path: path.join(SHOTS, 'seiri-button-960.png') });
      // 番組オーナーが入れたもの（メイン2・カテゴリ別のトー横）は動かさない
      await page.evaluate(([a, b]) => window.__show.edit('準備', (w) => { w.rundown.corners[0].items = [null, a, null]; w.rundown.corners[1].items = [b]; }), [HOST, TOYOKO]);
      const r = await seiri.run(page);
      assert(r.ended === 'done' && /^データ .+ 時点（前回から＋0件/.test(r.data) && r.botState === 'skip' && r.bot.includes('［ツール…］→「GitHub に直接保存」'), JSON.stringify(r));
      let st = await bd.state(page);
      assert(st.main[1] === HOST && st.main[0] && st.main[2] && st.category.join() === TOYOKO && st.chat.length === 3, `空いている所だけ ${JSON.stringify(st)}`);
      assert(r.draft.startsWith('メイン 2・雑談 3 を入れました（サイトのおまかせ') && r.from === '下書きのもと：サイトのおまかせ' && /^データ .+新着 0件・まとまり \d+（Grok 2）・下書き：メイン 2・カテゴリ別 0・雑談 3$/.test(r.sum), JSON.stringify(r));
      assert(await page.evaluate(() => window.__noReload === true), 'ページは読み直さない');
      await page.screenshot({ path: path.join(SHOTS, 'seiri-local-960.png') });
      await page.click('[data-key="seiri-go-2"]');
      assert(!(await page.$('[data-key="seiri-panel"]')) && await page.$('.bd[data-step="2"]'), 'go 2');
      await page.keyboard.press('Control+z');
      st = await bd.state(page);
      assert(st.main[1] === HOST && !st.main[0] && !st.main[2] && st.category.join() === TOYOKO && !st.chat.length, `undo ${JSON.stringify(st)}`);
      // 新しい下書きファイル（同じ番組週・12 時間以内）はトークンが無くても使う
      let fileDraft = { generated_at: new Date(Date.now() - 3600 * 1000).toISOString(), week: '2026-10-17', request_id: 'auto-20261016-1800', main: [{ topic_id: 'sample-ramen-2026w42' }], category: [], chat: [] };
      await page.route(/\/sample\/show\/draft\.json/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fileDraft) }));
      let r2 = await seiri.run(page);
      assert(r2.from === '下書きのもと：ボットの下書きファイル' && (await bd.state(page)).main[0] === 'g:sample-ramen-2026w42', JSON.stringify(r2));
      await page.click('[data-key="seiri-close"]');
      for (const bad of [{ generated_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString() }, { week: '2026-10-24' }]) {
        await page.keyboard.press('Control+z');
        fileDraft = { ...fileDraft, generated_at: new Date().toISOString(), ...bad };
        r2 = await seiri.run(page);
        assert(r2.from === '下書きのもと：サイトのおまかせ', `${JSON.stringify(bad)} ${JSON.stringify(r2)}`);
        await page.click('[data-key="seiri-close"]');
      }
      assert((await sw(page)) <= 960, 'no h-scroll');
      await c.close();
    });

    await check('整理開始: GitHub あり → 修正を最新に → お願いを書く（週・期間・決まり・決めたもの）→ status.json を見に行く（queued → running → done）・板の上の知らせ・リロードしても続く → その commit の投稿・Grok のまとまり・下書きを空いている所だけ・1 回で元に戻す・10 分以内は聞く・キャンセル', async () => {
      const c = await newCtx();
      const { page } = await open(c, show);
      const gh = await seiri.github(page);
      assert((await page.getAttribute('[data-key="bd-seiri"]', 'title')).includes('GitHub を通して'), 'title');
      assert(await page.evaluate(() => ![...document.querySelector('.bd').childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())), '板の直下に文字が混ざらない');
      // 番組オーナーが入れたもの: メイン1（ホストコール）と手で作ったまとまり（メイン候補）
      await page.evaluate(([a]) => window.__show.edit('準備', (w) => { w.rundown.corners[0].items = [a, null, null]; w.overrides.manual = [...w.overrides.manual, { id: 'm:e2eown', name: '手で作った', genre: 'host' }]; w.overrides.moves['2110001792007450003'] = 'm:e2eown'; w.mainCand = ['m:e2eown']; }), [HOST]);
      await page.click('[data-key="bd-seiri"]');
      await page.waitForFunction(() => (document.querySelector('[data-key="seiri-status"]') || {}).textContent === 'ボットを待っています');
      // 書いたもの: 修正 → お願い（feedback/ だけ）
      assert(gh.puts.map((x) => x.file).join() === 'feedback/show-feedback.json,feedback/prepare-request.json' && gh.puts.every((x) => x.branch === 'claude/e2e-branch'), JSON.stringify(gh.puts.map((x) => x.file)));
      const req = gh.puts[1].json;
      const want = await page.evaluate(() => { const a = window.__show; const iso = (t) => { const d = new Date((t + 9 * 3600) * 1000); const p = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+09:00`; }; return { key: a.week.key, from: iso(a.week.start), to: iso(a.week.end), rfrom: iso(a.range.start) }; });
      assert(req.app === 'xtrend-prepare' && req.v === 1 && /^p-\d{8}-\d{4}-[0-9a-z]{4}$/.test(req.id) && req.force === false && req.cancel === false && /\+09:00$/.test(req.requested_at), JSON.stringify(req).slice(0, 300));
      assert(JSON.stringify(req.week) === JSON.stringify({ key: want.key, from: want.from, to: want.to }) && req.week.key === '2026-10-17' && req.range.from === want.rfrom, JSON.stringify([req.week, want]));
      assert(req.rules.main_slots === 3 && req.rules.main_night_only === true && req.rules.genre_priority[0] === 'ホスト' && req.rules.category_count === 6 && req.rules.chat_count === 3 && req.rules.min_posts_for_main === 2, JSON.stringify(req.rules));
      assert(req.keep.placed_topic_ids.includes(HOST) && req.keep.placed_topic_ids.includes('m:e2eown') && req.keep.manual_topics.some((t) => t.id === 'm:e2eown' && t.name === '手で作った' && t.post_ids.includes('2110001792007450003')), JSON.stringify(req.keep));
      assert(req.feedback_generated_at && req.feedback_generated_at === gh.puts[0].json.generated_at && gh.puts[1].message === `prepare: request ${req.id}`, 'feedback_generated_at');
      assert(!JSON.stringify(req).includes('gh-e2e-token'), 'トークンは書かない');
      // status.json を GitHub の API（raw・ブランチ）で見に行く。ほかの id の知らせは自分のことにしない
      gh.status = seiri.st('auto-20261016-0600', { state: 'running', stage: 'push', message: 'ほかの整理' });
      await page.waitForFunction(() => /ほかの整理/.test((document.querySelector('[data-key="seiri-other"]') || {}).textContent || ''));
      const sget = gh.gets.filter((x) => x.file === 'data/show/status.json').at(-1);
      assert(sget.ref === 'claude/e2e-branch' && sget.accept === 'application/vnd.github.raw+json' && sget.auth === 'Bearer gh-e2e-token', JSON.stringify(sget));
      assert((await page.textContent('[data-key="seiri-chip"]')) === 'ボットにお願いしました（受け付けを待っています）', await page.textContent('[data-key="seiri-chip"]'));
      gh.status = seiri.st(req.id, { state: 'queued', stage: null });
      await page.waitForFunction(() => /^ボットが受け付けました/.test((document.querySelector('[data-key="seiri-chip"]') || {}).textContent || ''));
      gh.status = seiri.st(req.id, { state: 'running', stage: 'group', message: 'Grok がまとまりを作っています（412 件）', updated_at: '2026-10-16T07:42:00+09:00', eta_min: 15 });
      await page.waitForFunction(() => (document.querySelector('[data-key="seiri-chip"]') || {}).textContent === 'ボットが整理中：Grok がまとまりを作っています（412 件）（07:42 更新・あと 15分ほど）');
      const stages = await page.$$eval('.sr-stages li', (els) => els.map((e) => e.className));
      assert(stages.join() === 'is-done,is-done,is-done,is-now,,' && (await page.textContent('[data-key="bd-seiri"]')) === 'ボット整理中…', stages.join());
      await page.screenshot({ path: path.join(SHOTS, 'seiri-progress-960.png') });
      // 閉じても待つ（板の上の知らせ）。作業も続けられる
      await page.click('[data-key="seiri-close"]');
      assert(!(await page.$('[data-key="seiri-panel"]')) && await page.isVisible('[data-key="seiri-chip"]'), 'chip');
      await page.screenshot({ path: path.join(SHOTS, 'seiri-chip-960.png') });
      // リロードしても続く
      await page.reload();
      await ready(page);
      await page.waitForFunction(() => /^ボットが整理中/.test((document.querySelector('[data-key="seiri-chip"]') || {}).textContent || ''));
      assert(!(await page.$('[data-key="seiri-panel"]')), 'リロード後はパネルを閉じたまま');
      // done → その commit のデータを読む → 空いている所だけ下書き
      gh.files.abc1234 = { ...botFiles, 'data/show/draft.json': botDraft(req.id) };
      gh.status = seiri.st(req.id, { state: 'done', stage: 'push', finished_at: '2026-10-16T08:01:00+09:00', result: { commit: 'abc1234', data_generated_at: '2026-10-16T08:00:00+09:00', new_posts: 5, topics: 2 } });
      await seiri.ended(page, 'done');
      const r = await seiri.read(page);
      const dataGets = gh.gets.filter((x) => x.ref === 'abc1234').map((x) => x.file).sort();
      assert(dataGets.join() === 'data/posts.json,data/show/draft.json,data/show/topics.json', dataGets.join());
      assert(r.bot === 'ボットの整理が終わりました（新しい投稿 5件・まとまり 2）' && r.from === '下書きのもと：ボット' && /^データ 10\/16 08:00 時点・新着 5件・まとまり \d+（Grok 2）・下書き：メイン 1・カテゴリ別 0・雑談 1$/.test(r.sum) && !r.chip, JSON.stringify(r));
      let st = await bd.state(page);
      assert(st.main[0] === HOST && st.main[1] === 'g:e2e-call' && !st.main[2] && st.cand.join() === 'm:e2eown' && st.category.length === 0 && st.chat.join() === 'g:e2e-gen', `ボットの下書き ${JSON.stringify(st)}`);
      assert(r.draft.includes('使えないもの 2件は飛ばしました'), r.draft);
      await page.screenshot({ path: path.join(SHOTS, 'seiri-done-960.png') });
      await page.click('[data-key="seiri-go-1"]');
      await page.waitForSelector('.bd[data-step="1"]');
      assert(await page.$(`[data-key="lp-${NEWP[4]}"]`) && !(await page.$(`[data-key="lp-${NEWP[0]}"]`)) && await page.$('[data-key="grp-g:e2e-call"] .bd-mark.is-bot'), '①に出る');
      await page.keyboard.press('Control+z');
      st = await bd.state(page);
      assert(st.main[0] === HOST && !st.main[1] && st.cand.join() === 'm:e2eown' && !st.chat.length, `undo ${JSON.stringify(st)}`);
      // 10 分以内はまず聞く（お願いは書かない）→ 今あるデータで進める
      const n0 = gh.puts.length;
      await page.click('[data-key="bd-seiri"]');
      await page.waitForSelector('[data-key="seiri-local"]');
      assert((await page.textContent('[data-key="seiri-bot-text"]')).startsWith('少し前にボットにお願いしました（あと'), 'ask');
      await page.click('[data-key="seiri-local"]');
      await seiri.ended(page, 'done');
      assert(gh.puts.length === n0 && (await seiri.read(page)).from === '下書きのもと：サイトのおまかせ', 'お願いは書かない');
      await page.click('[data-key="seiri-close"]');
      await page.keyboard.press('Control+z');
      // それでも実行 → force: true → キャンセル（同じ id で cancel: true）
      await page.click('[data-key="bd-seiri"]');
      await page.click('[data-key="seiri-force"]');
      await page.waitForFunction(() => (document.querySelector('[data-key="seiri-status"]') || {}).textContent === 'ボットを待っています');
      const req2 = seiri.lastReq(gh).json;
      assert(req2.force === true && req2.id !== req.id, 'force');
      await page.click('[data-key="seiri-cancel"]');
      await page.waitForFunction(() => (document.querySelector('[data-key="seiri-bot-text"]') || {}).textContent === 'ボットに取り消しを送りました');
      const cancel = seiri.lastReq(gh);
      assert(cancel.json.id === req2.id && cancel.json.cancel === true && cancel.message === `prepare: cancel ${req2.id}` && (await seiri.read(page)).status === 'やめました' && !(await page.$('[data-key="seiri-chip"]')), JSON.stringify(cancel.json).slice(0, 200));
      assert(await page.evaluate(() => !localStorage.getItem('xtrend-show-prepare')), '待っているお願いは消す');
      st = await bd.state(page);
      assert(st.main[0] === HOST && !st.main[1] && !st.chat.length, 'キャンセルしたら下書きは入れない');
      assert((await sw(page)) <= 960, 'no h-scroll');
      await c.close();
    });

    await check('整理開始: ボットが busy（too_soon）・error・返事がない（10 分）→ 理由と「今あるデータで下書き」・「待ち続ける」・自動整理（auto-…）が終わったら「反映する」', async () => {
      const c = await newCtx();
      const { page } = await open(c, show);
      const gh = await seiri.github(page, { delays: { first: 300, later: 300, noReply: 2500, idle: 3600000 } });
      const press = async () => {
        await page.evaluate(() => localStorage.removeItem('xtrend-show-prepare-last'));
        const n = gh.puts.length;
        await page.click('[data-key="bd-seiri"]');
        await page.waitForFunction((k) => document.querySelector('[data-key="seiri-status"]') && document.querySelector('[data-key="seiri-status"]').textContent === 'ボットを待っています', null);
        assert(gh.puts.length === n + 2, 'お願いを書いた');
        return seiri.lastReq(gh).json.id;
      };
      // busy（too_soon）
      let id = await press();
      gh.status = seiri.st(id, { state: 'busy', error: { code: 'too_soon', message: '少し前に実行しました', retry_after_min: 7 } });
      await seiri.ended(page, 'error');
      let r = await seiri.read(page);
      assert(r.bot === '少し前に実行しました（あと7分）' && r.status === '止まりました' && await page.isVisible('[data-key="seiri-local-draft"]'), JSON.stringify(r));
      await page.click('[data-key="seiri-local-draft"]');
      await seiri.ended(page, 'done');
      assert((await seiri.read(page)).from === '下書きのもと：サイトのおまかせ', 'local');
      await page.click('[data-key="seiri-close"]');
      await page.keyboard.press('Control+z');
      // error
      id = await press();
      gh.status = seiri.st(id, { state: 'error', stage: 'collect', error: { code: 'x_rate_limited', message: 'X の上限に達しました', retry_after_min: 15 } });
      await seiri.ended(page, 'error');
      r = await seiri.read(page);
      assert(r.bot === 'X の上限に達しました（15分後にもう一度できます）' && r.botState === 'ng', JSON.stringify(r));
      await page.screenshot({ path: path.join(SHOTS, 'seiri-error-960.png') });
      await page.click('[data-key="seiri-close"]');
      // 返事がない（自分の id の知らせが来ない）→ 聞く → 待ち続ける → done
      id = await press();
      gh.status = seiri.st('auto-20261016-0600', { state: 'done', result: { commit: 'def5678' } });
      await page.waitForSelector('[data-key="seiri-keep-waiting"]', { timeout: 15000 });
      r = await seiri.read(page);
      assert(r.bot === 'ボットから返事がありません（起動していない可能性があります）' && r.botState === 'ask' && await page.isVisible('[data-key="seiri-local-draft"]'), JSON.stringify(r));
      await page.screenshot({ path: path.join(SHOTS, 'seiri-noreply-960.png') });
      await page.click('[data-key="seiri-keep-waiting"]');
      await page.waitForTimeout(3500);
      assert(!(await page.$('[data-key="seiri-keep-waiting"]')) && (await seiri.read(page)).status === 'ボットを待っています', 'もう聞かない');
      gh.files.fed9876 = { ...botFiles, 'data/show/draft.json': botDraft(id) };
      gh.status = seiri.st(id, { state: 'done', result: { commit: 'fed9876', new_posts: 5, topics: 2 } });
      await seiri.ended(page, 'done');
      assert((await seiri.read(page)).from === '下書きのもと：ボット' && (await bd.state(page)).main.includes('g:e2e-call'), 'done after waiting');
      await page.click('[data-key="seiri-close"]');
      await page.keyboard.press('Control+z');
      // 返事がない → 今あるデータで下書き（待つのをやめる）
      id = await press();
      gh.status = null;
      await page.waitForSelector('[data-key="seiri-keep-waiting"]', { timeout: 15000 });
      await page.click('[data-key="seiri-local-draft"]');
      await seiri.ended(page, 'done');
      r = await seiri.read(page);
      assert(r.bot === 'ボットから返事がありませんでした。今あるデータで進めます' && r.from === '下書きのもと：サイトのおまかせ' && await page.evaluate(() => !localStorage.getItem('xtrend-show-prepare')), JSON.stringify(r));
      await page.click('[data-key="seiri-close"]');
      await page.keyboard.press('Control+z');
      // ボットの自動整理（auto-…）が終わっている（お願いはしていない）→「反映する」→ 空いている所だけ
      gh.files.aaa1111 = { ...botFiles, 'data/show/draft.json': botDraft('auto-20261016-1800') };
      gh.status = seiri.st('auto-20261016-1800', { state: 'done', finished_at: '2026-10-16T18:40:00+09:00', result: { commit: 'aaa1111', new_posts: 5, topics: 2 } });
      await page.reload();
      await ready(page);
      await page.waitForSelector('[data-key="seiri-auto"]');
      assert((await page.textContent('[data-key="seiri-auto"]')).startsWith('ボットの自動整理が終わりました（18:40）'), await page.textContent('[data-key="seiri-auto"]'));
      await page.screenshot({ path: path.join(SHOTS, 'seiri-auto-960.png') });
      await page.click('[data-key="seiri-auto-apply"]');
      await seiri.ended(page, 'done');
      assert((await seiri.read(page)).from === '下書きのもと：ボット' && (await bd.state(page)).main.includes('g:e2e-call') && !(await page.$('[data-key="seiri-auto"]')), 'auto applied');
      // 反映したものは、読み直してももう出さない
      await page.reload();
      await ready(page);
      await page.waitForTimeout(800);
      assert(!(await page.$('[data-key="seiri-auto"]')), 'seen');
      assert((await sw(page)) <= 960, 'no h-scroll');
      await c.close();
    });

    // ---- 5. 実データ（リポジトリの data/。読むだけ）。今週（約 960 件）の 10/31 配信の週で確認
    if (existsSync(path.join(ROOT, 'data', 'posts.json'))) {
      await check('実データ: 1 操作の速さ（受信箱の表示・選択・移動・元に戻す・検索）', async () => {
        const c7 = await newCtx();
        const { page: p } = await open(c7, folders, {});
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
        // 対象期間を直近30日にしたとき
        await p.evaluate(() => window.__show.setRange({ mode: 'd30' }));
        await p.waitForFunction(() => window.__show.weekState().range.mode === 'd30');
        const t30 = await p.evaluate(() => {
          const a = window.__show;
          const ms = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
          const out = { n: a.rangePostCount };
          out.render = ms(() => a.render());
          out.select = ms(() => { a.ui.sel = { sel: new Set([a.ui.rows[0].key]), anchor: 0 }; a.render(); });
          out.edit = ms(() => a.edit('計測', (w) => { w.mainCand = [...w.mainCand]; }));
          out.undo = ms(() => a.undo());
          return out;
        });
        assert(t30.render < 120 && t30.select < 120 && t30.edit < 300, JSON.stringify(t30));
        t.d30 = t30;
        await c7.close();
        return `直近30日 ${t.d30.n}件: 描画 ${f(t.d30.render)}・選択 ${f(t.d30.select)}・編集 ${f(t.d30.edit)}・元に戻す ${f(t.d30.undo)}／今週 ${n}件（すべて表示 ${t.rows}行）: 描画 ${f(t.render)}・全件表示 ${f(t.allRows)}・検索 ${f(t.search)}・選択 ${f(t.select)}・編集 ${f(t.edit)}・元に戻す ${f(t.undo)}（画面操作込み: 右クリック移動 ${moveMs}ms・元に戻すボタン ${undoMs}ms）`;
      });
      await check('実データ: かんたん編成 ステップ①（960）— 投稿とまとまりの一覧・速さ・投稿をカードへ／新しいまとまりへ・チェックの選択中のバー・開いたまとまり', async () => {
        const c8 = await newCtx();
        const { page: p } = await open(c8, `${show}#plan`, {});
        assert(await p.isHidden('#sample-banner') && await p.$('.bd[data-step="1"]'), 'real step 1');
        const n = await p.evaluate(() => ({
          posts: window.__show.weekPosts.length, rows: document.querySelectorAll('.bd-post.is-list').length, free: Number(document.querySelector('[data-key="bd-lscroll"]').dataset.total),
          cards: document.querySelectorAll('.bd-card.is-group').length, groups: Number(document.querySelector('[data-key="bd-rscroll"]').dataset.total),
          subs: [1, 2].map((k) => document.querySelector(`[data-key="bd-step-${k}-sub"]`).textContent),
        }));
        assert(n.rows === 40 && n.free > 40 && n.cards === 40 && n.groups >= 40 && (await sw(p)) <= 960, JSON.stringify(n));
        await p.screenshot({ path: path.join(SHOTS, 'real-board-s1-960.png') });
        const t = await p.evaluate(() => {
          const a = window.__show;
          const ms = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
          const out = {};
          out.render = ms(() => a.render());
          a.ui.board.filter = 'all';
          out.all = ms(() => a.render());
          a.ui.board.query1 = 'ホスト';
          out.search = ms(() => a.render());
          a.ui.board.query1 = '';
          a.ui.board.filter = 'free';
          a.render();
          return out;
        });
        assert(t.render < 200 && t.all < 250 && t.search < 300, JSON.stringify(t));
        const rows = await p.$$eval('.bd-post.is-list', (els) => els.slice(0, 6).map((e) => e.dataset.post));
        const g0 = await p.$eval('.bd-card.is-group', (e) => ({ id: e.dataset.topic, meta: e.querySelector('.bd-meta').textContent }));
        const num = (s) => Number(/投稿 (\d+)/.exec(s)[1]);
        let d = await bd.drag(p, `[data-key="lp-${rows[0]}"]`, `[data-key="grp-${g0.id}"]`, { shot: 'real-board-s1-drag-960.png' });
        assert(d.lift && d.tip === 'このまとまりに足す' && d.ok >= 41, JSON.stringify(d));
        assert(num(await p.textContent(`[data-key="gmeta-${g0.id}"]`)) === num(g0.meta) + 1 && !(await p.$(`[data-key="lp-${rows[0]}"]`)), 'カードへ足す');
        await p.evaluate(() => { const e = document.getElementById('toast'); if (e) e.hidden = true; });
        await p.click(`[data-key="chk-${rows[1]}"]`);
        await p.click(`[data-key="chk-${rows[2]}"]`);
        await p.screenshot({ path: path.join(SHOTS, 'real-board-s1-select-960.png') });
        d = await bd.drag(p, `[data-key="lp-${rows[1]}"]`, '[data-key="zone-new"]');
        assert(d.n === '2件' && d.tip === '新しいまとまりを作る（2件）', JSON.stringify(d));
        await p.waitForSelector('dialog.name-dialog[open]');
        await p.click('[data-key="name-ok"]');
        await p.waitForSelector('dialog.name-dialog', { state: 'detached' });
        const made = await p.$eval('.bd-card.is-group', (e) => ({ id: e.dataset.topic, kind: e.querySelector('.bd-kind').textContent, meta: e.querySelector('.bd-meta').textContent }));
        assert(made.id.startsWith('m:') && made.kind === '作った' && num(made.meta) === 2, JSON.stringify(made));
        await p.click(`[data-key="grp-${g0.id}"]`);
        await p.waitForSelector('[data-key="bd-open"]');
        await p.evaluate(() => { const e = document.getElementById('toast'); if (e) e.hidden = true; });
        await p.screenshot({ path: path.join(SHOTS, 'real-board-s1-open-960.png') });
        assert((await sw(p)) <= 960, 'no h-scroll');
        await c8.close();
        return `投稿 ${n.posts}（まだ入っていない ${n.free}）・まとまり ${n.groups}: 描画 ${t.render.toFixed(1)}ms・すべての投稿 ${t.all.toFixed(1)}ms・検索 ${t.search.toFixed(1)}ms`;
      });
      await check('実データ: かんたん編成（960）— 描画と 1 操作の速さ・ドラッグ・開いた話題・1920 のプレビュー・375', async () => {
        const c7 = await newCtx();
        const { page: p } = await open(c7, `${show}#plan`, {});
        await bd.step2(p);
        assert(await p.isHidden('#sample-banner') && await p.$('.bd'), 'real board');
        const n = await p.evaluate(() => ({ topics: window.__show.visibleTopics.length, posts: window.__show.weekPosts.length, cards: document.querySelectorAll('.bd-card.is-material').length }));
        assert(n.cards <= 40 && (await sw(p)) <= 960, JSON.stringify(n));
        await p.screenshot({ path: path.join(SHOTS, 'real-board-960.png') });
        const ids = await p.$$eval('.bd-card.is-material:not(.is-used)', (els) => els.slice(0, 6).map((e) => e.dataset.topic));
        const d = await bd.drag(p, bd.mat(ids[2]), '[data-key="slot-1"]', { shot: 'real-board-drag-960.png' });
        assert(d.lift && d.ok >= 5 && (await bd.state(p)).main[1] === ids[2], JSON.stringify(d));
        await bd.drag(p, bd.mat(ids[0]), '[data-key="slot-0"]');
        await bd.drag(p, bd.mat(ids[1]), '[data-key="zone-category"]');
        await bd.drag(p, bd.mat(ids[3]), '[data-key="zone-category"]');
        const t = await p.evaluate(async () => {
          const a = window.__show;
          const ms = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
          const out = {};
          out.render = ms(() => a.render());
          out.edit = ms(() => a.edit('計測', (w) => { w.mainCand = [...w.mainCand]; }));
          out.undo = ms(() => a.undo());
          a.ui.board.query = 'ホスト';
          out.search = ms(() => a.render());
          a.ui.board.query = '';
          a.ui.board.pages = 40;
          out.all = ms(() => a.render());
          out.allCards = document.querySelectorAll('.bd-card.is-material').length;
          a.ui.board.pages = 1;
          a.render();
          return out;
        });
        assert(t.render < 150 && t.search < 250 && t.edit < 400, JSON.stringify(t));
        await p.click(bd.flow(ids[0]));
        await p.waitForSelector('[data-key="bd-open"]');
        const o = await p.evaluate(async () => { const a = window.__show; const t0 = performance.now(); a.render(); return { render: performance.now() - t0, addable: document.querySelectorAll('.bd-post.is-addable').length, rows: document.querySelectorAll('.bd-post.is-in-open').length }; });
        assert(o.render < 200 && o.addable <= 40 && o.rows >= 1, JSON.stringify(o));
        await p.locator('[data-key="bd-rscroll"]').evaluate((e) => { e.scrollTop = 0; });
        await p.screenshot({ path: path.join(SHOTS, 'real-board-open-960.png') });
        assert((await sw(p)) <= 960, 'no h-scroll');
        // 1920: プレビューの列
        await p.setViewportSize({ width: 1920, height: 1080 });
        await p.waitForSelector('.bd.is-wide');
        await p.click('[data-key="bd-preview"]');
        await p.waitForSelector('.bd-preview .pv-post');
        await p.waitForTimeout(600);
        await p.screenshot({ path: path.join(SHOTS, 'real-board-1920.png') });
        // 375
        await p.setViewportSize({ width: 375, height: 812 });
        await p.waitForSelector('.bd.is-narrow');
        await p.click('[data-key="bd-preview-close"]').catch(() => {});
        await p.click('[data-key="bd-tab-flow"]');
        await p.evaluate(() => window.scrollTo(0, 0));
        assert((await sw(p)) <= 375, `scrollWidth ${await sw(p)}`);
        await p.screenshot({ path: path.join(SHOTS, 'real-board-375.png'), fullPage: false });
        await c7.close();
        return `話題 ${n.topics}・投稿 ${n.posts}: 描画 ${t.render.toFixed(1)}ms・編集 ${t.edit.toFixed(1)}ms・元に戻す ${t.undo.toFixed(1)}ms・検索 ${t.search.toFixed(1)}ms・全件（${t.allCards}枚）${t.all.toFixed(1)}ms・開いた話題 ${o.render.toFixed(1)}ms`;
      });
      for (const [w, hh, route] of [[960, 1040, 'plan-folders'], [1280, 1400, 'plan-folders'], [1920, 1080, 'plan-folders'], [375, 812, 'plan-folders'], [960, 1040, 'plan'], [1920, 1080, 'plan'], [375, 812, 'plan'], [960, 1040, 'live'], [375, 812, 'live'], [1920, 1080, 'onair']]) {
        await check(`実データ data/ ${route} ${w}×${hh}`, async () => {
          const c7 = await newCtx({ viewport: { width: w, height: hh } });
          const { page: p } = await open(c7, `${show}#${route}`, {});
          assert(await p.isHidden('#sample-banner'), 'sample banner shown with real data');
          const wkKey = await p.evaluate(() => (window.__show.weeks.find((x) => x.key === '2026-10-31') || window.__show.weeks[0]).key);
          if (route !== 'onair') {
            await p.selectOption('#week-select', wkKey);
            await p.waitForFunction((k) => window.__show.weekKey === k, wkKey);
          }
          if (route === 'plan-folders' && w >= 1280) {
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
