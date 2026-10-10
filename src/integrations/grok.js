// xAI (Grok) API クライアント。Responses API (POST /v1/responses) + サーバーサイドツール x_search を使用。
// 旧 Live Search (search_parameters) は使わない。fetchImpl 注入可。例外は投げない。
import { parsePostUrl } from './url.js';
import { parseDate } from './importers.js';

const API_BASE = 'https://api.x.ai/v1';
const DEFAULT_MODEL = 'grok-4';

const SEARCH_SYSTEM = [
  'あなたはX（旧Twitter）の投稿を検索して事実だけを報告する調査アシスタントです。',
  'x_search ツールで実際に見つかった投稿だけを報告してください。推測・創作・要約の書き換えは禁止です。',
  '出力は次の JSON オブジェクトのみ（前後に説明やコードフェンスを付けない）:',
  '{"posts":[{"url":"https://x.com/<handle>/status/<id>","authorHandle":"...","authorName":"...","text":"投稿本文そのまま","postedAt":"ISO8601"}]}',
  '本文は投稿に書かれている文字をそのまま写し、確実でなければ null にしてください。要約や言い換えは入れないでください。',
  'いいね数・表示回数などの数値は出力しないでください（別途公式APIで取得します）。',
  '見つからなければ {"posts":[]} を返してください。',
].join('\n');

const SUMMARY_SYSTEM = [
  'あなたは夜職（ホスト・キャバクラ・歌舞伎町など）の業界動向を把握したい運営者向けの編集アシスタントです。',
  '入力は、利用者が収集したX投稿の候補一覧（トピック別）です。日本語で簡潔にまとめてください。',
  '必ず次の見出しで書いてください: 「## 夜職の業界動向」「## 投稿ネタ候補」「## 一般の雑談ネタ」。',
  '重要: 入力は「収集した候補」だけです。「Xで最も伸びた」「X全体の上位」「全体で人気」などX全体の順位を示唆する表現は使わず、',
  '「収集した候補内では」「今回の候補の中では」と明記してください。',
  '入力にない事実・数値は書かないこと。指標が null の投稿は「指標不明」として扱い、数値を推測しないこと。',
  '特定個人への中傷や私的情報の拡散につながる提案はしないこと。',
].join('\n');

function topicsSystem(genre, count) {
  const g = genre === 'nightlife'
    ? '夜職（ホスト・キャバクラ・歌舞伎町・ラウンジなど）に関する、投稿ネタや業界把握に使える話題'
    : '日本のXで今日話題になっている、雑談向けの一般的な話題（夜職に限らない）';
  return [
    'あなたはX（旧Twitter）の話題を調べる調査アシスタントです。x_search ツールで直近の投稿を確認し、',
    `${g}を ${count} 個挙げてください。`,
    '出力は次の JSON オブジェクトのみ（説明やコードフェンスなし）:',
    '{"topics":[{"label":"話題の短い名前（日本語）","query":"X検索にそのまま使えるキーワード"}]}',
    '実在が確認できない話題は含めず、誹謗中傷や個人攻撃にあたる話題は避けてください。',
  ].join('\n');
}

const ymd = (d) => d.toISOString().slice(0, 10);
function dateParam(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : ymd(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return String(v);
  const iso = parseDate(v);
  return iso ? iso.slice(0, 10) : null;
}

function httpError(status) {
  if (status === 401) return 'xAI APIの認証に失敗しました（XAI_API_KEY が無効です）。';
  if (status === 403) return 'xAI APIへのアクセスが許可されていません（権限・クレジット・地域制限を確認してください）。';
  if (status === 402) return 'xAI APIの利用枠（クレジット）が不足しています。';
  if (status === 429) return 'xAI APIのレート制限に達しました。しばらく待ってから再試行してください。';
  if (status === 400 || status === 404 || status === 422) return `xAI APIがリクエストを受け付けませんでした（HTTP ${status}）。モデル名が現行のものか、そのモデルがX検索ツールに対応しているか確認してください。`;
  if (status >= 500) return `xAI API側でエラーが発生しました（HTTP ${status}）。時間をおいて再試行してください。`;
  return `xAI APIがエラーを返しました（HTTP ${status}）。`;
}

/** Responses API の応答から本文と引用URLを取り出す */
export function extractResponse(json) {
  let text = '';
  const cites = [];
  const addCite = (c) => {
    const u = typeof c === 'string' ? c : c && typeof c === 'object' ? (c.url ?? c.link) : null;
    if (typeof u === 'string' && u) cites.push(u);
  };
  if (Array.isArray(json?.output)) {
    for (const item of json.output) {
      if (item?.type === 'message' || Array.isArray(item?.content)) {
        for (const part of item.content ?? []) {
          if (typeof part?.text === 'string' && (part.type === 'output_text' || part.type === 'text' || !part.type)) {
            text += (text ? '\n' : '') + part.text;
          }
          for (const a of part?.annotations ?? []) addCite(a);
        }
      }
    }
  }
  if (!text && typeof json?.output_text === 'string') text = json.output_text;
  if (Array.isArray(json?.citations)) json.citations.forEach(addCite);
  return { text: text.trim(), citations: [...new Set(cites)] };
}

function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/```(?:json)?/gi, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

export function createGrok({ apiKey, model = DEFAULT_MODEL, fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const useModel = model || DEFAULT_MODEL;

  async function call(system, user, tools) {
    if (!apiKey) return { ok: false, error: 'XAI_API_KEY が設定されていません。' };
    if (typeof fetchImpl !== 'function') return { ok: false, error: 'この環境ではネットワークアクセスを利用できません。' };
    const body = {
      model: useModel,
      input: [{ role: 'system', content: system }, { role: 'user', content: user }],
      store: false,
    };
    if (tools) body.tools = tools;
    let res;
    try {
      res = await fetchImpl(`${API_BASE}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      });
    } catch {
      return { ok: false, error: 'xAI APIに接続できませんでした（ネットワークエラーまたはタイムアウト）。' };
    }
    if (!res.ok) return { ok: false, error: httpError(res.status) };
    let json;
    try { json = await res.json(); } catch { return { ok: false, error: 'xAI APIの応答を解釈できませんでした。' }; }
    if (json?.error) return { ok: false, error: 'xAI APIがエラーを返しました。' };
    return { ok: true, ...extractResponse(json) };
  }

  return {
    isConfigured() {
      return Boolean(apiKey);
    },

    async searchX({ query, maxResults = 20, fromDate, toDate } = {}) {
      const q = typeof query === 'string' ? query.trim() : '';
      if (!q) return { posts: [], error: '検索クエリが空です。' };
      const limit = Math.min(100, Math.max(1, Math.trunc(Number(maxResults)) || 20));
      const tool = { type: 'x_search' };
      const from = dateParam(fromDate);
      const to = dateParam(toDate);
      if (from) tool.from_date = from;
      if (to) tool.to_date = to;
      const r = await call(SEARCH_SYSTEM, `次のキーワードに関するXの投稿を最大${limit}件、日本語圏を優先して探してください。\nキーワード: ${q}`, [tool]);
      if (!r.ok) return { posts: [], error: r.error };

      // 引用の x.com / twitter.com status URL（検索ツールが実際に返した投稿）
      const cited = new Map();
      for (const c of r.citations) {
        const p = parsePostUrl(c);
        if (p && /\/status(?:es)?\//.test(c) && !cited.has(p.postId)) cited.set(p.postId, p);
      }
      const parsed = parseJsonLoose(r.text);
      const claimed = Array.isArray(parsed?.posts) ? parsed.posts : [];
      const posts = [];
      const seen = new Set();
      let dropped = 0;
      const detail = q;
      const nowMs = now().getTime();
      const make = (p, g) => ({
        postId: p.postId,
        url: p.url,
        authorHandle: p.authorHandle,
        authorName: typeof g?.authorName === 'string' && g.authorName.trim() && g.authorName.length <= 100 ? g.authorName.trim() : null,
        text: cleanText(g?.text),
        postedAt: cleanDate(g?.postedAt, nowMs),
        metrics: { views: null, likes: null, reposts: null, replies: null, bookmarks: null },
        metricsFetchedAt: null,
        source: { type: 'grok_x_search', detail },
        genreHint: null,
        matchedKeywords: [],
        lang: null,
        raw: null,
      });
      for (const g of claimed) {
        const p = parsePostUrl(g?.url);
        if (!p || !cited.has(p.postId)) { dropped++; continue; }
        if (seen.has(p.postId)) continue;
        seen.add(p.postId);
        posts.push(make({ ...p, authorHandle: p.authorHandle ?? cited.get(p.postId).authorHandle }, g));
      }
      for (const [id, p] of cited) {
        if (!seen.has(id)) { seen.add(id); posts.push(make(p, null)); }
      }
      const notes = ['Grokが示した数値は推測の可能性があるため指標は未取得です（公式APIのlookupで補完してください）。'];
      if (dropped) notes.push(`引用で裏付けできなかった ${dropped} 件は除外しました。`);
      if (!cited.size) notes.push('Grokが投稿URLの引用を返さなかったため、投稿を確定できませんでした。');
      return { posts: posts.slice(0, limit), note: notes.join(' ') };
    },

    async summarize(input) {
      const sections = Array.isArray(input?.sections) ? input.sections : [];
      const total = sections.reduce((n, s) => n + (s?.topics ?? []).reduce((m, t) => m + (t?.posts?.length ?? 0), 0), 0);
      if (!total) return { text: '', error: '要約する投稿がありません。' };
      const compact = {
        kind: input.kind === 'weekly' ? 'weekly' : 'daily',
        periodLabel: String(input.periodLabel ?? ''),
        sections: sections.map((s) => ({
          genre: s.genre,
          genreLabel: s.genreLabel,
          topics: (s.topics ?? []).map((t) => ({
            label: t.label,
            posts: (t.posts ?? []).map((p) => ({
              text: typeof p.text === 'string' ? p.text.slice(0, 300) : null,
              url: p.url ?? null,
              metrics: p.metrics ?? null,
            })),
          })),
        })),
      };
      const r = await call(SUMMARY_SYSTEM, `${compact.kind === 'weekly' ? '週次' : '日次'}の要約を作ってください。\n${JSON.stringify(compact)}`, null);
      if (!r.ok) return { text: '', error: r.error };
      if (!r.text) return { text: '', error: 'xAI APIから要約が返りませんでした。' };
      return { text: r.text };
    },

    async suggestTopics({ genre = 'general', count = 5 } = {}) {
      const n = Math.min(20, Math.max(1, Math.trunc(Number(count)) || 5));
      const today = now();
      const from = new Date(today.getTime() - 2 * 86400000);
      const r = await call(topicsSystem(genre, n), `今日は ${ymd(today)} です。直近の投稿から${n}個挙げてください。`, [{ type: 'x_search', from_date: ymd(from), to_date: ymd(today) }]);
      if (!r.ok) return { topics: [], error: r.error };
      const parsed = parseJsonLoose(r.text);
      const topics = (Array.isArray(parsed?.topics) ? parsed.topics : [])
        .map((t) => ({ label: typeof t?.label === 'string' ? t.label.trim() : '', query: typeof t?.query === 'string' ? t.query.trim() : '' }))
        .filter((t) => t.label && t.query)
        .slice(0, n);
      if (!topics.length) return { topics: [], error: 'Grokから話題を取得できませんでした。' };
      return { topics };
    },
  };
}

function cleanText(t) {
  if (typeof t !== 'string') return null;
  const s = t.trim();
  if (!s || s.length > 1000) return null;
  if (/^(要約|まとめ|summary)\s*[:：]/i.test(s)) return null;
  return s;
}
function cleanDate(v, nowMs) {
  const iso = parseDate(typeof v === 'string' ? v : null);
  if (!iso) return null;
  return Date.parse(iso) > nowMs + 3600000 ? null : iso;
}
