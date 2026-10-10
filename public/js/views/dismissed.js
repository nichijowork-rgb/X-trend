// 興味なし（#/dismissed）
import { get, post as apiPost } from '../api.js';
import { canWrite } from '../state.js';
import { reasonText } from '../card.js';
import {
  h, icon, mount, button, pageHead, emptyEl, errorEl, skeletonList, badge, toast, toastError, timeEl, exactNum,
  SCOPE_LABELS, EFFECT_LABELS, segmented,
} from '../ui.js';

export async function render(root, ctx) {
  let tab = 'active';
  let items = [];
  const list = h('div', { class: 'dismiss-list', attrs: { 'aria-live': 'polite' } });
  const tabsHost = h('div', { class: 'filters' });

  mount(root,
    pageHead('興味なし', '不要な投稿・投稿者・キーワード・トピックを登録して、一覧から外したり順位を下げたりします。'),
    h('p', { class: 'notice-inline' }, icon('alert'), h('span', { text: 'ツール内の表示・順位にのみ反映します。Xのおすすめやフォローは変更しません。' })),
    tabsHost, list);

  function renderTabs() {
    const active = items.filter((d) => !d.revokedAt).length;
    const revoked = items.length - active;
    mount(tabsHost, segmented('dz', [['active', `有効（${active}）`], ['revoked', `取り消し済み（${revoked}）`]], tab,
      (v) => { tab = v; renderList(); }, { ariaLabel: '表示する項目', cls: 'seg-genre seg-2' }));
  }

  function renderList() {
    const shown = items.filter((d) => (tab === 'active' ? !d.revokedAt : !!d.revokedAt));
    if (!shown.length) {
      mount(list, tab === 'active'
        ? emptyEl({
          title: '「興味なし」はまだ登録されていません',
          body: canWrite() ? 'フィードの投稿カードにある「興味なし」から登録できます。別の意味の「ホスト」やVTuberの話題などを外すのに便利です。' : '管理者が登録すると、ここに一覧が表示されます。',
          iconName: 'dismissed',
          actions: [h('a', { class: 'btn btn-secondary', href: '#/feed' }, icon('feed'), h('span', { text: 'フィードへ' }))],
        })
        : emptyEl({ title: '取り消し済みの項目はありません', iconName: 'dismissed' }));
      return;
    }
    mount(list, shown.map(item));
  }

  function item(d) {
    const writable = canWrite();
    const value = d.scope === 'author' ? `@${String(d.value || '').replace(/^@/, '')}`
      : d.scope === 'keyword' ? `「${d.value}」` : d.scope === 'post' ? `投稿ID ${d.value}` : String(d.value ?? '');
    const action = !writable ? null : d.revokedAt
      ? button('再有効化', { small: true, iconName: 'refresh', ariaLabel: `${value} の「興味なし」を再有効化`, onClick: () => act(d, 'restore') })
      : button('取り消し', { small: true, iconName: 'undo', ariaLabel: `${value} の「興味なし」を取り消す`, onClick: () => act(d, 'revoke') });
    return h('article', { class: ['card', 'dismiss-item', d.revokedAt && 'is-revoked'] },
      h('div', { class: 'dismiss-main' },
        h('div', { class: 'dismiss-badges' },
          badge(SCOPE_LABELS[d.scope] || d.scope, 'scope'),
          badge(EFFECT_LABELS[d.effect] || d.effect || '非表示', d.effect === 'demote' ? 'effect-demote' : 'effect-hide'),
          d.revokedAt ? badge('取り消し済み', 'badge-muted') : null),
        h('p', { class: 'dismiss-value', text: value }),
        h('p', { class: 'dismiss-reason' }, h('span', { class: 'muted', text: '理由：' }), h('span', { text: reasonText(d) })),
        h('p', { class: 'hint' },
          `該当 ${d.matchCount === null || d.matchCount === undefined ? '不明' : exactNum(d.matchCount) + '件'} ・ 登録 `, timeEl(d.createdAt, { relative: true }),
          d.revokedAt ? h('span', {}, ' ・ 取り消し ', timeEl(d.revokedAt, { relative: true })) : null)),
      action ? h('div', { class: 'dismiss-actions' }, action) : null);
  }

  async function act(d, kind) {
    try {
      const res = await apiPost(`/dismissals/${encodeURIComponent(d.id)}/${kind}`);
      const nd = res.dismissal || { ...d, revokedAt: kind === 'revoke' ? new Date().toISOString() : null };
      items = items.map((x) => (x.id === d.id ? nd : x));
      renderTabs(); renderList();
      toast(kind === 'revoke' ? '取り消しました' : '再有効化しました', {
        type: 'success',
        action: { label: '元に戻す', iconName: 'undo', onClick: () => act(nd, kind === 'revoke' ? 'restore' : 'revoke') },
      });
    } catch (err) { toastError(err); }
  }

  async function load() {
    mount(list, skeletonList(3));
    try {
      const res = await get('/dismissals', { includeRevoked: 1 });
      if (!ctx.alive()) return;
      items = Array.isArray(res.items) ? res.items : [];
      renderTabs(); renderList();
    } catch (err) {
      if (!ctx.alive()) return;
      mount(list, errorEl(err, load));
    }
  }
  renderTabs();
  load();
}
