// X-trend 結合E2E（実バックエンド × 実フロント）
//
// 実行方法（依存ゼロ方針のため playwright はリポジトリに入れない）:
//   mkdir -p /path/to/qa && cd /path/to/qa && npm init -y && npm i playwright
//   # Chromium は PLAYWRIGHT_BROWSERS_PATH（例: /opt/pw-browsers）にあるものを使う。`playwright install` は不要
//   NODE_PATH=/path/to/qa/node_modules node test/e2e/e2e.mjs
//   # もしくは: PW_DIR=/path/to/qa/node_modules node test/e2e/e2e.mjs
//   スクリーンショットの出力先は SHOTS_DIR（既定: OS の一時ディレクトリ/x-trend-shots）
//
// このファイルは test/*.test.js の glob に入らないため `npm test` では実行されない。
// サーバーは本スクリプトが一時 DATA_DIR・空きポートで `node src/server.js`（npm start と同じフラグ）として起動・停止する。

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'x-trend-shots');
mkdirSync(SHOTS, { recursive: true });

async function loadPlaywright() {
  const dirs = [process.env.PW_DIR, ...(process.env.NODE_PATH || '').split(path.delimiter)].filter(Boolean);
  for (const d of dirs) {
    try {
      const req = createRequire(pathToFileURL(path.join(d, 'noop.js')));
      return await import(pathToFileURL(req.resolve('playwright')).href);
    } catch { /* 次へ */ }
  }
  return import('playwright');
}
const PW = await loadPlaywright();
const chromium = PW.chromium ?? PW.default?.chromium;

/* ---------------- 結果記録 ---------------- */
const results = [];
function check(item, ok, detail = '') {
  results.push({ item, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${item}] ${detail}`);
  return !!ok;
}

/* ---------------- サーバー ---------------- */
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
let server = null;
async function startServer(dataDir, port, extraEnv = {}) {
  const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), ...extraEnv };
  for (const k of ['ADMIN_TOKEN', 'X_BEARER_TOKEN', 'X_USER_ACCESS_TOKEN', 'X_USER_ID', 'XAI_API_KEY']) if (!(k in extraEnv)) delete env[k];
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('サーバー起動タイムアウト\n' + log)), 15000);
    const on = (d) => { log += d; if (log.includes('起動しました')) { clearTimeout(t); resolve(); } };
    proc.stdout.on('data', on);
    proc.stderr.on('data', (d) => { log += d; });
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error(`サーバーが終了しました(${c})\n${log}`)); });
  });
  proc.removeAllListeners('exit');
  proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  server = { proc, base: `http://127.0.0.1:${port}`, port, dataDir };
  return server;
}
async function stopServer() {
  if (!server) return;
  const p = server.proc;
  await new Promise((resolve) => { p.once('exit', resolve); p.kill('SIGTERM'); setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } }, 5000); });
  server = null;
}
async function api(method, p, body, headers = {}) {
  const res = await fetch(server.base + '/api' + p, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* */ }
  return { status: res.status, data, headers: res.headers };
}
const allPosts = async (h = {}) => (await api('GET', '/posts?genre=all&period=all&includeHidden=1&limit=200', undefined, h)).data;
const visibleIds = async (q = '') => (await api('GET', `/posts?genre=all&period=all&limit=200${q}`)).data.items.map((p) => p.postId);

/* ---------------- ブラウザ ---------------- */
const VIEWPORTS = { pc: { width: 1280, height: 800 }, sp: { width: 375, height: 812 } };
let browser;
const consoleErrors = [];
const dialogs = [];
async function newCtx(vpName, { allow401 = false } = {}) {
  const ctx = await browser.newContext({ viewport: VIEWPORTS[vpName], deviceScaleFactor: 1, isMobile: vpName === 'sp', hasTouch: vpName === 'sp', acceptDownloads: true });
  // フィードは「すべて／全期間」で見る（各テストの前提をそろえる）。既に値があれば上書きしない
  await ctx.addInitScript(() => {
    try {
      if (localStorage.getItem('feed.genre') === null) localStorage.setItem('feed.genre', '"all"');
      if (localStorage.getItem('feed.period') === null) localStorage.setItem('feed.period', '"all"');
      if (localStorage.getItem('topics.period') === null) localStorage.setItem('topics.period', '"all"');
    } catch { /* */ }
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (allow401 && /status of 401/.test(t)) return; // 認証テストで意図した 401
    consoleErrors.push(`[${vpName}] ${t}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`[${vpName}] pageerror: ${e.message}`));
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  return { ctx, page };
}
async function settle(page) {
  await page.waitForTimeout(250);
  await page.waitForFunction(() => !document.querySelector('.skeletons, .state-loading, [aria-busy="true"]'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(250);
}
async function go(page, hash) {
  const url = `${server.base}/${hash}`;
  // 同じハッシュへの goto は再描画されないため、その場合は再読み込みする
  if (page.url() === url) await page.reload();
  else await page.goto(url);
  await settle(page);
}

/** 横スクロール・はみ出し・兄弟要素の重なりを検査 */
async function layoutProblems(page) {
  return page.evaluate(() => {
    const out = [];
    const vw = document.documentElement.clientWidth;
    const de = document.documentElement;
    if (de.scrollWidth > vw + 1) out.push(`横スクロール: scrollWidth=${de.scrollWidth} > ${vw}`);
    const visible = (el) => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    };
    const clipped = (el) => {
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowX !== 'visible' || cs.clip !== 'auto') return true;
      }
      return false;
    };
    const desc = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}「${(el.textContent || '').trim().slice(0, 30)}」`;
    const all = [...document.querySelectorAll('body *')].filter((el) => !el.closest('.sr-only, .skip-link, svg, dialog:not([open])'));
    for (const el of all) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if ((r.right > vw + 1 || r.left < -1) && !clipped(el)) out.push(`はみ出し: ${desc(el)} left=${Math.round(r.left)} right=${Math.round(r.right)} vw=${vw}`);
    }
    // 兄弟要素の重なり（通常フローの要素のみ）
    const flowKids = (p) => [...p.children].filter((c) => {
      if (!visible(c) || c.closest('.sr-only, .skip-link, svg')) return false;
      const cs = getComputedStyle(c);
      return cs.position !== 'absolute' && cs.position !== 'fixed' && cs.float === 'none' && cs.display !== 'inline';
    });
    for (const p of all) {
      if (!visible(p) || p.closest('svg')) continue;
      const kids = flowKids(p);
      if (kids.length < 2 || kids.length > 80) continue;
      const rects = kids.map((k) => k.getBoundingClientRect());
      for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
        const a = rects[i], b = rects[j];
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 2 && h > 2) out.push(`重なり: ${desc(kids[i])} × ${desc(kids[j])} (${Math.round(w)}x${Math.round(h)})`);
      }
    }
    return [...new Set(out)].slice(0, 20);
  });
}
async function shot(page, name, full = true) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: full });
  return file;
}
const SCREENS = ['feed', 'topics', 'digests', 'import', 'dismissed', 'settings', 'capture'];
async function sweepScreens(label, vpName, { capturePayload } = {}) {
  const { ctx, page } = await newCtx(vpName);
  const problems = {};
  for (const s of SCREENS) {
    const hash = s === 'capture' && capturePayload ? `#/capture?d=${capturePayload}` : `#/${s}`;
    await go(page, hash);
    const p = await layoutProblems(page);
    if (p.length) problems[s] = p;
    await shot(page, `${label}-${vpName}-${s}`);
  }
  await ctx.close();
  return problems;
}

/* ---------------- テストデータ ---------------- */
const now = Date.now();
const iso = (hAgo) => new Date(now - hAgo * 3600000).toISOString();
const ID = {
  dup: '1900000000000000001', xss: '1900000000000000002', zero: '1900000000000000003', nul: '1900000000000000004',
  t1: '1900000000000000005', t2: '1900000000000000006', author: '1900000000000000007', kw: '1900000000000000008',
  extra: '1900000000000000009',
};
const XSS = '<img src=x onerror=alert(1)>XSSテスト ホストの話';
const CSV = [
  '投稿ID,URL,本文,投稿日時,いいね,表示回数,リポスト,返信,ブックマーク',
  `${ID.dup},https://x.com/qa_dup/status/${ID.dup},重複検証の投稿 ホストクラブの新人研修,${iso(2)},120,5000,10,3,1`,
  `${ID.zero},https://x.com/qa_zero/status/${ID.zero},指標ゼロの投稿 ホスト,${iso(3)},0,0,0,0,0`,
  `${ID.nul},https://x.com/qa_null/status/${ID.nul},指標不明の投稿 ホスト,${iso(4)},,,,,`,
].join('\n');
const JSON_IMPORT = JSON.stringify([
  { id: ID.dup, url: `https://x.com/qa_dup/status/${ID.dup}`, text: '重複検証の投稿 ホストクラブの新人研修', created_at: iso(2), like_count: 130, view_count: 5200, user: { screen_name: 'qa_dup' } },
  { id: ID.xss, text: XSS, created_at: iso(1), like_count: 50, view_count: 900, screen_name: 'qa_xss' },
  { id: ID.t1, text: '#QA研修トピック ホストクラブの新人研修で学んだこと その1', created_at: iso(5), like_count: 300, view_count: 9000, screen_name: 'qa_topic1' },
  { id: ID.t2, text: '#QA研修トピック ホストクラブの新人研修で学んだこと その2', created_at: iso(6), like_count: 280, view_count: 8000, screen_name: 'qa_topic2' },
  { id: ID.author, text: 'キャバクラの出勤前ルーティン（投稿者テスト）', created_at: iso(7), like_count: 400, view_count: 12000, screen_name: 'qa_author' },
  { id: ID.kw, text: 'ラウンジの話 QA除外語テスト を含む投稿', created_at: iso(8), like_count: 500, view_count: 15000, screen_name: 'qa_kw' },
], null, 1);
const capturePayload = (posts) => Buffer.from(JSON.stringify({ v: 1, capturedAt: new Date().toISOString(), page: 'foryou', pageUrl: 'https://x.com/home', posts }), 'utf8').toString('base64url');
const CAPTURE = capturePayload([
  { postId: ID.dup, url: `https://x.com/qa_dup/status/${ID.dup}`, authorHandle: 'qa_dup', authorName: 'QA重複さん', text: '重複検証の投稿 ホストクラブの新人研修', postedAt: iso(2), metrics: { views: 5300, likes: 140, reposts: 11, replies: null, bookmarks: null } },
]);

/* ---------------- 本体 ---------------- */
async function main() {
  browser = await chromium.launch();
  const dataA = mkdtempSync(path.join(os.tmpdir(), 'xtrend-e2e-'));
  const port = await freePort();
  await startServer(dataA, port);
  console.log(`server ${server.base} DATA_DIR=${dataA}`);

  /* ===== 1. サンプル（初回起動） ===== */
  {
    const st = (await api('GET', '/status')).data;
    check('サンプル: 初回起動で sampleMode', st.sampleMode && st.samplePostCount > 0, `sampleMode=${st.sampleMode} samples=${st.samplePostCount}`);
    for (const vp of ['pc', 'sp']) {
      const { ctx, page } = await newCtx(vp);
      await go(page, '#/feed');
      const banner = await page.locator('.banner-sample').innerText().catch(() => '');
      const pill = await page.locator('.pill-sample').count();
      const cardBadge = await page.locator('.post-card .badge-sample').count();
      check(`サンプル: 帯とバッジ(${vp})`, banner.includes('サンプルデータを表示中') && pill === 1 && cardBadge > 0, `banner="${banner.replace(/\n/g, ' ')}" pill=${pill} cardBadges=${cardBadge}`);
      // ランキング文言・欠けた指標
      const note = await page.locator('.ranking-note').innerText();
      check(`ランキング文言(${vp})`, note.includes('取得した候補内') && note.includes('X全体の順位ではありません'), note);
      await ctx.close();
    }
    const sampleProblems = { pc: await sweepScreens('sample', 'pc', { capturePayload: CAPTURE }), sp: await sweepScreens('sample', 'sp', { capturePayload: CAPTURE }) };
    check('表示: サンプル状態の全画面レイアウト', !Object.keys(sampleProblems.pc).length && !Object.keys(sampleProblems.sp).length, JSON.stringify(sampleProblems));
  }

  /* ===== 2. 空データ ===== */
  {
    const r = await api('DELETE', '/sample');
    check('空データ: DELETE /api/sample', r.status === 200, JSON.stringify(r.data));
    const errBefore = consoleErrors.length;
    for (const vp of ['pc', 'sp']) {
      const { ctx, page } = await newCtx(vp);
      const missing = [];
      for (const s of SCREENS) {
        await go(page, `#/${s}`);
        const empties = await page.locator('.state-empty').count();
        const errs = await page.locator('.state-error').count();
        const isSettings = s === 'settings';
        if (!isSettings && (empties === 0 || errs > 0)) missing.push(`${s}(empty=${empties},error=${errs})`);
        if (isSettings && errs > 0) missing.push(`settings error`);
        // 空状態には案内（本文またはボタン）がある
        if (!isSettings && empties) {
          const guide = await page.locator('.state-empty').first().innerText();
          if (guide.trim().split('\n').length < 2) missing.push(`${s}: 案内なし「${guide}」`);
        }
        const banner = await page.locator('.banner-sample').count();
        if (banner) missing.push(`${s}: 空なのにサンプル帯`);
      }
      check(`空データ: 全画面が案内付き空状態(${vp})`, !missing.length, missing.join(' / ') || 'OK');
      await ctx.close();
    }
    const emptyProblems = { pc: await sweepScreens('empty', 'pc'), sp: await sweepScreens('empty', 'sp') };
    check('表示: 空データの全画面レイアウト', !Object.keys(emptyProblems.pc).length && !Object.keys(emptyProblems.sp).length, JSON.stringify(emptyProblems));
    check('空データ: コンソールエラー0', consoleErrors.length === errBefore, consoleErrors.slice(errBefore).join(' | '));
  }

  /* ===== 3. 重複統合（URL・CSV・JSON・capture をUIで） ===== */
  {
    const { ctx, page } = await newCtx('pc');
    // URL 保存
    await go(page, '#/import');
    const urlTa = page.locator('textarea').first();
    await urlTa.fill(`https://x.com/qa_dup/status/${ID.dup}`);
    await page.getByRole('button', { name: '保存する' }).click();
    await page.waitForSelector('.url-results li', { timeout: 30000 });
    await settle(page);
    // CSV 貼り付け
    const pasteTa = page.locator('textarea.mono');
    await pasteTa.fill(CSV);
    await page.locator('select').filter({ has: page.locator('option[value="csv"]') }).selectOption('csv');
    await page.getByRole('button', { name: '取り込む', exact: true }).click();
    await page.waitForSelector('.result', { timeout: 10000 });
    const csvRes = await page.locator('.result').innerText();
    // JSON 貼り付け（XSS含む）
    await pasteTa.fill(JSON_IMPORT);
    await page.locator('select').filter({ has: page.locator('option[value="csv"]') }).selectOption('json');
    await page.getByRole('button', { name: '取り込む', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.result').length && document.querySelector('.result').innerText.includes('統合'), null, { timeout: 10000 });
    await settle(page);
    const jsonRes = await page.locator('.result').innerText();
    // capture
    await go(page, `#/capture?d=${CAPTURE}`);
    await shot(page, 'capture-preview-pc', false);
    await page.getByRole('button', { name: /件を取り込む/ }).click();
    await page.waitForSelector('.result', { timeout: 10000 });
    const capRes = await page.locator('.result').innerText();
    const hashAfter = await page.evaluate(() => location.hash);
    check('重複: capture 後に URL から d= を除去', !hashAfter.includes('d='), hashAfter);
    const ps = (await allPosts()).items.filter((p) => p.postId === ID.dup);
    const types = ps[0]?.sources.map((s) => s.type).sort().join(',');
    check('重複: 同じ投稿IDを4経路で入れても1件', ps.length === 1 && ps[0].mergedCount === 4, `count=${ps.length} mergedCount=${ps[0]?.mergedCount} sources=${types}`);
    check('重複: 4経路の取得元が記録', types === 'foryou_capture,import_csv,import_json,url', types);
    // フィード表示
    await go(page, '#/feed');
    const card = page.locator('.post-card', { hasText: `ID ${ID.dup}` });
    const n = await card.count();
    const merged = n ? await card.locator('.badge-merged').innerText() : '';
    check('重複: フィードに1枚・「4件の取得を統合」', n === 1 && merged === '4件の取得を統合', `cards=${n} badge="${merged}"`);
    await card.first().screenshot({ path: path.join(SHOTS, 'dup-card-pc.png') });
    console.log('  csv:', csvRes.replace(/\n/g, ' '), '| json:', jsonRes.replace(/\n/g, ' '), '| capture:', capRes.replace(/\n/g, ' '));

    /* ===== 4. 欠けた指標 ===== */
    const nulCard = page.locator('.post-card', { hasText: `ID ${ID.nul}` });
    const zeroCard = page.locator('.post-card', { hasText: `ID ${ID.zero}` });
    const nulVals = await nulCard.locator('.metric-val').allInnerTexts();
    const zeroVals = await zeroCard.locator('.metric-val').allInnerTexts();
    const nulMeta = await nulCard.locator('.post-meta').innerText();
    const zeroMeta = await zeroCard.locator('.post-meta').innerText();
    check('欠けた指標: null は「不明」、0 は「0」', nulVals.every((v) => v === '不明') && zeroVals.every((v) => v === '0'), `null=${nulVals} zero=${zeroVals}`);
    check('欠けた指標: 「数値取得: 不明」', nulMeta.includes('数値取得: 不明') && !zeroMeta.includes('不明'), `null="${nulMeta}" zero="${zeroMeta}"`);
    await nulCard.screenshot({ path: path.join(SHOTS, 'null-metrics-card-pc.png') });
    for (const sort of ['views', 'likes']) {
      const items = (await api('GET', `/posts?genre=all&period=all&sort=${sort}&limit=200`)).data.items;
      const firstNull = items.findIndex((p) => p.metrics[sort] === null);
      const tailOk = firstNull === -1 || items.slice(firstNull).every((p) => p.metrics[sort] === null);
      const zeroIdx = items.findIndex((p) => p.postId === ID.zero);
      const nulIdx = items.findIndex((p) => p.postId === ID.nul);
      check(`欠けた指標: sort=${sort} で null が末尾・0より後`, tailOk && zeroIdx < nulIdx, `zero#${zeroIdx + 1} null#${nulIdx + 1} / ${items.length}`);
    }
    // UI 上の並べ替え
    await page.locator('select[aria-label="並べ替え"]').selectOption('views');
    await settle(page);
    const lastVals = await page.locator('.post-card').last().locator('.metric-val').first().innerText();
    check('欠けた指標: UIで表示回数順の末尾が「不明」', lastVals === '不明', `last views="${lastVals}"`);
    await page.locator('select[aria-label="並べ替え"]').selectOption('score');
    await settle(page);

    /* ===== XSS ===== */
    const xssCard = page.locator('.post-card', { hasText: `ID ${ID.xss}` });
    const xssText = await xssCard.locator('.post-text').innerText();
    const injected = await page.evaluate(() => document.querySelectorAll('img[src="x"]').length);
    await page.waitForTimeout(300);
    check('XSS: 本文がテキストとして表示され実行されない', xssText.includes('<img src=x onerror=alert(1)>') && injected === 0 && dialogs.length === 0, `img=${injected} dialogs=${dialogs.length}`);
    await ctx.close();
  }

  /* ===== 5. 繰り返し操作 ===== */
  {
    const { ctx, page } = await newCtx('pc');
    await go(page, '#/import');
    const before = (await allPosts()).total;
    const ta = page.locator('textarea').first();
    const btn = page.getByRole('button', { name: '保存する' });
    for (let i = 0; i < 3; i++) {
      await ta.fill(`https://x.com/qa_rep/status/${ID.extra}\nhttps://twitter.com/qa_rep/status/${ID.extra}?s=20`);
      await btn.click({ clickCount: 3, delay: 20 }).catch(() => {});
      await page.waitForFunction(() => /件を保存しました|失敗/.test(document.querySelector('.result-area .hint')?.textContent || ''), null, { timeout: 30000 })
        .catch(async (e) => { console.log('DEBUG', await page.locator('main').innerText()); throw e; });
    }
    const after = await allPosts();
    const rep = after.items.filter((p) => p.postId === ID.extra);
    check('繰り返し: 同じURL保存の連打で1件', rep.length === 1 && after.total === before + 1, `total ${before}→${after.total} rows=${rep.length} mergedCount=${rep[0]?.mergedCount} sources=${rep[0]?.sources.length}`);
    // 興味なし登録の連打（UI：登録ボタン連打 + API 並列）
    await go(page, '#/feed');
    const card = page.locator('.post-card', { hasText: `ID ${ID.extra}` });
    await card.getByRole('button', { name: /興味なし/ }).click();
    const dlg = page.locator('dialog[open]');
    await dlg.getByRole('button', { name: '登録する' }).click({ clickCount: 3, delay: 10 }).catch(() => {});
    await page.waitForTimeout(800);
    await Promise.all(Array.from({ length: 5 }, () => api('POST', '/dismissals', { scope: 'post', value: ID.extra, reasonCode: 'other' })));
    let ds = (await api('GET', '/dismissals?includeRevoked=1')).data.items.filter((d) => d.scope === 'post' && d.value === ID.extra);
    check('繰り返し: 興味なし登録の連打で重複しない', ds.length === 1 && !ds[0].revokedAt, `rows=${ds.length}`);
    // 取消/再有効化の連打（UI）
    await go(page, '#/dismissed');
    for (let i = 0; i < 4; i++) {
      const b = page.locator('.dismiss-item').first().locator('button');
      await b.click({ clickCount: 2, delay: 5 }).catch(() => {});
      await page.waitForTimeout(150);
      await page.locator('.seg-2 label').nth(i % 2 === 0 ? 1 : 0).click();
      await page.waitForTimeout(150);
    }
    // API 並列連打
    const id = ds[0].id;
    await Promise.all([...Array(6)].map((_, i) => api('POST', `/dismissals/${id}/${i % 2 ? 'restore' : 'revoke'}`)));
    await api('POST', `/dismissals/${id}/restore`);
    await api('POST', `/dismissals/${id}/restore`);
    ds = (await api('GET', '/dismissals?includeRevoked=1')).data.items.filter((d) => d.scope === 'post' && d.value === ID.extra);
    const active = ds.filter((d) => !d.revokedAt);
    const hidden = !(await visibleIds()).includes(ID.extra);
    check('繰り返し: 取消/再有効化の連打で状態が一貫', ds.length === 1 && active.length === 1 && hidden, `rows=${ds.length} active=${active.length} hiddenInFeed=${hidden}`);
    await api('POST', `/dismissals/${id}/revoke`);
    check('繰り返し: 最後に取消→フィードに戻る', (await visibleIds()).includes(ID.extra));
    await ctx.close();
  }

  /* ===== 6. 興味なしの登録と取消（UI、各scope、理由付き） ===== */
  {
    for (const vp of ['pc', 'sp']) {
      const { ctx, page } = await newCtx(vp);
      const cases = [
        { scope: 'post', label: 'この投稿', target: ID.nul, reason: 'VTuber', note: 'QAメモ投稿', affects: [ID.nul] },
        { scope: 'author', label: 'この投稿者', target: ID.author, reason: '質の悪い投稿者', note: 'QAメモ投稿者', affects: [ID.author] },
        { scope: 'keyword', label: 'キーワード', target: ID.kw, reason: '別の意味', note: 'QAメモKW', keyword: 'QA除外語テスト', affects: [ID.kw] },
        { scope: 'topic', label: 'このトピック', target: ID.t1, reason: '不要な話題', note: 'QAメモトピック', affects: [ID.t1, ID.t2] },
      ];
      for (const c of cases) {
        for (const undoVia of ['toast', 'screen']) {
          await go(page, '#/feed');
          const card = page.locator('.post-card', { hasText: `ID ${c.target}` });
          if (!(await card.count())) { check(`興味なし(${vp}/${c.scope}/${undoVia})`, false, '対象カードが見つからない'); continue; }
          const rankBefore = (await api('GET', '/posts?genre=all&period=all&limit=200')).data.items.find((p) => p.postId === c.target)?.rank;
          await card.getByRole('button', { name: /興味なし/ }).click();
          const dlg = page.locator('dialog[open]');
          const dlgText = await dlg.innerText();
          const xNote = /Xには反映されません/.test(dlgText);
          await dlg.locator('label.radio-row', { hasText: c.label }).first().click();
          if (c.keyword) await dlg.locator('.kw-box input').fill(c.keyword);
          await dlg.locator('label.radio-row', { hasText: c.reason }).click();
          await dlg.locator('textarea').fill(c.note);
          if (c.scope === 'topic' && undoVia === 'screen') await dlg.locator('label.radio-row', { hasText: '順位を下げる' }).click();
          if (vp === 'sp' && c.scope === 'keyword' && undoVia === 'toast') await shot(page, `dismiss-sheet-${vp}`, false);
          if (vp === 'pc' && c.scope === 'post' && undoVia === 'toast') await shot(page, `dismiss-sheet-${vp}`, false);
          await dlg.getByRole('button', { name: '登録する' }).click();
          await page.waitForSelector('.toast', { timeout: 5000 });
          await settle(page);
          const demote = c.scope === 'topic' && undoVia === 'screen';
          const vis = await visibleIds();
          const all = (await api('GET', '/posts?genre=all&period=all&limit=200')).data.items;
          const uiCount = await page.locator('.post-card', { hasText: `ID ${c.target}` }).count();
          let applied;
          if (demote) {
            const r = all.find((p) => p.postId === c.target);
            applied = r && r.demoted && r.rank > rankBefore && r.rank >= all.length - 1;
          } else applied = c.affects.every((id) => !vis.includes(id)) && uiCount === 0;
          const ds = (await api('GET', '/dismissals')).data.items.find((d) => d.scope === c.scope && d.reasonNote === c.note);
          check(`興味なし: ${c.scope} 登録→${demote ? '順位下げ' : '非表示'}反映(${vp}/${undoVia})`, applied && ds && ds.reasonCode, `uiCount=${uiCount} dismissal=${ds ? `${ds.value}/${ds.reasonCode}/${ds.effect}` : 'なし'} rank ${rankBefore}→${all.find((p) => p.postId === c.target)?.rank}`);
          if (c.scope === 'post') check(`興味なし: 「Xには反映されません」の明記(${vp})`, xNote, dlgText.split('\n')[1] || '');
          if (undoVia === 'toast') {
            if (vp === 'sp' && c.scope === 'post') await shot(page, `dismiss-toast-${vp}`, false);
            await page.locator('.toast', { hasText: '登録しました' }).last().getByRole('button', { name: '元に戻す' }).click();
            await page.waitForTimeout(400);
            await settle(page);
          } else {
            await go(page, '#/dismissed');
            const scrText = await page.locator('main').innerText();
            if (c.scope === 'post') check(`興味なし画面: 「Xには反映されません」の明記(${vp})`, /Xには反映されません/.test(scrText));
            if (c.scope === 'topic') await shot(page, `dismissed-list-${vp}`);
            await page.locator('.dismiss-item', { hasText: c.note }).getByRole('button', { name: /取り消/ }).click();
            await page.waitForTimeout(400);
            await go(page, '#/feed');
          }
          const vis2 = await visibleIds();
          const all2 = (await api('GET', '/posts?genre=all&period=all&limit=200')).data.items;
          const back = c.affects.every((id) => vis2.includes(id)) && !all2.find((p) => p.postId === c.target).demoted;
          const uiBack = await page.locator('.post-card', { hasText: `ID ${c.target}` }).count();
          check(`興味なし: ${c.scope} 取消で即座に元通り(${vp}/${undoVia})`, back && uiBack === 1 && all2.find((p) => p.postId === c.target).rank === rankBefore, `uiCount=${uiBack} rank=${all2.find((p) => p.postId === c.target).rank} (before ${rankBefore})`);
        }
      }
      await ctx.close();
    }
  }

  /* ===== 7. データ入り全画面レイアウト ===== */
  {
    const dataProblems = { pc: await sweepScreens('data', 'pc', { capturePayload: CAPTURE }), sp: await sweepScreens('data', 'sp', { capturePayload: CAPTURE }) };
    check('表示: データ入り全画面レイアウト', !Object.keys(dataProblems.pc).length && !Object.keys(dataProblems.sp).length, JSON.stringify(dataProblems));
    const { ctx, page } = await newCtx('pc');
    await go(page, '#/settings');
    const txt = await page.locator('main').innerText();
    check('ホームTL: 「おすすめではない」表記', /おすすめ(欄)?では(ない|ありません)/.test(txt), (txt.match(/[^\n]*おすすめ[^\n]*/g) || []).join(' / '));
    await ctx.close();
  }

  /* ===== 8. 保存・復元 ===== */
  const snapshot = async () => {
    const p = await allPosts();
    const d = (await api('GET', '/dismissals?includeRevoked=1')).data.items;
    return JSON.stringify({
      posts: p.items.map((x) => [x.postId, x.text, x.mergedCount, x.metrics]).sort(),
      dism: d.map((x) => [x.scope, x.value, x.reasonCode, x.reasonNote, x.effect, !!x.revokedAt]).sort(),
    });
  };
  {
    const snap0 = await snapshot();
    await stopServer();
    await startServer(dataA, port);
    check('保存: 再起動後も内容が残る', (await snapshot()) === snap0);

    const { ctx, page } = await newCtx('pc');
    await go(page, '#/settings');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'ダウンロード' }).click()]);
    const bfile = path.join(dataA, '..', `dl-${path.basename(dataA)}.json`);
    await dl.saveAs(bfile);
    const bjson = JSON.parse(readFileSync(bfile, 'utf8'));
    check('バックアップ: DL できる', bjson.format === 'x-trend-backup' && bjson.posts.length > 0, `${dl.suggestedFilename()} posts=${bjson.posts.length}`);
    // 変更
    await api('POST', '/import', { format: 'json', content: JSON.stringify([{ id: '1900000000000000099', text: '復元で消えるべき投稿 ホスト' }]) });
    await api('POST', '/dismissals', { scope: 'keyword', value: '復元で消える', reasonCode: 'other' });
    await api('PUT', '/settings', { settings: { excludeTerms: ['ロイヤルホスト', '復元テスト語'] } });
    check('バックアップ: 変更が入った', (await snapshot()) !== snap0);
    // replace で復元
    await go(page, '#/settings');
    await page.locator('label.radio-row', { hasText: '置き換え' }).click();
    await page.locator('input[type=file][accept*="json"]').setInputFiles(bfile);
    await page.locator('dialog[open]').getByRole('button', { name: '置き換えて復元' }).click();
    await page.waitForSelector('.result-ok', { timeout: 10000 });
    const ex = (await api('GET', '/settings')).data.settings.excludeTerms;
    check('バックアップ: ファイルから replace 復元で元に戻る', (await snapshot()) === snap0 && !ex.includes('復元テスト語'), `excludeTerms=${ex}`);
    // 自動バックアップ
    await go(page, '#/settings');
    await page.getByRole('button', { name: '今すぐ自動バックアップ' }).click();
    await page.waitForSelector('.backup-row', { timeout: 10000 });
    await api('POST', '/import', { format: 'json', content: JSON.stringify([{ id: '1900000000000000098', text: '自動復元で消えるべき投稿 ホスト' }]) });
    await go(page, '#/settings');
    const listed = await page.locator('.backup-row').count();
    await page.locator('.backup-row').first().getByRole('button', { name: /復元/ }).click();
    await page.locator('dialog[open]').getByRole('button', { name: '復元する' }).click();
    await page.waitForSelector('.result-ok', { timeout: 10000 });
    const snapAuto = await snapshot();
    const diffOf = (a, b) => { const A = JSON.parse(a), B = JSON.parse(b); const out = []; for (const k of Object.keys(A)) { const sa = A[k].map(JSON.stringify), sb = B[k].map(JSON.stringify); out.push(...sa.filter((x) => !sb.includes(x)).map((x) => `-${k}:${x}`), ...sb.filter((x) => !sa.includes(x)).map((x) => `+${k}:${x}`)); } return out.join(' ').slice(0, 1500); };
    check('バックアップ: 自動バックアップ一覧から復元', listed >= 1 && snapAuto === snap0, `listed=${listed} ${diffOf(snap0, snapAuto)}`);
    await shot(page, 'settings-restored-pc');
    await ctx.close();
  }

  /* ===== 9. 共有（ADMIN_TOKEN） ===== */
  {
    const ADMIN = 'qa-admin-token-123';
    await stopServer();
    await startServer(dataA, port, { ADMIN_TOKEN: ADMIN });
    check('共有: トークンなし API は 401', (await api('GET', '/posts')).status === 401);
    for (const vp of ['pc', 'sp']) {
      // トークンなし
      const anon = await newCtx(vp, { allow401: true });
      await go(anon.page, '#/feed');
      const authTxt = await anon.page.locator('main').innerText();
      const adminPill = await anon.page.locator('.pill-admin').count();
      check(`共有: トークンなしで401画面(${vp})`, authTxt.includes('アクセスにはリンクかトークンが必要です') && adminPill === 0, `${authTxt.split('\n')[0]} adminPill=${adminPill}`);
      // 誤ったトークンでは開けない
      await anon.page.locator('input[type=password]').fill('wrong-token');
      await anon.page.getByRole('button', { name: 'この内容で開く' }).click();
      await anon.page.waitForSelector('.toast-error', { timeout: 5000 }).catch(() => {});
      const wrongTxt = await anon.page.locator('main').innerText();
      const wrongToast = await anon.page.locator('.toast-error').count();
      check(`共有: 誤った管理者トークンでは401画面のまま(${vp})`, wrongTxt.includes('アクセスにはリンクかトークンが必要です') && wrongToast > 0, `toast=${wrongToast}`);
      const ap = await layoutProblems(anon.page);
      check(`表示: 401画面レイアウト(${vp})`, !ap.length, ap.join(' | '));
      await shot(anon.page, `auth-401-${vp}`);
      // 管理者トークンを入力
      await anon.page.locator('input[type=password]').fill(ADMIN);
      await anon.page.getByRole('button', { name: 'この内容で開く' }).click();
      await settle(anon.page);
      await go(anon.page, '#/settings');
      const shareInput = anon.page.locator('input[aria-label="共有リンク"]');
      await shareInput.waitFor({ timeout: 10000 });
      const shareUrl = await shareInput.inputValue();
      check(`共有: 設定で共有リンク取得(${vp})`, /\?share=[\w-]{10,}/.test(shareUrl), shareUrl.replace(/share=.*/, 'share=…'));
      // 閲覧者
      const viewer = await newCtx(vp);
      await viewer.page.goto(shareUrl.replace(/^https?:\/\/[^/]+/, server.base));
      await settle(viewer.page);
      const urlAfter = viewer.page.url();
      const pill = await viewer.page.locator('.pill-viewer').count();
      const dismissBtns = await viewer.page.locator('.btn-dismiss').count();
      const cards = await viewer.page.locator('.post-card').count();
      await go(viewer.page, '#/import');
      const importForms = await viewer.page.locator('textarea').count();
      const collectBtn = await viewer.page.getByRole('button', { name: '今すぐ収集' }).count();
      await go(viewer.page, '#/dismissed');
      const revokeBtns = await viewer.page.locator('.dismiss-item button').count();
      await go(viewer.page, '#/digests');
      const digestBtns = await viewer.page.getByRole('button', { name: /を作成/ }).count();
      await go(viewer.page, '#/settings');
      const settingsTxt = await viewer.page.locator('main').innerText();
      const viewerProblems = await layoutProblems(viewer.page);
      await shot(viewer.page, `viewer-settings-${vp}`);
      await go(viewer.page, '#/feed');
      await shot(viewer.page, `viewer-feed-${vp}`);
      const writeApi = await api('POST', '/dismissals', { scope: 'post', value: ID.dup }, { 'X-Share-Token': new URL(shareUrl).searchParams.get('share') });
      check(`共有: ?share= で閲覧専用・書き込みUIなし(${vp})`,
        pill === 1 && cards > 0 && dismissBtns === 0 && importForms === 0 && collectBtn === 0 && revokeBtns === 0 && digestBtns === 0 && settingsTxt.includes('閲覧専用') && !urlAfter.includes('share=') && writeApi.status === 403,
        `pill=${pill} cards=${cards} dismissBtns=${dismissBtns} textareas=${importForms} collect=${collectBtn} revoke=${revokeBtns} digestBtns=${digestBtns} urlHasShare=${urlAfter.includes('share=')} writeApi=${writeApi.status}`);
      check(`表示: 閲覧専用画面レイアウト(${vp})`, !viewerProblems.length, viewerProblems.join(' | '));
      // 閲覧者が管理者トークンを入力 → 編集可
      await go(viewer.page, '#/settings');
      await viewer.page.locator('input[type=password]').fill(ADMIN);
      await viewer.page.getByRole('button', { name: '保存', exact: true }).click();
      await settle(viewer.page);
      await go(viewer.page, '#/feed');
      const nowDismiss = await viewer.page.locator('.btn-dismiss').count();
      const nowPill = await viewer.page.locator('.pill-viewer').count();
      check(`共有: 管理者トークン入力で編集可(${vp})`, nowDismiss > 0 && nowPill === 0, `dismissBtns=${nowDismiss} viewerPill=${nowPill}`);
      // 再発行 → 旧リンク無効
      await go(anon.page, '#/settings');
      await anon.page.getByRole('button', { name: '再発行' }).click();
      await anon.page.locator('dialog[open]').getByRole('button', { name: '再発行する' }).click();
      await anon.page.waitForFunction((old) => { const i = document.querySelector('input[aria-label="共有リンク"]'); return i && i.value && i.value !== old; }, shareUrl, { timeout: 10000 });
      const newUrl = await anon.page.locator('input[aria-label="共有リンク"]').inputValue();
      const stale = await newCtx(vp, { allow401: true });
      await stale.page.goto(shareUrl.replace(/^https?:\/\/[^/]+/, server.base));
      await settle(stale.page);
      const staleTxt = await stale.page.locator('main').innerText();
      const fresh = await newCtx(vp);
      await fresh.page.goto(newUrl.replace(/^https?:\/\/[^/]+/, server.base));
      await settle(fresh.page);
      const freshPill = await fresh.page.locator('.pill-viewer').count();
      check(`共有: 再発行で旧リンク無効・新リンク有効(${vp})`, newUrl !== shareUrl && staleTxt.includes('アクセスにはリンクかトークンが必要です') && freshPill === 1, `stale="${staleTxt.split('\n')[0]}" freshViewer=${freshPill}`);
      for (const c of [anon, viewer, stale, fresh]) await c.ctx.close();
    }
  }

  check('コンソールエラー0（全体）', consoleErrors.length === 0, consoleErrors.slice(0, 10).join(' | '));
  check('alert ダイアログ0（XSS）', dialogs.length === 0, dialogs.join(' | '));

  await stopServer();
  await browser.close();
  rmSync(dataA, { recursive: true, force: true });
}

try {
  await main();
} catch (e) {
  console.error('E2E 実行エラー:', e);
  check('E2E 実行', false, String(e && e.message));
} finally {
  await stopServer().catch(() => {});
  if (browser) await browser.close().catch(() => {});
}
const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
for (const f of failed) console.log(`FAIL [${f.item}] ${f.detail}`);
writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify(results, null, 1));
process.exit(failed.length ? 1 : 0);
