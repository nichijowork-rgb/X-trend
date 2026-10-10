import { classify, matchedKeywordsOf } from './genre.js';
import { clusterPosts } from './topics.js';

export const RANKING_NOTE = '取得した候補内の順位です（X全体の順位ではありません）';
const METRIC_KEYS = ['views', 'likes', 'reposts', 'replies', 'bookmarks'];
const SCOPES = ['post', 'author', 'keyword', 'topic'];
const REASONS = ['other_meaning', 'vtuber', 'off_topic', 'low_quality', 'staged', 'other'];
const EFFECTS = ['hide', 'demote'];
const TOPIC_CAP = 1500;
const DEMOTE_PENALTY = 1000;

export const httpError = (status, message) => Object.assign(new Error(message), { status });
const j = (s, d) => {
  try {
    return JSON.parse(s);
  } catch {
    return d;
  }
};
const toIso = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
export function toMetric(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
const cmpId = (a, b) => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0);

export function periodStartMs(period, nowMs) {
  const day = 86400000;
  if (period === 'day') return nowMs - day;
  if (period === 'week') return nowMs - 7 * day;
  if (period === 'month') return nowMs - 30 * day;
  return null;
}

export function normalizeDismissalValue(scope, value) {
  let v = String(value ?? '').trim();
  if (scope === 'author') v = v.replace(/^[@＠]+/, '').toLowerCase();
  if (scope === 'post') {
    const m = v.match(/status(?:es)?\/(\d+)/) || v.match(/^(\d+)$/);
    v = m ? m[1] : v;
  }
  return v;
}

export function createStore({ db, meta, clock, getSettings }) {
  let version = 0;
  let topicCache = null;
  let depth = 0;
  const nowIso = () => clock().toISOString();
  const nowMs = () => clock().getTime();

  function tx(fn) {
    if (depth > 0) return fn();
    db.exec('BEGIN');
    depth = 1;
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      depth = 0;
      version += 1;
    }
  }

  const POST_SELECT = `SELECT p.*, s.views AS m_views, s.likes AS m_likes, s.reposts AS m_reposts, s.replies AS m_replies,
    s.bookmarks AS m_bookmarks, s.fetched_at AS m_fetched
    FROM posts p LEFT JOIN metric_snapshots s ON s.id =
      (SELECT id FROM metric_snapshots WHERE post_id = p.post_id ORDER BY fetched_at DESC, id DESC LIMIT 1)`;

  function basePost(r) {
    const handle = r.author_handle;
    return {
      postId: r.post_id,
      url: r.url ?? (r.is_sample ? null : `https://x.com/${handle || 'i/web'}/status/${r.post_id}`),
      authorHandle: handle,
      authorName: r.author_name,
      text: r.text,
      postedAt: r.posted_at,
      genre: r.genre,
      topicId: null,
      topicLabel: null,
      metrics: { views: r.m_views ?? null, likes: r.m_likes ?? null, reposts: r.m_reposts ?? null, replies: r.m_replies ?? null, bookmarks: r.m_bookmarks ?? null },
      metricsFetchedAt: r.m_fetched ?? null,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      sources: j(r.sources, []),
      mergedCount: r.merged_count,
      matchedKeywords: j(r.matched_keywords, []),
      isSample: !!r.is_sample,
      hidden: false,
      demoted: false,
      matchedDismissals: [],
      rank: null,
    };
  }

  const timeOf = (p) => {
    const t = Date.parse(p.postedAt ?? p.firstSeenAt);
    return Number.isNaN(t) ? 0 : t;
  };

  function realCount() {
    return db.prepare('SELECT COUNT(*) AS c FROM posts WHERE is_sample = 0').get().c;
  }
  function sampleCount() {
    return db.prepare('SELECT COUNT(*) AS c FROM posts WHERE is_sample = 1').get().c;
  }

  function computeTopics() {
    if (topicCache && topicCache.version === version) return topicCache;
    const rows = db.prepare('SELECT post_id, text, sources, matched_keywords, posted_at, first_seen_at FROM posts').all();
    rows.sort((a, b) => (Date.parse(b.posted_at ?? b.first_seen_at) || 0) - (Date.parse(a.posted_at ?? a.first_seen_at) || 0));
    const input = rows.slice(0, TOPIC_CAP).map((r) => ({ postId: r.post_id, text: r.text, sources: j(r.sources, []), matchedKeywords: j(r.matched_keywords, []) }));
    const clusters = clusterPosts(input).filter((c) => c.postIds.length >= 2 || c.labeled);
    const byPost = new Map();
    const byId = new Map();
    for (const c of clusters) {
      byId.set(c.id, c);
      for (const id of c.postIds) byPost.set(id, c);
    }
    topicCache = { version, clusters, byPost, byId };
    return topicCache;
  }

  function loadPosts({ withSamples }) {
    const topics = computeTopics();
    const rows = db.prepare(POST_SELECT).all();
    const out = [];
    for (const r of rows) {
      if (!withSamples && r.is_sample) continue;
      const p = basePost(r);
      const c = topics.byPost.get(p.postId);
      if (c) {
        p.topicId = c.id;
        p.topicLabel = c.label;
      }
      out.push(p);
    }
    return out;
  }
  const visiblePosts = () => loadPosts({ withSamples: realCount() === 0 });

  function activeDismissals() {
    return db.prepare('SELECT * FROM dismissals WHERE revoked_at IS NULL ORDER BY id').all().map(dismissalRow);
  }
  function dismissalRow(r) {
    return {
      id: r.id,
      scope: r.scope,
      value: r.value,
      reasonCode: r.reason_code,
      reasonNote: r.reason_note,
      effect: r.effect,
      createdAt: r.created_at,
      revokedAt: r.revoked_at,
    };
  }
  function dismissalMatches(p, d) {
    switch (d.scope) {
      case 'post':
        return p.postId === d.value;
      case 'author':
        return !!p.authorHandle && p.authorHandle.toLowerCase() === d.value.toLowerCase();
      case 'keyword':
        return !!p.text && p.text.toLowerCase().includes(d.value.toLowerCase());
      case 'topic':
        return p.topicId === d.value;
      default:
        return false;
    }
  }
  function applyDismissals(posts, dismissals) {
    for (const p of posts) {
      for (const d of dismissals) {
        if (!dismissalMatches(p, d)) continue;
        p.matchedDismissals.push({ id: d.id, scope: d.scope, value: d.value, reasonCode: d.reasonCode, reasonNote: d.reasonNote });
        if (d.effect === 'hide') p.hidden = true;
        else p.demoted = true;
      }
    }
  }

  function scoreOf(p, now) {
    const m = p.metrics;
    let s = 0;
    if (m.likes !== null) s += Math.log10(1 + m.likes) * 3;
    if (m.views !== null) s += Math.log10(1 + m.views) * 1.5;
    if (m.reposts !== null) s += Math.log10(1 + m.reposts) * 3;
    const t = timeOf(p);
    if (t) s += 2 * Math.exp(-Math.max(0, now - t) / 3600000 / 48);
    if (p.demoted) s -= DEMOTE_PENALTY;
    return s;
  }

  function sortPosts(posts, sort, now) {
    const tie = (a, b) => timeOf(b) - timeOf(a) || cmpId(b.postId, a.postId);
    if (sort === 'newest') return posts.sort(tie);
    if (sort === 'views' || sort === 'likes') {
      return posts.sort((a, b) => {
        const x = a.metrics[sort];
        const y = b.metrics[sort];
        if (x === null && y === null) return tie(a, b);
        if (x === null) return 1;
        if (y === null) return -1;
        return y - x || tie(a, b);
      });
    }
    const sc = new Map(posts.map((p) => [p.postId, scoreOf(p, now)]));
    return posts.sort((a, b) => sc.get(b.postId) - sc.get(a.postId) || tie(a, b));
  }

  function inPeriod(p, period, now) {
    const start = periodStartMs(period, now);
    return start === null || timeOf(p) >= start;
  }

  function queryPosts({ genre = 'all', sort = 'score', period = 'all', topicId = '', q = '', includeHidden = false, limit = 50, offset = 0 } = {}) {
    const now = nowMs();
    let posts = visiblePosts();
    if (genre === 'nightlife' || genre === 'general') posts = posts.filter((p) => p.genre === genre);
    if (period !== 'all') posts = posts.filter((p) => inPeriod(p, period, now));
    if (topicId) posts = posts.filter((p) => p.topicId === topicId);
    const needle = String(q ?? '').trim().toLowerCase();
    if (needle) posts = posts.filter((p) => `${p.text ?? ''} ${p.authorHandle ?? ''} ${p.authorName ?? ''}`.toLowerCase().includes(needle));
    applyDismissals(posts, activeDismissals());
    const hiddenCount = posts.filter((p) => p.hidden).length;
    if (!includeHidden) posts = posts.filter((p) => !p.hidden);
    sortPosts(posts, sort, now);
    posts.forEach((p, i) => (p.rank = i + 1));
    return { items: posts.slice(offset, offset + limit), total: posts.length, hiddenCount, rankingNote: RANKING_NOTE };
  }

  function getPost(postId) {
    const row = db.prepare(`${POST_SELECT} WHERE p.post_id = ?`).get(postId);
    if (!row) return null;
    const p = basePost(row);
    const c = computeTopics().byPost.get(p.postId);
    if (c) {
      p.topicId = c.id;
      p.topicLabel = c.label;
    }
    applyDismissals([p], activeDismissals());
    return p;
  }

  function listTopics({ genre = '', period = 'all' } = {}) {
    const now = nowMs();
    const posts = visiblePosts();
    applyDismissals(posts, activeDismissals());
    const byId = new Map();
    for (const p of posts) {
      if (!p.topicId || p.hidden) continue;
      if (genre === 'nightlife' || genre === 'general') if (p.genre !== genre) continue;
      if (!inPeriod(p, period, now)) continue;
      if (!byId.has(p.topicId)) byId.set(p.topicId, []);
      byId.get(p.topicId).push(p);
    }
    const topics = computeTopics();
    const items = [];
    for (const [id, ps] of byId) {
      const c = topics.byId.get(id);
      if (!c) continue;
      const counts = {};
      for (const p of ps) counts[p.genre] = (counts[p.genre] || 0) + 1;
      const g = Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
      const likes = ps.map((p) => p.metrics.likes).filter((x) => x !== null);
      items.push({
        id,
        label: c.label,
        genre: g,
        keywords: c.keywords,
        postCount: ps.length,
        latestAt: new Date(Math.max(...ps.map(timeOf))).toISOString(),
        totalLikes: likes.length ? likes.reduce((a, b) => a + b, 0) : null,
        postIds: ps.map((p) => p.postId),
      });
    }
    items.sort((a, b) => b.postCount - a.postCount || (a.latestAt < b.latestAt ? 1 : -1) || (a.id < b.id ? -1 : 1));
    return { items };
  }

  const insertSnap = db.prepare('INSERT INTO metric_snapshots(post_id, views, likes, reposts, replies, bookmarks, fetched_at) VALUES(?,?,?,?,?,?,?)');
  const latestSnap = db.prepare('SELECT * FROM metric_snapshots WHERE post_id = ? ORDER BY fetched_at DESC, id DESC LIMIT 1');

  function addSnapshot(postId, metrics, fetchedAt) {
    const vals = METRIC_KEYS.map((k) => toMetric(metrics?.[k]));
    if (vals.every((v) => v === null)) return false;
    const last = latestSnap.get(postId);
    if (last && last.fetched_at === fetchedAt && METRIC_KEYS.every((k, i) => (last[k] ?? null) === vals[i])) return false;
    insertSnap.run(postId, ...vals, fetchedAt);
    return true;
  }

  function mergeSources(existing, incoming, at) {
    const out = existing.slice();
    for (const s of incoming) {
      if (!s || !s.type) continue;
      if (!out.some((x) => x.type === s.type && (x.detail ?? null) === (s.detail ?? null))) out.push({ type: s.type, detail: s.detail ?? null, at: s.at ?? at });
    }
    return out;
  }

  function upsertPosts(posts, { isSample = false, maxNew = Infinity } = {}) {
    const settings = getSettings();
    const result = { added: 0, merged: 0, skipped: 0 };
    const now = nowIso();
    tx(() => {
      for (const p of posts) {
        const postId = String(p?.postId ?? '').trim();
        if (!/^\d{1,25}$/.test(postId)) {
          result.skipped += 1;
          continue;
        }
        const ex = db.prepare('SELECT * FROM posts WHERE post_id = ?').get(postId);
        if (!ex && result.added >= maxNew) {
          result.skipped += 1;
          continue;
        }
        const pick = (inc, old) => (inc === undefined || inc === null || inc === '' ? old ?? null : inc);
        const handle = pick(typeof p.authorHandle === 'string' ? p.authorHandle.replace(/^@+/, '').trim() || null : null, ex?.author_handle);
        const text = pick(typeof p.text === 'string' ? p.text : null, ex?.text);
        const hint = pick(p.genreHint === 'nightlife' || p.genreHint === 'general' ? p.genreHint : null, ex?.genre_hint);
        const genre = classify({ text, hint }, settings).genre;
        const kws = [...new Set([...(ex ? j(ex.matched_keywords, []) : []), ...(Array.isArray(p.matchedKeywords) ? p.matchedKeywords.filter((x) => typeof x === 'string') : []), ...matchedKeywordsOf(text, settings)])];
        const sources = mergeSources(ex ? j(ex.sources, []) : [], p.source ? [p.source] : [], now);
        const fields = [
          pick(p.url, ex?.url),
          handle,
          pick(p.authorName, ex?.author_name),
          text,
          pick(toIso(p.postedAt), ex?.posted_at),
          genre,
          hint,
          pick(p.lang, ex?.lang),
          JSON.stringify(kws),
          JSON.stringify(sources),
        ];
        if (ex) {
          db.prepare(
            `UPDATE posts SET url=?, author_handle=?, author_name=?, text=?, posted_at=?, genre=?, genre_hint=?, lang=?, matched_keywords=?, sources=?,
             merged_count = merged_count + 1, last_seen_at=?, is_sample = ? WHERE post_id=?`,
          ).run(...fields, now, ex.is_sample && isSample ? 1 : 0, postId);
          result.merged += 1;
        } else {
          db.prepare(
            `INSERT INTO posts(url, author_handle, author_name, text, posted_at, genre, genre_hint, lang, matched_keywords, sources,
             post_id, merged_count, first_seen_at, last_seen_at, is_sample) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
          ).run(...fields, postId, now, now, isSample ? 1 : 0);
          result.added += 1;
        }
        addSnapshot(postId, p.metrics, toIso(p.metricsFetchedAt) ?? now);
      }
    });
    return result;
  }

  function reclassifyAll() {
    const settings = getSettings();
    tx(() => {
      for (const r of db.prepare('SELECT post_id, text, genre_hint, genre FROM posts').all()) {
        const g = classify({ text: r.text, hint: r.genre_hint }, settings).genre;
        if (g !== r.genre) db.prepare('UPDATE posts SET genre = ? WHERE post_id = ?').run(g, r.post_id);
      }
    });
  }

  function deleteSamples() {
    return tx(() => {
      db.exec('DELETE FROM metric_snapshots WHERE post_id IN (SELECT post_id FROM posts WHERE is_sample = 1)');
      const n = db.prepare('DELETE FROM posts WHERE is_sample = 1').run().changes;
      db.exec('DELETE FROM digests WHERE is_sample = 1');
      return Number(n);
    });
  }

  function countSince(sinceIso, genre) {
    return db.prepare('SELECT COUNT(*) AS c FROM posts WHERE is_sample = 0 AND genre = ? AND first_seen_at >= ?').get(genre, sinceIso).c;
  }

  // 興味なし
  function listDismissals({ includeRevoked = false } = {}) {
    const rows = db.prepare(`SELECT * FROM dismissals ${includeRevoked ? '' : 'WHERE revoked_at IS NULL'} ORDER BY id DESC`).all().map(dismissalRow);
    const posts = visiblePosts();
    return rows.map((d) => ({ ...d, matchCount: posts.filter((p) => dismissalMatches(p, d)).length }));
  }
  function getDismissal(id) {
    const r = db.prepare('SELECT * FROM dismissals WHERE id = ?').get(Number(id));
    if (!r) return null;
    const d = dismissalRow(r);
    return { ...d, matchCount: visiblePosts().filter((p) => dismissalMatches(p, d)).length };
  }
  function findActiveDismissal(scope, value) {
    const key = value.toLowerCase();
    return db.prepare('SELECT * FROM dismissals WHERE revoked_at IS NULL AND scope = ?').all(scope).find((r) => r.value.toLowerCase() === key);
  }
  function createDismissal({ scope, value, reasonCode = 'other', reasonNote = '', effect = 'hide' }) {
    if (!SCOPES.includes(scope)) throw httpError(400, '対象の種類（scope）が正しくありません');
    const v = normalizeDismissalValue(scope, value);
    if (!v) throw httpError(400, '対象の値を指定してください');
    if (v.length > 300) throw httpError(400, '対象の値が長すぎます');
    if (!REASONS.includes(reasonCode)) throw httpError(400, '理由コードが正しくありません');
    if (!EFFECTS.includes(effect)) throw httpError(400, '効果は hide か demote を指定してください');
    const note = String(reasonNote ?? '').slice(0, 500);
    const ex = findActiveDismissal(scope, v);
    if (ex) return getDismissal(ex.id);
    const info = db.prepare('INSERT INTO dismissals(scope, value, reason_code, reason_note, effect, created_at) VALUES(?,?,?,?,?,?)').run(scope, v, reasonCode, note, effect, nowIso());
    version += 1;
    return getDismissal(Number(info.lastInsertRowid));
  }
  function setDismissalRevoked(id, revoke) {
    const r = db.prepare('SELECT * FROM dismissals WHERE id = ?').get(Number(id));
    if (!r) throw httpError(404, '興味なし設定が見つかりません');
    if (revoke) {
      if (!r.revoked_at) db.prepare('UPDATE dismissals SET revoked_at = ? WHERE id = ?').run(nowIso(), r.id);
    } else if (r.revoked_at) {
      const other = findActiveDismissal(r.scope, r.value);
      if (other) return getDismissal(other.id);
      db.prepare('UPDATE dismissals SET revoked_at = NULL WHERE id = ?').run(r.id);
    }
    return getDismissal(r.id);
  }

  // まとめ
  const digestRow = (r) => ({ id: r.id, kind: r.kind, periodStart: r.period_start, periodEnd: r.period_end, createdAt: r.created_at, summaryBy: r.summary_by, isSample: !!r.is_sample, title: r.title });
  function insertDigest(d) {
    const info = db
      .prepare('INSERT INTO digests(kind, period_start, period_end, created_at, summary_by, is_sample, title, summary_text, sections) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(d.kind, d.periodStart, d.periodEnd, d.createdAt ?? nowIso(), d.summaryBy, d.isSample ? 1 : 0, d.title, d.summaryText ?? '', JSON.stringify(d.sections ?? []));
    return getDigest(Number(info.lastInsertRowid));
  }
  function listDigests(kind) {
    const rows = kind === 'daily' || kind === 'weekly' ? db.prepare('SELECT * FROM digests WHERE kind = ? ORDER BY created_at DESC, id DESC').all(kind) : db.prepare('SELECT * FROM digests ORDER BY created_at DESC, id DESC').all();
    return rows.map(digestRow);
  }
  function getDigest(id) {
    const r = db.prepare('SELECT * FROM digests WHERE id = ?').get(Number(id));
    return r ? { ...digestRow(r), summaryText: r.summary_text, sections: j(r.sections, []) } : null;
  }
  const digestCount = () => db.prepare('SELECT COUNT(*) AS c FROM digests').get().c;

  // 実行履歴
  const runRow = (r) => ({ id: r.id, job: r.job, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, message: r.message, counts: j(r.counts, {}) });
  function startRun(job, slot = null) {
    try {
      const info = db.prepare('INSERT INTO runs(job, slot, started_at) VALUES(?,?,?)').run(job, slot, nowIso());
      return Number(info.lastInsertRowid);
    } catch (e) {
      if (slot && /UNIQUE/i.test(String(e.message))) return null;
      throw e;
    }
  }
  function finishRun(id, { status, message = '', counts = {} }) {
    db.prepare('UPDATE runs SET finished_at = ?, status = ?, message = ?, counts = ? WHERE id = ?').run(nowIso(), status, message, JSON.stringify(counts), id);
    return getRun(id);
  }
  function getRun(id) {
    const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return r ? runRow(r) : null;
  }
  const listRuns = (limit = 20) => db.prepare('SELECT * FROM runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT ?').all(limit).map(runRow);
  function lastRunsByJob() {
    return db
      .prepare('SELECT * FROM runs WHERE id IN (SELECT MAX(id) FROM runs WHERE finished_at IS NOT NULL GROUP BY job) ORDER BY id DESC')
      .all()
      .map(runRow);
  }
  function runsSince(job, sinceIso) {
    return db.prepare('SELECT * FROM runs WHERE job = ? AND finished_at IS NOT NULL AND started_at >= ?').all(job, sinceIso).map(runRow);
  }

  // バックアップ入出力
  function exportAll() {
    const posts = visiblePostsRaw().map((r) => {
      const p = basePost(r);
      return {
        postId: p.postId,
        url: r.url,
        authorHandle: p.authorHandle,
        authorName: p.authorName,
        text: p.text,
        postedAt: p.postedAt,
        genreHint: r.genre_hint,
        lang: r.lang,
        matchedKeywords: p.matchedKeywords,
        sources: p.sources,
        mergedCount: p.mergedCount,
        firstSeenAt: p.firstSeenAt,
        lastSeenAt: p.lastSeenAt,
        isSample: p.isSample,
        snapshots: db
          .prepare('SELECT views, likes, reposts, replies, bookmarks, fetched_at FROM metric_snapshots WHERE post_id = ? ORDER BY fetched_at, id')
          .all(p.postId)
          .map((s) => ({ views: s.views, likes: s.likes, reposts: s.reposts, replies: s.replies, bookmarks: s.bookmarks, fetchedAt: s.fetched_at })),
      };
    });
    const dismissals = db.prepare('SELECT * FROM dismissals ORDER BY id').all().map(dismissalRow);
    const digests = db.prepare('SELECT id FROM digests ORDER BY id').all().map((r) => getDigest(r.id));
    return { posts, dismissals, digests, sampleDeleted: meta.get('sample_deleted') === '1' };
  }
  const visiblePostsRaw = () => db.prepare(POST_SELECT).all();

  function importAll(data, mode, restoreSettings) {
    const counts = { posts: 0, dismissals: 0, digests: 0, settings: 0 };
    tx(() => {
      if (mode === 'replace') {
        db.exec('DELETE FROM metric_snapshots; DELETE FROM posts; DELETE FROM dismissals; DELETE FROM digests;');
      }
      for (const p of data.posts) {
        const postId = String(p?.postId ?? '');
        if (!/^\d{1,25}$/.test(postId)) continue;
        const ex = db.prepare('SELECT * FROM posts WHERE post_id = ?').get(postId);
        const sources = mergeSources(ex ? j(ex.sources, []) : [], Array.isArray(p.sources) ? p.sources : [], p.firstSeenAt ?? nowIso());
        const kws = [...new Set([...(ex ? j(ex.matched_keywords, []) : []), ...(Array.isArray(p.matchedKeywords) ? p.matchedKeywords : [])])];
        const first = toIso(p.firstSeenAt) ?? nowIso();
        const last = toIso(p.lastSeenAt) ?? first;
        const pick = (inc, old) => (inc === undefined || inc === null ? old ?? null : inc);
        const text = pick(p.text, ex?.text);
        const hint = pick(p.genreHint, ex?.genre_hint);
        const genre = classify({ text, hint }, getSettings()).genre;
        const vals = [pick(p.url, ex?.url), pick(p.authorHandle, ex?.author_handle), pick(p.authorName, ex?.author_name), text, pick(toIso(p.postedAt), ex?.posted_at), genre, hint, pick(p.lang, ex?.lang), JSON.stringify(kws), JSON.stringify(sources)];
        if (ex) {
          db.prepare(
            `UPDATE posts SET url=?, author_handle=?, author_name=?, text=?, posted_at=?, genre=?, genre_hint=?, lang=?, matched_keywords=?, sources=?,
             merged_count=?, first_seen_at=?, last_seen_at=?, is_sample=? WHERE post_id=?`,
          ).run(...vals, Math.max(ex.merged_count, Number(p.mergedCount) || 1), first < ex.first_seen_at ? first : ex.first_seen_at, last > ex.last_seen_at ? last : ex.last_seen_at, ex.is_sample && p.isSample ? 1 : 0, postId);
        } else {
          db.prepare(
            `INSERT INTO posts(url, author_handle, author_name, text, posted_at, genre, genre_hint, lang, matched_keywords, sources,
             post_id, merged_count, first_seen_at, last_seen_at, is_sample) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(...vals, postId, Number(p.mergedCount) || 1, first, last, p.isSample ? 1 : 0);
        }
        for (const s of Array.isArray(p.snapshots) ? p.snapshots : []) {
          const at = toIso(s.fetchedAt) ?? last;
          const vs = METRIC_KEYS.map((k) => toMetric(s[k]));
          if (vs.every((v) => v === null)) continue;
          const dup = db.prepare('SELECT 1 FROM metric_snapshots WHERE post_id=? AND fetched_at=? AND views IS ? AND likes IS ? AND reposts IS ? AND replies IS ? AND bookmarks IS ?').get(postId, at, ...vs);
          if (!dup) insertSnap.run(postId, ...vs, at);
        }
        counts.posts += 1;
      }
      for (const d of Array.isArray(data.dismissals) ? data.dismissals : []) {
        if (!SCOPES.includes(d?.scope) || !d.value) continue;
        const v = normalizeDismissalValue(d.scope, d.value);
        const dup = db.prepare('SELECT 1 FROM dismissals WHERE scope=? AND lower(value)=? AND created_at=?').get(d.scope, v.toLowerCase(), d.createdAt ?? '');
        if (mode === 'merge' && dup) continue;
        db.prepare('INSERT INTO dismissals(scope, value, reason_code, reason_note, effect, created_at, revoked_at) VALUES(?,?,?,?,?,?,?)').run(
          d.scope,
          v,
          REASONS.includes(d.reasonCode) ? d.reasonCode : 'other',
          String(d.reasonNote ?? '').slice(0, 500),
          EFFECTS.includes(d.effect) ? d.effect : 'hide',
          toIso(d.createdAt) ?? nowIso(),
          toIso(d.revokedAt),
        );
        counts.dismissals += 1;
      }
      for (const d of Array.isArray(data.digests) ? data.digests : []) {
        if (!d || !['daily', 'weekly'].includes(d.kind)) continue;
        if (mode === 'merge' && db.prepare('SELECT 1 FROM digests WHERE kind=? AND period_start=? AND period_end=? AND created_at=?').get(d.kind, d.periodStart, d.periodEnd, d.createdAt)) continue;
        insertDigest({ ...d, createdAt: d.createdAt ?? nowIso(), summaryBy: d.summaryBy === 'grok' ? 'grok' : 'rule', title: d.title ?? '(無題)' });
        counts.digests += 1;
      }
      if (mode === 'replace') {
        if (restoreSettings) counts.settings = 1;
        if (data.sampleDeleted) meta.set('sample_deleted', '1');
        else meta.delete('sample_deleted');
      }
    });
    return counts;
  }

  return {
    meta,
    tx,
    realCount,
    sampleCount,
    upsertPosts,
    queryPosts,
    getPost,
    listTopics,
    reclassifyAll,
    deleteSamples,
    countSince,
    listDismissals,
    createDismissal,
    setDismissalRevoked,
    insertDigest,
    listDigests,
    getDigest,
    digestCount,
    startRun,
    finishRun,
    getRun,
    listRuns,
    lastRunsByJob,
    runsSince,
    exportAll,
    importAll,
  };
}
