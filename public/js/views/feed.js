// フィード（#/feed）
import { get, post as apiPost, store } from '../api.js';
import { state, canWrite, refreshStatus } from '../state.js';
import { postCard } from '../card.js';
import {
  h, icon, mount, button, segmented, selectEl, toggle, emptyEl, errorEl, skeletonList, debounce, toast, toastError, exactNum,
} from '../ui.js';

export const RANKING_NOTE = '取得した候補内の順位です（X全体の順位ではありません）';
const PAGE = 50;
const GENRES = [['nightlife', '夜職'], ['general', '一般'], ['all', 'すべて']];
const SORTS = [['score', 'スコア'], ['views', '表示回数'], ['likes', 'いいね'], ['newest', '新着']];
const PERIODS = [['day', '24時間'], ['week', '7日'], ['month', '30日'], ['all', '全期間']];
const pick = (v, list, d) => (list.some(([k]) => k === v) ? v : d);

export async function render(root, ctx) {
  const q = ctx.route.query;
  const st = {
    genre: pick(store.get('feed.genre'), GENRES, 'nightlife'),
    sort: pick(store.get('feed.sort'), SORTS, 'score'),
    period: pick(store.get('feed.period'), PERIODS, 'week'),
    includeHidden: !!store.get('feed.includeHidden', false),
    q: q.get('q') || '',
    topicId: q.get('topicId') || '',
    topicLabel: q.get('topicLabel') || '',
    offset: 0,
  };
  // トピックから来た場合は対象を広く（ジャンル・期間で取りこぼさない）
  if (st.topicId) { st.genre = 'all'; st.period = 'all'; }
  const save = () => {
    if (st.topicId) return;
    store.set('feed.genre', st.genre); store.set('feed.sort', st.sort);
    store.set('feed.period', st.period); store.set('feed.includeHidden', st.includeHidden);
  };

  const list = h('div', { class: 'post-list', attrs: { 'aria-live': 'polite', 'aria-busy': 'false' } });
  const summary = h('p', { class: 'list-summary' });
  const note = h('p', { class: 'ranking-note' }, icon('alert'), h('span', { text: RANKING_NOTE }));
  const more = h('div', { class: 'more' });
  let abort = null;
  let lastItems = [];

  const searchInput = h('input', {
    type: 'search', class: 'input input-search', value: st.q, id: 'feed-q',
    attrs: { placeholder: '本文・投稿者・キーワードで検索', 'aria-label': '投稿を検索', enterkeyhint: 'search' },
  });
  searchInput.addEventListener('input', debounce(() => { st.q = searchInput.value.trim(); reload(); }, 350));
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { st.q = searchInput.value.trim(); reload(); } });

  const topicChip = st.topicId ? h('div', { class: 'filter-chip' },
    icon('topics'), h('span', { text: `トピック：${st.topicLabel || st.topicId}` }),
    h('a', { class: 'icon-btn', href: '#/feed', attrs: { 'aria-label': 'トピックの絞り込みを解除' } }, icon('close'))) : null;

  const filters = h('div', { class: 'filters' },
    segmented('genre', GENRES, st.genre, (v) => { st.genre = v; save(); reload(); }, { ariaLabel: 'ジャンル', cls: 'seg-genre' }),
    h('div', { class: 'filter-row' },
      h('label', { class: 'select-wrap' }, h('span', { class: 'select-label', text: '並べ替え' }),
        selectEl(SORTS, st.sort, { ariaLabel: '並べ替え', onChange: (v) => { st.sort = v; save(); reload(); } })),
      h('label', { class: 'select-wrap' }, h('span', { class: 'select-label', text: '期間' }),
        selectEl(PERIODS, st.period, { ariaLabel: '期間', onChange: (v) => { st.period = v; save(); reload(); } }))),
    h('div', { class: 'filter-row' },
      h('div', { class: 'search-wrap' }, icon('search'), searchInput),
      toggle('非表示を含める', st.includeHidden, (v) => { st.includeHidden = v; save(); reload(); })),
    topicChip);

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', { class: 'page-title', text: 'フィード' }),
        h('p', { class: 'page-sub', text: '集めた投稿を指標で並べて、業界の動きと投稿ネタを探します。' })),
      h('div', { class: 'page-actions' }, button('', { iconName: 'refresh', ariaLabel: '再読み込み', title: '再読み込み', onClick: () => reload() }))),
    filters, note, summary, list, more);

  async function load(append = false) {
    if (abort) abort.abort();
    abort = new AbortController();
    const signal = abort.signal;
    if (!append) {
      st.offset = 0;
      list.setAttribute('aria-busy', 'true');
      mount(list, skeletonList(3));
      mount(more);
    }
    try {
      const res = await get('/posts', {
        genre: st.genre, sort: st.sort, period: st.period, topicId: st.topicId || undefined,
        q: st.q || undefined, includeHidden: st.includeHidden ? 1 : 0, limit: PAGE, offset: st.offset,
      }, { signal });
      if (!ctx.alive()) return;
      const items = Array.isArray(res.items) ? res.items : [];
      note.lastChild.textContent = res.rankingNote || RANKING_NOTE;
      lastItems = append ? lastItems.concat(items) : items;
      renderSummary(res);
      if (!append) mount(list);
      if (!lastItems.length) mount(list, emptyState(res));
      else for (const p of items) list.append(postCard(p, { onChanged: reload }));
      st.offset += items.length;
      const total = Number(res.total) || 0;
      mount(more, st.offset < total
        ? button(`さらに表示（残り ${exactNum(total - st.offset)}件）`, { onClick: () => load(true) })
        : null);
    } catch (err) {
      if (err.name === 'AbortError' || !ctx.alive()) return;
      if (append) toastError(err);
      else { mount(list, errorEl(err, () => reload())); mount(summary); }
    } finally {
      list.setAttribute('aria-busy', 'false');
    }
  }
  function reload() { return load(false); }

  function renderSummary(res) {
    const total = Number(res.total) || 0;
    const hiddenCount = Number(res.hiddenCount) || 0;
    mount(summary,
      h('span', { text: `${exactNum(total)}件` }),
      hiddenCount > 0
        ? h('span', { class: 'muted' }, ` ・ 非表示 ${exactNum(hiddenCount)}件`,
          !st.includeHidden ? h('button', { type: 'button', class: 'link-btn', text: '表示する', on: { click: () => { st.includeHidden = true; save(); render(root, ctx); } } }) : null)
        : null);
  }

  function emptyState(res) {
    const filtered = st.q || st.topicId || st.period !== 'all' || st.genre !== 'all';
    const hiddenCount = Number(res.hiddenCount) || 0;
    const nothingAtAll = state.status && !state.status.realPostCount && !state.status.samplePostCount;
    if (nothingAtAll || !filtered) {
      const actions = [];
      if (canWrite()) {
        actions.push(h('a', { class: 'btn btn-primary', href: '#/import' }, icon('import'), h('span', { text: '投稿を取り込む' })));
        actions.push(button('今すぐ収集', { iconName: 'play', onClick: runCollect }));
        if (!state.status?.samplePostCount) actions.push(button('サンプルを読み込む', { onClick: loadSample }));
      }
      return emptyEl({
        title: 'まだ投稿がありません',
        body: canWrite()
          ? '「取り込み」からURLやファイル、ブックマークレットで投稿を追加するか、「今すぐ収集」を実行してください。'
          : '管理者が投稿を取り込むと、ここに表示されます。',
        actions,
      });
    }
    const actions = [];
    if (st.period !== 'all') actions.push(button('期間を「全期間」にする', { onClick: () => { st.period = 'all'; save(); render(root, ctx); } }));
    if (st.genre !== 'all') actions.push(button('ジャンルを「すべて」にする', { onClick: () => { st.genre = 'all'; save(); render(root, ctx); } }));
    if (st.q) actions.push(button('検索をクリア', { onClick: () => { searchInput.value = ''; st.q = ''; reload(); } }));
    if (hiddenCount && !st.includeHidden) actions.push(button(`非表示の${exactNum(hiddenCount)}件を表示`, { onClick: () => { st.includeHidden = true; save(); render(root, ctx); } }));
    return emptyEl({ title: '条件に合う投稿がありません', body: '絞り込み条件をゆるめると見つかるかもしれません。', actions, iconName: 'search' });
  }

  async function runCollect() {
    try {
      const res = await apiPost('/jobs/run', { job: 'collect' });
      const r = res.run || {};
      toast(r.status === 'error' ? `収集に失敗しました：${r.message || ''}` : `収集を実行しました${r.message ? '：' + r.message : ''}`, { type: r.status === 'error' ? 'error' : 'success' });
      await refreshStatus();
      reload();
    } catch (err) { toastError(err); }
  }
  async function loadSample() {
    try {
      await apiPost('/sample/load');
      toast('サンプルを読み込みました', { type: 'success' });
      await refreshStatus();
      reload();
    } catch (err) { toastError(err); }
  }

  reload();
  return () => { if (abort) abort.abort(); };
}
