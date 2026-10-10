// トピック（#/topics）
import { get, store } from '../api.js';
import { canWrite } from '../state.js';
import { h, icon, mount, segmented, selectEl, emptyEl, errorEl, skeletonList, badge, timeEl, shortNum, exactNum, GENRE_LABELS, pageHead } from '../ui.js';

const GENRES = [['nightlife', '夜職'], ['general', '一般'], ['all', 'すべて']];
const PERIODS = [['day', '24時間'], ['week', '7日'], ['month', '30日'], ['all', '全期間']];
const pick = (v, list, d) => (list.some(([k]) => k === v) ? v : d);

export async function render(root, ctx) {
  const st = {
    genre: pick(store.get('topics.genre'), GENRES, 'all'),
    period: pick(store.get('topics.period'), PERIODS, 'week'),
  };
  const list = h('div', { class: 'topic-grid', attrs: { 'aria-live': 'polite' } });
  let abort = null;

  mount(root,
    pageHead('トピック', '同じ話題の投稿をまとめたグループです。タップすると該当投稿を表示します。'),
    h('div', { class: 'filters' },
      segmented('tgenre', GENRES, st.genre, (v) => { st.genre = v; store.set('topics.genre', v); load(); }, { ariaLabel: 'ジャンル', cls: 'seg-genre' }),
      h('div', { class: 'filter-row' },
        h('label', { class: 'select-wrap' }, h('span', { class: 'select-label', text: '期間' }),
          selectEl(PERIODS, st.period, { ariaLabel: '期間', onChange: (v) => { st.period = v; store.set('topics.period', v); load(); } })))),
    list);

  async function load() {
    if (abort) abort.abort();
    abort = new AbortController();
    mount(list, skeletonList(4));
    try {
      const res = await get('/topics', { genre: st.genre, period: st.period }, { signal: abort.signal });
      if (!ctx.alive()) return;
      const items = Array.isArray(res.items) ? res.items : [];
      if (!items.length) {
        mount(list, emptyEl({
          title: 'トピックがまだありません',
          body: st.period !== 'all'
            ? 'この期間にはトピックがありません。期間を広げるか、投稿を取り込むと自動でまとまります。'
            : '投稿が集まると、同じ話題の投稿が自動でトピックにまとまります。',
          iconName: 'topics',
          actions: [
            st.period !== 'all' ? h('button', { type: 'button', class: 'btn btn-secondary', text: '期間を「全期間」にする', on: { click: () => { st.period = 'all'; store.set('topics.period', 'all'); render(root, ctx); } } }) : null,
            canWrite() ? h('a', { class: 'btn btn-primary', href: '#/import' }, icon('import'), h('span', { text: '投稿を取り込む' })) : null,
          ].filter(Boolean),
        }));
        return;
      }
      mount(list, items.map(topicCard));
    } catch (err) {
      if (err.name === 'AbortError' || !ctx.alive()) return;
      mount(list, errorEl(err, load));
    }
  }

  load();
  return () => abort && abort.abort();
}

function topicCard(t) {
  const href = `#/feed?topicId=${encodeURIComponent(t.id)}&topicLabel=${encodeURIComponent(t.label || '')}`;
  const likes = t.totalLikes === null || t.totalLikes === undefined
    ? h('span', { class: 'unknown', text: 'いいね合計 不明' })
    : h('span', { attrs: { title: `いいね合計: ${exactNum(t.totalLikes)}` }, text: `いいね合計 ${shortNum(t.totalLikes)}` });
  return h('a', { class: 'card topic-card', href, attrs: { 'aria-label': `${t.label || 'トピック'}（${exactNum(t.postCount)}件）の投稿を見る` } },
    h('div', { class: 'topic-top' },
      t.genre ? badge(GENRE_LABELS[t.genre] || t.genre, `genre genre-${t.genre}`) : null,
      h('span', { class: 'topic-count', text: `${exactNum(t.postCount ?? (t.postIds || []).length)}件` })),
    h('h2', { class: 'topic-label', text: t.label || '（ラベルなし）' }),
    (t.keywords || []).length ? h('div', { class: 'chip-row' }, t.keywords.slice(0, 8).map((k) => h('span', { class: 'chip chip-kw', text: k }))) : null,
    h('div', { class: 'topic-meta' },
      h('span', {}, '最新 ', timeEl(t.latestAt, { relative: true })),
      likes),
    h('span', { class: 'topic-go' }, h('span', { text: '投稿を見る' }), icon('chevron')));
}
