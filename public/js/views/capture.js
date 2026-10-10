// ブックマークレットからの取り込みプレビュー（#/capture?d=<base64url UTF-8 JSON>）
import { post as apiPost } from '../api.js';
import { canWrite, refreshStatus } from '../state.js';
import { importResult } from './import.js';
import {
  h, icon, mount, button, pageHead, emptyEl, badge, toast, exactNum, shortNum, fmtDateTime, decodeBase64UrlJson,
} from '../ui.js';

const PAGE_LABELS = { foryou: 'おすすめ', following: 'フォロー中', search: '検索結果', other: 'その他の画面' };
const PREVIEW = 5;

export async function render(root, ctx) {
  const d = ctx.route.query.get('d');
  const head = pageHead('取り込みプレビュー', 'ブックマークレットで送られた投稿を確認して取り込みます。');
  if (!d) {
    mount(root, head, emptyEl({
      title: '取り込むデータがありません',
      body: 'Xの画面でブックマークレットを実行するとここに表示されます。件数が多くJSONがコピーされた場合は、取り込み画面の貼り付け欄に貼ってください。',
      iconName: 'import',
      actions: [h('a', { class: 'btn btn-primary', href: '#/import' }, icon('import'), h('span', { text: '取り込み画面へ' }))],
    }));
    return;
  }

  let payload;
  try {
    payload = decodeBase64UrlJson(d);
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.posts)) throw new Error('posts がありません');
  } catch {
    mount(root, head, emptyEl({
      title: 'データを読み取れませんでした',
      body: 'URLが途中で切れている可能性があります。もう一度ブックマークレットを実行するか、コピーされたJSONを取り込み画面に貼り付けてください。',
      iconName: 'alert',
      actions: [h('a', { class: 'btn btn-secondary', href: '#/import' }, h('span', { text: '取り込み画面へ' }))],
    }));
    return;
  }

  const posts = payload.posts;
  const out = h('div', { class: 'result-area', attrs: { 'aria-live': 'polite' } });
  const writable = canWrite();
  let done = false;

  const importBtn = writable ? button(`${exactNum(posts.length)}件を取り込む`, {
    variant: 'primary', iconName: 'import',
    onClick: async () => {
      if (done) return;
      try {
        const res = await apiPost('/capture', { payload });
        done = true;
        importBtn.hidden = true;
        // 再読み込みで二重取り込みしないよう URL からデータを消す
        history.replaceState(null, '', location.pathname + location.search + '#/capture');
        mount(out, importResult(res));
        toast('取り込みました', { type: 'success' });
        refreshStatus();
      } catch (err) {
        mount(out, h('p', { class: 'form-error', attrs: { role: 'alert' }, text: err.message }));
      }
    },
  }) : null;

  mount(root, head,
    h('section', { class: 'panel' },
      h('dl', { class: 'kv' },
        h('dt', { text: '件数' }), h('dd', {}, h('strong', { class: 'big-num', text: `${exactNum(posts.length)}件` })),
        h('dt', { text: '取得した画面' }), h('dd', { text: PAGE_LABELS[payload.page] || payload.page || '不明' }),
        h('dt', { text: '取得日時' }), h('dd', { text: fmtDateTime(payload.capturedAt) || '不明' }),
        payload.pageUrl ? h('dt', { text: 'ページ' }) : null,
        payload.pageUrl ? h('dd', { class: 'break', text: String(payload.pageUrl) }) : null),
      payload.page === 'foryou'
        ? h('p', { class: 'hint', text: 'あなたのブラウザに表示された「おすすめ」欄の内容です（取得元：おすすめ画面取り込み）。' })
        : null,
      h('p', { class: 'notice-inline notice-safe' }, icon('lock'), h('span', { text: '画面に表示された投稿テキストのみです。Cookieや認証情報は含まれません。' })),
      writable ? h('div', { class: 'form-row' }, importBtn, h('a', { class: 'btn btn-ghost', href: '#/import', text: 'キャンセル' }))
        : h('p', { class: 'notice-inline notice-viewer' }, icon('lock'), h('span', { text: '閲覧専用のため取り込めません。管理者トークンを設定してください。' })),
      out),
    h('h2', { class: 'section-title', text: posts.length > PREVIEW ? `先頭 ${PREVIEW}件のプレビュー` : 'プレビュー' }),
    posts.length
      ? h('ul', { class: 'preview-list' }, posts.slice(0, PREVIEW).map((p) => previewItem(p, payload.page)))
      : emptyEl({ title: '投稿が含まれていません', body: 'Xの画面をスクロールして投稿を表示してから、もう一度実行してください。', iconName: 'import' }));
}

function previewItem(p, page) {
  const m = p.metrics || {};
  const metric = (label, v) => h('span', { class: v === null || v === undefined ? 'unknown' : '', attrs: { title: `${label}: ${v === null || v === undefined ? '不明' : exactNum(v)}` }, text: `${label} ${v === null || v === undefined ? '不明' : shortNum(v)}` });
  return h('li', { class: 'card preview-item' },
    h('div', { class: 'post-author' },
      h('span', { class: 'author-name', text: p.authorName || (p.authorHandle ? '@' + p.authorHandle : '投稿者不明') }),
      p.authorHandle && p.authorName ? h('span', { class: 'author-handle', text: '@' + p.authorHandle }) : null,
      page === 'foryou' ? badge('おすすめ画面取り込み', 'src src-foryou') : badge('ブックマークレット', 'src src-url')),
    h('p', { class: 'post-text clamp', text: p.text || '（本文なし）' }),
    h('p', { class: 'preview-metrics' }, metric('表示', m.views), metric('いいね', m.likes), metric('リポスト', m.reposts), metric('返信', m.replies), metric('ブックマーク', m.bookmarks)),
    h('p', { class: 'hint mono', text: `ID ${p.postId || '不明'}` }));
}
