// X 公式埋め込み（widgets.js）。埋め込み表示が選ばれたときだけ動的に読み込む。
// 画面に近づいたものだけ IntersectionObserver で生成し、同時生成数を制限する。

export const WIDGETS_URL = 'https://platform.twitter.com/widgets.js';
const LOAD_TIMEOUT = 12000;
const EMBED_TIMEOUT = 15000;
const CONCURRENCY = 3;

let loadPromise = null;

/** widgets.js を読み込む（1 回だけ。失敗時は reset で再試行可能） */
export function loadWidgets() {
  const ready = () => window.twttr && window.twttr.widgets && typeof window.twttr.widgets.createTweet === 'function';
  if (ready()) return Promise.resolve(window.twttr);
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(window.twttr);
    };
    const timer = setTimeout(() => finish(new Error('widgets.js の読み込みがタイムアウトしました')), LOAD_TIMEOUT);
    s.src = WIDGETS_URL;
    s.async = true;
    s.charset = 'utf-8';
    s.onload = () => {
      if (!window.twttr) { finish(new Error('widgets.js が初期化されませんでした')); return; }
      if (typeof window.twttr.ready === 'function') window.twttr.ready(() => finish(ready() ? null : new Error('widgets.js が初期化されませんでした')));
      else finish(ready() ? null : new Error('widgets.js が初期化されませんでした'));
    };
    s.onerror = () => finish(new Error('widgets.js を読み込めませんでした'));
    document.head.append(s);
  });
  return loadPromise;
}

/** 失敗をキャッシュしたままにしない（表示切替のたびに再試行できるように） */
export function resetWidgetsFailure() {
  if (!loadPromise) return;
  loadPromise.catch(() => { loadPromise = null; });
}

function withTimeout(promise, ms, msg) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    Promise.resolve(promise).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * getTheme: () => 'light' | 'dark'
 * 返り値: { observe(host, id, onFail), now(host, id, onFail), reset() }
 *   host: 埋め込み先（.embed-host）。中の .embed-skeleton は成功時に消す
 */
export function createEmbedder({ getTheme }) {
  const queue = [];
  let running = 0;
  let gen = 0;
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const job = e.target.__embedJob;
        if (job) { queue.push(job); }
      }
      pump();
    }, { rootMargin: '300px 0px' })
    : null;

  async function run(job) {
    running++;
    const myGen = job.gen;
    try {
      if (!job.host.isConnected) return;
      const tw = await loadWidgets();
      if (!job.host.isConnected || (!job.persistent && myGen !== gen)) return;
      const target = document.createElement('div');
      target.className = 'embed-target';
      job.host.append(target);
      const node = await withTimeout(
        tw.widgets.createTweet(job.id, target, { lang: 'ja', theme: getTheme(), dnt: true, conversation: 'none' }),
        EMBED_TIMEOUT, '埋め込みの生成がタイムアウトしました',
      );
      if (!node) throw new Error('投稿を埋め込めませんでした（削除・非公開・センシティブ等）');
      job.host.classList.add('is-loaded');
      const sk = job.host.querySelector('.embed-skeleton');
      if (sk) sk.remove();
    } catch (err) {
      if (job.host.isConnected) job.onFail(err);
    } finally {
      running--;
      pump();
    }
  }

  function pump() {
    while (running < CONCURRENCY && queue.length) {
      const job = queue.shift();
      if (job.gen !== gen && !job.persistent) continue;
      run(job);
    }
  }

  return {
    observe(host, id, onFail) {
      const job = { host, id, onFail, gen };
      if (!io) { queue.push(job); pump(); return; }
      host.__embedJob = job;
      io.observe(host);
    },
    /** 単発（カードの「埋め込みで見る」）: 表示切替・再描画の影響を受けない */
    now(host, id, onFail) {
      queue.unshift({ host, id, onFail, gen, persistent: true });
      pump();
    },
    /** 一覧の作り直し時に呼ぶ（未生成のジョブを破棄） */
    reset() {
      gen++;
      if (io) io.disconnect();
      for (let i = queue.length - 1; i >= 0; i--) if (!queue[i].persistent) queue.splice(i, 1);
    },
  };
}
