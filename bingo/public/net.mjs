// 切れても自動でつなぎ直す WebSocket。リスナー画面と主催者画面で共用する。
//
// onOpen(send): つながるたび、または「状態を取り直したい」ときに呼ばれる。ここで hello / auth を送る。
//   何も送らなかったときは false を返す(返事を待たないようにするため)。
// onMessage(msg): サーバーからのメッセージ。
// onStatus(online): つながった・切れたの通知。

const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 5000;
const REPLY_TIMEOUT_MS = 4000; // 取り直しの返事がこの時間来なければ、切ってつなぎ直す

export function connect({ path = '/ws', onOpen, onMessage, onStatus }) {
  let ws = null;
  let stopped = false;
  let retry = RETRY_MIN_MS;
  let retryTimer = null;
  let watchdog = null;

  const url = () => (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + path;

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function disarm() { clearTimeout(watchdog); watchdog = null; }

  // 返事を待つ。来なければ、この接続は死んでいるとみなす。
  function arm() {
    disarm();
    watchdog = setTimeout(() => {
      const dead = ws;
      ws = null;
      if (dead) { try { dead.close(); } catch { /* すでに閉じている */ } }
      onStatus(false);
      retry = RETRY_MIN_MS;
      open();
    }, REPLY_TIMEOUT_MS);
  }

  // 状態を問い合わせ、返事を待つ。
  function ask() {
    if (onOpen(send) === false) disarm();
    else arm();
  }

  function open() {
    if (stopped) return;
    clearTimeout(retryTimer);
    let sock;
    try { sock = new WebSocket(url()); } catch { schedule(); return; }
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      retry = RETRY_MIN_MS;
      onStatus(true);
      ask();
    };
    sock.onmessage = (event) => {
      if (ws !== sock) return;
      disarm();
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      onMessage(msg);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      disarm();
      onStatus(false);
      schedule();
    };
    sock.onerror = () => { try { sock.close(); } catch { /* すでに閉じている */ } };
  }

  function schedule() {
    if (stopped) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, retry);
    retry = Math.min(retry * 2, RETRY_MAX_MS);
  }

  // 画面に戻ってきたとき: 切れていればすぐつなぎ、つながっていれば状態を取り直す。
  function refresh() {
    if (stopped) return;
    if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      retry = RETRY_MIN_MS;
      open();
    } else if (ws.readyState === WebSocket.OPEN) {
      ask();
    }
  }

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  window.addEventListener('online', refresh);
  window.addEventListener('pageshow', (event) => { if (event.persisted) refresh(); });

  open();

  return {
    send,
    close() {
      stopped = true;
      clearTimeout(retryTimer);
      disarm();
      const sock = ws;
      ws = null;
      if (sock) { try { sock.close(); } catch { /* すでに閉じている */ } }
    },
  };
}
