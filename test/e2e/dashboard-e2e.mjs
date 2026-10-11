// 静的ダッシュボード（index.html）の E2E。
//
// 実行方法（依存ゼロ方針のため playwright はリポジトリに入れない）:
//   mkdir -p /path/to/qa && cd /path/to/qa && npm init -y && npm i playwright
//   # Chromium は PLAYWRIGHT_BROWSERS_PATH（例: /opt/pw-browsers）にあるものを使う。`playwright install` は不要
//   PW_DIR=/path/to/qa/node_modules node test/e2e/dashboard-e2e.mjs
//   スクリーンショットの出力先は SHOTS_DIR（既定: OS の一時ディレクトリ/x-trend-dashboard-shots）
//
// このファイルは test/*.test.js の glob に入らないため `npm test` では実行されない。
// リポジトリ直下を `python3 -m http.server`（空きポート）で配信し、終了時に停止する。
// data/ のケースは主に page.route で差し替える（リポジトリに data/ を作らない）。
// 実ファイル配置のケースだけ一時的に data/ を作り、finally で必ず削除する（既に data/ があれば実行しない）。
// 外部通信（X 埋め込み・画像）はすべて page.route でモック／遮断する。

import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, cpSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'x-trend-dashboard-shots');
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

// ---------------------------------------------------------------- 結果集計

const results = [];
let failed = 0;
async function check(name, fn) {
  try {
    const info = await fn();
    results.push(`ok   ${name}${info ? ` — ${info}` : ''}`);
    console.log(results[results.length - 1]);
  } catch (err) {
    failed++;
    results.push(`FAIL ${name} — ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err}`);
    console.log(results[results.length - 1]);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ---------------------------------------------------------------- モック

// 1x1 の PNG（マゼンタ）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4/5/hPwAHAgL/jg2v2QAAAABJRU5ErkJggg==', 'base64');

// 偽 widgets.js: ID 末尾が偶数なら埋め込み成功、奇数なら失敗（undefined）を返す
const FAKE_WIDGETS = `
window.twttr = {
  ready: function (cb) { cb(window.twttr); },
  widgets: {
    createTweet: function (id, el, opts) {
      window.__embedCalls = (window.__embedCalls || []).concat([{ id: id, opts: opts }]);
      return new Promise(function (resolve) {
        setTimeout(function () {
          if (/[02468]$/.test(id)) {
            var d = document.createElement('div');
            d.className = 'fake-tweet';
            d.textContent = 'FAKE EMBED ' + id + ' theme=' + opts.theme;
            el.appendChild(d);
            resolve(d);
          } else { resolve(undefined); }
        }, 80);
      });
    }
  }
};`;

/**
 * ページごとのルーティング。
 *  data: { posts, summary } … 値が null なら 404、文字列ならそのまま返す（不正 JSON 用）。undefined なら実ファイル
 *  widgets: 'fake' | 'block'
 */
async function setupRoutes(page, { data, widgets = 'fake' } = {}) {
  const external = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') {
      if (data && url.pathname.startsWith('/data/')) {
        const key = { '/data/posts.json': 'posts', '/data/summary.json': 'summary', '/data/reports.json': 'reports' }[url.pathname] || null;
        if (key && key in data) {
          const v = data[key];
          if (v == null) return route.fulfill({ status: 404, body: 'not found' });
          return route.fulfill({ status: 200, contentType: 'application/json', body: typeof v === 'string' ? v : JSON.stringify(v) });
        }
      }
      return route.continue();
    }
    external.push(url.href);
    if (url.href.startsWith('https://platform.twitter.com/widgets.js') && widgets === 'fake') {
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_WIDGETS });
    }
    if (url.hostname === 'pbs.twimg.com' && /SAMPLE_ok_/.test(url.pathname)) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    }
    return route.abort('blockedbyclient');
  });
  return external;
}

function watchConsole(page) {
  const errors = [];
  const expected = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => { errors.push(`dialog: ${d.message()}`); d.dismiss(); });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // 想定内: data/ の 404（サンプルへフォールバックするケース）、遮断した外部リソース
    if (/Failed to load resource/.test(t)) expected.push(t);
    else errors.push(`console: ${t}`);
  });
  return { errors, expected };
}

async function ready(page) {
  await page.waitForFunction(() => (window.__dashboard && window.__dashboard.ready) || !document.getElementById('error').hidden, null, { timeout: 15000 });
}

const count = (page) => page.$eval('#result-count', (e) => e.textContent);
const shown = (page) => page.$$eval('#post-list > li', (l) => l.length);
// 初期状態（夜職すべて＝夜職4カテゴリ、期間 24 時間）の件数
const NIGHT = ['ホスト', 'キャバクラ', '歌舞伎町', '夜職その他'];
const inNight = (p) => p.categories.some((c) => NIGHT.includes(c));
function defaultCount(json) {
  const ref = Math.floor(Date.parse(json.generated_at) / 1000);
  return json.posts.filter((p) => p.ts > ref - 86400 && inNight(p)).length;
}
const num = (s) => Number((/[\d,]+/.exec(String(s)) || ['NaN'])[0].replace(/,/g, ''));

// ---------------------------------------------------------------- 本体

async function main() {
  const pw = await loadPlaywright();
  const chromium = pw.chromium || (pw.default && pw.default.chromium);
  const port = await freePort();
  const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}/`;
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'xdash-'));
  let createdData = false;
  let browser = null;
  try {
    browser = await chromium.launch();
    await waitHttp(base);
    execFileSync(process.execPath, [path.join(ROOT, 'tools/make-sample.mjs'), '3000', tmp], { stdio: 'ignore' });
    const big = JSON.parse(readFileSync(path.join(tmp, 'posts.json'), 'utf8'));
    const bigSummary = JSON.parse(readFileSync(path.join(tmp, 'summary.json'), 'utf8'));
    const sample = JSON.parse(readFileSync(path.join(ROOT, 'sample/posts.json'), 'utf8'));
    const sampleSummary = JSON.parse(readFileSync(path.join(ROOT, 'sample/summary.json'), 'utf8'));

    const newPage = async (opts = {}, routeOpts = {}) => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', locale: 'ja-JP', timezoneId: 'Asia/Tokyo', ...opts });
      const page = await ctx.newPage();
      const external = await setupRoutes(page, routeOpts);
      const con = watchConsole(page);
      return { ctx, page, external, con };
    };
    const allErrors = [];

    // ---- 1. サンプルフォールバック（data/ が 404）
    await check('サンプルフォールバック＋帯表示・スクショ', async () => {
      const { ctx, page, con, external } = await newPage({}, { data: { posts: null, summary: null } });
      await page.goto(base);
      await ready(page);
      assert(await page.isVisible('#sample-banner'), 'banner not visible');
      const banner = await page.textContent('#sample-banner');
      assert(banner.includes('サンプルデータを表示中（data/ が見つかりません）'), banner);
      assert(num(await count(page)) === defaultCount(sample), `${await count(page)} vs ${defaultCount(sample)}`);
      assert((await page.inputValue('#sort')) === 'imp', 'default sort');
      assert((await page.$eval('#period-group button[aria-pressed="true"]', (b) => b.dataset.period)) === '24h', 'default period');
      assert((await page.$eval('#cat-chips .chip[aria-pressed="true"]', (b) => b.dataset.group)) === 'night', 'default group');
      assert((await page.evaluate(() => location.hash)) === '', 'no params in URL');
      const chipNames = await page.$$eval('#cat-chips .chip .chip-name', (l) => l.map((e) => e.textContent));
      assert(chipNames[0] === '夜職すべて' && chipNames[chipNames.length - 1] === '一般のバズ' && !chipNames.includes('監視アカウント') && !chipNames.includes('すべて') && !chipNames.includes('その他'), chipNames.join());
      assert(!(await page.$$eval('#post-list .badge', (l) => l.some((e) => e.textContent === '監視アカウント'))), 'watch badge duplicated');
      assert(await page.$('#chart-day svg'), 'day chart');
      await page.screenshot({ path: path.join(SHOTS, 'desktop-dark-sample.png'), fullPage: false });
      await page.screenshot({ path: path.join(SHOTS, 'desktop-dark-sample-full.png'), fullPage: true });
      const ext = external.filter((u) => !u.startsWith('https://pbs.twimg.com/'));
      assert(ext.length === 0, `unexpected external: ${ext.join(', ')}`);
      allErrors.push(...con.errors);
      await ctx.close();
      return `外部通信(画像以外) 0 / 想定内 404 ログ ${con.expected.length} 件`;
    });

    // ---- 2. data/ 正規データ（3,000 件）＋性能
    await check('data/ 3,000件: 帯なし・性能計測', async () => {
      const { ctx, page, con } = await newPage({}, { data: { posts: big, summary: bigSummary } });
      const t0 = Date.now();
      await page.goto(base);
      await ready(page);
      const loadMs = Date.now() - t0;
      assert(await page.isHidden('#sample-banner'), 'banner shown');
      assert(num(await count(page)) === defaultCount(big), await count(page));
      const firstRender = await page.evaluate(() => window.__dashboard.perf.lastRenderMs);
      const timeOp = async (fn) => {
        const t = Date.now();
        const before = await page.evaluate(() => window.__dashboard.perf.renders);
        await fn();
        await page.waitForFunction((b) => window.__dashboard.perf.renders > b, before);
        return { wall: Date.now() - t, render: await page.evaluate(() => window.__dashboard.perf.lastRenderMs) };
      };
      await page.click('#panel-toggle'); // 検索欄は詳細パネル内
      const chip = await timeOp(() => page.click('#cat-chips .chip[data-cat="ホスト"]'));
      const period = await timeOp(() => page.click('#period-group button[data-period="7d"]'));
      const sort = await timeOp(() => page.selectOption('#sort', 'imp'));
      const kw = await timeOp(() => page.fill('#q', '指名'));
      const reset = await timeOp(() => page.click('#reset'));
      allErrors.push(...con.errors);
      await ctx.close();
      const f = (o) => `${o.render.toFixed(1)}ms(描画)/${o.wall}ms(操作〜反映)`;
      return `初回ロード ${loadMs}ms・初回描画 ${firstRender.toFixed(1)}ms / チップ ${f(chip)} / 期間 ${f(period)} / 並替 ${f(sort)} / 検索 ${f(kw)}（200msデバウンス込） / クリア ${f(reset)}`;
    });

    // ---- 2b. 更新遅れ表示（現在時刻を固定）
    for (const [now, expectDelay] of [['2026-10-11T20:00:00+09:00', false], ['2026-10-12T01:30:00+09:00', false], ['2026-10-12T02:30:00+09:00', true]]) {
      await check(`更新遅れ表示: 現在 ${now} → ${expectDelay ? '表示' : '非表示'}`, async () => {
        const { ctx, page, con } = await newPage({}, { data: { posts: big, summary: bigSummary } });
        await page.clock.setFixedTime(new Date(now));
        await page.goto(base);
        await ready(page);
        assert((await page.isVisible('#meta-delay')) === expectDelay, 'delay note');
        if (expectDelay) {
          assert((await page.textContent('#meta-delay')).includes('更新が遅れている可能性があります'), 'text');
          await page.screenshot({ path: path.join(SHOTS, 'header-delay.png'), clip: { x: 0, y: 0, width: 1280, height: 200 } });
        }
        allErrors.push(...con.errors);
        await ctx.close();
      });
    }

    // ---- 2c. 伸びペース順
    await check('伸びペース順（1時間あたり表示・先頭が最速・注記。不明は末尾は単体テストで確認）', async () => {
      const { ctx, page, con } = await newPage({}, { data: { posts: big, summary: bigSummary } });
      await page.goto(base + '#sort=pace');
      await ready(page);
      assert((await page.inputValue('#sort')) === 'pace', 'sort restored');
      assert(await page.isVisible('#pace-note'), 'note');
      assert((await page.textContent('#pace-note')).includes('今後の予測ではありません'), 'note text');
      const lines = await page.$$eval('#post-list .pace.is-active', (l) => l.map((e) => e.textContent));
      assert(lines.length === 50 && /^投稿から.+で.+表示（1時間あたり.+）$/.test(lines[0]), lines[0]);
      const gen = Date.parse(big.generated_at) / 1000;
      const rate = (p) => (p.metrics && typeof p.metrics.impression_count === 'number' ? p.metrics.impression_count / Math.max(1, (gen - p.ts) / 3600) : -1);
      const ref = Math.floor(Date.parse(big.generated_at) / 1000);
      const best = big.posts.filter((p) => p.ts > ref - 86400 && inNight(p)).reduce((a, b) => (rate(b) > rate(a) ? b : a));
      const firstUser = await page.$eval('#post-list .post-user', (e) => e.textContent);
      assert(firstUser === '@' + best.user, `${firstUser} vs ${best.user}`);
      await page.screenshot({ path: path.join(SHOTS, 'pace-sort.png') });
      await page.evaluate(() => document.getElementById('posts-heading').scrollIntoView());
      await page.screenshot({ path: path.join(SHOTS, 'pace-sort-list.png') });
      allErrors.push(...con.errors);
      await ctx.close();
      return lines[0];
    });

    // ---- 2d. reports.json のケース
    const sampleReports = JSON.parse(readFileSync(path.join(ROOT, 'sample/reports.json'), 'utf8'));
    for (const [name, reports, expect] of [
      ['ファイル無し（404）', null, 'hidden'],
      ['不正 JSON', '{', 'hidden'],
      ['空配列', { generated_at: '2026-10-12T23:59:00+09:00', daily: [], weekly: [] }, 'both-empty'],
      ['daily のみ', { daily: sampleReports.daily }, 'daily-only'],
    ]) {
      await check(`reports.json ${name}`, async () => {
        const data = { posts: sample, summary: sampleSummary };
        data.reports = reports;
        const { ctx, page, con } = await newPage({}, { data });
        await page.goto(base);
        await ready(page);
        assert(await page.isHidden('#sample-banner'), 'no banner');
        assert(num(await count(page)) === defaultCount(sample), 'posts unaffected');
        if (expect === 'hidden') {
          assert(await page.isHidden('#report'), 'report should be hidden');
          assert(await page.isHidden('#new-badge'), 'no NEW without reports');
        } else {
          await page.click('#panel-toggle');
          assert(await page.isVisible('#report'), 'report visible');
          const d = await page.textContent('#report-daily-body');
          const w = await page.textContent('#report-weekly-body');
          if (expect === 'both-empty') {
            assert(d.includes('10/12 23:59'), d);
            assert(w.includes('10/17'), w);
            await page.$eval('#report', (e) => e.scrollIntoView());
            await page.screenshot({ path: path.join(SHOTS, 'report-empty.png') });
          } else {
            assert((await page.$$('#report-daily-body .rising-item')).length > 0, 'rising');
            assert(w.includes('10/17'), w);
          }
        }
        allErrors.push(...con.errors);
        await ctx.close();
      });
    }

    // ---- 3. summary 無し
    await check('summary.json 無し → 投稿から集計', async () => {
      const { ctx, page, con } = await newPage({}, { data: { posts: sample, summary: null } });
      await page.goto(base);
      await ready(page);
      assert(await page.isHidden('#sample-banner'), 'banner');
      assert(num(await page.textContent('#stat-posts')) > 0, 'stat');
      assert((await page.textContent('#stat-imp-sub')).includes('一部不明'), 'unknown note');
      allErrors.push(...con.errors);
      await ctx.close();
    });

    // ---- 4. summary が壊れた JSON / posts が壊れた JSON → サンプル
    await check('posts.json 不正 JSON → サンプルへフォールバック', async () => {
      const { ctx, page, con } = await newPage({}, { data: { posts: '{broken', summary: '{' } });
      await page.goto(base);
      await ready(page);
      assert(await page.isVisible('#sample-banner'), 'banner');
      assert((await page.textContent('#sample-reason')).includes('JSON'), 'reason');
      allErrors.push(...con.errors);
      await ctx.close();
    });

    // ---- 5. 両方失敗 → エラー画面
    await check('data/ も sample/ も失敗 → エラー画面＋再読み込み', async () => {
      const { ctx, page, con } = await newPage({}, { data: { posts: null, summary: null } });
      await page.route('**/sample/*.json*', (r) => r.fulfill({ status: 404, body: 'x' }));
      await page.goto(base);
      await ready(page);
      assert(await page.isVisible('#error'), 'error');
      assert(await page.isVisible('#reload'), 'reload');
      await page.screenshot({ path: path.join(SHOTS, 'error.png') });
      allErrors.push(...con.errors);
      await ctx.close();
    });

    // ---- 6. 空 posts
    await check('空 posts（0件）', async () => {
      const { ctx, page, con } = await newPage({}, { data: { posts: { generated_at: '2026-10-11T18:41:00+09:00', categories: ['ホスト', 'その他'], posts: [] }, summary: null } });
      await page.goto(base);
      await ready(page);
      assert(await page.isVisible('#posts-empty'), 'empty msg');
      assert((await page.textContent('#stat-posts')) === '0', 'zero');
      assert((await page.$$('#cat-chips .chip')).length === 3, 'chips');
      await page.screenshot({ path: path.join(SHOTS, 'empty.png') });
      allErrors.push(...con.errors);
      await ctx.close();
    });

    // ---- 7. 機能一式（サンプル）
    const { ctx, page, con, external } = await newPage({}, { data: { posts: null, summary: null } });
    // 以降の確認はサンプル全期間・新しい順で行う（カテゴリは初期の「夜職すべて」）
    const ALL = '#period=all&sort=new';
    const resetAll = async () => {
      await page.click('#reset');
      await page.click('#period-group button[data-period="all"]');
      await page.selectOption('#sort', 'new');
      await page.fill('#user', '');
      await page.press('#user', 'Enter');
      await page.waitForFunction(() => window.__dashboard.state.user === '' && window.__dashboard.state.period === 'all');
    };
    await page.goto(base + ALL);
    await ready(page);

    await check('簡潔レイアウト: 詳細パネルは既定で閉じ、NEW バッジ→開くと既読・URL/保存', async () => {
      assert(await page.isHidden('#panel'), 'panel closed by default');
      for (const sel of ['#q', '#user', '#watched', '#reset', '#acc-list', '#chart-day', '#report', '#stat-posts']) assert(await page.isHidden(sel), `${sel} should be hidden`);
      for (const sel of ['#stat-top', '#cat-chips', '#period-group', '#sort', '#view-group', '#post-list']) assert(await page.isVisible(sel), `${sel} should be visible`);
      assert(await page.isVisible('#new-badge'), 'NEW badge');
      assert((await page.getAttribute('#panel-toggle', 'aria-expanded')) === 'false', 'aria');
      await page.screenshot({ path: path.join(SHOTS, 'desktop-dark-sample.png') });
      await page.click('#panel-toggle');
      assert(await page.isVisible('#panel') && await page.isVisible('#q') && await page.isVisible('#report'), 'panel open');
      assert(await page.isHidden('#new-badge'), 'NEW cleared');
      assert((await page.evaluate(() => location.hash)).includes('panel=1'), 'panel in URL');
      await page.click('#panel-toggle');
      await page.reload();
      await ready(page);
      assert(await page.isHidden('#panel'), 'closed after reload');
      assert(await page.isHidden('#new-badge'), 'NEW stays cleared (localStorage)');
      await page.click('#panel-toggle');
      await page.goto(base + ALL);
      await page.reload(); // ハッシュだけの遷移では再読み込みされないため
      await ready(page);
      assert(await page.isVisible('#panel'), 'panel open restored from localStorage');
    });

    await check('長文の折りたたみ（続きを読む／閉じる・ハイライトとリンクは維持）', async () => {
      const long = sample.posts.find((p) => p.text.startsWith('【サンプル】長文の投稿です。'));
      await page.fill('#user', long.user);
      await page.press('#user', 'Enter');
      await page.waitForFunction((u) => window.__dashboard.state.user === u, long.user);
      const card = page.locator('#post-list > li', { hasText: '長文の投稿です' }).first();
      const btn = card.locator('.more-text');
      assert((await btn.getAttribute('aria-expanded')) === 'false', 'collapsed');
      const h1 = await card.locator('.post-text').evaluate((e) => e.getBoundingClientRect().height);
      assert(await card.locator('.post-text mark').count() > 0 && await card.locator('.post-text a[href="https://t.co/LongSample1"]').count() === 1, 'marks/link kept');
      await card.screenshot({ path: path.join(SHOTS, 'long-collapsed.png') });
      await btn.focus();
      await page.keyboard.press('Enter');
      assert((await btn.getAttribute('aria-expanded')) === 'true' && (await btn.textContent()) === '閉じる', 'expanded');
      const h2 = await card.locator('.post-text').evaluate((e) => e.getBoundingClientRect().height);
      assert(h2 > h1 + 20, `height ${h1} -> ${h2}`);
      await btn.click();
      assert((await btn.getAttribute('aria-expanded')) === 'false', 'collapsed again');
      await page.fill('#user', '');
      await page.press('#user', 'Enter');
      await page.waitForFunction(() => window.__dashboard.state.user === '');
      return `高さ ${Math.round(h1)}px → ${Math.round(h2)}px`;
    });

    await check('詳細側の条件（検索・アカウント・監視のみ）はツールバーにチップ表示され解除できる', async () => {
      await page.fill('#q', '指名');
      await page.waitForFunction(() => window.__dashboard.state.q === '指名');
      await page.check('#watched');
      await page.click('#panel-toggle'); // 閉じても見える
      const chips = await page.$$eval('#active-filters .af', (l) => l.map((e) => e.textContent));
      assert(chips.some((t) => t.includes('キーワード: 指名')) && chips.some((t) => t.includes('監視アカウントのみ')), chips.join());
      await page.click('#active-filters .af:has-text("キーワード") button');
      await page.waitForFunction(() => window.__dashboard.state.q === '');
      await page.click('#active-filters .af:has-text("監視") button');
      await page.waitForFunction(() => !window.__dashboard.state.watched);
      await page.click('#panel-toggle');
      assert(await page.isVisible('#q'), 'panel reopened');
    });

    await check('レポート（サンプル）: 伸びている投稿・posts に無い id・答え合わせ・的中率・週間・XSS', async () => {
      assert(await page.isVisible('#report'), 'report');
      const today = sampleReports.daily[0];
      assert((await page.$$('#report-daily-body .rising-item:not([hidden])')).length === 3, 'initial 3');
      await page.click('#report-daily-body .rising-more');
      const items = await page.$$('#report-daily-body .rising-item:not([hidden])');
      assert(items.length === today.rising.length, `rising ${items.length}`);
      const band0 = await page.textContent('#report-daily-body .rising-item .rising-band');
      assert(band0.includes(today.rising[0].condition_label) && /投稿から.+で.+表示（1時間あたり.+）/.test(band0), band0);
      const missing = await page.$$eval('#report-daily-body .post-missing', (l) => l.map((e) => ({ text: e.textContent, href: e.querySelector('a') && e.querySelector('a').href })));
      assert(missing.length === 1 && missing[0].href === 'https://x.com/i/web/status/1999999999999999999', JSON.stringify(missing));
      const html = await page.$eval('#report', (e) => e.innerHTML);
      assert(!/<img[^>]*onerror/i.test(html) && !/<script/i.test(html), 'tag injected');
      assert((await page.textContent('#report')).includes('<img src=x onerror='), 'tag shown as text');
      assert((await page.textContent('#report-daily-body')).includes('伸びペース：不明'), 'unknown pace');
      const rows = await page.$$eval('#report-daily-body .report-table tbody tr', (l) => l.length);
      assert(rows === today.review.length, `review rows ${rows}`);
      assert((await page.$$('#report-daily-body .cross.yes')).length === today.review.filter((r) => r.crossed_500k === true).length, 'crossed badges');
      assert((await page.textContent('#report-daily-body .report-table')).includes('不明'), 'unknown in review');
      const rates = await page.$$eval('#report-daily-body .rate-value', (l) => l.map((e) => e.textContent));
      assert(rates.some((t) => /件中.+件（\d+%）/.test(t)) && rates.includes('対象なし'), rates.join());
      const proposal = await page.$eval('#report-weekly-body .proposal', (e) => ({ t: e.textContent, ws: getComputedStyle(e).whiteSpace }));
      assert(proposal.t.includes('\n') && proposal.ws === 'pre-wrap', JSON.stringify(proposal));
      await page.$eval('#report', (e) => e.scrollIntoView());
      await page.screenshot({ path: path.join(SHOTS, 'report-desktop.png') });
      await page.screenshot({ path: path.join(SHOTS, 'report-desktop-full.png'), fullPage: true });
      // 日付・週の切替と URL 保存、開閉
      await page.selectOption('#rdate', '2026-10-10');
      assert((await page.evaluate(() => location.hash)).includes('rdate=2026-10-10'), 'rdate url');
      assert((await page.textContent('#report-daily-body')).includes('答え合わせは'), 'review empty guide');
      await page.selectOption('#rweek', '2026-09-26_2026-10-03');
      await page.click('#report-weekly > summary');
      await page.waitForFunction(() => location.hash.includes('rc=weekly'));
      await page.reload();
      await ready(page);
      assert((await page.inputValue('#rdate')) === '2026-10-10', 'rdate restore');
      assert((await page.inputValue('#rweek')) === '2026-09-26_2026-10-03', 'rweek restore');
      assert(!(await page.$eval('#report-weekly', (e) => e.open)), 'closed restore');
      await page.click('#report-weekly > summary');
      await page.selectOption('#rdate', '2026-10-11');
      await page.selectOption('#rweek', '2026-10-03_2026-10-10');
      // 見張り候補クリックでアカウント絞り込み
      const cand = sampleReports.weekly[0].watch_candidates[0].user;
      await page.click(`#report-weekly-body .cand-list button:has-text("@${cand}")`);
      await page.waitForFunction((u) => window.__dashboard.state.user === u, cand);
      assert(num(await count(page)) === sample.posts.filter((p) => p.user === cand && inNight(p)).length, 'cand filter');
      await resetAll();
      await page.evaluate(() => window.scrollTo(0, 0));
    });

    await check('XSS 本文はテキストとして表示', async () => {
      await page.fill('#q', 'スクリプトタグ入り');
      await page.waitForFunction(() => document.querySelectorAll('#post-list > li').length === 1);
      const html = await page.$eval('#post-list', (e) => e.innerHTML);
      assert(!/<script/i.test(html), 'script element in list');
      assert((await page.textContent('#post-list')).includes('<script>alert("xss")</script>'), 'text');
      await page.fill('#q', '画像タグ入り');
      await page.waitForFunction(() => document.querySelectorAll('#post-list > li').length === 1);
      assert(!(await page.$('#post-list img[src="x"]')), 'img injected');
      assert(!(await page.$('#post-list .post-text svg, #post-list svg[onload]')), 'svg injected');
      assert(!(await page.$('#post-list a[href^="javascript"]')), 'javascript link');
      await page.screenshot({ path: path.join(SHOTS, 'xss.png') });
      await page.fill('#q', '');
      await page.waitForFunction(() => document.querySelectorAll('#post-list > li').length === 50);
    });

    await check('未知カテゴリのチップ・色・バッジ', async () => {
      const chip = await page.$('#cat-chips .chip[data-cat="テスト新カテゴリ"]');
      assert(chip, 'chip missing');
      const c = await chip.evaluate((e) => e.style.getPropertyValue('--c'));
      assert(/var\(--cat-[678]\)/.test(c), c);
      await chip.click();
      assert(num(await count(page)) === 5, await count(page));
      await page.click('#cat-chips .chip[data-cat="テスト新カテゴリ"]');
    });

    await check('複数カテゴリ OR', async () => {
      const n = (cat) => sample.posts.filter((p) => p.categories.includes(cat)).length;
      await page.click('#cat-chips .chip[data-cat="ホスト"]');
      assert(num(await count(page)) === n('ホスト'), 'host');
      await page.click('#cat-chips .chip[data-cat="キャバクラ"]');
      const both = sample.posts.filter((p) => p.categories.includes('ホスト') || p.categories.includes('キャバクラ')).length;
      assert(num(await count(page)) === both, `${await count(page)} vs ${both}`);
      const hash = await page.evaluate(() => decodeURIComponent(location.hash));
      assert(hash.includes('cat=ホスト') && hash.includes('cat=キャバクラ'), hash);
      // 最後の 1 つを外すと「夜職すべて」に戻る
      await page.click('#cat-chips .chip[data-cat="ホスト"]');
      await page.click('#cat-chips .chip[data-cat="キャバクラ"]');
      assert((await page.$eval('#cat-chips .chip[aria-pressed="true"]', (b) => b.dataset.group)) === 'night', 'back to night');
      // グループ「一般のバズ」
      await page.click('#cat-chips .chip[data-cat="ホスト"]');
      await page.click('#cat-chips .chip[data-group="general"]');
      assert(num(await count(page)) === sample.posts.filter((p) => p.categories.includes('その他')).length, 'general');
      assert((await page.$$('#cat-chips .chip[aria-pressed="true"]')).length === 1, 'only group pressed');
      assert((await page.evaluate(() => location.hash)).includes('group=general'), 'group url');
      const badges = await page.$$eval('#post-list .badge', (l) => [...new Set(l.map((e) => e.textContent))]);
      assert(badges.includes('一般のバズ') && !badges.includes('その他'), badges.join());
      await page.click('#cat-chips .chip[data-group="night"]');
      assert(num(await count(page)) === sample.posts.filter(inNight).length, 'night all-period');
      return `ホスト ${n('ホスト')} + キャバクラ → ${both}`;
    });

    await check('AND 検索・ハイライト', async () => {
      await page.fill('#q', '指名 歌舞伎町');
      await page.waitForTimeout(350);
      const expected = sample.posts.filter((p) => { const t = (p.text + '\n' + p.user).toLowerCase(); return inNight(p) && t.includes('指名') && t.includes('歌舞伎町'); }).length;
      assert(num(await count(page)) === expected, `${await count(page)} vs ${expected}`);
      assert(await page.$('#post-list mark.m-q'), 'q highlight');
      assert(await page.$('#post-list mark.m-term'), 'term highlight');
      await page.screenshot({ path: path.join(SHOTS, 'and-search.png') });
      await page.fill('#q', '');
      await page.waitForTimeout(350);
      return `${expected}件`;
    });

    await check('監視アカウントのみ', async () => {
      await page.check('#watched');
      const exp = sample.posts.filter((p) => p.is_watched && inNight(p)).length;
      assert(num(await count(page)) === exp, 'watched');
      await page.uncheck('#watched');
    });

    await check('上位アカウント（切替・クリックで絞り込み）', async () => {
      const first = await page.$eval('#acc-list button', (b) => b.dataset.user);
      await page.click('#acct-group button[data-acct="imp"]');
      const firstImp = await page.$eval('#acc-list button', (b) => b.dataset.user);
      await page.click('#acc-list button');
      const exp = sample.posts.filter((p) => p.user === firstImp && inNight(p)).length;
      assert(num(await count(page)) === exp, 'acct filter');
      assert((await page.inputValue('#user')) === firstImp, 'input sync');
      assert((await page.$eval('#acc-list button[aria-pressed="true"]', (b) => b.dataset.user)) === firstImp, 'pressed');
      await page.screenshot({ path: path.join(SHOTS, 'account-filter.png') });
      return `投稿数1位 @${first} / imp1位 @${firstImp}（${exp}件）`;
    });

    await check('URL 状態の復元（再読込・戻る/進む）', async () => {
      await page.click('#period-group button[data-period="30d"]');
      await page.selectOption('#sort', 'like');
      const c1 = await count(page);
      await page.reload();
      await ready(page);
      assert((await count(page)) === c1, 'count after reload');
      assert((await page.$eval('#period-group button[aria-pressed="true"]', (b) => b.dataset.period)) === '30d', 'period');
      assert((await page.inputValue('#sort')) === 'like', 'sort');
      assert((await page.inputValue('#user')) !== '', 'user');
      await page.goBack(); // sort 変更前
      await page.waitForFunction(() => document.getElementById('sort').value === 'new');
      await page.goBack(); // 30d 変更前
      await page.waitForFunction(() => document.querySelector('#period-group button[aria-pressed="true"]').dataset.period === 'all');
      await page.goForward();
      await page.waitForFunction(() => document.querySelector('#period-group button[aria-pressed="true"]').dataset.period === '30d');
      // 「条件をクリア」は初期状態（24時間・夜職すべて・インプレッションが多い順）に戻す
      await page.click('#reset');
      const st = await page.evaluate(() => window.__dashboard.state);
      assert(st.period === '24h' && st.group === 'night' && st.sort === 'imp' && !st.cats.length && !st.user, JSON.stringify(st));
      await resetAll();
    });

    await check('期間フィルタ（基準時刻表示・日別グラフの範囲）', async () => {
      const ref = await page.textContent('#meta-ref');
      assert(ref === '10/11 18:41 時点', ref); // generated_at 優先（最新投稿は 18:32）
      assert((await page.textContent('#meta-next')) === '毎日23:59（JST）', 'next update');
      assert(await page.isHidden('#meta-delay'), 'delay hidden in sample');
      const sub = await page.textContent('#chart-day-sub');
      assert(sub.includes('直近90日') && sub.includes('外れ値'), sub);
      await page.click('#period-group button[data-period="7d"]');
      const bars = await page.$$eval('#chart-day svg .col', (l) => l.length);
      assert(bars === 8, `bars ${bars}`);
      await page.click('#period-group button[data-period="all"]');
      assert((await page.$$eval('#chart-day svg .col', (l) => l.length)) === 90, '90 days');
      return sub;
    });

    await check('グラフのツールチップ（ホバー/キーボード）', async () => {
      await page.$eval('#chart-day', (e) => e.scrollIntoView({ block: 'center' }));
      const box = await page.$eval('#chart-day svg', (s) => { const r = s.getBoundingClientRect(); return { x: r.right - 20, y: r.top + 120 }; });
      await page.mouse.move(box.x, box.y);
      await page.waitForSelector('#tooltip:not([hidden])');
      const t = await page.textContent('#tooltip');
      assert(t.includes('投稿数'), t);
      await page.screenshot({ path: path.join(SHOTS, 'chart-tooltip.png') });
      await page.mouse.move(0, 0);
      await page.focus('#chart-day svg');
      await page.keyboard.press('ArrowLeft');
      await page.waitForSelector('#tooltip:not([hidden])');
      await page.keyboard.press('Tab');
    });

    await check('さらに表示（50件ずつ）', async () => {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.click('#more');
      assert((await shown(page)) === 100, 'more');
    });

    await check('欠損指標は「不明」', async () => {
      const unk = await page.$$eval('#post-list .metrics .v.unk', (l) => l.map((e) => e.textContent));
      assert(unk.length > 0 && unk.every((t) => t === '不明'), unk.join());
    });

    await check('添付メディア（写真・動画・GIF・許可外拒否）とライトボックス', async () => {
      const filterUser = async (u) => {
        await page.fill('#q', '');
        await page.fill('#user', u);
        await page.press('#user', 'Enter');
        await page.waitForFunction((x) => window.__dashboard.state.user === x && window.__dashboard.state.q === '', u);
      };
      const photoPost = sample.posts.find((p) => p.media && p.media.length === 4);
      await filterUser(photoPost.user);
      const card = page.locator('#post-list > li', { has: page.locator('.media-grid.n4') }).first();
      await card.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.querySelectorAll('.media-grid.n4 img').length + document.querySelectorAll('.media-grid.n4 .media-ph').length === 4 && [...document.querySelectorAll('.media-grid.n4 img')].every((i) => i.complete));
      const ph = await card.locator('.media-ph').count();
      assert(ph === 1, `placeholder ${ph}`);
      await card.screenshot({ path: path.join(SHOTS, 'media-photos.png') });
      await card.locator('.media-thumb:not(.is-broken)').first().click();
      assert(await page.isVisible('#lightbox'), 'lightbox');
      await page.screenshot({ path: path.join(SHOTS, 'lightbox.png') });
      await page.keyboard.press('Escape');
      assert(await page.isHidden('#lightbox'), 'esc close');
      // 動画（mp4 の最高 bit_rate を再生）
      const video = sample.posts.find((p) => p.media && p.media.some((m) => m.type === 'video' && m.variants.some((v) => v.bit_rate === 2176000)));
      await filterUser(video.user);
      const vcard = page.locator('#post-list > li', { has: page.locator('button.media-play') }).first();
      await vcard.scrollIntoViewIfNeeded();
      await vcard.screenshot({ path: path.join(SHOTS, 'media-video.png') });
      const vli = await vcard.elementHandle();
      await page.evaluate(() => {
        window.__videoSrc = null;
        new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.tagName === 'VIDEO') window.__videoSrc = n.getAttribute('src'); })
          .observe(document.getElementById('post-list'), { childList: true, subtree: true });
      });
      await (await vli.$('button.media-play')).click();
      await page.waitForFunction(() => window.__videoSrc);
      const src = await page.evaluate(() => window.__videoSrc);
      assert(src === 'https://video.twimg.com/ext_tw_video/SAMPLE/vid/1280x720/high.mp4', `video src ${src}`);
      await vli.waitForSelector('.media-ph-row'); // 遮断しているので読み込み失敗表示に切り替わる
      // mp4 無し →「Xで再生」
      const nomp4 = sample.posts.find((p) => p.media && p.media.some((m) => m.type === 'video' && !m.variants.some((v) => v.content_type === 'video/mp4')));
      await filterUser(nomp4.user);
      assert(await page.$('#post-list a.media-play[href*="/status/"]'), 'Xで再生 link');
      const evil = sample.posts.find((p) => p.media && p.media.some((m) => String(m.url || '').includes('evil')));
      await filterUser(evil.user);
      const html = await page.$eval('#post-list', (e) => e.innerHTML);
      assert(!html.includes('evil.example') && !html.includes('http://pbs'), 'disallowed media rendered');
      const bad = external.filter((u) => /evil|^http:/.test(u));
      assert(bad.length === 0, bad.join());
      await page.click('#reset');
      await page.fill('#q', '');
      await page.fill('#user', '');
      await page.press('#user', 'Enter');
      await page.waitForTimeout(350);
    });

    await check('「埋め込みで見る」（カード内の単発埋め込み）', async () => {
      const ok = await page.locator('#post-list > li').evaluateAll((lis) => lis.length);
      assert(ok > 0, 'no posts');
      const btns = page.locator('#post-list .embed-toggle');
      await btns.nth(0).click();
      await btns.nth(1).click();
      await page.waitForFunction(() => document.querySelectorAll('#post-list .fake-tweet').length + document.querySelectorAll('#post-list .embed-fail').length >= 2);
      assert(await page.isVisible('#embed-notice'), 'notice');
      const calls = await page.evaluate(() => window.__embedCalls);
      assert(calls[0].opts.dnt === true && calls[0].opts.lang === 'ja' && calls[0].opts.conversation === 'none' && calls[0].opts.theme === 'dark', JSON.stringify(calls[0].opts));
      await btns.nth(0).click();
      await btns.nth(1).click();
    });

    await check('X埋め込み表示: 切替・遅延生成・失敗時フォールバック・URL/保存', async () => {
      await page.click('#view-group button[data-view="embed"]');
      await page.evaluate(() => document.getElementById('posts-heading').scrollIntoView());
      await page.waitForFunction(() => document.querySelectorAll('#post-list .fake-tweet').length >= 1 && document.querySelectorAll('#post-list .embed-fallback').length >= 1, null, { timeout: 15000 });
      await page.waitForTimeout(500);
      const total = await shown(page);
      const done = await page.evaluate(() => document.querySelectorAll('#post-list .fake-tweet, #post-list .embed-fallback').length);
      assert(done < total, `lazy: ${done}/${total}`);
      const fb = await page.textContent('#post-list .embed-fallback .embed-fail');
      assert(fb === '埋め込みを表示できませんでした', fb);
      assert(await page.$('#post-list .post-embed .embed-band .badge'), 'band badges');
      assert((await page.evaluate(() => location.hash)).includes('view=embed'), 'url');
      await page.screenshot({ path: path.join(SHOTS, 'embed-view.png') });
      await page.reload();
      await ready(page);
      assert((await page.$eval('#view-group button[aria-pressed="true"]', (b) => b.dataset.view)) === 'embed', 'restore');
      await page.goto(base);
      await ready(page);
      assert((await page.evaluate(() => window.__dashboard.state.view)) === 'embed', 'localStorage restore');
      await page.click('#view-group button[data-view="card"]');
      return `画面内 ${done}/${total} 件のみ生成`;
    });

    await check('ライト/ダーク切替（localStorage 保存）', async () => {
      const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const dark = await bg();
      await page.click('#theme-toggle'); // auto → dark
      assert((await page.getAttribute('html', 'data-theme')) === 'dark', 'dark');
      await page.click('#theme-toggle'); // dark → light
      assert((await page.getAttribute('html', 'data-theme')) === 'light', 'light');
      const light = await bg();
      assert(light !== dark, 'bg unchanged');
      await page.reload();
      await ready(page);
      assert((await page.getAttribute('html', 'data-theme')) === 'light', 'persist');
      await page.screenshot({ path: path.join(SHOTS, 'desktop-light.png') });
      await page.click('#theme-toggle'); // light → auto
      assert((await page.getAttribute('html', 'data-theme')) === null, 'auto');
    });

    allErrors.push(...con.errors);
    await ctx.close();

    // ---- 8. ライト OS 設定（自動追従）
    await check('OS ライト設定に自動追従', async () => {
      const { ctx: c2, page: p2, con: k2 } = await newPage({ colorScheme: 'light' }, { data: { posts: null, summary: null } });
      await p2.goto(base);
      await ready(p2);
      const bg = await p2.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert(bg === 'rgb(246, 244, 251)', bg);
      allErrors.push(...k2.errors);
      await c2.close();
    });

    // ---- 9. 外部（CDN・X）全遮断
    await check('外部通信を全遮断しても動作（widgets.js 失敗→フォールバック）', async () => {
      const { ctx: c2, page: p2, con: k2 } = await newPage({}, { data: { posts: null, summary: null }, widgets: 'block' });
      await p2.goto(base + '#view=embed');
      await ready(p2);
      await p2.evaluate(() => document.getElementById('posts-heading').scrollIntoView());
      assert(await p2.$('#chart-day svg'), 'chart');
      await p2.waitForFunction(() => document.querySelectorAll('#post-list .embed-fallback').length >= 3, null, { timeout: 20000 });
      assert((await p2.$$('#post-list .fake-tweet')).length === 0, 'no embeds');
      await p2.screenshot({ path: path.join(SHOTS, 'embed-blocked.png') });
      allErrors.push(...k2.errors);
      await c2.close();
    });

    // ---- 10. スマホ 375 / 360
    for (const w of [375, 360]) {
      await check(`スマホ ${w}px: 横スクロールなし・タップ領域44px`, async () => {
        const { ctx: c2, page: p2, con: k2 } = await newPage({ viewport: { width: w, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, { data: { posts: null, summary: null } });
        await p2.goto(base);
        await ready(p2);
        const sw = await p2.evaluate(() => document.documentElement.scrollWidth);
        assert(sw <= w, `scrollWidth ${sw}`);
        const small = await p2.evaluate(() => {
          const sel = '#panel-toggle, .more-text, #rdate, #rweek, .report > summary, .report-sub > summary, .cand-list button, .rt-user, .chip, .segmented button, #sort, #q, #user, #reset, #more, #theme-toggle, .open-x, .embed-toggle, .acc-item button, .check, .media-thumb, .post-user, .af button, .table-view summary, .notice-close';
          return [...document.querySelectorAll(sel)].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44).map((e) => `${e.className || e.id}:${Math.round(e.getBoundingClientRect().height)}`).slice(0, 5);
        });
        assert(small.length === 0, small.join(', '));
        if (w === 375) {
          await p2.screenshot({ path: path.join(SHOTS, 'mobile-375-top.png') });
          await p2.screenshot({ path: path.join(SHOTS, 'mobile-375-full.png'), fullPage: true });
          await p2.evaluate(() => document.getElementById('posts-heading').scrollIntoView());
          await p2.screenshot({ path: path.join(SHOTS, 'mobile-375-posts.png') });
          await p2.screenshot({ path: path.join(SHOTS, 'mobile-375-closed.png') });
          await p2.click('#panel-toggle');
          const rw = await p2.$eval('#report', (e) => [...e.querySelectorAll('*')].filter((x) => x.getBoundingClientRect().right > window.innerWidth + 1 && !x.closest('.table-scroll')).map((x) => x.className).slice(0, 3));
          assert(rw.length === 0, `report overflow: ${rw.join()}`);
          await p2.evaluate(() => document.getElementById('report').scrollIntoView());
          await p2.screenshot({ path: path.join(SHOTS, 'mobile-375-report.png') });
          await p2.evaluate(() => document.getElementById('report-weekly').scrollIntoView());
          await p2.screenshot({ path: path.join(SHOTS, 'mobile-375-report-weekly.png') });
        }
        allErrors.push(...k2.errors);
        await c2.close();
        return `scrollWidth=${sw}`;
      });
    }

    // ---- 10b. リポジトリに data/ がある場合は実データでも表示確認（読むだけ。data/ は変更しない）
    if (existsSync(path.join(ROOT, 'data', 'posts.json'))) {
      for (const [w, h, scheme] of [[1280, 800, 'dark'], [1280, 800, 'light'], [375, 812, 'dark'], [375, 812, 'light']]) {
        await check(`実データ data/ ${w}px ${scheme}`, async () => {
          const { ctx: c2, page: p2, con: k2 } = await newPage({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: w < 500 ? 2 : 1, isMobile: w < 500, hasTouch: w < 500 }, {});
          await p2.goto(base);
          await ready(p2);
          assert(await p2.isHidden('#sample-banner'), 'sample banner shown with real data');
          const sw = await p2.evaluate(() => document.documentElement.scrollWidth);
          assert(sw <= w, `scrollWidth ${sw}`);
          await p2.screenshot({ path: path.join(SHOTS, `real-${w}-${scheme}.png`) });
          await p2.click('#panel-toggle');
          await p2.waitForTimeout(200);
          await p2.screenshot({ path: path.join(SHOTS, `real-${w}-${scheme}-panel.png`) });
          allErrors.push(...k2.errors);
          await c2.close();
          return `scrollWidth=${sw}`;
        });
      }
    }

    // ---- 11. 実ファイルとして data/ を一時配置
    await check('data/ に実ファイル配置（検証後に削除）', async () => {
      const dataDir = path.join(ROOT, 'data');
      if (existsSync(dataDir)) return 'skip: data/ が既に存在するため実ファイル検証は省略';
      createdData = true;
      try {
        mkdirSync(dataDir);
        cpSync(path.join(tmp, 'posts.json'), path.join(dataDir, 'posts.json'));
        cpSync(path.join(tmp, 'summary.json'), path.join(dataDir, 'summary.json'));
        const { ctx: c2, page: p2, con: k2 } = await newPage({}, {});
        await p2.goto(base);
        await ready(p2);
        assert(await p2.isHidden('#sample-banner'), 'banner');
        assert(num(await count(p2)) === defaultCount(big), await count(p2));
        await p2.screenshot({ path: path.join(SHOTS, 'desktop-dark-data.png') });
        allErrors.push(...k2.errors);
        await c2.close();
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
      return 'data/ 削除済み';
    });

    await check('コンソールエラー 0（想定内の 404/遮断ログを除く）', async () => {
      assert(allErrors.length === 0, allErrors.slice(0, 5).join(' / '));
    });
  } finally {
    if (browser) await browser.close();
    server.kill();
    rmSync(tmp, { recursive: true, force: true });
    if (createdData) rmSync(path.join(ROOT, 'data'), { recursive: true, force: true });
  }
  console.log(`\nshots: ${SHOTS}`);
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
