// ③ 映す用（配信画面用・1920×1080）。自分用メモ（話すポイント・質問・メモ）は出さない。
// 進行画面の操作に追従する（show.js の同期で app.saved が更新されると描き直される）。
import { formatCompact, hitRateText, UNKNOWN } from '../../../assets/js/core.js';
import { cornerDef, pickWeeklyReport } from '../logic.js';
import { h, genreSticker, metricRow, prefersReducedMotion } from '../dom.js';
import { genreIcon } from '../icons.js';
import { sizedImageUrl } from '../../../assets/js/media.js';
import { cueColor, currentTitle, mainTopics, refYear } from './common.js';
import { cueTitle } from './live.js';
import { formatDateTime } from '../../../assets/js/core.js';

const W = 1920;
const H = 1080;

export function renderOnair(app) {
  const wk = app.weekState();
  const live = wk.live;
  const cue = app.cues[live.index] || null;
  const waiting = live.startedAt == null && !Object.keys(live.status).length && live.index === 0;
  const color = waiting ? 'main' : cue ? cueColor(app, cue) : 'white';
  const vp = h('div', { class: 'oa-viewport' });
  const stage = h('div', { class: `oa-stage oa-${color}`, id: 'oa-stage', dataset: { cue: cue ? cue.id : 'end', waiting: String(waiting) } });
  const def = cue ? cornerDef(cue.cornerKey) : null;

  stage.append(h('header', { class: 'oa-top' },
    h('span', { class: 'oa-pill oa-pill-show' }, app.saved.showName),
    !waiting && def ? h('span', { class: `oa-pill g-${color}` }, genreIcon(color), def.name, cue.kind === 'topic' && cue.of > 1 ? ` ${cue.n}/${cue.of}` : '') : null,
    h('span', { class: 'oa-date' }, `${app.weekKey.slice(5).replace('-', '/')}(土) 配信`),
    app.isSample ? h('span', { class: 'oa-pill oa-sample' }, 'サンプル') : null));

  const body = h('div', { class: 'oa-body' });
  if (waiting) body.append(titleScreen(app, 'まもなく配信開始'));
  else if (!cue) body.append(titleScreen(app, 'ご視聴ありがとうございました'));
  else body.append(cueBody(app, cue, wk, color));
  stage.append(body);

  // 進行の帯（コーナー）
  const foot = h('footer', { class: 'oa-foot' });
  const curCorner = cue ? cue.cornerKey : null;
  for (const c of wk.rundown.corners) {
    const d = cornerDef(c.key);
    foot.append(h('span', { class: `oa-step${c.key === curCorner && !waiting ? ' is-current' : ''}` }, d.name));
  }
  stage.append(foot);

  // コーナーが切り替わったらタイトルカード
  const cornerKey = waiting ? null : curCorner;
  if (cornerKey && app.ui.oaLastCorner !== cornerKey) {
    const card = h('div', { class: `oa-card g-${color}${prefersReducedMotion() ? '' : ' is-anim'}`, attrs: { 'aria-hidden': 'true' } },
      h('span', { class: 'oa-card-icon' }, genreIcon(color)),
      h('p', { class: 'oa-card-name' }, def.name),
      h('p', { class: 'oa-card-sub' }, def.sub));
    stage.append(card);
    setTimeout(() => card.remove(), 2600);
  }
  app.ui.oaLastCorner = cornerKey;

  vp.append(stage);
  scaleStage(stage);
  return vp;
}

function titleScreen(app, sub) {
  return h('div', { class: 'oa-title' },
    h('p', { class: 'oa-title-sub' }, sub),
    h('h1', { class: 'oa-title-main' }, currentTitle(app)));
}

function cueBody(app, cue, wk, color) {
  const def = cornerDef(cue.cornerKey);
  if (cue.kind === 'topic') {
    const t = app.topicsById.get(cue.topicId);
    if (!t) return h('div', { class: 'oa-title' }, h('h1', { class: 'oa-title-main' }, def.name));
    const st = t.stats;
    const left = h('div', { class: `oa-news g-${color}` },
      h('div', { class: 'oa-news-top' }, genreSticker(t.genre)),
      h('h1', { class: 'oa-headline' }, t.name),
      h('div', { class: 'oa-nums' },
        num('投稿', st.count ? `${st.count}件` : UNKNOWN),
        num('合計表示', formatCompact(st.totalImp)),
        num('最大', formatCompact(st.maxImp))));
    const p = st.topPostId ? app.postsById.get(st.topPostId) : null;
    const right = p ? postPanel(app, p) : h('div', { class: 'oa-post is-empty' }, h('p', {}, 'くわしくは X で'));
    return h('div', { class: 'oa-split' }, left, right);
  }
  if (cue.cornerKey === 'opening') {
    const mains = mainTopics(app);
    return h('div', { class: 'oa-list-wrap' },
      h('h1', { class: 'oa-title-main is-small' }, currentTitle(app)),
      h('p', { class: 'oa-list-head' }, '今週の3大ニュース'),
      h('ol', { class: 'oa-list' }, mains.map((t, i) => h('li', { class: 'g-main' }, h('span', { class: 'oa-no' }, String(i + 1)), t.name))));
  }
  if (cue.kind === 'review') {
    const wr = app.reports ? pickWeeklyReport(app.reports.weekly, app.week) : null;
    const rows = wr ? [...wr.byCondition, ...wr.byPace].slice(0, 5) : [];
    return h('div', { class: 'oa-list-wrap' },
      h('h1', { class: 'oa-title-main is-small' }, '今週の答え合わせ'),
      rows.length
        ? h('ul', { class: 'oa-hits' }, rows.map((r) => h('li', {}, h('span', {}, r.label ?? UNKNOWN), h('b', {}, hitRateText(r.total, r.crossed)))))
        : h('p', { class: 'oa-list-head' }, '今週のまとめは準備中です'));
  }
  if (cue.cornerKey === 'ending') {
    return h('div', { class: 'oa-list-wrap' },
      h('h1', { class: 'oa-title-main is-small' }, 'ご視聴ありがとうございました'),
      wk.carriedOut.length ? h('p', { class: 'oa-list-head' }, '来週もこの話題を追いかけます') : null,
      wk.carriedOut.length ? h('ul', { class: 'oa-list' }, wk.carriedOut.slice(0, 4).map((c) => h('li', { class: `g-${c.genre}` }, c.name))) : null);
  }
  return h('div', { class: 'oa-title' }, h('span', { class: 'oa-big-icon' }, genreIcon(color)), h('h1', { class: 'oa-title-main' }, cue.kind === 'empty' ? def.name : cueTitle(app, cue)), h('p', { class: 'oa-title-sub' }, def.sub));
}

function num(label, value) {
  return h('div', { class: 'oa-num' }, h('span', { class: 'oa-num-k' }, label), h('span', { class: 'oa-num-v' }, value));
}

function postPanel(app, p) {
  const panel = h('article', { class: 'oa-post' },
    h('header', { class: 'oa-post-head' }, h('span', { class: 'oa-post-user' }, p.user ? `@${p.user}` : UNKNOWN), h('time', {}, formatDateTime(p.created_jst, p.ts, refYear(app)))),
    h('p', { class: 'oa-post-text' }, p.text || ''));
  const m = (p.media || []).find((x) => (x.type === 'photo' ? x.url : x.preview));
  if (m) {
    const img = h('img', { class: 'oa-post-img', alt: m.alt || '添付画像', decoding: 'async', referrerPolicy: 'no-referrer' });
    img.addEventListener('error', () => img.remove());
    img.src = sizedImageUrl(m.type === 'photo' ? m.url : m.preview, 'small');
    panel.append(img);
  }
  panel.append(metricRow(p));
  return panel;
}

function scaleStage(stage) {
  const s = Math.min(window.innerWidth / W, window.innerHeight / H) || 1;
  stage.style.transform = `scale(${s})`;
}

export function tickOnair(app, resized = false) {
  const stage = document.getElementById('oa-stage');
  if (stage && resized) scaleStage(stage);
}
