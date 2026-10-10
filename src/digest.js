import { localParts } from './scheduler.js';

const GENRE_LABEL = { nightlife: '夜職', general: '一般のバズ話題' };
const fmt = (n) => (n === null || n === undefined ? '不明' : n.toLocaleString('ja-JP'));

function groupTopics(posts, maxTopics, perTopic) {
  const groups = new Map();
  for (const p of posts) {
    const key = p.topicId ?? '__other';
    if (!groups.has(key)) groups.set(key, { label: p.topicLabel ?? 'その他の投稿', posts: [] });
    groups.get(key).posts.push(p);
  }
  return [...groups.values()].slice(0, maxTopics).map((g) => ({ label: g.label, posts: g.posts.slice(0, perTopic) }));
}

export function ruleSummary({ kind, periodLabel, sections }) {
  const lines = [`【${kind === 'weekly' ? '週次' : '日次'}まとめ ${periodLabel}】`];
  let any = false;
  for (const s of sections) {
    const all = s.topics.flatMap((t) => t.posts);
    if (!all.length) continue;
    any = true;
    const names = s.topics.slice(0, 3).map((t) => `「${t.label}」（${t.posts.length}件）`).join('、');
    const withLikes = all.filter((p) => p.metrics.likes !== null);
    const best = withLikes.sort((a, b) => b.metrics.likes - a.metrics.likes)[0];
    const unknown = all.length - withLikes.length;
    let line = `${s.genreLabel}：候補内の上位${all.length}件を掲載。話題は${names}。`;
    if (best) line += `最も反応が大きかったのは@${best.authorHandle ?? '不明'}の投稿（いいね${fmt(best.metrics.likes)}）。`;
    if (unknown > 0) line += `指標が不明の投稿が${unknown}件あります。`;
    lines.push(line);
  }
  if (!any) lines.push('対象期間に表示できる投稿がありませんでした。');
  lines.push('※取得した候補内の順位であり、X全体の順位ではありません。');
  return lines.join('\n');
}

export function createDigest({ store, settings, getIntegrations, clock, fetchImpl = globalThis.fetch }) {
  async function generate(kind, { offline = false } = {}) {
    if (kind !== 'daily' && kind !== 'weekly') throw Object.assign(new Error('まとめの種類が正しくありません'), { status: 400 });
    const s = settings.get();
    const tz = s.schedule.timezone;
    const end = clock();
    const days = kind === 'daily' ? 1 : 7;
    const start = new Date(end.getTime() - days * 86400000);
    const period = kind === 'daily' ? 'day' : 'week';
    const periodLabel = kind === 'daily' ? localParts(end, tz).ymd : `${localParts(start, tz).ymd}〜${localParts(end, tz).ymd}`;

    const night = store.queryPosts({ genre: 'nightlife', sort: 'score', period, limit: 500 }).items;
    const general = store.queryPosts({ genre: 'general', sort: 'score', period, limit: 500 }).items;
    let nightLimit;
    let genLimit;
    if (kind === 'daily') {
      nightLimit = 12;
      genLimit = Math.max(1, s.targets.generalTopicsPerDay) * Math.max(1, s.targets.generalPostsPerTopic);
    } else {
      const total = s.schedule.weeklyDigest.postCount;
      nightLimit = Math.max(1, Math.ceil(total * 0.7));
      genLimit = Math.max(1, total - nightLimit);
    }
    const sections = [];
    const nightPosts = night.slice(0, nightLimit);
    if (nightPosts.length) sections.push({ genre: 'nightlife', genreLabel: GENRE_LABEL.nightlife, topics: groupTopics(nightPosts, 10, nightLimit) });
    const genTopics = groupTopics(general, kind === 'daily' ? Math.max(1, s.targets.generalTopicsPerDay) : Math.max(3, s.targets.generalTopicsPerDay * 2), Math.max(1, s.targets.generalPostsPerTopic));
    let used = 0;
    const trimmed = [];
    for (const t of genTopics) {
      const room = genLimit - used;
      if (room <= 0) break;
      const ps = t.posts.slice(0, room);
      used += ps.length;
      trimmed.push({ label: t.label, posts: ps });
    }
    if (trimmed.length) sections.push({ genre: 'general', genreLabel: GENRE_LABEL.general, topics: trimmed });

    const input = { kind, periodLabel, sections };
    let summaryText = null;
    let summaryBy = 'rule';
    const { grok } = getIntegrations();
    if (!offline && s.sources.grok.enabled && s.sources.grok.useForSummary && grok.isConfigured() && sections.length) {
      try {
        const r = await grok.summarize({
          kind,
          periodLabel,
          sections: sections.map((sec) => ({ genre: sec.genre, genreLabel: sec.genreLabel, topics: sec.topics.map((t) => ({ label: t.label, posts: t.posts.map((p) => ({ text: p.text, url: p.url, metrics: p.metrics })) })) })),
        });
        if (r && r.text && !r.error) {
          summaryText = String(r.text);
          summaryBy = 'grok';
        }
      } catch {
        /* ルールベースにフォールバック */
      }
    }
    if (!summaryText) summaryText = ruleSummary(input);

    const all = sections.flatMap((x) => x.topics.flatMap((t) => t.posts));
    const digest = store.insertDigest({
      kind,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      createdAt: end.toISOString(),
      summaryBy,
      isSample: all.length > 0 && all.every((p) => p.isSample),
      title: `${kind === 'daily' ? '日次' : '週次'}まとめ ${periodLabel}`,
      summaryText,
      sections,
    });

    let delivery = null;
    if (!offline && s.delivery.method === 'webhook' && s.delivery.webhookUrl) {
      try {
        const res = await fetchImpl(s.delivery.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: digest.title, kind, periodStart: digest.periodStart, periodEnd: digest.periodEnd, summaryBy, summaryText }),
          signal: AbortSignal.timeout(10000),
        });
        delivery = res.ok ? 'sent' : `failed:${res.status}`;
      } catch {
        delivery = 'failed';
      }
    }
    return { digest, postCount: all.length, delivery };
  }
  return { generate };
}
