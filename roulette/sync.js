// ===== 同期アダプタ: mock(同一ブラウザ内) / firebase(本番) =====
// 口は同じ: { uid, get, set, update, remove, watch, onDisconnectRemove, onDisconnectSet, now, close }
const RouletteSync = (() => {
  'use strict';

  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;
  /**
   * 部屋の置き場所。チンチロと同じ Firebase(同じルール rooms/$code)を使うので、
   * 「RL-」を頭に付けてチンチロの部屋(4文字そのまま)と絶対に重ならないようにする。
   */
  const roomPath = (code) => `rooms/RL-${code}`;
  function roomCode(rng = Math.random) {
    let s = '';
    for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(rng() * CODE_CHARS.length)];
    return s;
  }

  // ---------- JSON ツリーの読み書き(Firebase と同じ感覚: null は削除、空オブジェクトは消える) ----------
  const split = (path) => String(path).split('/').filter(Boolean);
  function getAt(tree, path) {
    let cur = tree;
    for (const k of split(path)) {
      if (cur === null || typeof cur !== 'object' || !(k in cur)) return null;
      cur = cur[k];
    }
    return cur === undefined ? null : cur;
  }
  function setAt(tree, path, value) {
    const keys = split(path);
    if (keys.length === 0) return value == null ? {} : value;
    const root = tree && typeof tree === 'object' ? tree : {};
    let cur = root;
    for (let i = 0; i < keys.length - 1; i++) {
      if (cur[keys[i]] === null || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    const last = keys[keys.length - 1];
    if (value == null) delete cur[last];
    else cur[last] = value;
    prune(root);
    return root;
  }
  function prune(obj) {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === 'object') {
        prune(v);
        if (Object.keys(v).length === 0) delete obj[k];
      } else if (v == null) {
        delete obj[k];
      }
    }
  }

  // ---------- mock ----------
  const DB_KEY = 'roulette.mock.db';
  const UID_KEY = 'roulette.uid';
  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

  function createMock(opts = {}) {
    const storage = opts.storage || (isBrowser ? localStorage : null);
    if (!storage) throw new Error('mock には storage が必要');
    const uidStorage = opts.uidStorage || storage;
    const channel = opts.channel || (typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('roulette-mock') : null);
    let uid = opts.uid || uidStorage.getItem(UID_KEY);
    if (!uid) {
      uid = 'u_' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 6);
      uidStorage.setItem(UID_KEY, uid);
    }
    const readTree = () => { try { return JSON.parse(storage.getItem(DB_KEY) || '{}'); } catch { return {}; } };
    const writeTree = (t) => storage.setItem(DB_KEY, JSON.stringify(t));
    const watchers = new Set();
    const onDisconnect = [];

    // 各 watcher に、書き込みごとのスナップショットを順番どおり届ける。
    // 登録直後の初回配信(microtask)より前に来た変更は queue に溜めて、初回のあとに流す。
    function deliver(w, tree) {
      const v = getAt(tree, w.path);
      const key = JSON.stringify(v);
      if (key !== w.last) { w.last = key; w.cb(v); }
    }
    function notifyWith(tree) {
      for (const w of watchers) {
        if (w.ready) deliver(w, tree);
        else w.queue.push(tree);
      }
    }
    const onMessage = (ev) => { if (ev.data && ev.data.type === 'change') notifyWith(ev.data.tree); };
    if (channel) {
      channel.addEventListener('message', onMessage);
      if (typeof channel.unref === 'function') channel.unref(); // Node でプロセスを止めない
    }

    function commit(tree) {
      writeTree(tree);
      notifyWith(tree);
      if (channel) channel.postMessage({ type: 'change', tree });
    }

    const api = {
      uid,
      async get(path) { return getAt(readTree(), path); },
      async set(path, value) { commit(setAt(readTree(), path, value)); },
      async update(path, obj) {
        let tree = readTree();
        for (const [k, v] of Object.entries(obj)) tree = setAt(tree, path + '/' + k, v);
        commit(tree);
      },
      async remove(path) { commit(setAt(readTree(), path, null)); },
      watch(path, cb) {
        const v = getAt(readTree(), path);
        const w = { path, cb, last: JSON.stringify(v), ready: false, queue: [] };
        watchers.add(w);
        queueMicrotask(() => {
          if (!watchers.has(w)) return;
          cb(v);
          w.ready = true;
          for (const t of w.queue) deliver(w, t);
          w.queue = [];
        });
        return () => watchers.delete(w);
      },
      async onDisconnectRemove(path) { onDisconnect.push(() => api.remove(path)); },
      async onDisconnectSet(path, value) { onDisconnect.push(() => api.set(path, value)); },
      now: () => Date.now(),
      serverTimestamp: () => Date.now(),
      onConnected(cb) { queueMicrotask(() => cb(true)); return () => {}; },
      close() {
        if (channel) { channel.removeEventListener('message', onMessage); channel.close(); }
        watchers.clear();
      },
    };
    if (isBrowser) window.addEventListener('pagehide', () => { for (const f of onDisconnect) f(); });
    return api;
  }

  // ---------- firebase ----------
  const FIREBASE_CDN = 'https://www.gstatic.com/firebasejs/11.0.0/';
  async function createFirebase(config) {
    if (!config || typeof config !== 'object') throw new Error('FIREBASE_CONFIG がありません(roulette/firebase-config.js を確認してください)');
    const [appMod, authMod, dbMod] = await Promise.all([
      import(FIREBASE_CDN + 'firebase-app.js'),
      import(FIREBASE_CDN + 'firebase-auth.js'),
      import(FIREBASE_CDN + 'firebase-database.js'),
    ]);
    const app = appMod.initializeApp(config);
    const auth = authMod.getAuth(app);
    const cred = await authMod.signInAnonymously(auth);
    const db = dbMod.getDatabase(app);
    const r = (p) => dbMod.ref(db, p);
    return {
      uid: cred.user.uid,
      async get(path) { return (await dbMod.get(r(path))).val(); },
      set: (path, value) => dbMod.set(r(path), value),
      update: (path, obj) => dbMod.update(r(path), obj),
      remove: (path) => dbMod.remove(r(path)),
      watch: (path, cb) => dbMod.onValue(r(path), (snap) => cb(snap.val())),
      onDisconnectRemove: (path) => dbMod.onDisconnect(r(path)).remove(),
      onDisconnectSet: (path, value) => dbMod.onDisconnect(r(path)).set(value),
      now: () => Date.now(),
      serverTimestamp: () => dbMod.serverTimestamp(),
      onConnected: (cb) => dbMod.onValue(r('.info/connected'), (snap) => cb(!!snap.val())),
      close() {},
    };
  }

  /** まだ使われていない部屋コードを選ぶ(衝突したら引き直す)。 */
  async function allocateRoomCode(backend, rng = Math.random) {
    for (let i = 0; i < 20; i++) {
      const code = roomCode(rng);
      if ((await backend.get(roomPath(code))) == null) return code;
    }
    throw new Error('空いている部屋コードが見つかりません');
  }

  /** Firebase のエラーを、利用者が次に何をすればよいか分かる日本語にする。 */
  function explainError(err) {
    const code = err && typeof err === 'object' ? String(err.code || '') : '';
    const msg = err && typeof err === 'object' ? String(err.message || '') : String(err);
    if (code === 'auth/admin-restricted-operation' || code === 'auth/operation-not-allowed') return '匿名ログインが有効になっていません。Firebase の Authentication →「ログイン方法」→「匿名」を有効にしてください。';
    if (code === 'auth/unauthorized-domain') return 'このサイトが Firebase に許可されていません。Authentication →「設定」→「承認済みドメイン」に suesugi60.github.io を追加してください。';
    if (code === 'auth/network-request-failed') return 'ネットワークに接続できません。電波の良いところで再読み込みしてください。';
    if (code === 'PERMISSION_DENIED' || /PERMISSION_DENIED|permission_denied/i.test(msg)) return '書き込みが拒否されました。Realtime Database の「ルール」に chinchiro/firebase-rules.json の内容を貼って「公開」してください(チンチロと同じルールを使います)。';
    return msg;
  }

  async function createBackend(opts = {}) {
    if (opts.kind === 'mock') return createMock(opts);
    if (opts.kind === 'firebase') return createFirebase(opts.config);
    throw new Error('kind が不正: ' + opts.kind);
  }

  return { createBackend, roomCode, roomPath, CODE_RE, allocateRoomCode, explainError, getAt, setAt };
})();
if (typeof module !== 'undefined') module.exports = RouletteSync;
