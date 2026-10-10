// まとめ（#/digests, #/digests/:id）
import { get, post as apiPost, store } from '../api.js';
import { canWrite, refreshStatus } from '../state.js';
import { postCard } from '../card.js';
import {
  h, icon, mount, segmented, emptyEl, errorEl, skeletonList, loadingEl, badge, button, toast, toastError,
  fmtDateTime, fmtDay, pageHead, GENRE_LABELS,
} from '../ui.js';

const KINDS = [['daily', '日次'], ['weekly', '週次'], ['all', 'すべて']];
const KIND_LABELS = { daily: '日次', weekly: '週次' };
const SUMMARY_BY = { grok: 'Grokによる要約', rule: '自動集計' };

export async function render(root, ctx) {
  const id = ctx.route.parts[0];
  return id ? renderDetail(root, ctx, id) : renderList(root, ctx);
}

function periodText(d) {
  const a = fmtDay(d.periodStart), b = fmtDay(d.periodEnd);
  if (!a && !b) return '';
  return d.kind === 'daily' || a === b ? a : `${a} 〜 ${b}`;
}
function summaryByBadge(by) {
  return badge(SUMMARY_BY[by] || (by ? by : '作成方法不明'), by === 'grok' ? 'badge-grok' : 'badge-rule',
    by === 'grok' ? 'Grok（xAI）が要約した文章です' : '集計ルールで自動作成したまとめです');
}

async function renderList(root, ctx) {
  let kind = store.get('digests.kind', 'all');
  if (!KINDS.some(([k]) => k === kind)) kind = 'all';
  const list = h('div', { class: 'digest-list', attrs: { 'aria-live': 'polite' } });

  const runJob = (job, label) => async () => {
    try {
      const res = await apiPost('/jobs/run', { job });
      const r = res.run || {};
      if (r.status === 'error') toast(`${label}の作成に失敗しました：${r.message || ''}`, { type: 'error' });
      else if (r.status === 'skipped') toast(`${label}はスキップされました${r.message ? '：' + r.message : ''}`);
      else toast(`${label}を作成しました`, { type: 'success' });
      refreshStatus();
      load();
    } catch (err) { toastError(err); }
  };

  mount(root,
    pageHead('まとめ', '日次・週次で話題と注目投稿をまとめます。',
      canWrite() ? button('日次を作成', { small: true, iconName: 'play', onClick: runJob('daily_digest', '日次まとめ') }) : null,
      canWrite() ? button('週次を作成', { small: true, iconName: 'play', onClick: runJob('weekly_digest', '週次まとめ') }) : null),
    h('div', { class: 'filters' },
      segmented('dkind', KINDS, kind, (v) => { kind = v; store.set('digests.kind', v); load(); }, { ariaLabel: '種類', cls: 'seg-genre' })),
    list);

  async function load() {
    mount(list, skeletonList(3));
    try {
      const res = await get('/digests', { kind: kind === 'all' ? undefined : kind });
      if (!ctx.alive()) return;
      const items = Array.isArray(res.items) ? res.items : [];
      if (!items.length) {
        mount(list, emptyEl({
          title: 'まとめはまだありません',
          body: canWrite()
            ? '設定したスケジュールで自動作成されます。今すぐ作るには右上の「日次を作成」「週次を作成」を押してください。'
            : '管理者のスケジュールに沿って自動で作成されます。',
          iconName: 'digests',
        }));
        return;
      }
      mount(list, items.map((d) => h('a', { class: 'card digest-item', href: `#/digests/${encodeURIComponent(d.id)}` },
        h('div', { class: 'digest-badges' },
          badge(KIND_LABELS[d.kind] || d.kind, `kind kind-${d.kind}`),
          summaryByBadge(d.summaryBy),
          d.isSample ? badge('サンプル', 'badge-sample') : null),
        h('h2', { class: 'digest-title', text: d.title || `${KIND_LABELS[d.kind] || ''}まとめ` }),
        h('p', { class: 'digest-meta' },
          h('span', { text: periodText(d) }),
          d.createdAt ? h('span', { class: 'muted', text: ` ・ 作成 ${fmtDateTime(d.createdAt) || ''}` }) : null),
        h('span', { class: 'topic-go' }, h('span', { text: '詳細' }), icon('chevron')))));
    } catch (err) {
      if (!ctx.alive()) return;
      mount(list, errorEl(err, load));
    }
  }
  load();
}

async function renderDetail(root, ctx, id) {
  const back = h('a', { class: 'back-link', href: '#/digests' }, icon('back'), h('span', { text: 'まとめ一覧へ' }));
  mount(root, back, loadingEl());
  let d;
  try {
    const res = await get(`/digests/${encodeURIComponent(id)}`);
    d = res.digest;
  } catch (err) {
    if (!ctx.alive()) return;
    mount(root, back, err.status === 404
      ? emptyEl({ title: 'このまとめは見つかりません', body: '削除されたか、URLが間違っている可能性があります。', iconName: 'digests' })
      : errorEl(err, () => renderDetail(root, ctx, id)));
    return;
  }
  if (!ctx.alive()) return;
  if (!d) { mount(root, back, emptyEl({ title: 'このまとめは見つかりません', iconName: 'digests' })); return; }

  const sections = Array.isArray(d.sections) ? d.sections : [];
  const reload = () => renderDetail(root, ctx, id);
  mount(root,
    back,
    h('header', { class: 'digest-head' },
      h('div', { class: 'digest-badges' },
        badge(KIND_LABELS[d.kind] || d.kind, `kind kind-${d.kind}`), summaryByBadge(d.summaryBy),
        d.isSample ? badge('サンプル', 'badge-sample') : null),
      h('h1', { class: 'page-title', text: d.title || `${KIND_LABELS[d.kind] || ''}まとめ` }),
      h('p', { class: 'page-sub', text: [periodText(d), d.createdAt ? `作成 ${fmtDateTime(d.createdAt)}` : ''].filter(Boolean).join(' ・ ') })),
    d.summaryText
      ? h('section', { class: 'panel summary-text', attrs: { 'aria-label': '要約' } },
        h('h2', { class: 'panel-title' }, h('span', { text: SUMMARY_BY[d.summaryBy] || '要約' })),
        h('p', { class: 'prewrap', text: d.summaryText }))
      : h('p', { class: 'muted', text: '要約文はありません。' }),
    sections.length
      ? h('nav', { class: 'toc', attrs: { 'aria-label': 'セクション' } },
        sections.map((s, i) => h('a', { class: 'chip', href: `#/digests/${encodeURIComponent(id)}`, on: { click: (e) => { e.preventDefault(); document.getElementById(`sec-${i}`)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); } } },
          h('span', { text: s.genreLabel || GENRE_LABELS[s.genre] || s.genre || 'セクション' }))))
      : null,
    sections.length
      ? sections.map((s, i) => h('section', { class: 'digest-section', id: `sec-${i}` },
        h('h2', { class: 'section-title', text: s.genreLabel || GENRE_LABELS[s.genre] || s.genre || 'セクション' }),
        (s.topics || []).length
          ? (s.topics || []).map((t) => h('div', { class: 'digest-topic' },
            h('h3', { class: 'digest-topic-label' }, icon('topics'), h('span', { text: t.label || '（ラベルなし）' }),
              h('span', { class: 'muted', text: ` ${(t.posts || []).length}件` })),
            h('div', { class: 'post-list' }, (t.posts || []).map((p) => postCard(p, { onChanged: reload, showRank: false })))))
          : h('p', { class: 'muted', text: 'このセクションにはトピックがありません。' })))
      : emptyEl({ title: 'このまとめには投稿がありません', body: '対象期間に投稿が集まっていなかった可能性があります。', iconName: 'digests' }));
}
