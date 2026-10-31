// OBS WebSocket（obs-websocket v5）への接続（段階2）。進行画面（Chrome）だけが接続し、
// CallVendorRequest（vendorName: obs-browser / requestType: emit_event）で全ブラウザソースへ window の CustomEvent を送る。
// プロトコル: 接続 → Hello(op 0) → Identify(op 1。パスワードありなら authentication) → Identified(op 2) → Request(op 6) / RequestResponse(op 7)
// 認証: secret = base64(SHA256(password + salt))、auth = base64(SHA256(secret + challenge))（crypto.subtle）
// DOM 非依存（WebSocket と crypto.subtle を外から渡せる）。

export const OBS_DEFAULTS = Object.freeze({ host: '127.0.0.1', port: 4455, password: '', auto: true });
export const OBS_PREF_KEY = 'xtrend-show-obs';

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(bytes).toString('base64');
}

async function sha256b64(text, subtle) {
  return b64(await subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** obs-websocket v5 の認証文字列 */
export async function obsAuthString(password, salt, challenge, subtle = globalThis.crypto.subtle) {
  const secret = await sha256b64(String(password) + String(salt), subtle);
  return sha256b64(secret + String(challenge), subtle);
}

/** 接続先 URL（ホスト・ポートを検証。不正なら null） */
export function obsUrl(host, port) {
  const h = String(host || '').trim();
  const p = Number(port);
  if (!/^[A-Za-z0-9.\-:\[\]]{1,100}$/.test(h) || !Number.isInteger(p) || p < 1 || p > 65535) return null;
  return `ws://${h.includes(':') && !h.startsWith('[') ? `[${h}]` : h}:${p}`;
}

/** 閉じたときの理由（日本語）。closeCode は WebSocket の close コード */
export function obsCloseReason(closeCode, { everOpened = false, identified = false } = {}) {
  if (closeCode === 4009) return 'パスワードが違います（OBS の「WebSocket サーバー設定」のパスワードを確認してください）';
  if (closeCode === 4010) return 'OBS の WebSocket の版が合いません（OBS 28 以降の obs-websocket v5 が必要です）';
  if (closeCode === 4011) return 'OBS 側から接続を切られました';
  if (closeCode === 4008 || closeCode === 4007 || closeCode === 4006) return 'OBS とのやりとりに失敗しました（版の違いの可能性）';
  if (identified) return 'OBS との接続が切れました（OBS を閉じた・WebSocket を止めた可能性）';
  if (!everOpened) return 'OBS に接続できません。OBS が起動していない／「WebSocket サーバーを有効にする」がオフ／ポート番号が違う／ブラウザが「デバイス上のアプリ」への接続を許可していない、のどれかの可能性があります';
  return `OBS との接続が切れました（コード ${closeCode}）`;
}

/**
 * OBS クライアント。
 * opts: { WebSocketImpl, subtle, onStatus(status), now(), setTimer, clearTimer }
 * status: { state: 'idle'|'connecting'|'connected'|'error', reason, url, obsVersion }
 * 返り値: { connect({host,port,password,auto}), disconnect(), emit(eventName, data) → Promise<boolean>, status() }
 */
export function createObsClient(opts = {}) {
  const WS = opts.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  const subtle = opts.subtle || (globalThis.crypto && globalThis.crypto.subtle);
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer || ((t) => clearTimeout(t));
  let ws = null;
  let cfg = null;
  let st = { state: 'idle', reason: '', url: null, obsVersion: null };
  let reqSeq = 0;
  const pending = new Map();
  let retryTimer = null;
  let retries = 0;
  let manual = false;

  const set = (patch) => { st = { ...st, ...patch }; if (opts.onStatus) opts.onStatus({ ...st }); };

  function scheduleRetry() {
    if (manual || !cfg || !cfg.auto) return;
    clearTimer(retryTimer);
    const wait = [2000, 5000, 10000, 20000][Math.min(retries, 3)];
    retries++;
    retryTimer = setTimer(() => open(), wait);
  }

  function open() {
    if (!WS) { set({ state: 'error', reason: 'このブラウザは WebSocket に対応していません' }); return; }
    const url = obsUrl(cfg.host, cfg.port);
    if (!url) { set({ state: 'error', reason: 'ホスト名かポート番号が正しくありません' }); return; }
    let everOpened = false;
    let identified = false;
    let sock;
    try { sock = new WS(url); } catch { set({ state: 'error', reason: obsCloseReason(1006), url }); scheduleRetry(); return; }
    ws = sock;
    set({ state: 'connecting', reason: '', url });
    sock.onopen = () => { everOpened = true; };
    sock.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.op === 0) { // Hello
        const d = msg.d || {};
        const identify = { op: 1, d: { rpcVersion: 1, eventSubscriptions: 0 } };
        if (d.authentication) {
          if (!subtle) { set({ state: 'error', reason: 'このブラウザでは認証の計算ができません（https で開いてください）' }); sock.close(); return; }
          identify.d.authentication = await obsAuthString(cfg.password || '', d.authentication.salt, d.authentication.challenge, subtle);
        }
        set({ obsVersion: d.obsWebSocketVersion || null });
        sock.send(JSON.stringify(identify));
      } else if (msg.op === 2) { // Identified
        identified = true;
        retries = 0;
        set({ state: 'connected', reason: '' });
      } else if (msg.op === 7) { // RequestResponse
        const d = msg.d || {};
        const p = pending.get(d.requestId);
        if (p) {
          pending.delete(d.requestId);
          const ok = Boolean(d.requestStatus && d.requestStatus.result);
          if (!ok) set({ reason: `OBS が送信を受け付けませんでした（${(d.requestStatus && (d.requestStatus.comment || d.requestStatus.code)) || '理由不明'}）。ブラウザソースが 1 つも無い場合もこうなります` });
          p(ok);
        }
      }
    };
    sock.onerror = () => { /* close で理由を出す */ };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null;
      for (const p of pending.values()) p(false);
      pending.clear();
      if (manual) { set({ state: 'idle', reason: '' }); return; }
      const reason = obsCloseReason(ev && ev.code, { everOpened, identified });
      set({ state: 'error', reason });
      if (ev && ev.code === 4009) return; // パスワード違いは再接続しない
      scheduleRetry();
    };
  }

  return {
    connect(c) {
      cfg = { ...OBS_DEFAULTS, ...c };
      manual = false;
      retries = 0;
      clearTimer(retryTimer);
      if (ws) { const old = ws; ws = null; try { old.close(); } catch { /* 無視 */ } }
      open();
    },
    disconnect() {
      manual = true;
      clearTimer(retryTimer);
      if (ws) { const old = ws; ws = null; try { old.close(1000); } catch { /* 無視 */ } }
      set({ state: 'idle', reason: '' });
    },
    /** 全ブラウザソースへ CustomEvent（event_name）を送る。送れたら true */
    emit(eventName, data) {
      if (!ws || st.state !== 'connected') return Promise.resolve(false);
      const requestId = `xt-${++reqSeq}`;
      const msg = { op: 6, d: { requestType: 'CallVendorRequest', requestId, requestData: { vendorName: 'obs-browser', requestType: 'emit_event', requestData: { event_name: eventName, event_data: data } } } };
      return new Promise((resolve) => {
        pending.set(requestId, resolve);
        try { ws.send(JSON.stringify(msg)); } catch { pending.delete(requestId); resolve(false); return; }
        setTimer(() => { if (pending.has(requestId)) { pending.delete(requestId); resolve(false); } }, 5000);
      });
    },
    status() { return { ...st }; },
  };
}

/** 保存した OBS 設定（壊れていれば既定） */
export function parseObsPrefs(raw) {
  let o = null;
  try { o = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { o = null; }
  if (!o || typeof o !== 'object') return { ...OBS_DEFAULTS };
  const port = Number(o.port);
  return {
    host: typeof o.host === 'string' && o.host.trim() ? o.host.trim().slice(0, 100) : OBS_DEFAULTS.host,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : OBS_DEFAULTS.port,
    password: typeof o.password === 'string' ? o.password.slice(0, 200) : '',
    auto: o.auto !== false,
    enabled: o.enabled === true,
  };
}
