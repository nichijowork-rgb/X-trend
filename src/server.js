import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb, createMeta } from './db.js';
import { createSettingsStore, ValidationError } from './settings.js';
import { createStore, httpError } from './store.js';
import { createAuth } from './auth.js';
import { createBackup } from './backup.js';
import { createDigest } from './digest.js';
import { createJobs, resolveIntegrations, JOB_NAMES } from './jobs.js';
import { createScheduler, nextRuns } from './scheduler.js';
import { loadSample } from './sample.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 10 * 1024 * 1024;
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

async function loadModules() {
  const out = {};
  for (const n of ['url', 'importers', 'xapi', 'grok', 'bookmarklet']) {
    try {
      out[n] = await import(`./integrations/${n}.js`);
    } catch {
      out[n] = null;
    }
  }
  return out;
}
const MODS = await loadModules();

function fallbackUrl() {
  return {
    parsePostUrl(input) {
      const s = String(input ?? '').trim();
      if (/^\d{1,25}$/.test(s)) return { postId: s, authorHandle: null, url: `https://x.com/i/web/status/${s}` };
      const m = s.match(/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:([A-Za-z0-9_]{1,15})|i\/web)\/status\/(\d{1,25})/);
      return m ? { postId: m[2], authorHandle: m[1] ?? null, url: `https://x.com/${m[1] ?? 'i/web'}/status/${m[2]}` } : null;
    },
    fetchOEmbed: async () => null,
  };
}

export function defaultIntegrations(env, fetchImpl) {
  return {
    url: MODS.url ?? fallbackUrl(),
    importers: MODS.importers,
    bookmarklet: MODS.bookmarklet,
    xapi: MODS.xapi
      ? MODS.xapi.createXApi({ bearerToken: env.X_BEARER_TOKEN, userAccessToken: env.X_USER_ACCESS_TOKEN, userId: env.X_USER_ID, fetchImpl })
      : null,
    grok: MODS.grok ? (settings) => MODS.grok.createGrok({ apiKey: env.XAI_API_KEY, model: settings?.sources?.grok?.model, fetchImpl }) : null,
  };
}

export function createApp(options = {}) {
  const env = options.env ?? process.env;
  const dataDir = path.resolve(options.dataDir ?? env.DATA_DIR ?? './data');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const clock = () => {
    const v = typeof options.now === 'function' ? options.now() : options.now;
    return v === undefined || v === null ? new Date() : new Date(v);
  };
  const integrations = { ...defaultIntegrations(env, fetchImpl), ...(options.integrations || {}) };

  const db = openDb(dataDir);
  const meta = createMeta(db);
  const settings = createSettingsStore(meta);
  const store = createStore({ db, meta, clock, getSettings: settings.get });
  const auth = createAuth({ env, meta });
  const getInt = () => resolveIntegrations(integrations, settings.get());
  const digest = createDigest({ store, settings, getIntegrations: getInt, clock, fetchImpl });
  const backup = createBackup({ store, settings, dataDir, clock });
  const jobs = createJobs({ store, settings, integrations, clock, digest, backup });
  const scheduler = createScheduler({ settings, jobs, clock, onError: (e) => console.error('スケジューラのエラー:', e?.message) });

  function ensureSampleDigest() {
    if (store.digestCount() === 0) void digest.generate('daily', { offline: true }).catch(() => {});
  }
  if (store.realCount() === 0 && store.sampleCount() === 0 && meta.get('sample_deleted') !== '1') {
    loadSample(store, clock());
    ensureSampleDigest();
  }

  const sendJson = (res, status, body, headers = {}) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    res.end(data);
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let over = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) over = true;
        else chunks.push(c);
      });
      req.on('end', () => {
        if (over) return reject(httpError(413, 'リクエストが大きすぎます（上限10MB）'));
        if (!chunks.length) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(v && typeof v === 'object' ? v : {});
        } catch {
          reject(httpError(400, 'JSONの形式が正しくありません'));
        }
      });
      req.on('error', reject);
    });
  }

  function originOf(req) {
    const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim() === 'https' ? 'https' : 'http';
    const host = String(req.headers.host ?? 'localhost').replace(/[^A-Za-z0-9.:\-[\]]/g, '');
    return `${proto}://${host}`;
  }

  function statusBody(role) {
    const g = getInt();
    const xc = g.xapi.isConfigured();
    const s = settings.get();
    return {
      sampleMode: store.realCount() === 0 && store.sampleCount() > 0,
      realPostCount: store.realCount(),
      samplePostCount: store.sampleCount(),
      role,
      authRequired: auth.authRequired,
      integrations: { xSearch: !!xc.search, xHome: !!xc.home, grok: !!g.grok.isConfigured() },
      lastRuns: store.lastRunsByJob(),
      nextRuns: nextRuns(s, clock()),
      version: VERSION,
    };
  }

  const intParam = (v, d, min, max) => {
    const n = Number.parseInt(v ?? '', 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };
  const oneOf = (v, list, d) => (list.includes(v) ? v : d);
  const hintOf = (g) => (g === 'nightlife' || g === 'general' ? g : null);

  function ingestResult(parsed, genre, sourceType) {
    const hint = hintOf(genre);
    const posts = (parsed.posts || []).map((p) => ({ ...p, genreHint: p.genreHint ?? hint, source: p.source ?? (sourceType ? { type: sourceType, detail: null } : undefined) }));
    const r = store.upsertPosts(posts);
    return { added: r.added, merged: r.merged, skipped: r.skipped, errors: parsed.errors || [] };
  }
  const need = (mod, name) => {
    if (!mod) throw httpError(501, `${name}機能が利用できません`);
    return mod;
  };

  const routes = [];
  const route = (method, pattern, fn, opts = {}) => routes.push({ method, re: new RegExp(`^${pattern}$`), fn, ...opts });

  route('GET', '/api/status', async (c) => ({ body: statusBody(c.role) }), { public: true });
  route('GET', '/api/posts', async (c) => {
    const q = c.query;
    return {
      body: store.queryPosts({
        genre: oneOf(q.get('genre'), ['nightlife', 'general', 'all'], 'all'),
        sort: oneOf(q.get('sort'), ['views', 'likes', 'newest', 'score'], 'score'),
        period: oneOf(q.get('period'), ['day', 'week', 'month', 'all'], 'all'),
        topicId: q.get('topicId') || '',
        q: q.get('q') || '',
        includeHidden: q.get('includeHidden') === '1',
        limit: intParam(q.get('limit'), 50, 1, 200),
        offset: intParam(q.get('offset'), 0, 0, 1e9),
      }),
    };
  });
  route('GET', '/api/topics', async (c) => ({ body: store.listTopics({ genre: c.query.get('genre') || '', period: oneOf(c.query.get('period'), ['day', 'week', 'month', 'all'], 'all') }) }));

  route('POST', '/api/posts/url', async (c) => {
    const int = integrations.url ?? fallbackUrl();
    const parsed = int.parsePostUrl(c.body.url);
    if (!parsed) throw httpError(400, '投稿のURLとして認識できません（x.com / twitter.com の投稿URLを指定してください）');
    const existing = store.getPost(parsed.postId);
    let oe = null;
    if (!existing || !existing.text) {
      try {
        oe = await int.fetchOEmbed(parsed.url, { fetchImpl });
      } catch {
        oe = null;
      }
    }
    const r = store.upsertPosts([
      {
        postId: parsed.postId,
        url: parsed.url,
        authorHandle: oe?.authorHandle ?? parsed.authorHandle ?? null,
        authorName: oe?.authorName ?? null,
        text: oe?.text ?? null,
        postedAt: oe?.postedAt ?? null,
        metrics: { views: null, likes: null, reposts: null, replies: null, bookmarks: null },
        metricsFetchedAt: null,
        source: { type: 'url', detail: parsed.url },
        genreHint: hintOf(c.body.genre),
        matchedKeywords: [],
      },
    ]);
    return { body: { post: store.getPost(parsed.postId), created: r.added === 1 } };
  });
  route('POST', '/api/import', async (c) => {
    const { format, content, filename, genre } = c.body;
    if (typeof content !== 'string' || !content.trim()) throw httpError(400, '取り込む内容が空です');
    const imp = need(integrations.importers, '取り込み');
    const detail = typeof filename === 'string' && filename ? filename.slice(0, 200) : null;
    let parsed;
    if (format === 'json') parsed = imp.parseJSON(content, { sourceDetail: detail });
    else if (format === 'csv') parsed = imp.parseCSV(content, { sourceDetail: detail });
    else throw httpError(400, 'format は json か csv を指定してください');
    return { body: ingestResult(parsed, genre, format === 'json' ? 'import_json' : 'import_csv') };
  });
  route('POST', '/api/capture', async (c) => {
    const imp = need(integrations.importers, '取り込み');
    if (!c.body.payload || typeof c.body.payload !== 'object') throw httpError(400, 'payload を指定してください');
    return { body: ingestResult(imp.normalizeCapture(c.body.payload), c.body.genre, 'foryou_capture') };
  });
  route('GET', '/api/bookmarklet', async (c) => {
    const appUrl = originOf(c.req);
    const bm = need(integrations.bookmarklet, 'ブックマークレット');
    return { body: { code: bm.buildBookmarklet(appUrl), appUrl } };
  });

  route('POST', '/api/jobs/run', async (c) => {
    if (!JOB_NAMES.includes(c.body.job)) throw httpError(400, `job は ${JOB_NAMES.join(' / ')} のいずれかを指定してください`);
    return { body: { run: await jobs.run(c.body.job) } };
  });
  route('GET', '/api/runs', async (c) => ({ body: { items: store.listRuns(intParam(c.query.get('limit'), 20, 1, 200)) } }));
  route('GET', '/api/digests', async (c) => ({ body: { items: store.listDigests(c.query.get('kind')) } }));
  route('GET', '/api/digests/(\\d+)', async (c) => {
    const d = store.getDigest(c.m[1]);
    if (!d) throw httpError(404, 'まとめが見つかりません');
    return { body: { digest: d } };
  });

  route('GET', '/api/dismissals', async (c) => ({ body: { items: store.listDismissals({ includeRevoked: c.query.get('includeRevoked') === '1' }) } }));
  route('POST', '/api/dismissals', async (c) => ({ body: { dismissal: store.createDismissal(c.body) } }));
  route('POST', '/api/dismissals/(\\d+)/revoke', async (c) => ({ body: { dismissal: store.setDismissalRevoked(c.m[1], true) } }));
  route('POST', '/api/dismissals/(\\d+)/restore', async (c) => ({ body: { dismissal: store.setDismissalRevoked(c.m[1], false) } }));

  route('GET', '/api/settings', async (c) => {
    const s = settings.get();
    if (c.role !== 'admin') s.delivery.webhookUrl = null;
    return { body: { settings: s } };
  });
  route('PUT', '/api/settings', async (c) => {
    const next = settings.update(c.body.settings ?? {});
    store.reclassifyAll();
    return { body: { settings: next } };
  });

  route(
    'GET',
    '/api/backup',
    async () => {
      const stamp = clock().toISOString().slice(0, 10).replace(/-/g, '');
      return { body: backup.exportJson(), headers: { 'content-disposition': `attachment; filename="x-trend-backup-${stamp}.json"` } };
    },
    { admin: true },
  );
  route('POST', '/api/restore', async (c) => ({ body: backup.restore(c.body.backup, c.body.mode ?? 'replace') }));
  route('GET', '/api/backups', async () => ({ body: { items: backup.listBackups() } }), { admin: true });
  route('POST', '/api/backups/([^/]+)/restore', async (c) => ({ body: backup.restoreFromFile(decodeURIComponent(c.m[1]), c.body.mode ?? 'replace') }));

  route('POST', '/api/sample/load', async () => {
    meta.delete('sample_deleted');
    const r = loadSample(store, clock());
    ensureSampleDigest();
    return { body: { added: r.added, merged: r.merged, skipped: r.skipped } };
  });
  route('DELETE', '/api/sample', async () => {
    const deleted = store.deleteSamples();
    meta.set('sample_deleted', '1');
    return { body: { deleted } };
  });

  route('GET', '/api/share', async (c) => ({ body: { shareUrl: auth.shareUrl(originOf(c.req)), authRequired: auth.authRequired } }), { admin: true });
  route('POST', '/api/share/rotate', async (c) => {
    if (auth.authRequired) auth.rotate();
    return { body: { shareUrl: auth.shareUrl(originOf(c.req)), authRequired: auth.authRequired } };
  });

  async function handleApi(req, res, url) {
    const role = auth.roleOf(req.headers);
    const matched = routes.map((r) => ({ r, m: r.re.exec(url.pathname) })).filter((x) => x.m);
    if (!matched.length) return sendJson(res, 404, { error: 'APIが見つかりません' });
    const hit = matched.find((x) => x.r.method === req.method);
    if (!hit) return sendJson(res, 405, { error: 'このメソッドは使えません' });
    const { r, m } = hit;
    if (role === null && !r.public) return sendJson(res, 401, { error: '認証が必要です。共有URLまたは管理者トークンでアクセスしてください', authRequired: true });
    if (role === null && r.public) return sendJson(res, 200, { authRequired: true, role: 'none' });
    if ((req.method !== 'GET' || r.admin) && role !== 'admin') return sendJson(res, 403, { error: 'この操作には管理者権限が必要です' });
    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
    const out = await r.fn({ req, m, query: url.searchParams, body, role });
    return sendJson(res, 200, out.body, out.headers);
  }

  async function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'このメソッドは使えません' });
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(res, 400, { error: 'URLが正しくありません' });
    }
    if (rel.includes('\0')) return sendJson(res, 400, { error: 'URLが正しくありません' });
    let file = path.resolve(PUBLIC_DIR, `.${path.posix.normalize(`/${rel}`)}`);
    const inside = file === PUBLIC_DIR || file.startsWith(PUBLIC_DIR + path.sep);
    let ok = inside && existsSync(file) && statSync(file).isFile();
    if (!ok && inside && existsSync(file) && statSync(file).isDirectory()) {
      file = path.join(file, 'index.html');
      ok = existsSync(file);
    }
    if (!ok) {
      if (path.extname(rel) && path.extname(rel) !== '.html') return sendJson(res, 404, { error: 'ファイルが見つかりません' });
      file = path.join(PUBLIC_DIR, 'index.html');
      if (!existsSync(file)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('画面ファイル(public/index.html)が見つかりません');
      }
    }
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return await serveStatic(req, res, url);
    } catch (e) {
      const status = e instanceof ValidationError || e?.status ? e.status : 500;
      if (status >= 500) console.error('サーバーエラー:', e?.message);
      if (res.headersSent) return res.end();
      return sendJson(res, status, { error: status >= 500 ? 'サーバー内部でエラーが発生しました' : e.message }, status === 413 ? { connection: 'close' } : {});
    }
  };

  const server = http.createServer(handler);

  return {
    server,
    handler,
    db,
    store,
    settings,
    auth,
    jobs,
    scheduler,
    backup,
    digest,
    meta,
    dataDir,
    start(port = Number(env.PORT) || 8787, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          scheduler.start();
          resolve(server.address());
        });
      });
    },
    close() {
      scheduler.stop();
      return new Promise((resolve) => {
        server.close(() => {
          try {
            db.close();
          } catch {
            /* 既に閉じている */
          }
          resolve();
        });
        server.closeAllConnections?.();
        if (!server.listening) {
          try {
            db.close();
          } catch {
            /* 既に閉じている */
          }
          resolve();
        }
      });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createApp();
  const addr = await app.start();
  const mode = app.auth.authRequired ? '認証あり（ADMIN_TOKEN）' : 'ローカルモード（認証なし）';
  console.log(`X-trend を起動しました: http://localhost:${addr.port}  [${mode}]`);
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
