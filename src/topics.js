const GENERIC_TAGS = new Set(['ホスト', 'キャバクラ', '歌舞伎町', 'ホストクラブ', 'キャバ嬢', 'ラウンジ', '夜職', 'pr', 'rt', 'fyp']);
export const TOPIC_DETAIL_PREFIX = 'トピック: ';

function normText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@\w+/g, ' ')
    .replace(/#[^\s#]+/g, ' ')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}
function bigrams(s) {
  const set = new Set();
  if (s.length === 1) set.add(s);
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
export function hashtagsOf(text) {
  const out = new Set();
  for (const m of String(text ?? '').normalize('NFKC').matchAll(/#([^\s#]+)/g)) out.add(m[1].toLowerCase());
  return out;
}
const cmpId = (a, b) => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0);

// posts: [{ postId, text, sources?, matchedKeywords? }] -> [{ id, label, postIds, keywords, labeled }]
export function clusterPosts(posts, { textThreshold = 0.4, tagThreshold = 0.12 } = {}) {
  const list = posts.slice().sort((a, b) => cmpId(a.postId, b.postId));
  const n = list.length;
  const parent = list.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };
  const grams = list.map((p) => bigrams(normText(p.text)));
  const tags = list.map((p) => [...hashtagsOf(p.text)].filter((t) => !GENERIC_TAGS.has(t) && t.length >= 2));
  const labelOf = list.map((p) => {
    const s = (p.sources || []).find((x) => typeof x.detail === 'string' && x.detail.startsWith(TOPIC_DETAIL_PREFIX));
    return s ? s.detail.slice(TOPIC_DETAIL_PREFIX.length).trim() : null;
  });

  const byLabel = new Map();
  const byTag = new Map();
  for (let i = 0; i < n; i++) {
    if (labelOf[i]) {
      if (byLabel.has(labelOf[i])) union(byLabel.get(labelOf[i]), i);
      else byLabel.set(labelOf[i], i);
    }
    for (const t of tags[i]) {
      if (!byTag.has(t)) byTag.set(t, []);
      byTag.get(t).push(i);
    }
  }
  for (const members of byTag.values()) {
    const m = members.slice(0, 200);
    for (let x = 0; x < m.length; x++) for (let y = x + 1; y < m.length; y++) if (jaccard(grams[m[x]], grams[m[y]]) >= tagThreshold) union(m[x], m[y]);
  }
  for (let i = 0; i < n; i++) {
    if (grams[i].size < 4) continue;
    for (let j = i + 1; j < n; j++) {
      if (grams[j].size < 4 || find(i) === find(j)) continue;
      const a = grams[i].size;
      const b = grams[j].size;
      if (Math.min(a, b) / Math.max(a, b) < textThreshold) continue;
      if (jaccard(grams[i], grams[j]) >= textThreshold) union(i, j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  const clusters = [];
  for (const idxs of groups.values()) {
    const labels = idxs.map((i) => labelOf[i]).filter(Boolean);
    const tagCount = new Map();
    const kwCount = new Map();
    for (const i of idxs) {
      for (const t of tags[i]) tagCount.set(t, (tagCount.get(t) || 0) + 1);
      for (const k of list[i].matchedKeywords || []) kwCount.set(k, (kwCount.get(k) || 0) + 1);
    }
    const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k]) => k);
    const topTags = top(tagCount);
    let label = labels[0] || null;
    if (!label && idxs.length > 1 && topTags.length && tagCount.get(topTags[0]) >= 2) label = `#${topTags[0]}`;
    if (!label) {
      const t = String(list[idxs[0]].text ?? '').replace(/\s+/g, ' ').trim();
      label = t ? (t.length > 28 ? `${t.slice(0, 28)}…` : t) : '(本文なし)';
    }
    clusters.push({
      id: `t_${list[idxs[0]].postId}`,
      label,
      postIds: idxs.map((i) => list[i].postId),
      keywords: [...topTags.map((t) => `#${t}`), ...top(kwCount)].slice(0, 6),
      labeled: labels.length > 0,
    });
  }
  return clusters;
}
