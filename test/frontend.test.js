// フロントの純粋ロジックの回帰テスト（結合E2Eで見つかった不具合の再発防止）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { state, canWrite, isViewer, isUnauthenticated } from '../public/js/state.js';

test('未認証（/api/status が role:"none"）は書き込み不可・認証画面対象', () => {
  state.status = { authRequired: true, role: 'none' };
  assert.equal(canWrite(), false);
  assert.equal(isViewer(), false);
  assert.equal(isUnauthenticated(), true);
});

test('admin / viewer / ローカルモードの権限判定', () => {
  state.status = { authRequired: true, role: 'admin' };
  assert.equal(canWrite(), true);
  assert.equal(isUnauthenticated(), false);
  state.status = { authRequired: true, role: 'viewer' };
  assert.equal(canWrite(), false);
  assert.equal(isUnauthenticated(), false);
  state.status = { authRequired: false, role: 'admin' };
  assert.equal(canWrite(), true);
  state.status = null;
  assert.equal(canWrite(), false);
});

test('未認証時に「管理者」ピルを出さない（role を見て判定）', () => {
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(src, /s\.authRequired && s\.role === 'admin'\) pills\.push/);
});

test('興味なしの UI に「Xには反映されません」を明記', () => {
  for (const f of ['../public/js/card.js', '../public/js/views/dismissed.js']) {
    assert.match(readFileSync(new URL(f, import.meta.url), 'utf8'), /Xには反映されません/);
  }
});
