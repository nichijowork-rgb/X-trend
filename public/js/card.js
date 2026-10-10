// 投稿カードと「興味なし」シート
import { post as apiPost } from './api.js';
import { canWrite } from './state.js';
import {
  h, icon, button, badge, toast, toastError, copyText, openDialog, nextId, timeEl,
  shortNum, exactNum, fmtDateTime, SOURCE_LABELS, SOURCE_CLASS, GENRE_LABELS, REASONS, REASON_LABELS,
} from './ui.js';

const METRICS = [
  ['views', '表示'],
  ['likes', 'いいね'],
  ['reposts', 'リポスト'],
  ['replies', '返信'],
  ['bookmarks', 'ブックマーク'],
];

export function reasonText(d) {
  const label = REASON_LABELS[d.reasonCode] || d.reasonCode || '理由なし';
  return d.reasonNote ? `${label}：${d.reasonNote}` : label;
}

function metricItem(key, label, value) {
  const known = value !== null && value !== undefined;
  const short = known ? shortNum(value) : '不明';
  return h('li', {
    class: ['metric', !known && 'metric-unknown'],
    attrs: { title: known ? `${label}: ${exactNum(value)}` : `${label}: 不明（取得できていません）` },
  },
  icon(key),
  h('span', { class: 'sr-only', text: `${label} ` }),
  h('span', { class: 'metric-val', text: short }),
  h('span', { class: 'metric-label', attrs: { 'aria-hidden': 'true' }, text: label }));
}

export function sourceBadges(sources = []) {
  const seen = new Map();
  for (const s of sources || []) {
    if (!s || !s.type) continue;
    const prev = seen.get(s.type);
    const detail = [s.detail, s.at ? `取得: ${fmtDateTime(s.at) || s.at}` : null].filter(Boolean).join(' / ');
    seen.set(s.type, prev ? `${prev}\n${detail}` : detail);
  }
  return [...seen.entries()].map(([type, detail]) =>
    badge(SOURCE_LABELS[type] || type, `src ${SOURCE_CLASS[type] || ''}`, detail ? `${SOURCE_LABELS[type] || type}\n${detail}` : SOURCE_LABELS[type] || type));
}

async function revokeAll(dismissals, onChanged) {
  try {
    for (const d of dismissals) await apiPost(`/dismissals/${encodeURIComponent(d.id)}/revoke`);
    toast('「興味なし」を取り消しました', { type: 'success' });
    onChanged && onChanged();
  } catch (err) { toastError(err); }
}

/**
 * @param {object} p Post（契約の APIレスポンス形）
 * @param {{ onChanged?: Function, showRank?: boolean }} opts
 */
export function postCard(p, { onChanged, showRank = true } = {}) {
  const writable = canWrite();
  const dismissals = Array.isArray(p.matchedDismissals) ? p.matchedDismissals : [];
  const titleId = nextId('post');

  const author = h('div', { class: 'post-author' },
    h('span', { class: 'author-name', id: titleId, text: p.authorName || (p.authorHandle ? `@${p.authorHandle}` : '投稿者不明') }),
    p.authorHandle && p.authorName ? h('span', { class: 'author-handle', text: `@${p.authorHandle}` }) : null,
    h('span', { class: 'post-time' }, timeEl(p.postedAt, { fallback: '投稿日時不明' })));

  const head = h('header', { class: 'post-head' },
    showRank && p.rank !== null && p.rank !== undefined
      ? h('span', { class: 'rank', attrs: { title: '取得した候補内の順位（X全体の順位ではありません）' } }, h('span', { class: 'sr-only', text: '候補内順位 ' }), `#${p.rank}`)
      : null,
    author);

  const badges = h('div', { class: 'post-badges' },
    p.isSample ? badge('サンプル', 'badge-sample', 'サンプルデータです（実データではありません）') : null,
    p.genre ? badge(GENRE_LABELS[p.genre] || p.genre, `genre genre-${p.genre}`) : null,
    sourceBadges(p.sources),
    p.mergedCount > 1 ? badge(`${exactNum(p.mergedCount)}件の取得元を統合`, 'badge-merged', '同じ投稿を複数の取得元から取得したため1件にまとめています') : null);

  const notices = [];
  if (p.hidden || p.demoted) {
    const reasons = dismissals.length ? dismissals.map(reasonText).join('、') : '理由不明';
    const label = p.hidden ? `非表示中（${reasons}）` : `順位を下げています（${reasons}）`;
    notices.push(h('div', { class: ['post-notice', p.hidden ? 'notice-hidden' : 'notice-demoted'] },
      icon(p.hidden ? 'eyeoff' : 'down'),
      h('span', { text: label }),
      writable && dismissals.length
        ? button('取消', { small: true, variant: 'ghost', ariaLabel: `この投稿の「興味なし」を取り消す`, onClick: () => revokeAll(dismissals, onChanged) })
        : null));
  }

  const text = p.text
    ? h('p', { class: 'post-text', text: p.text })
    : h('p', { class: 'post-text unknown', text: '（本文を取得できていません）' });

  const tags = [];
  if (p.topicId || p.topicLabel) {
    tags.push(h('a', {
      class: 'chip chip-topic',
      href: p.topicId ? `#/feed?topicId=${encodeURIComponent(p.topicId)}&topicLabel=${encodeURIComponent(p.topicLabel || '')}` : undefined,
      attrs: { title: 'このトピックの投稿だけを表示' },
    }, icon('topics'), h('span', { text: p.topicLabel || 'トピック' })));
  }
  for (const k of (p.matchedKeywords || []).slice(0, 6)) tags.push(h('span', { class: 'chip chip-kw', text: k }));

  const metrics = h('ul', { class: 'metrics', attrs: { 'aria-label': '指標' } },
    METRICS.map(([k, label]) => metricItem(k, label, p.metrics ? p.metrics[k] : null)));

  const fetched = fmtDateTime(p.metricsFetchedAt);
  const meta = h('p', { class: 'post-meta' },
    fetched
      ? h('span', {}, '数値取得: ', h('time', { attrs: { datetime: p.metricsFetchedAt }, text: fetched }))
      : h('span', { class: 'unknown', text: '数値取得: 不明' }));

  const actions = h('div', { class: 'post-actions' },
    h('button', {
      type: 'button', class: 'btn btn-ghost btn-sm id-btn',
      attrs: { 'aria-label': `投稿ID ${p.postId} をコピー`, title: '投稿IDをコピー' },
      on: { click: () => copyText(String(p.postId), '投稿IDをコピーしました') },
    }, icon('copy'), h('span', { class: 'mono', text: `ID ${p.postId}` })),
    p.url ? h('a', {
      class: 'btn btn-ghost btn-sm', href: p.url, target: '_blank', rel: 'noopener noreferrer',
      attrs: { 'aria-label': '元投稿をXで開く（新しいタブ）' },
    }, icon('external'), h('span', { text: '元投稿' })) : null,
    writable ? button('興味なし', {
      small: true, variant: 'ghost', iconName: 'dismissed', cls: 'btn-dismiss',
      ariaLabel: 'この投稿に「興味なし」を設定',
      onClick: () => openDismissSheet(p, { onChanged }),
    }) : null);

  return h('article', {
    class: ['card', 'post-card', p.hidden && 'is-hidden', p.demoted && 'is-demoted'],
    attrs: { 'aria-labelledby': titleId },
  }, head, badges, notices, text, tags.length ? h('div', { class: 'post-tags' }, tags) : null, metrics, meta, actions);
}

/* ---------- 興味なしシート ---------- */
function radioGroup(name, legend, options, value, onChange) {
  const fs = h('fieldset', { class: 'radio-group' }, h('legend', { text: legend }));
  for (const opt of options) {
    const [v, label, extra = {}] = opt;
    const id = nextId(name);
    const input = h('input', { type: 'radio', name, id, value: v, checked: v === value, disabled: extra.disabled });
    input.addEventListener('change', () => input.checked && onChange(v));
    fs.append(h('label', { class: ['radio-row', extra.disabled && 'is-disabled'], attrs: { for: id } },
      input, h('span', { class: 'radio-text' }, h('span', { text: label }), extra.hint ? h('small', { class: 'hint', text: extra.hint }) : null)));
  }
  return fs;
}

export function openDismissSheet(p, { onChanged } = {}) {
  const groupName = nextId('dz');
  const st = { scope: 'post', reasonCode: 'off_topic', effect: 'hide', keyword: (p.matchedKeywords || [])[0] || '' };

  const kwInput = h('input', { type: 'text', class: 'input', value: st.keyword, maxLength: 100, attrs: { placeholder: '例：ロイヤルホスト', autocomplete: 'off' } });
  kwInput.addEventListener('input', () => { st.keyword = kwInput.value; err.textContent = ''; });
  const setKw = (v) => { kwInput.value = v; st.keyword = v; err.textContent = ''; };

  const sourceText = h('p', { class: 'select-source', text: p.text || '（本文なし）', attrs: { tabindex: '0', 'aria-label': '投稿本文（語句をドラッグで選択するとキーワード欄に入ります）' } });
  const pickSelection = () => {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed) return;
    if (!sourceText.contains(sel.anchorNode) || !sourceText.contains(sel.focusNode)) return;
    const v = sel.toString().trim().slice(0, 100);
    if (v) setKw(v);
  };
  sourceText.addEventListener('mouseup', pickSelection);
  sourceText.addEventListener('touchend', () => setTimeout(pickSelection, 50));
  sourceText.addEventListener('keyup', pickSelection);

  const kwBox = h('div', { class: 'kw-box', hidden: true },
    h('label', { attrs: { for: (kwInput.id = nextId('kw')) }, text: 'キーワード' }),
    kwInput,
    (p.matchedKeywords || []).length
      ? h('div', { class: 'chip-row' }, h('span', { class: 'hint', text: '一致した語：' }),
        (p.matchedKeywords || []).map((k) => h('button', { type: 'button', class: 'chip chip-btn', text: k, on: { click: () => setKw(k) } })))
      : null,
    h('p', { class: 'hint', text: '下の本文から語句をドラッグで選択しても入力できます。' }),
    sourceText);

  const err = h('p', { class: 'form-error', attrs: { role: 'alert' } });

  const scopes = [
    ['post', 'この投稿', { hint: `ID ${p.postId}` }],
    ['author', 'この投稿者', { hint: p.authorHandle ? `@${p.authorHandle} の投稿すべて` : '投稿者が不明なため選べません', disabled: !p.authorHandle }],
    ['keyword', 'キーワード', { hint: 'この語を含む投稿' }],
    ['topic', 'このトピック', { hint: p.topicId ? (p.topicLabel || p.topicId) : 'トピック未分類のため選べません', disabled: !p.topicId }],
  ];
  const scopeGroup = radioGroup(groupName + '-scope', '対象', scopes, st.scope, (v) => {
    st.scope = v; kwBox.hidden = v !== 'keyword'; err.textContent = '';
    if (v === 'keyword') kwInput.focus();
  });
  const reasonGroup = radioGroup(groupName + '-reason', '理由', REASONS, st.reasonCode, (v) => { st.reasonCode = v; });
  const note = h('textarea', { class: 'input', rows: 2, maxLength: 500, attrs: { placeholder: '任意：あとで見返すためのメモ' } });
  const effectGroup = radioGroup(groupName + '-effect', '効果', [
    ['hide', '非表示', { hint: '一覧に出さない（「非表示を含める」で確認可）' }],
    ['demote', '順位を下げる', { hint: '表示はするが下位に並べる' }],
  ], st.effect, (v) => { st.effect = v; });

  const body = h('div', { class: 'dismiss-form' },
    h('p', { class: 'notice-inline' }, icon('alert'), h('span', { text: 'ツール内の表示・順位にのみ反映します。Xには反映されません（Xのおすすめやフォローは変わりません）。' })),
    scopeGroup, kwBox, reasonGroup,
    h('div', { class: 'field' }, h('label', { attrs: { for: (note.id = nextId('note')) }, text: 'メモ（任意）' }), note),
    effectGroup, err);

  const submit = button('登録する', {
    variant: 'primary',
    onClick: async () => {
      let value;
      if (st.scope === 'post') value = String(p.postId);
      else if (st.scope === 'author') value = p.authorHandle;
      else if (st.scope === 'topic') value = p.topicId;
      else value = (st.keyword || '').trim();
      if (!value) {
        err.textContent = st.scope === 'keyword' ? 'キーワードを入力してください。' : '対象を選んでください。';
        if (st.scope === 'keyword') kwInput.focus();
        return;
      }
      try {
        const res = await apiPost('/dismissals', {
          scope: st.scope, value, reasonCode: st.reasonCode,
          reasonNote: note.value.trim() || undefined, effect: st.effect,
        });
        const d = res.dismissal;
        dlg.close();
        onChanged && onChanged();
        toast(`「興味なし」に登録しました（${st.effect === 'hide' ? '非表示' : '順位を下げる'}）`, {
          type: 'success',
          action: d && d.id ? {
            label: '元に戻す', iconName: 'undo',
            onClick: async () => {
              try {
                await apiPost(`/dismissals/${encodeURIComponent(d.id)}/revoke`);
                toast('元に戻しました', { type: 'success', timeout: 2500 });
                onChanged && onChanged();
              } catch (e) { toastError(e); }
            },
          } : undefined,
        });
      } catch (e) {
        err.textContent = e.message;
      }
    },
  });
  const cancel = button('キャンセル', { onClick: () => dlg.close() });
  const dlg = openDialog({ title: '興味なし', body, footer: [cancel, submit] });
}
