export const DEFAULT_SETTINGS = {
  keywords: {
    nightlife: ['ホスト', 'キャバクラ', '歌舞伎町', 'ホストクラブ', 'キャバ嬢', 'ラウンジ', '夜職'],
    general: [],
  },
  excludeTerms: ['ロイヤルホスト'],
  targets: { nightlifePerDay: { min: 30, max: 50 }, generalTopicsPerDay: 3, generalPostsPerTopic: 5 },
  schedule: {
    timezone: 'Asia/Tokyo',
    collectTimes: ['09:00', '21:00'],
    dailyDigest: { enabled: true, time: '23:30' },
    weeklyDigest: { enabled: true, weekday: 1, time: '10:00', postCount: 30 },
    autoBackup: { enabled: true, time: '04:00', keep: 14 },
  },
  sources: {
    xSearch: { enabled: true, maxPerQuery: 20 },
    xHome: { enabled: false, maxResults: 50 },
    grok: { enabled: true, model: 'grok-4', useForSearch: true, useForSummary: true },
  },
  budget: { note: '未決定', xApiMonthlyReadCap: null },
  delivery: { method: 'none', webhookUrl: null },
};

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (msg) => {
  throw new ValidationError(msg);
};

function strList(v, label, max = 200) {
  if (!Array.isArray(v)) fail(`${label}は配列で指定してください`);
  const out = [];
  for (const x of v) {
    if (typeof x !== 'string') fail(`${label}には文字列のみ指定できます`);
    const t = x.trim();
    if (!t) continue;
    if (t.length > 100) fail(`${label}の各項目は100文字以内にしてください`);
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > max) fail(`${label}は${max}件以内にしてください`);
  return out;
}
function timeStr(v, label) {
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) fail(`${label}は HH:MM 形式で指定してください`);
  return v;
}
function intIn(v, label, min, max) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(`${label}は${min}〜${max}の整数で指定してください`);
  return v;
}
function bool(v, label) {
  if (typeof v !== 'boolean') fail(`${label}は true/false で指定してください`);
  return v;
}
function section(patch, key) {
  if (patch[key] === undefined) return null;
  if (!isObj(patch[key])) fail(`${key}はオブジェクトで指定してください`);
  return patch[key];
}
function sub(obj, key) {
  if (!obj || obj[key] === undefined) return null;
  if (!isObj(obj[key])) fail(`${key}はオブジェクトで指定してください`);
  return obj[key];
}

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return typeof tz === 'string' && tz.length > 0;
  } catch {
    return false;
  }
}

export function mergeSettings(base, patch) {
  if (!isObj(patch)) fail('設定はオブジェクトで指定してください');
  const s = structuredClone(base);

  let k = section(patch, 'keywords');
  if (k) {
    if (k.nightlife !== undefined) s.keywords.nightlife = strList(k.nightlife, '夜職キーワード');
    if (k.general !== undefined) s.keywords.general = strList(k.general, '一般キーワード');
  }
  if (patch.excludeTerms !== undefined) s.excludeTerms = strList(patch.excludeTerms, '除外ワード');

  const t = section(patch, 'targets');
  if (t) {
    const n = sub(t, 'nightlifePerDay');
    if (n) {
      if (n.min !== undefined) s.targets.nightlifePerDay.min = intIn(n.min, '夜職の1日最小件数', 0, 10000);
      if (n.max !== undefined) s.targets.nightlifePerDay.max = intIn(n.max, '夜職の1日上限件数', 0, 10000);
    }
    if (t.generalTopicsPerDay !== undefined) s.targets.generalTopicsPerDay = intIn(t.generalTopicsPerDay, '一般の1日トピック数', 0, 50);
    if (t.generalPostsPerTopic !== undefined) s.targets.generalPostsPerTopic = intIn(t.generalPostsPerTopic, 'トピックあたりの投稿数', 0, 100);
    if (s.targets.nightlifePerDay.min > s.targets.nightlifePerDay.max) fail('夜職の最小件数は上限件数以下にしてください');
  }

  const sc = section(patch, 'schedule');
  if (sc) {
    if (sc.timezone !== undefined) {
      if (!isValidTimezone(sc.timezone)) fail('タイムゾーンが正しくありません');
      s.schedule.timezone = sc.timezone;
    }
    if (sc.collectTimes !== undefined) {
      if (!Array.isArray(sc.collectTimes)) fail('収集時刻は配列で指定してください');
      const list = [...new Set(sc.collectTimes.map((x) => timeStr(x, '収集時刻')))].sort();
      if (list.length > 12) fail('収集時刻は12件以内にしてください');
      s.schedule.collectTimes = list;
    }
    const d = sub(sc, 'dailyDigest');
    if (d) {
      if (d.enabled !== undefined) s.schedule.dailyDigest.enabled = bool(d.enabled, '日次まとめの有効');
      if (d.time !== undefined) s.schedule.dailyDigest.time = timeStr(d.time, '日次まとめの時刻');
    }
    const w = sub(sc, 'weeklyDigest');
    if (w) {
      if (w.enabled !== undefined) s.schedule.weeklyDigest.enabled = bool(w.enabled, '週次まとめの有効');
      if (w.weekday !== undefined) s.schedule.weeklyDigest.weekday = intIn(w.weekday, '週次まとめの曜日', 0, 6);
      if (w.time !== undefined) s.schedule.weeklyDigest.time = timeStr(w.time, '週次まとめの時刻');
      if (w.postCount !== undefined) s.schedule.weeklyDigest.postCount = intIn(w.postCount, '週次まとめの件数', 1, 500);
    }
    const b = sub(sc, 'autoBackup');
    if (b) {
      if (b.enabled !== undefined) s.schedule.autoBackup.enabled = bool(b.enabled, '自動バックアップの有効');
      if (b.time !== undefined) s.schedule.autoBackup.time = timeStr(b.time, '自動バックアップの時刻');
      if (b.keep !== undefined) s.schedule.autoBackup.keep = intIn(b.keep, 'バックアップ保持数', 1, 365);
    }
  }

  const so = section(patch, 'sources');
  if (so) {
    const xs = sub(so, 'xSearch');
    if (xs) {
      if (xs.enabled !== undefined) s.sources.xSearch.enabled = bool(xs.enabled, 'X検索の有効');
      if (xs.maxPerQuery !== undefined) s.sources.xSearch.maxPerQuery = intIn(xs.maxPerQuery, '1クエリの最大件数', 1, 100);
    }
    const xh = sub(so, 'xHome');
    if (xh) {
      if (xh.enabled !== undefined) s.sources.xHome.enabled = bool(xh.enabled, 'ホームタイムラインの有効');
      if (xh.maxResults !== undefined) s.sources.xHome.maxResults = intIn(xh.maxResults, 'ホームタイムラインの最大件数', 1, 100);
    }
    const g = sub(so, 'grok');
    if (g) {
      if (g.enabled !== undefined) s.sources.grok.enabled = bool(g.enabled, 'Grokの有効');
      if (g.model !== undefined) {
        if (typeof g.model !== 'string' || !g.model.trim() || g.model.length > 100) fail('Grokのモデル名が正しくありません');
        s.sources.grok.model = g.model.trim();
      }
      if (g.useForSearch !== undefined) s.sources.grok.useForSearch = bool(g.useForSearch, 'Grok検索の利用');
      if (g.useForSummary !== undefined) s.sources.grok.useForSummary = bool(g.useForSummary, 'Grok要約の利用');
    }
  }

  const bu = section(patch, 'budget');
  if (bu) {
    if (bu.note !== undefined) {
      if (typeof bu.note !== 'string' || bu.note.length > 500) fail('予算メモは500文字以内の文字列にしてください');
      s.budget.note = bu.note;
    }
    if (bu.xApiMonthlyReadCap !== undefined) {
      s.budget.xApiMonthlyReadCap = bu.xApiMonthlyReadCap === null ? null : intIn(bu.xApiMonthlyReadCap, '月間読み取り上限', 0, 100000000);
    }
  }

  const de = section(patch, 'delivery');
  if (de) {
    if (de.method !== undefined) {
      if (!['none', 'webhook'].includes(de.method)) fail('配信方法は none か webhook を指定してください');
      s.delivery.method = de.method;
    }
    if (de.webhookUrl !== undefined) {
      if (de.webhookUrl === null || de.webhookUrl === '') s.delivery.webhookUrl = null;
      else {
        let u;
        try {
          u = new URL(de.webhookUrl);
        } catch {
          fail('Webhook URLが正しくありません');
        }
        if (!['http:', 'https:'].includes(u.protocol)) fail('Webhook URLは http(s) で指定してください');
        s.delivery.webhookUrl = u.toString();
      }
    }
    if (s.delivery.method === 'webhook' && !s.delivery.webhookUrl) fail('Webhook配信にはURLが必要です');
  }
  return s;
}

export function createSettingsStore(meta) {
  let cache = null;
  const load = () => {
    if (cache) return cache;
    let stored = null;
    try {
      const raw = meta.get('settings');
      stored = raw ? JSON.parse(raw) : null;
    } catch {
      stored = null;
    }
    try {
      cache = stored ? mergeSettings(structuredClone(DEFAULT_SETTINGS), stored) : structuredClone(DEFAULT_SETTINGS);
    } catch {
      cache = structuredClone(DEFAULT_SETTINGS);
    }
    return cache;
  };
  return {
    get: () => structuredClone(load()),
    update(patch) {
      const next = mergeSettings(load(), patch);
      meta.set('settings', JSON.stringify(next));
      cache = next;
      return structuredClone(next);
    },
    replace(full) {
      const next = mergeSettings(structuredClone(DEFAULT_SETTINGS), full);
      meta.set('settings', JSON.stringify(next));
      cache = next;
      return structuredClone(next);
    },
  };
}

export const defaultSettings = () => structuredClone(DEFAULT_SETTINGS);
