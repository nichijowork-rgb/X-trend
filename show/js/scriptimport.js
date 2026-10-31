// 台本ファイル（xtrend-script v1）の取り込み。DOM 非依存（node:test から import される）。
//
// 形: { app: 'xtrend-script', v: 1, title, week: 'YYYY-MM-DD'（配信日＝番組週のキー）,
//       range: { from, to }（ISO 日時。任意）,
//       corners: { main: [項目…最大3], category: [項目…], chat: [項目…] },
//       hold: [{ name, post_ids }] }
// 項目: { name, genre（ホスト／キャバクラ／歌舞伎町／夜職その他／その他 かジャンルキー）, post_ids: [], lead（リード文）, notes（自分用メモ） }
//
// 取り込み: 各項目を「手で作ったまとまり」（m:s-<週と名前から作る id>）として作る/更新し、メイン1〜3・カテゴリ別・雑談へ順に置く。
// 同じファイルを 2 回取り込んでも、名前＋週が同じなら同じ id なので重複しない（中身を更新）。

import { weekByKey, mainSlots, setMainSlot, removeTopic, cornerDef, normalizeForMatch, majorityGenre } from './logic.js';
import { parseTimestamp } from '../../assets/js/core.js';
import { botGenre } from './bot.js';

const ID_RE = /^\d{5,25}$/;
const CTRL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]', 'g');
const text = (v, max) => (typeof v === 'string' ? v.replace(CTRL, '').trim().slice(0, max) : '');
export const SCRIPT_CORNERS = Object.freeze(['main', 'category', 'chat']);
const LIMITS = Object.freeze({ main: 3, category: 30, chat: 30, hold: 100, posts: 300 });

/** 名前＋週から決まる話題 id（2 回取り込んでも同じ） */
export function scriptTopicId(weekKey, name) {
  const s = `${weekKey}|${normalizeForMatch(name).replace(/\s+/g, ' ').trim()}`;
  let h = 0x811c9dc5;
  for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  let h2 = 0x9747b28c;
  for (const ch of s) { h2 = Math.imul(h2 ^ ch.codePointAt(0), 0x5bd1e995) >>> 0; }
  return `m:s-${h.toString(36)}${h2.toString(36)}`;
}

function ids(v) {
  const out = [];
  for (const x of Array.isArray(v) ? v.slice(0, LIMITS.posts) : []) {
    const s = typeof x === 'string' ? x.trim() : (Number.isSafeInteger(x) ? String(x) : '');
    if (ID_RE.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * 台本ファイルを読む。返り値: { ok, script, errors: [日本語], warnings: [日本語] }
 * script: { title, week, range: { from, to }（UNIX 秒）| null, corners: { main, category, chat }, hold }
 */
export function parseScriptFile(input) {
  let raw = input;
  if (typeof input === 'string') {
    try { raw = JSON.parse(input); } catch { return { ok: false, errors: ['JSON として読めませんでした（台本ファイル xtrend-script を選んでください）'], warnings: [] }; }
  }
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['台本ファイルの形が違います'], warnings };
  if (raw.app !== 'xtrend-script') errors.push('台本ファイルではありません（"app": "xtrend-script" がありません。番組サイトの書き出しファイルは［読み込み］から）');
  if (raw.v !== 1) errors.push(`この版の台本ファイルには対応していません（v: ${JSON.stringify(raw.v ?? null)}。対応は v: 1）`);
  const week = typeof raw.week === 'string' ? weekByKey(raw.week.trim()) : null;
  if (!week) errors.push('番組週（"week": "YYYY-MM-DD"＝土曜の配信日）が正しくありません');
  if (!raw.corners || typeof raw.corners !== 'object') errors.push('"corners"（main・category・chat）がありません');
  if (errors.length) return { ok: false, errors, warnings };
  const corners = {};
  const seenNames = new Set();
  let count = 0;
  for (const key of SCRIPT_CORNERS) {
    const list = Array.isArray(raw.corners[key]) ? raw.corners[key] : [];
    if (raw.corners[key] != null && !Array.isArray(raw.corners[key])) warnings.push(`${cornerDef(key).name}（${key}）が配列ではないので読み飛ばしました`);
    if (list.length > LIMITS[key]) warnings.push(`${cornerDef(key).name}は最大 ${LIMITS[key]} 本です（${list.length - LIMITS[key]} 本は読み飛ばしました）`);
    corners[key] = [];
    list.slice(0, LIMITS[key]).forEach((x, i) => {
      if (!x || typeof x !== 'object') { warnings.push(`${cornerDef(key).name} ${i + 1} 本目の形が違うので読み飛ばしました`); return; }
      const name = text(x.name, 80);
      if (!name) { warnings.push(`${cornerDef(key).name} ${i + 1} 本目に名前（name）が無いので読み飛ばしました`); return; }
      const nk = normalizeForMatch(name);
      if (seenNames.has(nk)) { warnings.push(`「${name}」が 2 回あります（2 回目は読み飛ばしました）`); return; }
      seenNames.add(nk);
      const genre = botGenre(x.genre);
      if (x.genre != null && !genre) warnings.push(`「${name}」のジャンル「${String(x.genre).slice(0, 20)}」が分からないので、投稿から決めます`);
      corners[key].push({ name, genre, postIds: ids(x.post_ids), lead: text(x.lead, 2000) || null, notes: text(x.notes, 4000) || '' });
      count++;
    });
  }
  if (!count) return { ok: false, errors: ['取り込める話題が 1 本もありません（corners の各項目に name が必要です）'], warnings };
  let range = null;
  if (raw.range && typeof raw.range === 'object') {
    const from = parseTimestamp(typeof raw.range.from === 'string' ? raw.range.from : '');
    const to = parseTimestamp(typeof raw.range.to === 'string' ? raw.range.to : '');
    if (from != null && (to == null || to > from)) range = { from, to: to ?? null };
    else warnings.push('対象期間（range）が読めないので、今の対象期間のままにします');
  }
  const hold = (Array.isArray(raw.hold) ? raw.hold : []).slice(0, LIMITS.hold)
    .map((x) => (x && typeof x === 'object' ? { name: text(x.name, 80) || '台本の保留', postIds: ids(x.post_ids) } : null))
    .filter((x) => x && x.postIds.length);
  return { ok: true, errors: [], warnings, script: { title: text(raw.title, 200) || null, week: week.key, range, corners, hold } };
}

/**
 * 取り込みの一覧（確認ダイアログ用）。week: 取り込み先の番組週の状態、nameOf(topicId) → 今の名前
 * 返り値: [{ corner, slot, label, id, name, genre, posts, missing, replaces（置き換える話題の名前）| null, update（同じ話題の更新） }]
 */
export function planScriptImport(script, week, { postsById = new Map(), nameOf = () => null } = {}) {
  const out = [];
  const slots = mainSlots(week.rundown);
  const existing = new Set((week.overrides.manual || []).map((m) => m.id));
  for (const key of SCRIPT_CORNERS) {
    script.corners[key].forEach((it, i) => {
      const id = scriptTopicId(script.week, it.name);
      const cur = key === 'main' ? slots[i] : null;
      out.push({
        corner: key, slot: key === 'main' ? i : null, label: key === 'main' ? `メイン${i + 1}` : cornerDef(key).name,
        id, name: it.name, genre: it.genre, posts: it.postIds.filter((x) => postsById.has(x)).length, missing: it.postIds.filter((x) => !postsById.has(x)).length,
        replaces: cur && cur !== id ? (nameOf(cur) || cur) : null, update: existing.has(id),
      });
    });
  }
  return out;
}

/**
 * 取り込む（week・saved をその場で書き換える）。postsById: posts.json の全投稿。
 * 返り値: { topics: 作った/更新した本数, displaced: メイン候補へ退避した話題 id, held: 保留した投稿数 }
 */
export function applyScriptImport(week, saved, script, { postsById = new Map() } = {}) {
  const ov = week.overrides;
  const displaced = [];
  const placedIds = [];
  for (const key of SCRIPT_CORNERS) {
    const corner = week.rundown.corners.find((c) => c.key === key);
    if (!corner) continue;
    const idsHere = [];
    script.corners[key].forEach((it, i) => {
      const id = scriptTopicId(script.week, it.name);
      idsHere.push(id);
      placedIds.push(id);
      const have = it.postIds.filter((x) => postsById.has(x));
      const missing = it.postIds.filter((x) => !postsById.has(x));
      // 手で作ったまとまり（同じ id があれば更新）
      // ジャンル: 台本に無ければ投稿の多数決（投稿も無ければ夜職その他）
      const posts = have.map((x) => postsById.get(x));
      const entry = { id, name: it.name, genre: it.genre || (posts.length ? majorityGenre(posts) : 'night'), source: 'script', ...(missing.length ? { missing } : {}) };
      const k = ov.manual.findIndex((m) => m.id === id);
      if (k >= 0) ov.manual[k] = entry; else ov.manual.push(entry);
      delete ov.renames[id];
      delete ov.genres[id];
      // 投稿の出し入れ（前回の取り込みで入れて今回は無いものは外す）
      for (const [pid, t] of Object.entries(ov.moves)) if (t === id && !have.includes(pid)) delete ov.moves[pid];
      for (const pid of have) ov.moves[pid] = id;
      // 片付けから外す（台本で使うので）
      week.shelved = (week.shelved || []).filter((x) => x.topicId !== id);
      // リード文・メモ
      const sc = week.script[id] || { lead: null, points: '', question: '' };
      week.script[id] = { ...sc, lead: it.lead || sc.lead || null, points: it.notes || sc.points || '' };
      // 置き場所
      week.mainCand = (week.mainCand || []).filter((x) => x !== id);
      if (key === 'main') {
        const r = setMainSlot(week.rundown, id, i);
        week.rundown = r.rundown;
        if (r.displaced) displaced.push(r.displaced);
      } else {
        week.rundown = removeTopic(week.rundown, id);
      }
    });
    if (key !== 'main') {
      const c = week.rundown.corners.find((x) => x.key === key);
      c.items = [...idsHere, ...c.items.filter((x) => !idsHere.includes(x))];
    }
  }
  // メイン枠から押し出された話題はメイン候補へ（今回の台本の話題は除く）
  for (const d of displaced) if (!placedIds.includes(d) && !week.mainCand.includes(d)) week.mainCand.push(d);
  // 前に削除（ゴミ箱）していた同じ話題は戻す（台本で使うので）
  if (Array.isArray(saved.trash)) saved.trash = saved.trash.filter((x) => !placedIds.includes(x.topicId));
  if (script.title) week.title = script.title;
  if (script.range) week.range = { mode: 'custom', from: script.range.from, to: script.range.to };
  // 保留（名前ごとに置き換え）
  const holdNames = new Set(script.hold.map((x) => x.name));
  week.scriptHold = [...(week.scriptHold || []).filter((x) => !holdNames.has(x.name)), ...script.hold.map((x) => ({ name: x.name, postIds: [...x.postIds] }))];
  return { topics: placedIds.length, displaced: displaced.filter((d) => !placedIds.includes(d)), held: script.hold.reduce((n, x) => n + x.postIds.length, 0) };
}
