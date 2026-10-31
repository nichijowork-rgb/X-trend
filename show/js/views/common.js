// 画面共通の部品（話題の見た目・色・数値の行）。
import { formatCompact, UNKNOWN } from '../../../assets/js/core.js';
import { leadText, cornerDef, genreLabel, autoTitle } from '../logic.js';
import { h, badge, genreSticker, postCard, linkCard } from '../dom.js';

/** キューの色（ジャンルキー） */
export function cueColor(app, cue) {
  if (!cue) return 'white';
  const def = cornerDef(cue.cornerKey);
  if (cue.kind === 'topic') {
    if (cue.cornerKey === 'main') return 'main';
    const t = app.topicsById.get(cue.topicId);
    return t ? t.genre : def.color;
  }
  return def ? def.color : 'white';
}

/** 「投稿 3件・合計 12.3万・最大 8万・伸び 1時間あたり 1.2万」 */
export function statsLine(topic) {
  const st = topic.stats;
  if (!st.count) return [h('span', { class: 'stat' }, '数値：', UNKNOWN, '（posts.json に無い投稿）')];
  return [
    h('span', { class: 'stat' }, h('b', {}, `${st.count}`), '件'),
    h('span', { class: 'stat' }, '合計 ', h('b', {}, formatCompact(st.totalImp)), st.unknownImp && st.totalImp != null ? '（一部不明）' : ''),
    h('span', { class: 'stat' }, '最大 ', h('b', {}, formatCompact(st.maxImp))),
    h('span', { class: 'stat' }, '伸び ', h('b', {}, st.maxPace == null ? UNKNOWN : `${formatCompact(st.maxPace)}/時`)),
  ];
}

/** 台本のリード（手入力があればそれ、無ければ自動） */
export function leadFor(app, topic) {
  const sc = app.weekState().script[topic.id];
  return sc && typeof sc.lead === 'string' && sc.lead.trim() ? sc.lead : leadText(topic, app.postsById, app.ds.refTs);
}

export function scriptFor(app, topicId) {
  return app.weekState().script[topicId] || { lead: null, points: '', question: '' };
}

export function topicPosts(app, topic) {
  return topic.postIds.map((id) => app.postsById.get(id)).filter(Boolean);
}

/** 話題の印（NEW・持ち越し・自分で追加・ブクマ・同じ話題かも？） */
export function topicMarks(app, topic) {
  const marks = [];
  const nw = app.newInfo && app.newInfo.topics.get(topic.id);
  if (nw != null) marks.push(badge(nw > 0 && topic.stats.count > nw ? `NEW +${nw}` : 'NEW', 'badge-new'));
  if (topic.kind === 'carried') marks.push(badge('先週から持ち越し', 'badge-carry'));
  if (topic.bookmark) marks.push(badge(`★ブックマーク ${topic.bookmarkCount}件`, 'badge-bm'));
  if (topic.personal && topic.postIds.some((id) => app.weekState().personal.some((p) => p.id === id)) || (topic.kind === 'link' && app.weekState().personal.some((p) => p.id === topic.linkId))) marks.push(badge('自分で追加', 'badge-me'));
  if (topic.suggested) marks.push(badge('同じ話題かも？', 'badge-suggest'));
  if (topic.outsideCount) marks.push(outsideBadge(topic));
  marks.push(...botMarks(topic));
  return marks;
}

/** 「期間外」の印（対象期間の外の投稿を、番組構成に入っているので残している） */
export function outsideLabel(topic) {
  if (!topic || !topic.outsideCount) return null;
  return topic.outsideCount >= (topic.stats ? topic.stats.count : topic.postIds.length) ? '期間外' : `期間外 ${topic.outsideCount}件`;
}
export function outsideBadge(topic) {
  return h('span', { class: 'badge badge-out', attrs: { title: '対象期間の外の投稿です（番組構成に入っているので残しています）' } }, outsideLabel(topic));
}

/** ボット（Grok）がまとめた話題の印。自信が低いものは「要確認」 */
export function botMarks(topic, small = false) {
  if (!topic || !topic.bot) return [];
  const c = topic.bot.confidence;
  const title = `Grok（ボット）がまとめた話題${c != null ? `（確からしさ ${Math.round(c * 100)}%）` : ''}`;
  const out = [h('span', { class: `badge badge-bot${small ? ' is-small' : ''}`, attrs: { title } }, 'Grok')];
  if (topic.bot.low) out.push(h('span', { class: `badge badge-check${small ? ' is-small' : ''}`, attrs: { title: 'まとめ方の確からしさが低いので、中身を確認してください' } }, '要確認'));
  return out;
}

/** リード文がボットのまとめ（summary）そのままか（手で書き換えていない） */
export function leadIsBot(app, topic) {
  const sc = app.weekState().script[topic.id];
  return Boolean(topic.bot && topic.bot.summary) && !(sc && typeof sc.lead === 'string' && sc.lead.trim());
}

/** 雑談おすすめ（show_pick）の理由。おすすめでなければ null、理由が無ければ '' */
export function pickReason(app, postId) {
  if (!app.pickIds || !app.pickIds.has(postId)) return null;
  return (app.pickReasons && app.pickReasons.get(postId)) || '';
}

/** 代表投稿（カード）。posts.json に無いときはリンクだけのカード */
export function repPostCard(app, topic, opts = {}) {
  const p = topic.stats.topPostId ? app.postsById.get(topic.stats.topPostId) : null;
  if (p) return postCard(p, { refTs: app.ds.refTs, refYear: refYear(app), embedder: app.embedder, bm: bmInfo(app, p.id), ...opts });
  const id = topic.linkId || (topic.linkIds && topic.linkIds[0]);
  return id ? linkCard(id, null, app.embedder) : null;
}

/** ブックマークで取り込んだ投稿か（posts.json の in_bookmarks か bookmarks.json にある）。違えば null */
export function bmInfo(app, id) {
  if (app.bmFlags && app.bmFlags.has(id)) return app.bmFlags.get(id);
  if (app.bookmarks && app.bookmarks.some((b) => b.id === id)) return { below: false };
  return null;
}

export function refYear(app) {
  const ts = app.ds.refTs;
  return ts ? new Date((ts + 9 * 3600) * 1000).getUTCFullYear() : null;
}

/** メインの話題名（自動タイトル用） */
export function mainTopics(app) {
  const c = app.weekState().rundown.corners.find((x) => x.key === 'main');
  return c ? c.items.map((id) => app.topicsById.get(id)).filter(Boolean) : [];
}

export function currentTitle(app) {
  const wk = app.weekState();
  return typeof wk.title === 'string' && wk.title.trim() ? wk.title : autoTitle(app.saved.showName, mainTopics(app).map((t) => t.name));
}

export function genreName(key) {
  return genreLabel(key);
}

export { genreSticker };
