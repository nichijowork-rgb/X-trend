// ブックマークレット生成。ブラウザ側の関数は単体で動くよう書き、toString から組み立てる。
// 方針: 画面に表示されているDOMのテキスト/属性だけを読む。通信・保存領域・認証情報・クリック操作は一切使わない。
// 注意: 下の xt* 関数の本体にはコメントを書かないこと（1行化するため）。外部参照も禁止（他の xt* 関数のみ可）。

function xtParseNum(s) {
  var m = String(s).replace(/,/g, '').match(/^\s*(\d+(?:\.\d+)?)\s*(万|億|千|[KkMmBb])?\s*$/);
  if (!m) return null;
  var mult = { '万': 1e4, '億': 1e8, '千': 1e3, K: 1e3, k: 1e3, M: 1e6, m: 1e6, B: 1e9, b: 1e9 }[m[2]] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

function xtParseLabels(label) {
  var out = {};
  if (!label) return out;
  var re = /(\d[\d,]*(?:\.\d+)?\s*(?:万|億|[KkMmBb](?![A-Za-z]))?)\s*(?:件の|件|個の|回の)?\s*(返信|リポスト|リツイート|いいね|ブックマーク|表示|repl(?:y|ies)|reposts?|retweets?|likes?|bookmarks?|views?)/gi;
  var m;
  while ((m = re.exec(label)) !== null) {
    var w = m[2].toLowerCase();
    var key = /返信|repl/.test(w) ? 'replies' : /リポスト|リツイート|repost|retweet/.test(w) ? 'reposts' : /いいね|like/.test(w) ? 'likes' : /ブックマーク|bookmark/.test(w) ? 'bookmarks' : 'views';
    if (out[key] === undefined) out[key] = xtParseNum(m[1]);
  }
  return out;
}

function xtText(el) {
  var s = '';
  var nodes = el.childNodes || [];
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (n.nodeType === 3) s += n.data;
    else if (n.nodeType === 1) {
      var t = String(n.tagName || '').toUpperCase();
      if (t === 'IMG') s += n.getAttribute('alt') || '';
      else if (t === 'BR') s += '\n';
      else s += xtText(n);
    }
  }
  return s;
}

function xtIsAd(article) {
  var spans = article.querySelectorAll('span');
  for (var i = 0; i < spans.length; i++) {
    var t = String(spans[i].textContent || '').replace(/\s+/g, ' ').trim();
    if (t === 'プロモーション' || t === 'Promoted' || t === 'Ad' || t === '広告' || /^(Promoted by|プロモーション by)/.test(t)) return true;
  }
  return false;
}

function xtExtractOne(article) {
  if (xtIsAd(article)) return null;
  var time = article.querySelector('time[datetime]');
  var link = time && time.closest ? time.closest('a') : null;
  var href = link ? link.getAttribute('href') || '' : '';
  var m = href.match(/\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
  if (!m) {
    var links = article.querySelectorAll('a[href*="/status/"]');
    for (var i = 0; i < links.length && !m; i++) {
      m = (links[i].getAttribute('href') || '').match(/\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
    }
  }
  if (!m) return null;
  var handle = m[1];
  var name = null;
  var user = article.querySelector('[data-testid="User-Name"]');
  if (user) {
    var anchors = user.querySelectorAll('a');
    for (var j = 0; j < anchors.length; j++) {
      var h = (anchors[j].getAttribute('href') || '').split('?')[0];
      var hm = h.match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (hm) {
        handle = hm[1];
        var nm = xtText(anchors[j]).trim();
        if (name === null && nm && nm.charAt(0) !== '@') name = nm;
      }
    }
  }
  var textEl = article.querySelector('[data-testid="tweetText"]');
  var text = textEl ? xtText(textEl).trim() : '';
  var metrics = { views: null, likes: null, reposts: null, replies: null, bookmarks: null };
  var labeled = article.querySelectorAll('[aria-label]');
  for (var k = 0; k < labeled.length; k++) {
    var got = xtParseLabels(labeled[k].getAttribute('aria-label'));
    for (var key in got) {
      if (metrics[key] === null && got[key] !== null) metrics[key] = got[key];
    }
  }
  var ids = { replies: ['reply'], reposts: ['retweet', 'unretweet'], likes: ['like', 'unlike'], bookmarks: ['bookmark', 'removeBookmark'] };
  for (var mk in ids) {
    if (metrics[mk] !== null) continue;
    for (var q = 0; q < ids[mk].length && metrics[mk] === null; q++) {
      var btn = article.querySelector('[data-testid="' + ids[mk][q] + '"]');
      if (btn) metrics[mk] = xtParseNum(String(btn.textContent || '').trim());
    }
  }
  return {
    postId: m[2],
    url: 'https://x.com/' + handle + '/status/' + m[2],
    authorHandle: handle,
    authorName: name,
    text: text || null,
    postedAt: time ? time.getAttribute('datetime') || null : null,
    metrics: metrics
  };
}

function xtExtract(root) {
  var arts = root.querySelectorAll('article[data-testid="tweet"]');
  var out = [];
  for (var i = 0; i < arts.length; i++) {
    var p = null;
    try { p = xtExtractOne(arts[i]); } catch (e) { p = null; }
    if (p) out.push(p);
  }
  return out;
}

function xtDetectPage(path, root) {
  if (/^\/search/.test(path)) return 'search';
  if (/^\/home/.test(path)) {
    var tabs = root.querySelectorAll('[role="tab"]');
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].getAttribute('aria-selected') === 'true') {
        var t = String(tabs[i].textContent || '').trim();
        if (/おすすめ|For you/i.test(t)) return 'foryou';
        if (/フォロー中|Following/i.test(t)) return 'following';
      }
    }
  }
  return 'other';
}

function xtB64(str) {
  var bytes = new TextEncoder().encode(str);
  var bin = '';
  for (var i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function xtMain(appUrl) {
  var host = location.hostname;
  if (!/(^|\.)(x|twitter)\.com$/.test(host)) { alert('x.com または twitter.com の画面で実行してください。'); return; }
  if (window.__xtRunning) return;
  var ans = prompt('取り込む最大件数を入力してください（既定 50）', '50');
  if (ans === null) return;
  var limit = parseInt(ans, 10);
  if (!(limit > 0)) limit = 50;
  if (limit > 500) limit = 500;
  var auto = confirm('自動でスクロールして最大 ' + limit + ' 件まで集めますか？\nOK＝自動スクロール / キャンセル＝今表示されている分だけ');
  window.__xtRunning = true;
  var stop = false;
  var onKey = function (e) { if (e.key === 'Escape') stop = true; };
  document.addEventListener('keydown', onKey, true);
  var box = document.createElement('div');
  box.setAttribute('style', 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#111;color:#fff;font:14px/1.6 sans-serif;padding:10px 14px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.5)');
  document.body.appendChild(box);
  var show = function (t) { box.textContent = t; };
  var map = {};
  var order = [];
  var page = xtDetectPage(location.pathname, document);
  var stagnant = 0;
  var rounds = 0;
  while (true) {
    var found = xtExtract(document);
    var before = order.length;
    for (var i = 0; i < found.length; i++) {
      var p = found[i];
      if (!map[p.postId]) { map[p.postId] = p; order.push(p.postId); }
    }
    stagnant = order.length === before ? stagnant + 1 : 0;
    show('X-trend 取り込み中: ' + order.length + ' / ' + limit + ' 件（Escで中断）');
    rounds++;
    if (!auto || stop || order.length >= limit || stagnant >= 5 || rounds > 150) break;
    window.scrollBy(0, Math.round(window.innerHeight * 0.8));
    await new Promise(function (r) { setTimeout(r, 900 + Math.random() * 500); });
  }
  document.removeEventListener('keydown', onKey, true);
  window.__xtRunning = false;
  var posts = order.slice(0, limit).map(function (id) { return map[id]; });
  if (!posts.length) { show('投稿が見つかりませんでした。タイムラインを表示した状態で再実行してください。'); setTimeout(function () { box.remove(); }, 5000); return; }
  var payload = { v: 1, capturedAt: new Date().toISOString(), page: page, pageUrl: location.origin + location.pathname, posts: posts };
  var json = JSON.stringify(payload);
  var base = appUrl.replace(/\/+$/, '');
  var target = base + '/#/capture?d=' + xtB64(json);
  if (target.length > 60000) {
    var copied = false;
    try { await navigator.clipboard.writeText(json); copied = true; } catch (e) { copied = false; }
    if (!copied) {
      var ta = document.createElement('textarea');
      ta.value = json;
      document.body.appendChild(ta);
      ta.select();
      try { copied = document.execCommand('copy'); } catch (e) { copied = false; }
      ta.remove();
    }
    show(posts.length + ' 件を集めました。' + (copied ? 'JSONをクリップボードにコピーしました。開いた画面の「取り込み」に貼り付けてください。' : 'コピーに失敗しました。件数を減らして再実行してください。'));
    if (copied) window.open(base + '/#/import', '_blank');
    setTimeout(function () { box.remove(); }, 15000);
    return;
  }
  show(posts.length + ' 件を集めました。X-trend を開きます…');
  var w = window.open(target, '_blank');
  if (!w) {
    box.textContent = '';
    var a = document.createElement('a');
    a.href = target;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = posts.length + ' 件を集めました。ここを押して X-trend を開く';
    a.setAttribute('style', 'color:#8cf;text-decoration:underline');
    box.appendChild(a);
    setTimeout(function () { box.remove(); }, 60000);
  } else {
    setTimeout(function () { box.remove(); }, 3000);
  }
}

const FUNCS = [xtParseNum, xtParseLabels, xtText, xtIsAd, xtExtractOne, xtExtract, xtDetectPage, xtB64, xtMain];

// テスト用に公開（ブラウザ内で動くものと同一コード）
export { xtParseNum as parseMetricNumber, xtParseLabels as parseMetricLabels, xtExtract as extractPosts, xtDetectPage as detectPage, xtB64 as toBase64Url };

/** 実行されるJavaScript本体（javascript: 接頭辞なし・エンコード前） */
export function buildBookmarkletSource(appUrl) {
  let u;
  try {
    u = new URL(String(appUrl));
  } catch {
    throw new Error('appUrl が不正です');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('appUrl は http(s) の URL を指定してください');
  const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  return `(function(){${FUNCS.map((f) => f.toString()).join('\n')}\nxtMain(${JSON.stringify(base)});})();`;
}

/** ブックマークに登録する 1 行の javascript: URL */
export function buildBookmarklet(appUrl) {
  return `javascript:${encodeURIComponent(buildBookmarkletSource(appUrl))}`;
}
