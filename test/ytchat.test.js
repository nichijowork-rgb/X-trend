// YouTube ライブのコメント（show/js/ytchat.js）と流れるコメントの列（show/js/lanes.js）の単体テスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVideoId, validKey, looksLikeGoogleKey, safeIcon, initialOf, inkFor, cleanText, screenText, normalizeChatItem, normalizeChatResponse, liveChatIdOf, classifyApiError,
  videosUrl, messagesUrl, quotaUnits, quotaPerHour, normalizeNg, parseNgWords, ngMatcher, applyChatBatch, sanitizeChatCfg, parseChatPrefs, restorePin,
  wireItem, buildChatMessage, createChatReceiver, createChatPoller, demoChatItem, demoChatPin,
  CHAT_CFG_DEFAULTS, CHAT_INTERVALS, CHAT_STALE_MS, CHAT_PIN_BOX, CHAT_PIN_RESTORE_MS, YT_API,
  createJsonArrayParser, createStreamBodyReader, streamErrorDecision, streamUrl, createChatClient, STREAM_BACKOFF_MS, applyChatOverrides,
  parseChannelInput, channelsUrl, channelInfoOf, playlistItemsUrl, videosDetailUrl, searchLiveUrl, videoIdsOf, pickActiveLive, createLiveFinder, FINDER_WAIT_TEXT,
  pinBoxHeight,
} from '../show/js/ytchat.js';
import { createLaneScheduler, lanesOverlapping, laneY, laneH, laneTop, travelMs, laneBusyMs, pxPerMs, LANE_GAP, QUEUE_MAX } from '../show/js/lanes.js';

const KEY = 'AIzaSyA-test_key_0123456789abcdefghij';

test('動画 ID: watch?v= / youtu.be / live / shorts / embed / studio / m. / 11 文字 ID。それ以外は null', () => {
  const id = 'dQw4w9WgXcQ';
  for (const u of [
    id, ` ${id} `,
    `https://www.youtube.com/watch?v=${id}`, `https://youtube.com/watch?v=${id}&t=30s`, `youtube.com/watch?feature=share&v=${id}`,
    `https://youtu.be/${id}`, `https://youtu.be/${id}?si=abc`, `youtu.be/${id}`,
    `https://www.youtube.com/live/${id}`, `https://www.youtube.com/live/${id}?feature=share`, `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`, `https://studio.youtube.com/video/${id}/livestreaming`, `https://studio.youtube.com/video/${id}/edit`,
    `https://m.youtube.com/watch?v=${id}`, `http://m.youtube.com/live/${id}`,
  ]) assert.equal(parseVideoId(u), id, u);
  for (const u of ['', null, 'abc', `${id}x`, 'https://example.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/@channel', 'https://www.youtube.com/watch?v=short',
    `javascript:alert(1)//youtu.be/${id}`, 'https://youtu.be/', `https://studio.youtube.com/channel/${id}`]) assert.equal(parseVideoId(u), null, String(u));
});

test('API キーの形・アイコンの URL（YouTube の画像置き場の https だけ）・頭文字・文字色', () => {
  assert.ok(validKey(KEY));
  for (const k of ['', 'short', `${KEY} x`, 'あいうえおかきくけこさしすせそたちつてとなにぬねの', null]) assert.ok(!validKey(k), String(k));
  assert.equal(safeIcon('https://yt3.ggpht.com/abc=s64-c-k'), 'https://yt3.ggpht.com/abc=s64-c-k');
  for (const h of ['yt4.ggpht.com', 'yt3.googleusercontent.com', 'lh3.googleusercontent.com']) assert.ok(safeIcon(`https://${h}/x.jpg`), h);
  for (const u of ['http://yt3.ggpht.com/x', 'https://evil.example/x.png', 'https://yt3.ggpht.com.evil.example/x', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'https://user:pw@yt3.ggpht.com/x', 'https://yt3.ggpht.com:8443/x', 42, null]) {
    assert.equal(safeIcon(u), null, String(u));
  }
  assert.equal(initialOf('@mio_cabajo'), 'M');
  assert.equal(initialOf('みお'), 'み');
  assert.equal(initialOf(''), '?');
  assert.equal(inkFor('#ffca28'), '#111111');
  assert.equal(inkFor('#1e88e5'), '#ffffff');
  assert.equal(inkFor('bad'), '#ffffff');
});

test('文字の整え方: 改行・制御文字・向きを変える文字を外し、画面用は 60 文字で …', () => {
  assert.equal(cleanText('a\nb\tc‮d​e\u0007'), 'a b cde');
  assert.equal(screenText('あ'.repeat(60)), 'あ'.repeat(60));
  const long = screenText('い'.repeat(61));
  assert.equal(Array.from(long).length, 60);
  assert.ok(long.endsWith('…'));
  assert.equal(Array.from(screenText('😀'.repeat(70))).length, 60, '絵文字はコードポイントで数える');
});

const author = (o = {}) => ({ channelId: 'UCabc', displayName: '@mio_cabajo', profileImageUrl: 'https://yt3.ggpht.com/a=s64', isChatOwner: false, isChatModerator: false, ...o });
const text = (id, msg, a = {}) => ({ id, snippet: { type: 'textMessageEvent', publishedAt: '2026-11-14T12:00:00Z', displayMessage: msg, textMessageDetails: { messageText: msg } }, authorDetails: author(a) });

test('応答の読み方: 通常・スーパーチャット・ステッカー・削除・BAN・対象外・壊れた項目', () => {
  const now = 1_800_000_000_000;
  const res = normalizeChatResponse({
    nextPageToken: 'NEXT', pollingIntervalMillis: 5400,
    items: [
      text('m1', 'こんばんは\n改行'),
      { id: 'm2', snippet: { type: 'superChatEvent', superChatDetails: { amountDisplayString: '¥1,000', userComment: 'いつも楽しみ', tier: 4 } }, authorDetails: author({ displayName: '@sakura', isChatModerator: true }) },
      { id: 'm3', snippet: { type: 'superStickerEvent', superStickerDetails: { amountDisplayString: '¥500', tier: 3 } }, authorDetails: author({ profileImageUrl: 'https://evil.example/x.png' }) },
      { id: 'm4', snippet: { type: 'messageDeletedEvent', messageDeletedDetails: { deletedMessageId: 'm1' } } },
      { id: 'm5', snippet: { type: 'userBannedEvent', userBannedDetails: { banType: 'permanent', bannedUserDetails: { channelId: 'UCbad' } } } },
      { id: 'm6', snippet: { type: 'newSponsorEvent' }, authorDetails: author() },
      { id: 'm7', snippet: { type: 'textMessageEvent', displayMessage: '' }, authorDetails: author() },
      { snippet: { type: 'textMessageEvent', displayMessage: 'id なし' } },
      null, 'x',
      text('m8', 'オーナー', { isChatOwner: true, displayName: '' }),
    ],
  }, now);
  assert.equal(res.next, 'NEXT');
  assert.equal(res.pollMs, 5400);
  assert.equal(res.offline, false);
  assert.deepEqual(res.events.map((e) => e.type), ['add', 'add', 'add', 'delete', 'ban', 'add']);
  const [a, sc, st, del, ban, own] = res.events;
  assert.deepEqual({ ...a.item }, { id: 'm1', kind: 'text', text: 'こんばんは 改行', name: '@mio_cabajo', icon: 'https://yt3.ggpht.com/a=s64', channelId: 'UCabc', amount: '', color: null, owner: false, mod: false, member: false, publishedAt: Date.parse('2026-11-14T12:00:00Z'), at: now });
  assert.equal(sc.item.kind, 'super');
  assert.equal(sc.item.text, 'いつも楽しみ');
  assert.equal(sc.item.amount, '¥1,000');
  assert.equal(sc.item.color, '#ffca28');
  assert.equal(sc.item.mod, true);
  assert.equal(st.item.kind, 'sticker');
  assert.equal(st.item.text, 'スーパーステッカー');
  assert.equal(st.item.amount, '¥500');
  assert.equal(st.item.icon, null, '許可していない画像は使わない');
  assert.deepEqual(del, { type: 'delete', id: 'm1' });
  assert.deepEqual(ban, { type: 'ban', channelId: 'UCbad' });
  assert.equal(own.item.owner, true);
  assert.equal(own.item.name, '（名前なし）');
  // 壊れた応答
  assert.deepEqual(normalizeChatResponse(null), { events: [], next: null, pollMs: null, offline: false });
  assert.equal(normalizeChatResponse({ offlineAt: '2026-11-14T13:00:00Z', items: [] }).offline, true);
  assert.equal(normalizeChatItem({ id: 'x y', snippet: { type: 'textMessageEvent', displayMessage: 'a' } }), null, 'id に空白');
});

test('videos.list → activeLiveChatId。無い・終わった・ライブでないは止めて案内', () => {
  assert.deepEqual(liveChatIdOf({ items: [{ liveStreamingDetails: { activeLiveChatId: 'Cg0KC2RRdzR3OVdnWGNR' } }] }), { id: 'Cg0KC2RRdzR3OVdnWGNR' });
  const msgs = [
    liveChatIdOf({ items: [] }), liveChatIdOf(null), liveChatIdOf({ items: [{ snippet: {} }] }),
    liveChatIdOf({ items: [{ liveStreamingDetails: { actualEndTime: '2026-11-14T13:00:00Z' } }] }),
    liveChatIdOf({ items: [{ liveStreamingDetails: { scheduledStartTime: '2026-11-15T13:00:00Z' } }] }),
  ];
  for (const m of msgs) { assert.equal(m.error.stop, true); assert.equal(m.error.code, 'ended'); }
  assert.match(msgs[0].error.message, /URL/);
  assert.match(msgs[2].error.message, /ライブ配信ではありません/);
  assert.match(msgs[3].error.message, /終わって/);
  assert.match(msgs[4].error.message, /始まっていない/);
});

test('API のエラー: 上限・配信なし・キーの設定は止める／通信・混雑はやり直す', () => {
  const err = (status, reason, extra = {}) => classifyApiError(status, { error: { code: status, errors: [{ reason }], ...extra } });
  for (const r of ['quotaExceeded', 'dailyLimitExceeded']) { const e = err(403, r); assert.equal(e.code, 'quota'); assert.equal(e.stop, true); assert.match(e.message, /上限/); }
  for (const r of ['liveChatEnded', 'liveChatNotFound', 'liveChatDisabled']) { const e = err(r === 'liveChatNotFound' ? 404 : 403, r); assert.equal(e.code, 'ended', r); assert.equal(e.stop, true); }
  const keyBad = err(400, 'badRequest', { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] });
  assert.equal(keyBad.code, 'key');
  assert.match(keyBad.message, /API キーの設定を確認/);
  assert.equal(err(400, 'keyInvalid').code, 'key');
  assert.match(err(403, 'accessNotConfigured').message, /YouTube Data API v3/);
  assert.match(classifyApiError(403, { error: { status: 'PERMISSION_DENIED', details: [{ reason: 'API_KEY_HTTP_REFERRER_BLOCKED' }] } }).message, /x-yoru-buzz\.com/);
  assert.match(err(403, 'ipRefererBlocked').message, /ウェブサイトの制限/);
  for (const e of [classifyApiError(0, null), err(503, 'backendError'), err(429, 'rateLimitExceeded'), classifyApiError(500, null)]) assert.equal(e.stop, false, e.code);
  assert.equal(classifyApiError(0).code, 'network');
  assert.equal(classifyApiError(404, null).code, 'ended');
  assert.equal(classifyApiError(401, 'not json').code, 'key');
  assert.equal(classifyApiError(418, null).stop, true);
});

test('URL の組み立て（キーは URL の key= だけ）・使った量の見積もり', () => {
  assert.equal(videosUrl('dQw4w9WgXcQ', KEY), `${YT_API}/videos?part=liveStreamingDetails&id=dQw4w9WgXcQ&key=${KEY}`);
  assert.equal(messagesUrl('Cg0/+=', KEY), `${YT_API}/liveChat/messages?liveChatId=Cg0%2F%2B%3D&part=snippet,authorDetails&maxResults=200&key=${KEY}`);
  assert.ok(messagesUrl('C', KEY, 'P&1').includes('&pageToken=P%261&'));
  assert.equal(quotaUnits({ videos: 1, messages: 10 }), 51);
  assert.equal(quotaUnits(null), 0);
  assert.equal(quotaPerHour(6000), 3000);
  assert.equal(quotaPerHour(10000), 1800);
  assert.equal(quotaPerHour(5000), 3600);
});

test('NG ワード: 区切り・全角半角・大文字小文字・名前も見る', () => {
  assert.deepEqual(parseNgWords('荒らし、宣伝,ＮＧ\nng\n\n  spam  '), ['荒らし', '宣伝', 'ＮＧ', 'spam']);
  assert.equal(normalizeNg('ＡＢＣｱｲｳ'), 'abcアイウ');
  const ng = ngMatcher(parseNgWords('ng、宣伝'));
  assert.equal(ng({ text: 'これはＮＧです', name: '@a' }), 'ng');
  assert.equal(ng({ text: '普通のコメント', name: '@senden_宣伝' }), '宣伝');
  assert.equal(ng({ text: '普通のコメント', name: '@a' }), null);
  assert.equal(ngMatcher([])({ text: 'ng' }), null);
});

const add = (id, o = {}) => ({ type: 'add', item: { id, kind: 'text', text: `本文${id}`, name: `@u${id}`, icon: null, channelId: o.ch || `UC${id}`, amount: '', color: null, at: 1, ...o } });

test('ログ: 最初の応答はログだけ（流さない）・重複・NG・画面から消した・削除・BAN・300 件まで', () => {
  const ng = ngMatcher(['ng']);
  let r = applyChatBatch([], [add('a'), add('b')], { backlog: true, ng });
  assert.deepEqual(r.log.map((x) => x.id), ['a', 'b']);
  assert.ok(r.log.every((x) => x.backlog));
  assert.deepEqual(r.flow, []);
  r = applyChatBatch(r.log, [add('b'), add('c'), add('d', { text: 'ＮＧ入り' }), add('e'), add('f', { ch: 'UCbad' }), { type: 'delete', id: 'c' }, { type: 'ban', channelId: 'UCbad' }, { type: 'delete', id: 'zzz' }],
    { ng, hidden: new Set(['e']) });
  assert.deepEqual(r.log.map((x) => x.id), ['a', 'b', 'd', 'e'], '重複・削除・BAN は入らない');
  assert.equal(r.log.find((x) => x.id === 'd').ng, 'ng');
  assert.deepEqual(r.flow.map((x) => x.id), [], 'NG・画面から消した・削除・BAN は流さない');
  assert.deepEqual(r.removed, ['c', 'f', 'zzz']);
  assert.deepEqual(r.banned, ['UCbad']);
  assert.equal(r.added, 4);
  r = applyChatBatch(r.log, [add('g'), add('h', { ch: 'UCbad' })], { banned: new Set(['UCbad']) });
  assert.deepEqual(r.flow.map((x) => x.id), ['g'], 'BAN 済みの人は入れない');
  const many = Array.from({ length: 320 }, (_, i) => add(`n${i}`));
  r = applyChatBatch([], many, { max: 300 });
  assert.equal(r.log.length, 300);
  assert.equal(r.log[0].id, 'n20', '古いものから捨てる');
});

test('設定: 範囲に丸める・取得間隔は選択肢だけ・古い形（top・laneH）は帯へ・1 列 24px 未満の列は減らす・固定は 3 時間まで復元', () => {
  const D = sanitizeChatCfg(null);
  assert.deepEqual(D, { band: { x: 0, y: 660, w: 1920, h: 248 }, lanes: 4, size: 34, speed: 8, pin: { x: 655, y: 600, w: 1170, size: 34, lines: 2 }, flow: true });
  assert.deepEqual(D, sanitizeChatCfg(CHAT_CFG_DEFAULTS));
  // 古い形 → 帯 { x: 0, y: top, w: 1920, h: lanes × laneH }
  assert.deepEqual(sanitizeChatCfg({ top: 700, lanes: 3, laneH: 62 }).band, { x: 0, y: 700, w: 1920, h: 186 });
  assert.deepEqual(sanitizeChatCfg({ top: 1000, lanes: 4, laneH: 62 }).band, { x: 0, y: 832, w: 1920, h: 248 }, '画面からはみ出さない');
  const big = sanitizeChatCfg({ band: { x: -50, y: 2000, w: 5000, h: 10 }, lanes: 99, size: 500, speed: 0, flow: false, pin: { x: 9999, y: -3, w: 10, size: 5, lines: 9 } });
  assert.deepEqual(big.band, { x: 0, y: 1050, w: 1920, h: 30 });
  assert.equal(big.lanes, 1, '1 列 24px 未満にならない');
  assert.deepEqual([big.size, big.speed, big.flow], [96, 3, false]);
  assert.deepEqual(big.pin, { x: 1620, y: 0, w: 300, size: 16, lines: 3 });
  assert.equal(sanitizeChatCfg({ band: { x: 0, y: 0, w: 1920, h: 100 }, lanes: 12 }).lanes, 4);
  assert.equal(sanitizeChatCfg({ speed: 7.3 }).speed, 7.5);
  assert.equal(sanitizeChatCfg({ band: { x: 'abc', y: 700, w: 1000, h: 200 } }).band.x, 0);
  assert.equal(sanitizeChatCfg({ pin: { lines: 'x' } }).pin.lines, 2);
  // 古い保存（top・lanes・laneH・size・speed が直下）→ layout へ
  const old = parseChatPrefs({ top: 700, lanes: 3, laneH: 50, size: 40, speed: 6, flow: false });
  assert.deepEqual(old.layout, { band: { x: 0, y: 700, w: 1920, h: 150 }, lanes: 3, size: 40, speed: 6, pin: { x: 655, y: 600, w: 1170, size: 34, lines: 2 } });
  assert.equal(old.flow, false);
  assert.deepEqual(parseChatPrefs({ layout: { band: { x: 100, y: 500, w: 800, h: 200 }, lanes: 2, pin: { x: 10, y: 20, w: 400, size: 40, lines: 1 } } }).layout.pin, { x: 10, y: 20, w: 400, size: 40, lines: 1 });
  assert.equal(parseChatPrefs({ mode: 'poll' }).mode, 'poll');
  assert.equal(parseChatPrefs({ mode: 'evil' }).mode, 'auto');
  assert.equal(parseChatPrefs({ channel: ' @HajimeRikuto ' }).channel, '@HajimeRikuto');
  assert.equal(parseChatPrefs({ channelInfo: { id: 'bad', uploads: 'UU' } }).channelInfo, null);
  const p = parseChatPrefs(JSON.stringify({ key: `  ${KEY}  `, url: ' https://youtu.be/dQw4w9WgXcQ ', interval: 7000, ng: 'a、b', top: 700, pin: { id: 'p1', kind: 'text', text: 'x', name: '@a', icon: 'https://evil.example/a.png' }, pinnedAt: 1000 }));
  assert.equal(p.key, KEY);
  assert.equal(p.url, 'https://youtu.be/dQw4w9WgXcQ');
  assert.equal(p.interval, 6000, '選択肢に無い間隔は既定');
  assert.ok(CHAT_INTERVALS.includes(parseChatPrefs({ interval: 15000 }).interval));
  assert.equal(p.layout.band.y, 700);
  assert.equal(p.pin.icon, null);
  assert.equal(p.layout.pin.x, 655, '固定したコメント（pin）はレイアウトの箱ではない');
  assert.deepEqual(parseChatPrefs('{broken'), parseChatPrefs(null));
  assert.equal(parseChatPrefs(null).flow, true);
  assert.equal(restorePin(p, 1000 + CHAT_PIN_RESTORE_MS - 1).id, 'p1');
  assert.equal(restorePin(p, 1000 + CHAT_PIN_RESTORE_MS + 1), null);
});

test('オーバーレイへのメッセージ: 画面用に短く・余計な値は落とす', () => {
  const m = buildChatMessage({ sid: 's', seq: 3, at: 100, add: [{ id: 'a', kind: 'super', text: 'あ'.repeat(80), name: '@n', icon: 'https://yt3.ggpht.com/x', amount: '¥500', color: '#FFCA28', at: 90, channelId: 'UCsecret', extra: 1 }, { id: 'bad id' }],
    remove: ['x', 'bad id', 3], pin: { id: 'p', kind: 'text', text: 'い'.repeat(200), name: '@p', color: '#ffffff' }, cfg: { band: { x: 0, y: 700, w: 1920, h: 186 }, lanes: 3 } });
  assert.equal(m.type, 'chat');
  assert.equal(m.v, 1);
  assert.equal(m.add.length, 1);
  assert.deepEqual(Object.keys(m.add[0]).sort(), ['amount', 'at', 'color', 'icon', 'id', 'kind', 'name', 'text']);
  assert.equal(Array.from(m.add[0].text).length, 60);
  assert.equal(m.add[0].color, '#ffca28');
  assert.deepEqual(m.remove, ['x']);
  assert.equal(Array.from(m.pin.text).length, 140);
  assert.equal(m.pin.color, null, '通常のコメントに色は付けない');
  assert.equal(m.cfg.band.y, 700);
  assert.equal(m.cfg.lanes, 3);
  assert.equal(wireItem({ id: 'a', kind: 'evil', text: 'x' }).kind, 'text');
});

test('受け手: id で重複を除く・古いもの（30 秒）は流さない・古い seq は固定や設定を変えない・時計のずれ', () => {
  const r = createChatReceiver({ max: 3 });
  const now = 1_000_000;
  const msg = (seq, add, extra = {}) => buildChatMessage({ sid: 'A', seq, at: now, add, ...extra });
  const it = (id, at = now) => ({ id, kind: 'text', text: id, name: '@x', at });
  let x = r.accept(msg(1, [it('a'), it('b'), it('old', now - CHAT_STALE_MS - 1)], { pin: it('p'), cfg: { lanes: 3 } }), now);
  assert.deepEqual(x.add.map((i) => i.id), ['a', 'b']);
  assert.equal(x.pin.id, 'p');
  assert.equal(x.cfg.lanes, 3);
  x = r.accept(msg(2, [it('a'), it('c')]), now);
  assert.deepEqual(x.add.map((i) => i.id), ['c'], '同じ id は 1 回だけ');
  assert.equal(x.pin, null, '固定なし＝外す');
  x = r.accept(msg(1, [it('d')], { pin: it('p') }), now);
  assert.deepEqual(x.add.map((i) => i.id), ['d'], '古い seq でも新しいコメントは流す');
  assert.equal(x.pin, undefined, '古い seq は固定を変えない');
  assert.equal(x.cfg, null);
  assert.equal(r.seen(), 3, '覚える id は max まで');
  assert.equal(r.accept({ v: 1, type: 'state' }, now), null);
  assert.equal(r.accept(null, now), null);
  // 送り手のパソコンと時計が 10 分ずれている: 送った時刻を基準に
  const skewed = createChatReceiver();
  const far = now + 600000;
  x = skewed.accept(buildChatMessage({ sid: 'B', seq: 1, at: far, add: [it('s', far - 1000)] }), now);
  assert.deepEqual(x.add.map((i) => i.id), ['s']);
  // 送り手が変わった（開き直した）: at が新しければ使う
  x = r.accept(buildChatMessage({ sid: 'C', seq: 1, at: now + 5, pin: it('q') }), now);
  assert.equal(x.pin.id, 'q');
});

test('列: 上から空いている列・同じ速さなので前のお尻＋40px で次・空きが無ければ待つ（40 件まで）・固定と重なる列は使わない', () => {
  const cfg = sanitizeChatCfg(CHAT_CFG_DEFAULTS);
  assert.equal(laneY(cfg, 0), 660);
  assert.equal(laneY(cfg, 3), 846);
  assert.equal(laneY(cfg, 3) + laneH(cfg), 908, '帯の下端 908（トピック帯 915 の上）');
  assert.equal(laneTop(cfg, 2), 124, '帯の中の位置');
  assert.equal(pxPerMs(cfg), 1920 / 8000);
  assert.equal(travelMs(480, cfg), 10000);
  assert.equal(laneBusyMs(200, cfg), Math.ceil((200 + LANE_GAP) / (1920 / 8000)));
  assert.equal(laneBusyMs(200, cfg, { calm: true }), 8000);
  // 帯の幅で速さが決まる（狭い帯は同じ秒数でゆっくり）
  const narrow = sanitizeChatCfg({ band: { x: 960, y: 660, w: 960, h: 248 } });
  assert.equal(pxPerMs(narrow), 960 / 8000);
  assert.equal(travelMs(240, narrow), 10000);
  // 横に重ならない固定コメントは列をふさがない
  assert.deepEqual(lanesOverlapping(narrow, { x: 0, y: 600, w: 900, h: 160 }), []);
  assert.deepEqual(lanesOverlapping(narrow, { x: 900, y: 600, w: 100, h: 160 }), [0, 1]);
  // 固定コメントの箱（600〜760）と重なるのは 1・2 列目（660〜722・722〜784）
  assert.deepEqual(lanesOverlapping(cfg, { x: CHAT_PIN_BOX.x, y: CHAT_PIN_BOX.y, w: CHAT_PIN_BOX.w, h: 160 }), [0, 1]);
  assert.deepEqual(lanesOverlapping(cfg, { y: CHAT_PIN_BOX.y, h: 160 }), [0, 1]);
  assert.deepEqual(lanesOverlapping(cfg, { y: 600, h: 60 }), [], '1 行の固定は帯にかからない');
  assert.deepEqual(lanesOverlapping(cfg, { y: 600, h: 61 }), [0]);
  assert.deepEqual(lanesOverlapping(cfg, null), []);
  const s = createLaneScheduler({ lanes: 4 });
  const it = (id) => ({ id });
  for (const id of ['a', 'b', 'c', 'd', 'e']) s.enqueue(it(id));
  const now = 1000;
  const got = [];
  let r;
  while ((r = s.take(now, []))) { got.push([r.item.id, r.lane]); s.occupy(r.lane, now + 1000, r.item.id); }
  assert.deepEqual(got, [['a', 0], ['b', 1], ['c', 2], ['d', 3]]);
  assert.equal(s.queued, 1, '空きが無いので e は待つ');
  assert.equal(s.take(now + 999, []), null);
  assert.deepEqual(s.take(now + 1000, []), { item: { id: 'e' }, lane: 0 });
  // 固定中: 1・2 列目は使わない
  const p = createLaneScheduler({ lanes: 4 });
  p.enqueue(it('x'));
  p.enqueue(it('y'));
  p.enqueue(it('z'));
  const blocked = lanesOverlapping(cfg, { y: 600, h: 160 });
  const lanes = [];
  while ((r = p.take(0, blocked))) { lanes.push(r.lane); p.occupy(r.lane, 500, r.item.id); }
  assert.deepEqual(lanes, [2, 3]);
  assert.equal(p.queued, 1);
  // 消したコメントがその列の最後なら列を空ける
  p.release('x', 100);
  assert.equal(p.pickLane(100, blocked), 2);
  p.release('nope', 100);
  // 待ち行列は 40 件まで（古いものを捨てる）
  const q = createLaneScheduler({ lanes: 1 });
  let dropped = [];
  for (let i = 0; i < QUEUE_MAX + 3; i++) dropped = dropped.concat(q.enqueue(it(`q${i}`)));
  assert.equal(q.queued, QUEUE_MAX);
  assert.deepEqual(dropped.map((x) => x.id), ['q0', 'q1', 'q2']);
  assert.ok(q.remove('q10'));
  assert.equal(q.queued, QUEUE_MAX - 1);
  q.clear();
  assert.equal(q.queued, 0);
  // 列の数を変える
  const rs = createLaneScheduler({ lanes: 2 });
  rs.occupy(1, 999, 'k');
  rs.resize(4);
  assert.deepEqual(rs.state().free, [0, 999, 0, 0]);
  rs.resize(1);
  assert.equal(rs.lanes, 1);
});

/** 偽の時計と fetch（応答を順に返す） */
function harness(responses) {
  let t = 0;
  let timers = [];
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const r = responses.shift();
    if (!r) return { ok: true, status: 200, json: async () => ({ items: [], pollingIntervalMillis: 1000 }) };
    if (r === 'network') throw new TypeError('Failed to fetch');
    return { ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.body };
  };
  return {
    calls,
    fetchImpl,
    now: () => t,
    setTimer: (fn, ms) => { const x = { fn, at: t + ms }; timers.push(x); return x; },
    clearTimer: (x) => { timers = timers.filter((y) => y !== x); },
    pending: () => timers.map((x) => x.at - t),
    async advance(ms) {
      t += ms;
      const due = timers.filter((x) => x.at <= t);
      timers = timers.filter((x) => x.at > t);
      for (const x of due) x.fn();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
    async flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); },
  };
}

test('取得: videos.list → 最初の応答はログだけ → pollingIntervalMillis と最短の間隔の長い方で次・Referer は origin・Cookie なし', async () => {
  const h = harness([
    { body: { items: [{ liveStreamingDetails: { activeLiveChatId: 'CHAT1' } }] } },
    { body: { items: [text('old1', '前のコメント')], nextPageToken: 'P1', pollingIntervalMillis: 2000 } },
    { body: { items: [text('new1', '新しいコメント')], nextPageToken: 'P2', pollingIntervalMillis: 9000 } },
  ]);
  const batches = [];
  const states = [];
  const units = [];
  const p = createChatPoller({ key: KEY, videoId: 'dQw4w9WgXcQ', interval: 6000, ...h, onBatch: (n, o) => batches.push([n.events.map((e) => e.item.id), o.backlog]), onStatus: (s) => states.push(s.status), onUnits: (k) => units.push(k) });
  p.start();
  await h.flush();
  assert.deepEqual(batches, [[['old1'], true]]);
  assert.ok(h.calls[0].url.startsWith(`${YT_API}/videos?part=liveStreamingDetails&id=dQw4w9WgXcQ`));
  assert.ok(h.calls[1].url.includes('liveChatId=CHAT1'));
  for (const c of h.calls) { assert.equal(c.opts.referrerPolicy, 'origin'); assert.equal(c.opts.credentials, 'omit'); assert.equal(c.opts.method, 'GET'); }
  assert.deepEqual(h.pending(), [6000], 'poll 2 秒より最短 6 秒が長い');
  await h.advance(6000);
  assert.deepEqual(batches[1], [['new1'], false]);
  assert.ok(h.calls[2].url.includes('pageToken=P1'));
  assert.deepEqual(h.pending(), [9000], 'YouTube の指定が長ければそちら');
  assert.deepEqual(units, ['videos', 'messages', 'messages']);
  assert.deepEqual(states, ['starting', 'running']);
  p.stop();
  assert.deepEqual(h.pending(), []);
  assert.equal(p.status().status, 'stopped');
});

test('取得: 通信の失敗はやり直す（止めない）・上限は止めて案内・止めたあとの応答は捨てる', async () => {
  const h = harness([
    'network',
    { body: { items: [{ liveStreamingDetails: { activeLiveChatId: 'C' } }] } },
    { body: { items: [], pollingIntervalMillis: 1000 } },
    { status: 503, body: { error: { errors: [{ reason: 'backendError' }] } } },
    { status: 403, body: { error: { errors: [{ reason: 'quotaExceeded' }] } } },
  ]);
  const states = [];
  const p = createChatPoller({ key: KEY, videoId: 'dQw4w9WgXcQ', interval: 5000, ...h, onStatus: (s) => states.push(`${s.status}:${s.code}`) });
  p.start();
  await h.flush();
  assert.equal(p.status().status, 'retrying');
  assert.deepEqual(h.pending(), [2000]);
  await h.advance(2000);
  assert.equal(p.status().status, 'running');
  await h.advance(5000);
  assert.equal(p.status().status, 'retrying', '混雑はやり直す');
  assert.deepEqual(h.pending(), [2000], '成功したら待ちは最初から');
  await h.advance(2000);
  assert.equal(p.status().status, 'error');
  assert.equal(p.status().code, 'quota');
  assert.match(p.status().reason, /上限/);
  assert.deepEqual(h.pending(), [], '上限では止める');
  assert.deepEqual(states, ['starting:', 'retrying:network', 'running:', 'retrying:busy', 'error:quota']);
  // 止めたあとに届いた応答は使わない
  const h2 = harness([{ body: { items: [{ liveStreamingDetails: { activeLiveChatId: 'C' } }] } }]);
  const got = [];
  const p2 = createChatPoller({ key: KEY, videoId: 'dQw4w9WgXcQ', interval: 5000, ...h2, onBatch: (n) => got.push(n) });
  p2.start();
  p2.stop();
  await h2.flush();
  assert.equal(got.length, 0);
  assert.equal(p2.status().status, 'stopped');
});

test('取得: 配信が見つからない・キーの設定・配信終了（offlineAt）は止める', async () => {
  for (const [res, code] of [
    [[{ body: { items: [] } }], 'ended'],
    [[{ status: 400, body: { error: { errors: [{ reason: 'badRequest' }], details: [{ reason: 'API_KEY_INVALID' }] } } }], 'key'],
    [[{ body: { items: [{ liveStreamingDetails: { activeLiveChatId: 'C' } }] } }, { body: { items: [], offlineAt: '2026-11-14T13:00:00Z' } }], 'ended'],
  ]) {
    const h = harness(res);
    const p = createChatPoller({ key: KEY, videoId: 'dQw4w9WgXcQ', interval: 5000, ...h });
    p.start();
    await h.flush();
    assert.equal(p.status().status, 'error', code);
    assert.equal(p.status().code, code);
    assert.deepEqual(h.pending(), []);
  }
});

test('見本のコメント（API を使わない）: 架空の名前・毎回別の id・固定の見本', () => {
  const a = demoChatItem(0, 1000);
  const b = demoChatItem(0, 2000);
  assert.notEqual(a.id, b.id);
  assert.ok(a.name.startsWith('@'));
  assert.equal(a.icon, null);
  assert.ok(demoChatItem(-1, 1).name);
  const kinds = new Set(Array.from({ length: 12 }, (_, i) => demoChatItem(i, 1).kind));
  assert.deepEqual([...kinds].sort(), ['sticker', 'super', 'text']);
  const pin = demoChatPin(5);
  assert.ok(wireItem(pin, 140));
});

test('looksLikeGoogleKey: AIza で始まるキーだけ（ブラウザが自動で入れたパスワードを弾く）', () => {
  assert.ok(looksLikeGoogleKey(KEY));
  assert.ok(looksLikeGoogleKey('AIzaSyD0123456789abcdefghijklmnopqrstu'));
  for (const k of ['', 'hunter2-password-1234567890', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop', 'AIza', `${KEY} `, null]) assert.ok(!looksLikeGoogleKey(k), String(k));
});

// ================================================================ プッシュ型（stream）・チャンネルから探す・URL の上書き

test('JSON 配列を少しずつ: どのバイト位置で切っても同じ要素（文字列の中の " \\ [ ] { }・日本語・絵文字・改行区切り）', () => {
  const data = [
    { items: [{ id: 'a', snippet: { displayMessage: 'こんばんは！"引用"と \\ と [角] {波} 😀👍🏽' } }], nextPageToken: 'T1', pollingIntervalMillis: 0 },
    { items: [], nextPageToken: 'T2' },
    { error: { code: 403, message: 'x', errors: [{ reason: 'quotaExceeded' }] } },
    [1, 'two', { three: 3 }], 'str,]', 42, true, null,
  ];
  const body = `[${data.map((x) => JSON.stringify(x)).join('\n,')}]`;
  const bytes = new TextEncoder().encode(body);
  for (let k = 0; k <= bytes.length; k++) {
    const rd = createStreamBodyReader();
    const got = [...rd.push(bytes.slice(0, k)), ...rd.push(bytes.slice(k))];
    const end = rd.end();
    got.push(...end.items);
    assert.deepEqual(got, data, `split at ${k}`);
    assert.equal(end.truncated, false);
    assert.equal(end.closed, true);
  }
  // 1 バイトずつ
  const rd = createStreamBodyReader();
  const one = [];
  for (const b of bytes) one.push(...rd.push(new Uint8Array([b])));
  one.push(...rd.end().items);
  assert.deepEqual(one, data);
  // 途中で切れた・単体のオブジェクト（エラーの本文）・空・壊れた要素
  const cut = createJsonArrayParser();
  assert.deepEqual(cut.push('[{"a":1},{"b":'), [{ a: 1 }]);
  assert.equal(cut.end().truncated, true);
  assert.deepEqual(createJsonArrayParser().push('  {"error":{"code":400}}'), [{ error: { code: 400 } }]);
  assert.deepEqual(createJsonArrayParser().push('[]'), []);
  const bad = createJsonArrayParser();
  assert.deepEqual(bad.push('[{"a":1},{bad},{"c":3}]'), [{ a: 1 }, { c: 3 }]);
  assert.equal(bad.end().bad, 1);
});

test('プッシュのエラー: 上限・配信なし・キーは止める／404・405・501・理由の分からない 4xx は切り替え／混雑はつなぎ直す（配列で包まれた本文も読む）', () => {
  const wrap = (code, reason, extra = {}) => [{ error: { code, message: 'm', errors: reason ? [{ reason }] : [], ...extra } }];
  assert.equal(streamErrorDecision(403, wrap(403, 'quotaExceeded')).action, 'stop');
  assert.equal(streamErrorDecision(403, wrap(403, 'quotaExceeded')).error.code, 'quota');
  assert.equal(streamErrorDecision(404, wrap(404, 'liveChatNotFound')).action, 'stop');
  assert.equal(streamErrorDecision(403, wrap(403, 'liveChatEnded')).action, 'stop');
  assert.equal(streamErrorDecision(400, wrap(400, 'badRequest', { details: [{ reason: 'API_KEY_INVALID' }] })).action, 'stop');
  assert.equal(streamErrorDecision(403, wrap(403, null, { details: [{ reason: 'API_KEY_HTTP_REFERRER_BLOCKED' }] })).action, 'stop');
  assert.equal(streamErrorDecision(403, wrap(403, 'accessNotConfigured')).action, 'stop');
  for (const st of [404, 405, 501]) assert.equal(streamErrorDecision(st, null).action, st === 501 ? 'retry' : 'fallback', String(st));
  assert.equal(streamErrorDecision(400, wrap(400, 'invalidArgument')).action, 'fallback');
  assert.equal(streamErrorDecision(401, null).action, 'fallback');
  assert.equal(streamErrorDecision(503, wrap(503, 'backendError')).action, 'retry');
  assert.equal(streamErrorDecision(429, null).action, 'retry');
  assert.equal(classifyApiError(403, wrap(403, 'quotaExceeded')).code, 'quota', '配列で包まれた本文');
  assert.equal(streamUrl('C/1', KEY, 'P'), `${YT_API}/liveChat/messages/stream?liveChatId=C%2F1&part=snippet,authorDetails&maxResults=200&pageToken=P&key=${KEY}`);
});

/** 偽の時計・fetch（stream は配列の本文を chunks で返す） */
function streamHarness(handler) {
  let t = 0;
  let timers = [];
  const calls = [];
  const enc = new TextEncoder();
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const r = await handler(url, calls.length, opts);
    if (r === 'network') throw new TypeError('Failed to fetch');
    const chunks = r.chunks || [JSON.stringify(r.body ?? {})];
    return {
      ok: (r.status || 200) < 400, status: r.status || 200,
      json: async () => JSON.parse(chunks.join('')),
      text: async () => chunks.join(''),
      body: {
        getReader() {
          let i = 0;
          return {
            read: () => {
              if (r.hang && i >= chunks.length) return new Promise((_, rej) => { opts.signal.addEventListener('abort', () => rej(new Error('aborted'))); });
              if (r.dropAfter != null && i >= r.dropAfter) return Promise.reject(new Error('dropped'));
              return Promise.resolve(i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true });
            },
            cancel() {},
          };
        },
      },
    };
  };
  return {
    calls, fetchImpl,
    now: () => t,
    setTimer: (fn, ms) => { const x = { fn, at: t + ms }; timers.push(x); return x; },
    clearTimer: (x) => { timers = timers.filter((y) => y !== x); },
    pending: () => timers.map((x) => x.at - t).sort((a, b) => a - b),
    async flush() { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        t = next.at;
        timers = timers.filter((x) => x !== next);
        next.fn();
        await this.flush();
      }
      t = end;
      await this.flush();
    },
  };
}
const videosOk = { body: { items: [{ liveStreamingDetails: { activeLiveChatId: 'CH' } }] } };
const el = (ids, token) => JSON.stringify({ items: ids.map((id) => text(id, `本文${id}`)), nextPageToken: token, pollingIntervalMillis: 0 });

test('プッシュ: 最初の要素はログだけ・あとは流す・切れたら続き（pageToken）から 5 秒に 1 回まで・1 接続 5 単位', async () => {
  const h = streamHarness((url, n) => {
    if (url.includes('/videos?')) return videosOk;
    if (n === 2) return { chunks: [`[${el(['old'], 'T1')}`, `\n,${el(['n1'], 'T2')}`, '\n]'] };
    return { chunks: [`[${el([`r${n}`], `T${n}`)}]`] };
  });
  const batches = [];
  const units = [];
  const states = [];
  const c = createChatClient({ key: KEY, videoId: 'dQw4w9WgXcQ', interval: 6000, ...h, onBatch: (n, o) => batches.push([n.events.map((e) => e.item.id), o.backlog]), onUnits: (k) => units.push(k), onStatus: (s) => states.push(`${s.status}:${s.via}`) });
  c.start();
  await h.flush();
  assert.deepEqual(batches, [[['old'], true], [['n1'], false]]);
  assert.ok(h.calls[1].url.startsWith(`${YT_API}/liveChat/messages/stream?liveChatId=CH`));
  assert.ok(!h.calls[1].url.includes('pageToken'));
  assert.equal(h.calls[1].opts.referrerPolicy, 'origin');
  assert.equal(h.calls[1].opts.credentials, 'omit');
  assert.deepEqual(h.pending(), [0], 'すぐつなぎ直す（予約）');
  await h.advance(0);
  assert.deepEqual(h.pending(), [5000], '5 秒に 1 回まで');
  await h.advance(5000);
  assert.ok(h.calls[2].url.includes('pageToken=T2'), '続きから');
  assert.deepEqual(batches[2], [['r3'], false]);
  assert.deepEqual(units, ['videos', 'stream', 'stream']);
  assert.equal(c.status().via, 'stream');
  assert.ok(states.includes('running:stream'));
  c.stop();
  assert.deepEqual(h.pending(), []);
});

test('プッシュ: 最初の接続で通信の失敗（CORS）・404 → 数秒おきに切り替え（開始前のコメントはログだけ）', async () => {
  for (const first of ['network', { status: 404, chunks: ['Not Found'] }, { status: 400, chunks: [JSON.stringify([{ error: { code: 400, errors: [{ reason: 'invalidArgument' }] } }])] }]) {
    const h = streamHarness((url) => {
      if (url.includes('/videos?')) return videosOk;
      if (url.includes('/stream?')) return first;
      return { body: { items: [text('p1', '数秒おき')], nextPageToken: 'Q1', pollingIntervalMillis: 0 } };
    });
    const batches = [];
    const c = createChatClient({ key: KEY, videoId: 'dQw4w9WgXcQ', interval: 6000, ...h, onBatch: (n, o) => batches.push([n.events.map((e) => e.item.id), o.backlog]) });
    c.start();
    await h.flush();
    const st = c.status();
    assert.equal(st.via, 'poll');
    assert.equal(st.fallback, 'プッシュが使えないため');
    assert.equal(st.status, 'running');
    assert.ok(h.calls.some((x) => x.url.includes('/liveChat/messages?')));
    assert.ok(!h.calls.some((x, i) => i > 1 && x.url.includes('/videos?')), 'chatId は使い回す');
    assert.deepEqual(batches, [[['p1'], true]]);
    c.stop();
  }
});

test('プッシュ: 上限（配列のエラー）は止める・混雑はつなぎ直す・30 秒に要素なしで 3 回切れたら切り替え・届いたあとの切断はつなぎ直す', async () => {
  // 上限
  let h = streamHarness((url) => (url.includes('/videos?') ? videosOk : { status: 403, chunks: [JSON.stringify([{ error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } }])] }));
  let c = createChatClient({ key: KEY, videoId: 'dQw4w9WgXcQ', ...h });
  c.start();
  await h.flush();
  assert.equal(c.status().status, 'error');
  assert.equal(c.status().code, 'quota');
  assert.deepEqual(h.pending(), []);
  // 混雑 → 1 秒（と 5 秒に 1 回）でつなぎ直す
  h = streamHarness((url, n) => (url.includes('/videos?') ? videosOk : n === 2 ? { status: 503, chunks: ['[]'] } : { chunks: [`[${el(['ok'], 'T')}]`] }));
  c = createChatClient({ key: KEY, videoId: 'dQw4w9WgXcQ', ...h });
  c.start();
  await h.flush();
  assert.equal(c.status().status, 'retrying');
  assert.deepEqual(h.pending(), [STREAM_BACKOFF_MS[1]]);
  await h.advance(5000);
  assert.equal(c.status().status, 'running');
  assert.equal(c.status().via, 'stream');
  c.stop();
  // 何も届かないまま 3 回切れる → 数秒おき
  h = streamHarness((url) => (url.includes('/videos?') ? videosOk : url.includes('/stream?') ? { chunks: ['[]'] } : { body: { items: [], pollingIntervalMillis: 0 } }));
  c = createChatClient({ key: KEY, videoId: 'dQw4w9WgXcQ', ...h });
  c.start();
  await h.flush();
  await h.advance(20000);
  assert.equal(c.status().via, 'poll');
  assert.equal(c.status().fallback, 'プッシュが続かないため');
  assert.equal(h.calls.filter((x) => x.url.includes('/stream?')).length, 3);
  c.stop();
  // 届いたあとに切れた → 数秒おきにはせず、続きからつなぎ直す
  h = streamHarness((url, n) => (url.includes('/videos?') ? videosOk : n === 2 ? { chunks: [`[${el(['a'], 'TA')}`, `,${el(['b'], 'TB')}`], dropAfter: 1 } : { chunks: [`[${el(['c'], 'TC')}]`] }));
  c = createChatClient({ key: KEY, videoId: 'dQw4w9WgXcQ', ...h });
  c.start();
  await h.flush();
  await h.advance(6000);
  assert.equal(c.status().via, 'stream');
  assert.ok(h.calls[2].url.includes('pageToken=TA'));
  c.stop();
});

test('プッシュ: 何も届かないまま 120 秒（見張り）→ 切って続きからつなぎ直す／数秒ごとのみの設定ならプッシュは使わない', async () => {
  const h = streamHarness((url, n) => (url.includes('/videos?') ? videosOk : n === 2 ? { chunks: [`[${el(['a'], 'TA')}`], hang: true } : { chunks: [`[${el(['b'], 'TB')}]`] }));
  const c = createChatClient({ key: KEY, videoId: 'dQw4w9WgXcQ', ...h, idleMs: 120000 });
  c.start();
  await h.flush();
  assert.equal(h.calls.length, 2);
  await h.advance(119000);
  assert.equal(h.calls.length, 2, 'まだ待つ');
  await h.advance(1000);
  assert.equal(h.calls.length, 3, '見張りで切ってつなぎ直す');
  assert.ok(h.calls[2].url.includes('pageToken=TA'));
  c.stop();
  const h2 = streamHarness((url) => (url.includes('/videos?') ? videosOk : { body: { items: [], pollingIntervalMillis: 0 } }));
  const p = createChatClient({ key: KEY, videoId: 'dQw4w9WgXcQ', mode: 'poll', ...h2 });
  p.start();
  await h2.flush();
  assert.ok(!h2.calls.some((x) => x.url.includes('/stream?')));
  assert.equal(p.status().via, 'poll');
  assert.equal(p.status().fallback, '');
  p.stop();
});

test('チャンネルの入力: @ハンドル・URL（/@x・/@x/live・/channel/UC…・m.）・UC… の ID。それ以外は null', () => {
  const uc = `UC${'a1_-'.repeat(5)}ab`;
  assert.deepEqual(parseChannelInput('@HajimeRikuto'), { handle: '@HajimeRikuto' });
  assert.deepEqual(parseChannelInput(' https://www.youtube.com/@HajimeRikuto/live '), { handle: '@HajimeRikuto' });
  assert.deepEqual(parseChannelInput('youtube.com/@yoru.buzz-ch'), { handle: '@yoru.buzz-ch' });
  assert.deepEqual(parseChannelInput(`https://m.youtube.com/${encodeURIComponent('@よるバズ')}`), { handle: '@よるバズ' });
  assert.equal(parseChannelInput('@よる'), null, '3 文字から');
  assert.deepEqual(parseChannelInput(`https://www.youtube.com/channel/${uc}`), { id: uc });
  assert.deepEqual(parseChannelInput(uc), { id: uc });
  for (const x of ['', 'HajimeRikuto', '@a', '@has space', 'https://example.com/@abc', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'UCshort', 'javascript:alert(1)']) assert.equal(parseChannelInput(x), null, x);
  assert.equal(channelsUrl({ handle: '@よる' }, KEY), `${YT_API}/channels?part=snippet,contentDetails&forHandle=%40%E3%82%88%E3%82%8B&key=${KEY}`);
  assert.ok(channelsUrl({ id: uc }, KEY).includes(`&id=${uc}&`));
  assert.ok(playlistItemsUrl('UUx', KEY).includes('playlistId=UUx&maxResults=10'));
  assert.ok(videosDetailUrl(['a', 'b'], KEY).includes('part=snippet,liveStreamingDetails&id=a,b'));
  assert.ok(searchLiveUrl(uc, KEY).includes('eventType=live&type=video&maxResults=5'));
  assert.deepEqual(channelInfoOf({ items: [{ id: uc, snippet: { title: 'はじめ' }, contentDetails: { relatedPlaylists: { uploads: 'UUabc' } } }] }), { id: uc, uploads: 'UUabc', title: 'はじめ' });
  assert.ok(channelInfoOf({ items: [] }).error);
  assert.deepEqual(videoIdsOf({ items: [{ contentDetails: { videoId: 'dQw4w9WgXcQ' } }, { id: { videoId: 'aaaaaaaaaaa' } }, { id: { videoId: 'bad' } }, { contentDetails: { videoId: 'dQw4w9WgXcQ' } }] }), ['dQw4w9WgXcQ', 'aaaaaaaaaaa']);
});

const vid = (id, d, title = `配信${id}`) => ({ id, snippet: { title }, liveStreamingDetails: d });
test('今の配信を選ぶ: 始まっていて終わっていない・チャットあり・いちばん新しい（予定・終わった・チャットなしは選ばない）', () => {
  const body = { items: [
    vid('upcoming001', { scheduledStartTime: '2026-11-14T20:00:00Z', activeLiveChatId: 'C1' }),
    vid('ended000001', { actualStartTime: '2026-11-14T10:00:00Z', actualEndTime: '2026-11-14T11:00:00Z', activeLiveChatId: 'C2' }),
    vid('nochat00001', { actualStartTime: '2026-11-14T13:00:00Z' }),
    vid('live0000001', { actualStartTime: '2026-11-14T12:00:00Z', activeLiveChatId: 'C3' }),
    vid('live0000002', { actualStartTime: '2026-11-14T12:30:00Z', activeLiveChatId: 'C4' }, '今夜の配信'),
    { id: 'novideo0001' },
  ] };
  assert.deepEqual(pickActiveLive(body), { videoId: 'live0000002', chatId: 'C4', title: '今夜の配信', startedAt: Date.parse('2026-11-14T12:30:00Z') });
  assert.equal(pickActiveLive({ items: body.items.slice(0, 3) }), null);
  assert.equal(pickActiveLive(null), null);
});

test('チャンネルから探す: ハンドル→アップロード→videos で見つける／無ければ検索（100）／見つからなければ 30 秒おき・検索は 5 分に 1 回・15 分であきらめる', async () => {
  const uc = `UC${'x'.repeat(22)}`;
  const chBody = { items: [{ id: uc, snippet: { title: 'はじめ' }, contentDetails: { relatedPlaylists: { uploads: 'UUx' } } }] };
  // 安い方法で見つかる
  let h = streamHarness((url) => {
    if (url.includes('/channels?')) return { body: chBody };
    if (url.includes('/playlistItems?')) return { body: { items: [{ contentDetails: { videoId: 'ended000001' } }, { contentDetails: { videoId: 'live0000001' } }] } };
    if (url.includes('/videos?')) return { body: { items: [vid('ended000001', { actualStartTime: '2026-11-14T10:00:00Z', actualEndTime: '2026-11-14T11:00:00Z', activeLiveChatId: 'C2' }), vid('live0000001', { actualStartTime: '2026-11-14T12:00:00Z', activeLiveChatId: 'C3' })] } };
    return { status: 500, chunks: ['{}'] };
  });
  let found = null;
  let info = null;
  const units = [];
  let f = createLiveFinder({ key: KEY, channel: { handle: '@HajimeRikuto' }, ...h, onFound: (v) => { found = v; }, onChannel: (i) => { info = i; }, onUnits: (k) => units.push(k) });
  f.start();
  await h.flush();
  assert.equal(found.videoId, 'live0000001');
  assert.equal(found.chatId, 'C3');
  assert.deepEqual(info, { id: uc, uploads: 'UUx', title: 'はじめ' });
  assert.deepEqual(units, ['channels', 'playlistItems', 'videos']);
  assert.ok(h.calls[0].url.includes('forHandle=%40HajimeRikuto'));
  // 覚えたチャンネルは channels.list を省く。再生リストに無ければ検索
  h = streamHarness((url) => {
    if (url.includes('/playlistItems?')) return { body: { items: [{ contentDetails: { videoId: 'upcoming001' } }] } };
    if (url.includes('/search?')) return { body: { items: [{ id: { kind: 'youtube#video', videoId: 'live0000009' } }] } };
    if (url.includes('id=upcoming001')) return { body: { items: [vid('upcoming001', { scheduledStartTime: '2026-11-15T12:00:00Z' })] } };
    if (url.includes('id=live0000009')) return { body: { items: [vid('live0000009', { actualStartTime: '2026-11-14T12:00:00Z', activeLiveChatId: 'C9' }, '限定じゃない配信')] } };
    return { status: 500, chunks: ['{}'] };
  });
  found = null;
  units.length = 0;
  f = createLiveFinder({ key: KEY, channel: { handle: '@x_y_z' }, cached: { id: uc, uploads: 'UUx', title: 't' }, ...h, onFound: (v) => { found = v; }, onUnits: (k) => units.push(k) });
  f.start();
  await h.flush();
  assert.equal(found.videoId, 'live0000009');
  assert.deepEqual(units, ['playlistItems', 'videos', 'search', 'videos']);
  // どこにも無い: 30 秒おきに安い方法、検索は 5 分に 1 回、15 分であきらめる
  h = streamHarness((url) => {
    if (url.includes('/playlistItems?')) return { body: { items: [] } };
    if (url.includes('/search?')) return { body: { items: [] } };
    return { body: { items: [] } };
  });
  const states = [];
  f = createLiveFinder({ key: KEY, channel: { id: uc }, cached: { id: uc, uploads: 'UUx' }, ...h, onStatus: (s) => states.push(s.status) });
  f.start();
  await h.flush();
  assert.equal(f.status().status, 'searching');
  assert.equal(f.status().reason, FINDER_WAIT_TEXT);
  assert.equal(f.searches(), 1, '最初は検索も');
  assert.deepEqual(h.pending(), [30000]);
  await h.advance(30000);
  assert.equal(f.searches(), 1, '5 分たつまで検索しない');
  assert.equal(h.calls.filter((x) => x.url.includes('/playlistItems?')).length, 2);
  await h.advance(270000);
  assert.equal(f.searches(), 2, '5 分たったら検索');
  await h.advance(600000);
  assert.equal(f.status().status, 'error');
  assert.match(f.status().reason, /15 分/);
  assert.deepEqual(h.pending(), []);
  assert.ok(f.searches() <= 4, `検索は 5 分に 1 回まで ${f.searches()}`);
  // 上限は止める
  h = streamHarness(() => ({ status: 403, chunks: [JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }] } })] }));
  f = createLiveFinder({ key: KEY, channel: { handle: '@abc' }, ...h });
  f.start();
  await h.flush();
  assert.equal(f.status().code, 'quota');
  // チャンネルが無い
  h = streamHarness(() => ({ body: { items: [] } }));
  f = createLiveFinder({ key: KEY, channel: { handle: '@nobody' }, ...h });
  f.start();
  await h.flush();
  assert.equal(f.status().status, 'error');
  assert.match(f.status().reason, /チャンネルが見つかりません/);
});

test('オーバーレイの URL の上書き（&top= &lanes= &laneh= &size= &speed=）は帯に当てる・使った量（stream・search も）・固定の高さの目安', () => {
  const base = sanitizeChatCfg(null);
  assert.deepEqual(applyChatOverrides(base, {}), base);
  assert.deepEqual(applyChatOverrides(base, { top: 700, lanes: 3 }).band, { x: 0, y: 700, w: 1920, h: 186 }, '列の高さはそのまま');
  assert.deepEqual(applyChatOverrides(base, { lanes: 2, laneH: 80 }).band, { x: 0, y: 660, w: 1920, h: 160 });
  const o = applyChatOverrides(base, { size: 40, speed: 5 });
  assert.deepEqual([o.size, o.speed], [40, 5]);
  assert.equal(quotaUnits({ stream: 2, channels: 1, playlistItems: 3, search: 1, videos: 2, messages: 1 }), 10 + 1 + 3 + 100 + 2 + 5);
  assert.ok(Math.abs(pinBoxHeight({ size: 34, lines: 2 }) - 160) <= 3, String(pinBoxHeight({ size: 34, lines: 2 })));
  assert.ok(pinBoxHeight({ size: 34, lines: 1 }) < pinBoxHeight({ size: 34, lines: 3 }));
});

