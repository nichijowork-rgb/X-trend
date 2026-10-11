// Xレポート ダッシュボード — 純粋関数（DOM 非依存）
// ブラウザ（ES module）と Node（node:test）の両方から import される。
// ここには document / window / fetch を一切書かないこと。

export const METRIC_KEYS = [
  'impression_count', 'like_count', 'retweet_count', 'reply_count', 'quote_count', 'bookmark_count',
];

export const METRIC_LABELS = {
  impression_count: '表示',
  like_count: 'いいね',
  retweet_count: 'RP',
  reply_count: '返信',
  quote_count: '引用',
  bookmark_count: 'ブクマ',
};

export const PERIODS = [
  { key: '24h', label: '24時間', seconds: 86400 },
  { key: '7d', label: '7日', seconds: 7 * 86400 },
  { key: '30d', label: '30日', seconds: 30 * 86400 },
  { key: 'all', label: 'すべて', seconds: null },
];

export const SORTS = [
  { key: 'new', label: '新しい順', metric: null },
  { key: 'imp', label: 'インプレッション', metric: 'impression_count' },
  { key: 'like', label: 'いいね', metric: 'like_count' },
  { key: 'bookmark', label: 'ブックマーク', metric: 'bookmark_count' },
  { key: 'pace', label: '伸びペース（1時間あたり表示）', metric: null, pace: true },
];

export const ACCOUNT_SORTS = [
  { key: 'posts', label: '投稿数順' },
  { key: 'imp', label: 'インプレッション順' },
];

/** 「すべて」選択時に日別グラフへ載せる日数 */
export const CHART_MAX_DAYS = 90;

export const UNKNOWN = '不明';

const JST_OFFSET = 9 * 3600;

// ---------------------------------------------------------------- 数値

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function withCommas(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function trimZero(s) {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** 正確値（カンマ区切り）。欠損は「不明」 */
export function formatExact(n) {
  if (!isNum(n)) return UNKNOWN;
  const sign = n < 0 ? '-' : '';
  return sign + withCommas(String(Math.round(Math.abs(n))));
}

/**
 * 万・億表記。1万未満はカンマ区切り。
 * 1155424 → "115.5万" / 123456789 → "1.2億" / 9999 → "9,999" / null → "不明"
 */
export function formatCompact(n) {
  if (!isNum(n)) return UNKNOWN;
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a < 1e4) return sign + withCommas(String(Math.round(a)));
  const man = Math.round(a / 1e3) / 10; // 小数1桁の「万」
  if (a >= 1e8 || man >= 10000) {
    const oku = Math.round(a / 1e7) / 10;
    const [i, f] = trimZero(oku.toFixed(1)).split('.');
    return sign + withCommas(i) + (f ? '.' + f : '') + '億';
  }
  return sign + trimZero(man.toFixed(1)) + '万';
}

// ---------------------------------------------------------------- 日時

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** UNIX 秒 → JST の {y,m,d,hh,mm} */
export function jstParts(ts) {
  if (!isNum(ts)) return null;
  const d = new Date((ts + JST_OFFSET) * 1000);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    hh: d.getUTCHours(), mm: d.getUTCMinutes(),
  };
}

/** "2026-10-11T13:34:05+09:00" / "2026-10-11 13:34" などから JST の壁時計値を取り出す */
export function parseJstString(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})/.exec(s.trim());
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3], hh: +m[4], mm: +m[5] };
}

/** ISO 風文字列 → UNIX 秒（タイムゾーン無しは JST とみなす） */
export function parseTimestamp(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  const str = s.trim();
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(str)) {
    const t = Date.parse(str.replace(' ', 'T'));
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  }
  const p = parseJstString(str);
  if (!p) return null;
  return Math.floor(Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) / 1000) - JST_OFFSET;
}

/**
 * 表示用日時「10/11 13:34」。created_jst を優先し、無ければ ts から JST で算出。
 * refYear（データの最新年）と年が違う場合のみ「2016/3/4 10:00」と年を付ける。
 */
export function formatDateTime(createdJst, ts, refYear = null) {
  const p = parseJstString(createdJst) || jstParts(ts);
  if (!p) return UNKNOWN;
  const base = `${p.m}/${p.d} ${pad2(p.hh)}:${pad2(p.mm)}`;
  return refYear != null && p.y !== refYear ? `${p.y}/${base}` : base;
}

/** title 属性用の完全な日時 */
export function formatDateTimeFull(createdJst, ts) {
  const p = parseJstString(createdJst) || jstParts(ts);
  if (!p) return UNKNOWN;
  return `${p.y}/${pad2(p.m)}/${pad2(p.d)} ${pad2(p.hh)}:${pad2(p.mm)} JST`;
}

/** UNIX 秒 → JST の日付キー "YYYY-MM-DD" */
export function dateKeyFromTs(ts) {
  const p = jstParts(ts);
  return p ? `${p.y}-${pad2(p.m)}-${pad2(p.d)}` : null;
}

/** "YYYY-MM-DD" に n 日加算 */
export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** "YYYY-MM-DD" → "10/11" */
export function shortDate(key) {
  const [, m, d] = key.split('-').map(Number);
  return `${m}/${d}`;
}

// ---------------------------------------------------------------- データ正規化

function toMetric(v) {
  if (isNum(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null; // null・キー欠落・不正値はすべて「不明」
}

export function searchKey(s) {
  return String(s).normalize('NFKC').toLowerCase();
}

/**
 * posts.json を検証・正規化する。不正な形式なら例外。
 * カテゴリ一覧は categories 配列 ＋ 投稿内に現れたカテゴリ（出現順）から動的生成する。
 */
export function normalizeDataset(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.posts)) {
    throw new Error('posts.json の形式が不正です（posts 配列がありません）');
  }
  const categories = [];
  const seen = new Set();
  const addCat = (c) => {
    if (typeof c !== 'string') return;
    const name = c.trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    categories.push(name);
  };
  if (Array.isArray(raw.categories)) raw.categories.forEach(addCat);

  const posts = [];
  let latestPostTs = null;
  let minTs = null;
  for (const p of raw.posts) {
    if (!p || typeof p !== 'object') continue;
    const createdJst = typeof p.created_jst === 'string' && p.created_jst.trim() ? p.created_jst : null;
    let ts = isNum(p.ts) ? p.ts : (typeof p.ts === 'string' && /^\d+$/.test(p.ts) ? Number(p.ts) : null);
    if (ts == null) ts = parseTimestamp(createdJst);
    const metricsSrc = p.metrics && typeof p.metrics === 'object' ? p.metrics : {};
    const metrics = {};
    for (const k of METRIC_KEYS) metrics[k] = toMetric(metricsSrc[k]);
    let cats = Array.isArray(p.categories)
      ? [...new Set(p.categories.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim()))]
      : [];
    if (!cats.length) cats = ['その他'];
    cats.forEach(addCat);
    const text = typeof p.text === 'string' ? p.text : '';
    const user = String(p.user ?? '').replace(/^@/, '');
    const terms = Array.isArray(p.matched_terms)
      ? p.matched_terms.filter((t) => typeof t === 'string' && t.trim())
      : [];
    const post = {
      id: String(p.id ?? ''),
      url: typeof p.url === 'string' ? p.url : '',
      user,
      created_jst: createdJst,
      ts,
      metrics,
      text,
      categories: cats,
      matched_terms: terms,
      is_watched: p.is_watched === true,
      media: sanitizeMedia(p.media),
      _search: searchKey(text + '\n' + user),
      _userKey: user.toLowerCase(),
      _day: dateKeyFromTs(ts),
    };
    if (ts != null) {
      if (latestPostTs == null || ts > latestPostTs) latestPostTs = ts;
      if (minTs == null || ts < minTs) minTs = ts;
    }
    posts.push(post);
  }
  // 新しい順（安定ソート。ts 欠損は末尾）
  posts.sort((a, b) => (b.ts ?? -Infinity) - (a.ts ?? -Infinity));
  return {
    generated_at: typeof raw.generated_at === 'string' ? raw.generated_at : null,
    categories,
    posts,
    ...chooseRefTs(typeof raw.generated_at === 'string' ? raw.generated_at : null, latestPostTs),
    latestPostTs,
    minTs,
  };
}

/**
 * 期間フィルタ・伸びペースの基準時刻。generated_at を優先し、無ければ最新投稿の ts。
 * 返り値: { refTs, refSource: 'generated_at' | 'latest_post' | null }
 */
export function chooseRefTs(generatedAt, latestPostTs) {
  const g = parseTimestamp(generatedAt);
  if (g != null) return { refTs: g, refSource: 'generated_at' };
  if (isNum(latestPostTs)) return { refTs: latestPostTs, refSource: 'latest_post' };
  return { refTs: null, refSource: null };
}

// ---------------------------------------------------------------- 更新スケジュール

/**
 * generatedTs の後に来る最初の定時更新（JST の hour:minute）の UNIX 秒。
 * 例: 10/11 18:41 → 10/11 23:59、10/11 23:59:30 → 10/12 23:59、10/11 23:50（定時直前の生成）→ 10/12 23:59
 */
export function nextScheduledUpdate(generatedTs, daily) {
  if (!isNum(generatedTs) || !daily) return null;
  const p = jstParts(generatedTs);
  let t = Math.floor(Date.UTC(p.y, p.m - 1, p.d, daily.hour, daily.minute) / 1000) - JST_OFFSET;
  // 定時の少し前（earlyMinutes 以内）に生成されたものはその回の更新とみなし、次は翌日
  const early = (daily.earlyMinutes ?? 30) * 60;
  if (t - generatedTs < early) t += 86400;
  return t;
}

/** 次の定時更新＋猶予を過ぎても更新されていなければ true（nowTs は呼び出し側が現在時刻を渡す） */
export function isUpdateDelayed(generatedTs, nowTs, schedule) {
  const next = nextScheduledUpdate(generatedTs, schedule && schedule.daily);
  if (next == null || !isNum(nowTs)) return false;
  return nowTs > next + (schedule.delayGraceHours || 0) * 3600;
}

// ---------------------------------------------------------------- 伸びペース

/**
 * 1時間あたりの表示数 = impression_count ÷ (基準時刻 − ts の時間数)。経過1時間未満は1時間として計算。
 * 不明（impression_count や ts が無い）なら null。
 */
export function viewsPerHour(post, refTs) {
  const imp = post && post.metrics ? post.metrics.impression_count : null;
  if (!isNum(imp) || !isNum(post.ts) || !isNum(refTs)) return null;
  const hours = Math.max(1, (refTs - post.ts) / 3600);
  return { hours, views: imp, perHour: imp / hours };
}

function formatElapsed(hours) {
  if (hours < 1) return '1時間未満';
  if (hours < 48) return `${Math.floor(hours)}時間`;
  return `${Math.floor(hours / 24)}日`;
}

/** 「投稿から3時間で38.2万表示（1時間あたり12.7万）」。不明なら「伸びペース：不明」 */
export function formatPace(post, refTs) {
  const v = viewsPerHour(post, refTs);
  if (!v) return `伸びペース：${UNKNOWN}`;
  const elapsed = isNum(refTs) && isNum(post.ts) ? (refTs - post.ts) / 3600 : v.hours;
  return `投稿から${formatElapsed(elapsed)}で${formatCompact(v.views)}表示（1時間あたり${formatCompact(v.perHour)}）`;
}

// ---------------------------------------------------------------- フィルタ・並べ替え

export const VIEWS = [
  { key: 'card', label: 'カード' },
  { key: 'embed', label: 'X埋め込み' },
];

export const DEFAULT_STATE = Object.freeze({
  cats: [], period: 'all', user: '', q: '', watched: false, sort: 'new', acct: 'posts', view: 'card',
});

/** キーワードを空白（全角含む）で分割。AND 検索用 */
export function parseKeywords(q) {
  if (typeof q !== 'string') return [];
  return searchKey(q).split(/\s+/u).filter(Boolean);
}

export function periodSeconds(key) {
  const p = PERIODS.find((x) => x.key === key);
  return p ? p.seconds : null;
}

/**
 * 絞り込み。期間は基準時刻 refTs（generated_at 優先、無ければ最新投稿）基準。
 * opts.ignoreCategories=true でカテゴリ条件だけ外す（チップの件数表示用）。
 */
export function filterPosts(posts, state, refTs, opts = {}) {
  const st = { ...DEFAULT_STATE, ...state };
  const terms = parseKeywords(st.q);
  const cats = opts.ignoreCategories ? null : (st.cats.length ? new Set(st.cats) : null);
  const user = st.user ? st.user.replace(/^@/, '').toLowerCase() : '';
  const sec = periodSeconds(st.period);
  const since = sec != null && refTs != null ? refTs - sec : null;
  const out = [];
  for (const p of posts) {
    if (since != null && (p.ts == null || p.ts <= since)) continue;
    if (st.watched && !p.is_watched) continue;
    if (user && p._userKey !== user) continue;
    if (cats && !p.categories.some((c) => cats.has(c))) continue; // OR
    if (terms.length) {
      let ok = true;
      for (const t of terms) if (!p._search.includes(t)) { ok = false; break; } // AND
      if (!ok) continue;
    }
    out.push(p);
  }
  return out;
}

/** 並べ替え。欠損指標は末尾、同値は新しい順。伸びペース順は refTs が必要 */
export function sortPosts(posts, sortKey, refTs = null) {
  const s = SORTS.find((x) => x.key === sortKey) || SORTS[0];
  const arr = posts.slice();
  const byTs = (a, b) => (b.ts ?? -Infinity) - (a.ts ?? -Infinity) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  if (!s.metric && !s.pace) return arr.sort(byTs);
  const k = s.metric;
  const val = s.pace
    ? (() => { const m = new Map(); for (const p of arr) { const v = viewsPerHour(p, refTs); m.set(p, v ? v.perHour : null); } return (p) => m.get(p); })()
    : (p) => p.metrics[k];
  return arr.sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (va == null && vb == null) return byTs(a, b);
    if (va == null) return 1;
    if (vb == null) return -1;
    return vb - va || byTs(a, b);
  });
}

export function isFilterActive(state) {
  const st = { ...DEFAULT_STATE, ...state };
  return st.cats.length > 0 || st.period !== 'all' || !!st.user || !!st.q.trim() || st.watched;
}

// ---------------------------------------------------------------- 集計

function sumBox() {
  return { sum: 0, unknown: 0 };
}

function addTo(box, v) {
  if (v == null) box.unknown += 1;
  else box.sum += v;
}

/**
 * 投稿の配列からサマリー・カテゴリ別・アカウント別・日別を集計する。
 * 合計は既知値のみ。unknown に欠損件数を持つ（「一部不明」注記用）。
 */
export function aggregate(posts, categories = []) {
  const byCat = new Map();
  for (const c of categories) byCat.set(c, { posts: 0, impressions: sumBox(), likes: sumBox() });
  const byAcc = new Map();
  const byDay = new Map();
  const impressions = sumBox();
  const likes = sumBox();
  let maxImp = null;
  for (const p of posts) {
    const imp = p.metrics.impression_count;
    const lk = p.metrics.like_count;
    addTo(impressions, imp);
    addTo(likes, lk);
    if (imp != null && (!maxImp || imp > maxImp.metrics.impression_count)) maxImp = p;
    for (const c of p.categories) {
      let e = byCat.get(c);
      if (!e) { e = { posts: 0, impressions: sumBox(), likes: sumBox() }; byCat.set(c, e); }
      e.posts += 1;
      addTo(e.impressions, imp);
      addTo(e.likes, lk);
    }
    let a = byAcc.get(p.user);
    if (!a) {
      a = { user: p.user, is_watched: false, posts: 0, impressions: sumBox(), likes: sumBox() };
      byAcc.set(p.user, a);
    }
    a.posts += 1;
    a.is_watched = a.is_watched || p.is_watched;
    addTo(a.impressions, imp);
    addTo(a.likes, lk);
    if (p._day) {
      let d = byDay.get(p._day);
      if (!d) { d = { date: p._day, posts: 0, impressions: 0, likes: 0, categories: {} }; byDay.set(p._day, d); }
      d.posts += 1;
      d.impressions += imp ?? 0;
      d.likes += lk ?? 0;
      for (const c of p.categories) d.categories[c] = (d.categories[c] || 0) + 1;
    }
  }
  return {
    source: 'client',
    totalPosts: posts.length,
    totalAccounts: byAcc.size,
    impressions,
    likes,
    maxImp,
    byCategory: [...byCat].map(([name, v]) => ({ name, ...v })),
    byAccount: [...byAcc.values()],
    byDay: [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

function numOrNull(v) {
  return isNum(v) ? v : null;
}

/** summary.json の最低限の形式チェック */
export function isValidSummary(s) {
  return !!s && typeof s === 'object' && !Array.isArray(s)
    && isNum(s.total_posts)
    && s.by_category && typeof s.by_category === 'object' && !Array.isArray(s.by_category)
    && Array.isArray(s.by_account) && Array.isArray(s.by_day);
}

/**
 * フィルタ無しのときに summary.json の値でクライアント集計を上書きする。
 * 投稿数が posts.json と食い違う（更新タイミングのずれ等）場合や形式不正なら clientAgg をそのまま返す。
 * 欠損件数（unknown）は投稿から数えた値を使う（summary には無い情報のため）。
 */
export function mergeSummary(clientAgg, summary, postsById) {
  if (!isValidSummary(summary) || summary.total_posts !== clientAgg.totalPosts) return clientAgg;
  try {
    const byCategory = clientAgg.byCategory.map((c) => {
      const s = summary.by_category[c.name];
      if (!s || typeof s !== 'object') return c;
      return {
        name: c.name,
        posts: numOrNull(s.posts) ?? c.posts,
        impressions: { sum: numOrNull(s.impressions) ?? c.impressions.sum, unknown: c.impressions.unknown },
        likes: { sum: numOrNull(s.likes) ?? c.likes.sum, unknown: c.likes.unknown },
      };
    });
    const unknownByUser = new Map(clientAgg.byAccount.map((a) => [a.user, a]));
    const byAccount = summary.by_account
      .filter((a) => a && typeof a.user === 'string')
      .map((a) => {
        const c = unknownByUser.get(a.user);
        return {
          user: a.user,
          is_watched: a.is_watched === true,
          posts: numOrNull(a.posts) ?? (c ? c.posts : 0),
          impressions: { sum: numOrNull(a.impressions) ?? (c ? c.impressions.sum : 0), unknown: c ? c.impressions.unknown : 0 },
          likes: { sum: numOrNull(a.likes) ?? (c ? c.likes.sum : 0), unknown: c ? c.likes.unknown : 0 },
        };
      });
    const byDay = summary.by_day
      .filter((d) => d && typeof d.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date))
      .map((d) => ({
        date: d.date,
        posts: numOrNull(d.posts) ?? 0,
        impressions: numOrNull(d.impressions) ?? 0,
        likes: numOrNull(d.likes) ?? 0,
        categories: d.categories && typeof d.categories === 'object' ? { ...d.categories } : {},
      }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    let impSum = 0;
    for (const a of byAccount) impSum += a.impressions.sum;
    let likeSum = 0;
    for (const a of byAccount) likeSum += a.likes.sum;
    let maxImp = clientAgg.maxImp;
    const top = summary.top_posts && Array.isArray(summary.top_posts.by_impressions) ? summary.top_posts.by_impressions[0] : null;
    if (top && top.id != null && postsById && postsById.has(String(top.id))) maxImp = postsById.get(String(top.id));
    return {
      source: 'summary',
      totalPosts: summary.total_posts,
      totalAccounts: numOrNull(summary.total_accounts) ?? clientAgg.totalAccounts,
      impressions: { sum: impSum, unknown: clientAgg.impressions.unknown },
      likes: { sum: likeSum, unknown: clientAgg.likes.unknown },
      maxImp,
      byCategory,
      byAccount: byAccount.length ? byAccount : clientAgg.byAccount,
      byDay,
    };
  } catch {
    return clientAgg;
  }
}

/** カテゴリ（ignoreCategories で絞った投稿）ごとの件数 */
export function countByCategory(posts) {
  const m = new Map();
  for (const p of posts) for (const c of p.categories) m.set(c, (m.get(c) || 0) + 1);
  return m;
}

/** 上位アカウント（投稿数順 or インプレッション順） */
export function topAccounts(byAccount, mode = 'posts', limit = 20) {
  const arr = byAccount.slice();
  if (mode === 'imp') {
    arr.sort((a, b) => b.impressions.sum - a.impressions.sum || b.posts - a.posts || (a.user < b.user ? -1 : 1));
  } else {
    arr.sort((a, b) => b.posts - a.posts || b.impressions.sum - a.impressions.sum || (a.user < b.user ? -1 : 1));
  }
  return arr.slice(0, limit);
}

// ---------------------------------------------------------------- 日別

/**
 * 日別グラフの表示範囲。endKey は refTs の日。
 * 期間指定時はその期間が掛かる日、「すべて」は直近 CHART_MAX_DAYS 日。
 */
export function chartDayRange(period, refTs) {
  if (refTs == null) return null;
  const endKey = dateKeyFromTs(refTs);
  const sec = periodSeconds(period);
  const startKey = sec != null ? dateKeyFromTs(refTs - sec + 1) : addDays(endKey, -(CHART_MAX_DAYS - 1));
  return { startKey, endKey };
}

/** by_day を startKey〜endKey で 0 埋めする（範囲外は捨てる） */
export function fillDays(byDay, startKey, endKey) {
  const map = new Map();
  for (const d of byDay) if (d && d.date) map.set(d.date, d);
  const out = [];
  for (let k = startKey, guard = 0; k <= endKey && guard < 4000; k = addDays(k, 1), guard++) {
    const d = map.get(k);
    out.push(d
      ? { date: k, posts: d.posts || 0, impressions: d.impressions || 0, likes: d.likes || 0, categories: { ...(d.categories || {}) } }
      : { date: k, posts: 0, impressions: 0, likes: 0, categories: {} });
  }
  return out;
}

/** 範囲より前の日の投稿数（外れ値として除外した件数） */
export function countBefore(byDay, startKey) {
  let n = 0;
  for (const d of byDay) if (d.date < startKey) n += d.posts || 0;
  return n;
}

/** 軸の目盛り（0 を含むきれいな値） */
export function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const s = step < 1 ? 1 : step;
  const ticks = [];
  for (let v = 0; v < max + s; v += s) ticks.push(Math.round(v));
  return ticks;
}

// ---------------------------------------------------------------- 本文

const URL_RE = /https?:\/\/[^\s<>"'`　-〿！-｠]+/gi;

/**
 * 本文を {type:'text'|'url', value} の配列に分割する。http(s) のみ URL 扱い。
 * 末尾の句読点・閉じ括弧は URL に含めない。
 */
export function linkifySegments(text) {
  const s = typeof text === 'string' ? text : '';
  const out = [];
  let last = 0;
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(s))) {
    let url = m[0];
    const trail = /[.,!?;:)\]}]+$/.exec(url);
    if (trail) url = url.slice(0, -trail[0].length);
    if (url.length <= 'https://'.length) continue;
    if (m.index > last) out.push({ type: 'text', value: s.slice(last, m.index) });
    out.push({ type: 'url', value: url });
    last = m.index + url.length;
    URL_RE.lastIndex = last;
  }
  if (last < s.length) out.push({ type: 'text', value: s.slice(last) });
  return out;
}

/** href に使ってよい URL か（http/https のみ） */
export function isSafeHttpUrl(u) {
  if (typeof u !== 'string') return false;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * terms（matched_terms・検索語）に一致する部分を切り出す。
 * 返り値: [{text, hit:false} | {text, hit:true, kind}]。大文字小文字は無視、長い語を優先、重なりなし。
 * termGroups: [{kind:'term', terms:[...]}, {kind:'q', terms:[...]}]
 */
export function highlightSegments(text, termGroups) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];
  const lower = s.toLowerCase();
  const sameLen = lower.length === s.length; // toLowerCase で長さが変わる文字があれば区別ありで照合
  const hay = sameLen ? lower : s;
  const terms = [];
  for (const g of termGroups || []) {
    for (const t of g.terms || []) {
      if (typeof t !== 'string' || !t) continue;
      terms.push({ kind: g.kind, needle: sameLen ? t.toLowerCase() : t });
    }
  }
  terms.sort((a, b) => b.needle.length - a.needle.length);
  const marks = new Array(s.length).fill(null);
  for (const { kind, needle } of terms) {
    let from = 0;
    while (needle && from <= hay.length) {
      const i = hay.indexOf(needle, from);
      if (i < 0) break;
      let free = true;
      for (let j = i; j < i + needle.length; j++) if (marks[j]) { free = false; break; }
      if (free) for (let j = i; j < i + needle.length; j++) marks[j] = kind;
      from = i + needle.length;
    }
  }
  const out = [];
  let i = 0;
  while (i < s.length) {
    const k = marks[i];
    let j = i + 1;
    while (j < s.length && marks[j] === k) j++;
    out.push(k ? { text: s.slice(i, j), hit: true, kind: k } : { text: s.slice(i, j), hit: false });
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------- URL 状態

/** 状態 → クエリ文字列（既定値は省略） */
export function serializeState(state) {
  const st = { ...DEFAULT_STATE, ...state };
  const sp = new URLSearchParams();
  for (const c of st.cats) sp.append('cat', c);
  if (st.period !== DEFAULT_STATE.period) sp.set('period', st.period);
  if (st.user) sp.set('user', st.user);
  if (st.q.trim()) sp.set('q', st.q.trim());
  if (st.watched) sp.set('watched', '1');
  if (st.sort !== DEFAULT_STATE.sort) sp.set('sort', st.sort);
  if (st.acct !== DEFAULT_STATE.acct) sp.set('acct', st.acct);
  if (st.view !== DEFAULT_STATE.view) sp.set('view', st.view);
  return sp.toString();
}

/**
 * クエリ文字列（先頭の # / ? 可）→ 状態。不正値は既定値。
 * fallbackView: URL に view が無いときに使う値（localStorage の保存値など）
 */
export function parseState(str, fallbackView = null) {
  const sp = new URLSearchParams(String(str || '').replace(/^[#?]/, ''));
  const period = sp.get('period');
  const sort = sp.get('sort');
  const acct = sp.get('acct');
  const isView = (v) => VIEWS.some((x) => x.key === v);
  const view = sp.get('view');
  return {
    cats: [...new Set(sp.getAll('cat').map((c) => c.trim()).filter(Boolean))],
    period: PERIODS.some((p) => p.key === period) ? period : DEFAULT_STATE.period,
    user: (sp.get('user') || '').replace(/^@/, '').trim(),
    q: sp.get('q') || '',
    watched: sp.get('watched') === '1',
    sort: SORTS.some((s) => s.key === sort) ? sort : DEFAULT_STATE.sort,
    acct: ACCOUNT_SORTS.some((s) => s.key === acct) ? acct : DEFAULT_STATE.acct,
    view: isView(view) ? view : (isView(fallbackView) ? fallbackView : DEFAULT_STATE.view),
  };
}

// ---------------------------------------------------------------- 添付メディア

/** 表示を許可するメディアのホスト（https のみ） */
export const MEDIA_HOSTS = Object.freeze(['pbs.twimg.com', 'video.twimg.com']);

export function isAllowedMediaUrl(u) {
  if (typeof u !== 'string') return false;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && MEDIA_HOSTS.includes(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function posInt(v) {
  return isNum(v) && v > 0 ? Math.round(v) : null;
}

/** variants から mp4 の最高 bit_rate（許可ドメインのみ）を選ぶ */
export function bestMp4(variants) {
  if (!Array.isArray(variants)) return null;
  let best = null;
  for (const v of variants) {
    if (!v || typeof v !== 'object') continue;
    const type = String(v.content_type || '').toLowerCase();
    if (type !== 'video/mp4' || !isAllowedMediaUrl(v.url)) continue;
    const br = isNum(v.bit_rate) ? v.bit_rate : 0;
    if (!best || br > best.br) best = { url: v.url, br };
  }
  return best ? best.url : null;
}

/**
 * 任意フィールド media を正規化する。許可外ドメイン・http・不正値は捨てる。
 * 返り値: [{type:'photo', url, width, height, alt} | {type:'video'|'animated_gif', preview, video, width, height, alt}]
 * 写真は最大 4 枚。
 */
export function sanitizeMedia(media) {
  if (!Array.isArray(media)) return [];
  const out = [];
  let photos = 0;
  for (const m of media) {
    if (!m || typeof m !== 'object') continue;
    const alt = typeof m.alt_text === 'string' ? m.alt_text.slice(0, 1000) : '';
    const width = posInt(m.width);
    const height = posInt(m.height);
    if (m.type === 'photo') {
      const url = isAllowedMediaUrl(m.url) ? m.url : (isAllowedMediaUrl(m.preview_image_url) ? m.preview_image_url : null);
      if (!url || photos >= 4) continue;
      photos++;
      out.push({ type: 'photo', url, width, height, alt });
    } else if (m.type === 'video' || m.type === 'animated_gif') {
      const preview = isAllowedMediaUrl(m.preview_image_url) ? m.preview_image_url : null;
      const video = bestMp4(m.variants);
      if (!preview && !video) continue;
      out.push({ type: m.type, preview, video, width, height, alt });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 埋め込み

/** X 埋め込み用の投稿 ID（数字のみ）。不正なら null */
export function embedTweetId(post) {
  if (post && /^\d{1,25}$/.test(String(post.id))) return String(post.id);
  const m = post && typeof post.url === 'string' ? /\/status(?:es)?\/(\d{1,25})/.exec(post.url) : null;
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- カテゴリ色

/**
 * 既知カテゴリは固定スロット、未知カテゴリは名前のハッシュで予備スロットへ（決定的）。
 * スロット番号は CSS 変数 --cat-N に対応（dashboard.css 参照）。0 は「その他」用のニュートラル。
 * パレットは dataviz の検証済み 8 色（隣接 CVD ΔE≥8）を使用。
 */
export const KNOWN_CATEGORY_SLOTS = Object.freeze({
  'ホスト': 1,
  'キャバクラ': 2,
  '歌舞伎町': 3,
  '夜職その他': 4,
  '監視アカウント': 5,
  'その他': 0,
});

export const SPARE_SLOTS = Object.freeze([6, 7, 8]);

/** FNV-1a 32bit */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    h ^= cp & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    if (cp > 0xff) {
      h ^= (cp >>> 8) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    if (cp > 0xffff) {
      h ^= (cp >>> 16) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

export function categorySlot(name) {
  if (Object.prototype.hasOwnProperty.call(KNOWN_CATEGORY_SLOTS, name)) return KNOWN_CATEGORY_SLOTS[name];
  return SPARE_SLOTS[hashString(name) % SPARE_SLOTS.length];
}

// ---------------------------------------------------------------- 汎用

export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
  d.cancel = () => { if (t) clearTimeout(t); t = null; };
  return d;
}
