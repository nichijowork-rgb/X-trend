import { classify } from './genre.js';
import { TOPIC_DETAIL_PREFIX } from './topics.js';
import { startOfLocalDay, localParts } from './scheduler.js';
import { httpError } from './store.js';

export const JOB_NAMES = ['collect', 'daily_digest', 'weekly_digest', 'backup'];

const INERT_XAPI = { isConfigured: () => ({ search: false, home: false }), searchRecent: async () => ({ posts: [] }), homeTimeline: async () => ({ posts: [] }), lookup: async () => ({ posts: [] }) };
const INERT_GROK = { isConfigured: () => false, searchX: async () => ({ posts: [] }), summarize: async () => ({ text: '' }), suggestTopics: async () => ({ topics: [] }) };

// integrations: { xapi, grok, url, importers, bookmarklet }。xapi/grok は実体でも settings を受ける関数でも可。
export function resolveIntegrations(integrations = {}, settings) {
  const pick = (v, inert) => {
    const x = typeof v === 'function' ? v(settings) : v;
    return x || inert;
  };
  return { ...integrations, xapi: pick(integrations.xapi, INERT_XAPI), grok: pick(integrations.grok, INERT_GROK) };
}

export function createJobs({ store, settings, integrations, clock, digest, backup }) {
  const running = new Set();
  const getInt = () => resolveIntegrations(integrations, settings.get());

  async function collect() {
    const s = settings.get();
    const { xapi, grok } = getInt();
    const xc = xapi.isConfigured();
    const useX = s.sources.xSearch.enabled && !!xc.search;
    const useHome = s.sources.xHome.enabled && !!xc.home;
    const useGrok = s.sources.grok.enabled && s.sources.grok.useForSearch && !!grok.isConfigured();
    if (!useX && !useHome && !useGrok) {
      const why = [];
      if (!xc.search) why.push('X API（検索）が未接続');
      else if (!s.sources.xSearch.enabled) why.push('X API検索が無効');
      if (!grok.isConfigured()) why.push('Grokが未接続');
      else if (!s.sources.grok.enabled || !s.sources.grok.useForSearch) why.push('Grok検索が無効');
      return { status: 'skipped', message: `収集できる接続先がないためスキップしました（${why.join('、')}）。URL保存や取り込みは利用できます。`, counts: {} };
    }

    const now = clock();
    const tz = s.schedule.timezone;
    const dayStart = startOfLocalDay(now, tz).toISOString();
    const ym = localParts(now, tz).ymd.slice(0, 7);
    const capKey = `xapi_reads:${ym}`;
    const cap = s.budget.xApiMonthlyReadCap;
    const totals = { added: 0, merged: 0, skipped: 0, nightlifeAdded: 0, generalAdded: 0, generalTopics: 0 };
    const errors = [];
    const notes = [];
    let xStopped = false;

    const countX = (n) => store.meta.set(capKey, Number(store.meta.get(capKey) || 0) + n);
    const capReached = () => cap !== null && Number(store.meta.get(capKey) || 0) >= cap;

    const prepare = (posts, hint, detail) =>
      (posts || [])
        .map((p) => ({ ...p, genreHint: hint ?? p.genreHint ?? null, source: detail ? { ...(p.source || { type: 'grok_x_search' }), detail } : p.source }))
        .filter((p) => !classify({ text: p.text, hint: p.genreHint }, s).excluded);

    const ingest = (posts, opts) => {
      const r = store.upsertPosts(posts, opts);
      totals.added += r.added;
      totals.merged += r.merged;
      totals.skipped += r.skipped;
      return r;
    };

    const callX = async (fn, args) => {
      if (xStopped) return { posts: [] };
      if (capReached()) {
        xStopped = true;
        notes.push('X APIの月間読み取り上限に達したため以降のX API呼び出しを止めました');
        return { posts: [] };
      }
      const r = await fn(args);
      countX((r.posts || []).length);
      if (r.error) errors.push(r.error);
      if (r.rateLimit && r.rateLimit.remaining === 0) {
        xStopped = true;
        notes.push('X APIのレート制限に達したため以降の呼び出しを止めました');
      }
      return r;
    };
    const callGrok = async (args) => {
      const r = await grok.searchX(args);
      if (r.error) errors.push(r.error);
      return r;
    };
    const excl = s.excludeTerms.map((t) => `-"${t}"`).join(' ');

    // 夜職
    const max = s.targets.nightlifePerDay.max;
    let remaining = max - store.countSince(dayStart, 'nightlife');
    if (remaining <= 0) notes.push(`夜職は本日の上限（${max}件）に達しているため収集しませんでした`);
    for (const kw of s.keywords.nightlife) {
      if (remaining <= 0) break;
      if (useX) {
        const r = await callX((a) => xapi.searchRecent(a), { query: `${kw} -is:retweet ${excl}`.trim(), maxResults: s.sources.xSearch.maxPerQuery });
        const res = ingest(prepare(r.posts, 'nightlife'), { maxNew: remaining });
        remaining -= res.added;
        totals.nightlifeAdded += res.added;
      }
      if (useGrok && remaining > 0) {
        const r = await callGrok({ query: kw, maxResults: s.sources.xSearch.maxPerQuery });
        const res = ingest(prepare(r.posts, 'nightlife'), { maxNew: remaining });
        remaining -= res.added;
        totals.nightlifeAdded += res.added;
      }
    }

    // 一般
    const perTopic = s.targets.generalPostsPerTopic;
    if (useGrok && s.targets.generalTopicsPerDay > 0 && perTopic > 0) {
      const done = store.runsSince('collect', dayStart).reduce((n, r) => n + (r.counts?.generalTopics || 0), 0);
      const need = s.targets.generalTopicsPerDay - done;
      if (need > 0) {
        const sug = await grok.suggestTopics({ genre: 'general', count: need });
        if (sug.error) errors.push(sug.error);
        for (const t of (sug.topics || []).slice(0, need)) {
          if (!t?.label) continue;
          const r = await callGrok({ query: t.query || t.label, maxResults: perTopic * 2 });
          const posts = prepare(r.posts, 'general', `${TOPIC_DETAIL_PREFIX}${t.label}`).slice(0, perTopic);
          const res = ingest(posts, {});
          totals.generalAdded += res.added;
          if (posts.length) totals.generalTopics += 1;
        }
      }
    } else if (!useGrok && s.targets.generalTopicsPerDay > 0) {
      notes.push('一般のバズ話題はGrok未接続のため収集しませんでした');
    }
    for (const kw of s.keywords.general) {
      if (useX) {
        const r = await callX((a) => xapi.searchRecent(a), { query: `${kw} -is:retweet ${excl}`.trim(), maxResults: s.sources.xSearch.maxPerQuery });
        totals.generalAdded += ingest(prepare(r.posts, 'general'), {}).added;
      }
      if (useGrok) {
        const r = await callGrok({ query: kw, maxResults: s.sources.xSearch.maxPerQuery });
        totals.generalAdded += ingest(prepare(r.posts, 'general'), {}).added;
      }
    }

    if (useHome) {
      const r = await callX((a) => xapi.homeTimeline(a), { maxResults: s.sources.xHome.maxResults });
      ingest(prepare(r.posts, null), {});
    }

    const uniqErrors = [...new Set(errors)];
    const failedAll = uniqErrors.length > 0 && totals.added + totals.merged === 0;
    const parts = [`新規${totals.added}件・統合${totals.merged}件（夜職${totals.nightlifeAdded}件／一般${totals.generalAdded}件）`];
    if (notes.length) parts.push(notes.join('。'));
    if (uniqErrors.length) parts.push(`エラー: ${uniqErrors.slice(0, 3).join(' / ')}`);
    return { status: failedAll ? 'error' : 'ok', message: parts.join('。'), counts: { ...totals, errors: uniqErrors.length } };
  }

  async function runDigest(kind) {
    const r = await digest.generate(kind);
    const label = kind === 'daily' ? '日次' : '週次';
    let msg = `${label}まとめを作成しました（${r.postCount}件、要約: ${r.digest.summaryBy === 'grok' ? 'Grok' : 'ルールベース'}）`;
    if (r.delivery === 'sent') msg += '。Webhookへ送信しました';
    else if (r.delivery) msg += '。Webhook送信に失敗しました';
    return { status: 'ok', message: msg, counts: { posts: r.postCount, digestId: r.digest.id } };
  }

  async function doBackup() {
    const keep = settings.get().schedule.autoBackup.keep;
    const r = backup.createAutoBackup(keep);
    return { status: 'ok', message: `バックアップを作成しました（${r.name}）`, counts: { size: r.size, pruned: r.pruned } };
  }

  const IMPL = { collect, daily_digest: () => runDigest('daily'), weekly_digest: () => runDigest('weekly'), backup: doBackup };

  // slot 指定時は同じスロットを一度しか実行しない（再起動後も）。重複なら null。
  async function run(job, { slot = null } = {}) {
    if (!JOB_NAMES.includes(job)) throw httpError(400, 'ジョブ名が正しくありません');
    const id = store.startRun(job, slot);
    if (id === null) return null;
    if (running.has(job)) return store.finishRun(id, { status: 'skipped', message: '同じジョブが実行中のためスキップしました' });
    running.add(job);
    try {
      const r = await IMPL[job]();
      return store.finishRun(id, r);
    } catch (e) {
      return store.finishRun(id, { status: 'error', message: `実行中にエラーが発生しました: ${String(e?.message ?? e).slice(0, 200)}` });
    } finally {
      running.delete(job);
    }
  }

  return { run };
}
