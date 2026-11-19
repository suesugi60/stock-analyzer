// ===== 表示層: 役割の判定、配信者(ディーラー)・リスナー・表示専用の画面 =====
(() => {
  'use strict';
  const L = RouletteLogic;
  const WH = RouletteWheel;
  const SY = RouletteSync;
  const params = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const MOCK = params.get('mock') === '1';
  const ROOM_PARAM = (params.get('room') || '').toUpperCase();
  const ROOM_OK = SY.CODE_RE.test(ROOM_PARAM);
  const IS_STAGE = params.get('stage') === '1';
  const QUICK = params.get('quick') === '1';          // 回る演出を一瞬で終える(テスト用)
  const SHARED_UID = params.get('shareduid') === '1'; // mock で uid をタブ間で共有(テスト用)
  const FORCE_N = params.get('n');                    // mock のときだけ: 出る数字を決め打ち(テスト用)
  const KEY_HOST = 'roulette.host';
  const KEY_MUTED = 'roulette.muted';
  const KEY_CHIP = 'roulette.chip';
  const MAX_PRESENCE = 80; // 無料枠(同時100接続)の安全装置
  const WAIT_HOST_MS = Number(params.get('waitms')) || 6000; // 賭けに配信者の画面が応えないとき案内を出すまで
  const TOP_ROWS = 10;     // リスナー・表示専用に出す順位の数
  const MAX_ROWS = 100;    // 配信者の一覧に出す人数

  // リスナーのアイコン。id はチンチロと同じ Firebase ルール(char に入れてよい 12 個の名前)に合わせた合言葉で、
  // このアプリでは絵文字の番号としてだけ使う。
  const ICONS = [
    { id: 'momotaro', e: '🍑' }, { id: 'kintaro', e: '🐻' }, { id: 'urashima', e: '🐰' }, { id: 'kaguya', e: '🌙' },
    { id: 'issun', e: '🌸' }, { id: 'akaoni', e: '🍓' }, { id: 'aooni', e: '🦄' }, { id: 'inu', e: '🐶' },
    { id: 'saru', e: '🐱' }, { id: 'kiji', e: '🐥' }, { id: 'kappa', e: '🍒' }, { id: 'binbo', e: '🎀' },
  ];
  const ICON_OF = Object.fromEntries(ICONS.map((c) => [c.id, c.e]));
  const validChar = (id) => typeof id === 'string' && Object.hasOwn(ICON_OF, id);
  const iconOf = (id) => (validChar(id) ? ICON_OF[id] : '💗');
  const AVATAR_COLORS = ['#ffd6e7', '#ffe9c7', '#e9dcff', '#d6efff', '#dcf7e6', '#fff3b8'];
  const colorFor = (uid) => { let h = 0; for (const ch of String(uid)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return AVATAR_COLORS[h % AVATAR_COLORS.length]; };

  const store = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できなくても動く */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* 同上 */ } },
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const safeName = (s) => String(s ?? '').trim().slice(0, 12);
  const fmt = (n) => Number(n).toLocaleString('ja-JP');
  const signed = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : '±0');
  /** 同じ中身なら DOM を触らない(ボタンを押している最中に作り直さない)。 */
  function setHtml(el, html) { if (el && el.__last !== html) { el.__last = html; el.innerHTML = html; } }
  /** 出る数字を決める乱数。端末の暗号用の乱数を使う(無ければ Math.random)。 */
  const fairRandom = () => {
    try { return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296; } catch { return Math.random(); }
  };
  /** テスト用: 最初の 1 回(= 出る数字)だけ決め打ちする乱数。本番(Firebase)では使えない。 */
  function spinRandom() {
    const n = Number(FORCE_N);
    if (!MOCK || FORCE_N === null || !Number.isInteger(n) || n < 0 || n > 36) return fairRandom;
    let first = true;
    return () => { if (first) { first = false; return (n + 0.5) / 37; } return fairRandom(); };
  }

  const sounds = WH.createSounds();
  sounds.setMuted(store.get(KEY_MUTED) === true);

  function show(id) {
    for (const s of document.querySelectorAll('#app > .screen')) s.hidden = s.id !== id;
    window.scrollTo(0, 0);
  }
  let toastTimer = 0;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }
  function setAvatar(el, charId, color) {
    el.dataset.char = validChar(charId) ? charId : '';
    el.style.setProperty('--c', color || '#ffd6e7');
    el.textContent = iconOf(charId);
  }

  // ---------- 接続 ----------
  let backend = null;
  let code = null;      // いまの部屋コード
  let room;             // 同期された部屋(最新)。配信者の進行はこれを使う。undefined: まだ届いていない / null: 部屋が無い
  let shown = null;     // 画面に出している部屋。玉が止まるまで古いまま(結果の先バレ防止)
  let role = null;      // 'host' | 'stage' | 'listener'
  let wheel = null;
  let unsubRoom = null;
  let seenSpin = null;  // 見たことのある最後の spin.id(初回は再生しない)
  let playing = false;
  let playToken = 0;
  const path = (sub = '') => SY.roomPath(code) + (sub ? `/${sub}` : '');

  async function connect() {
    if (MOCK) return SY.createBackend({ kind: 'mock', storage: localStorage, uidStorage: SHARED_UID ? localStorage : sessionStorage });
    return SY.createBackend({ kind: 'firebase', config: window.FIREBASE_CONFIG });
  }

  function subscribe(c) {
    if (unsubRoom) unsubRoom();
    code = c;
    unsubRoom = backend.watch(SY.roomPath(c), onRoom);
  }
  function onRoom(r) {
    if (!r || !r.hostUid) { room = null; render(); return; }
    room = { ...r, state: L.normalizeState(r.state) };
    const sp = room.state.spin;
    if (seenSpin === null) seenSpin = sp ? sp.id : 0;       // 途中から開いた端末は、最後の回転を再生しない
    else if (sp && sp.id !== seenSpin) { seenSpin = sp.id; play(sp); }
    if (!playing) shown = room;
    if (role === 'listener') syncPending();
    render();
  }

  /** 新しい回転を再生する。止まるまで画面のチップや出目は古いまま、止まったら最新に切り替えて結果を出す。 */
  async function play(sp) {
    const token = ++playToken;
    playing = true;
    hideConfetti();
    if (role === 'listener' && listenerView.refs.wheel) { try { listenerView.refs.wheel.scrollIntoView({ block: 'center', behavior: QUICK ? 'auto' : 'smooth' }); } catch { /* 古いブラウザ */ } }
    await wheel.spin(sp, { quick: QUICK });
    if (token !== playToken) return; // もっと新しい回転に替わった
    playing = false;
    shown = room;
    render();
    if (room && room.state.phase === 'done' && room.state.spin && room.state.spin.id === sp.id) celebrate();
  }

  const CONFETTI = ['#ff2e88', '#ff8ab5', '#ffffff', '#ffd166', '#c9a7ff', '#ff6f91'];
  function hideConfetti() { const box = $('confetti'); if (!box.hidden) { box.hidden = true; box.innerHTML = ''; } }
  function showConfetti() {
    const box = $('confetti');
    box.innerHTML = '';
    for (let i = 0; i < 60; i++) {
      const piece = document.createElement('i');
      const color = CONFETTI[i % CONFETTI.length];
      piece.style.left = `${Math.random() * 100}%`;
      if (i % 2) { piece.className = 'heart'; piece.textContent = '♥'; piece.style.color = color; } else piece.style.background = color;
      piece.style.animationDelay = `${Math.random() * 1.2}s`;
      piece.style.animationDuration = `${2.2 + Math.random() * 1.4}s`;
      piece.style.transform = `rotate(${Math.random() * 360}deg)`;
      box.appendChild(piece);
    }
    box.hidden = false;
  }
  /** 止まった瞬間の演出。リスナーは自分の勝ち負け、配信者と表示専用は当たった人がいるかで変える。 */
  function celebrate() {
    const res = L.results(room.state);
    if (role === 'listener') {
      const mine = res[backend.uid];
      if (mine && mine.net > 0) { sounds.fanfare(); showConfetti(); try { navigator.vibrate?.([200, 100, 200]); } catch { /* 非対応 */ } }
      else if (mine && mine.net < 0) sounds.lose();
      else sounds.ding();
      return;
    }
    const anyWin = Object.values(res).some((r) => r.net > 0);
    if (anyWin) { sounds.fanfare(); showConfetti(); } else sounds.ding();
  }

  // ---------- 画面の共通部分(盤・結果・出目・テーブル・順位) ----------
  const hostView = { root: null, refs: {} };
  const stageView = { root: null, refs: {} };
  const listenerView = { root: null, refs: {} };
  function bind(view, root) {
    view.root = root;
    view.refs = {};
    for (const el of root.querySelectorAll('[data-ref]')) view.refs[el.dataset.ref] = el;
  }

  function joinUrl(c) {
    const u = new URL(location.href);
    u.search = '';
    u.hash = '';
    u.searchParams.set('room', c);
    if (MOCK) u.searchParams.set('mock', '1');
    return u.toString();
  }

  let qrDrawnFor = null;
  let qrLoading = false;
  function loadQrLib() {
    if (qrLoading || MOCK || window.QRCode) return;
    qrLoading = true;
    const sc = document.createElement('script');
    sc.src = 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js';
    sc.onload = () => render();
    sc.onerror = () => { qrLoading = false; };
    document.head.appendChild(sc);
  }
  function drawQr(view, text) {
    const canvas = view.refs.qr;
    if (!canvas) return;
    if (!window.QRCode || typeof window.QRCode.toCanvas !== 'function') { loadQrLib(); canvas.hidden = true; return; }
    if (qrDrawnFor === text) return;
    qrDrawnFor = text;
    canvas.hidden = false;
    window.QRCode.toCanvas(canvas, text, { width: 96, margin: 1 }, (err) => { if (err) canvas.hidden = true; });
  }

  const dispName = (m) => (m.hidden ? '？？？' : m.name);
  /** いま画面に見せる段階。'bet' 賭けの受付中 / 'spin' 回っている / 'done' 結果 / 'closed'。 */
  const viewPhase = () => (playing ? 'spin' : room.state.phase);
  const discHtml = (n, cls = '') => `<span class="disc ${L.colorOf(n)} ${cls}" data-n="${n}">${n}</span>`;

  function statusHtml(st, phase) {
    if (phase === 'spin') return '<span class="spinning-note">ノーモアベット! 回っています…</span>';
    if (phase === 'done') return `第${st.round}ゲームの結果`;
    const t = L.totals(st);
    return `第${st.round}ゲーム ・ <b>ベット受付中</b>` + (t.players ? ` ・ ${t.players}人 / 合計 <b>${fmt(t.total)}</b>` : '');
  }

  function resultHtml(rm) {
    const st = rm.state;
    const n = st.spin.n;
    const res = L.results(st);
    const byUid = Object.fromEntries(L.members(rm).map((m) => [m.uid, m]));
    const rows = Object.entries(res).filter(([uid]) => byUid[uid]).map(([uid, r]) => ({ ...r, m: byUid[uid] })).sort((a, b) => b.net - a.net);
    const winners = rows.filter((r) => r.net > 0);
    let list;
    if (!rows.length) list = '<div class="rsub">だれも賭けていませんでした</div>';
    else if (!winners.length) list = '<div class="rsub">全員はずれ… 配信者の総取り!</div>';
    else {
      list = '<div class="winners">' + winners.slice(0, 5).map((r) =>
        `<div class="winner"><span class="avatar sm" style="--c:${colorFor(r.m.uid)}">${iconOf(r.m.char)}</span><span class="wname">${esc(dispName(r.m))}</span>` +
        `<b class="plus">${signed(r.net)}</b>${r.hits.some((s) => s <= 36) ? '<span class="tag won">数字ぴったり!</span>' : ''}</div>`).join('') +
        (winners.length > 5 ? `<div class="rsub">ほか ${winners.length - 5}人が当たり</div>` : '') + '</div>';
    }
    return `<div class="rcap">出た数字は…</div><div class="rmain">${discHtml(n, 'big')}<div class="rdesc">${esc(L.describe(n))}</div></div>${list}`;
  }

  function rankingHtml(rm, isHost) {
    const all = L.ranking(rm);
    if (!all.length) return '<div class="empty-note">まだ誰もいません。QR か URL から入ってもらおう</div>';
    const limit = isHost ? MAX_ROWS : TOP_ROWS;
    const rows = all.slice(0, limit).map((m, i) => ({ m, rank: i + 1 }));
    const meIdx = all.findIndex((m) => m.uid === backend.uid);
    if (!isHost && meIdx >= limit) rows.push({ m: all[meIdx], rank: meIdx + 1 }); // 自分が圏外でも自分の行は出す
    const html = rows.map(({ m, rank }) => {
      const tags = (m.rebuys ? `<span class="tag">おかわり×${m.rebuys}</span>` : '') + (m.online ? '' : '<span class="tag off">オフライン</span>');
      const acts = isHost
        ? `<span class="qacts"><button type="button" class="btn" data-act="hide">${m.hidden ? '表示' : '非表示'}</button><button type="button" class="btn ban" data-act="ban">ブロック</button></span>`
        : '';
      return `<div class="member-row${m.uid === backend.uid ? ' me' : ''}" data-uid="${esc(m.uid)}"><span class="rno">${rank}</span>` +
        `<span class="avatar sm" style="--c:${colorFor(m.uid)}">${iconOf(m.char)}</span><span class="qname">${esc(dispName(m))}${tags}</span>` +
        `<b class="pts">${fmt(m.chips)}</b>${acts}</div>`;
    }).join('');
    return html + (all.length > rows.length ? `<div class="empty-note">ぜんぶで ${all.length}人</div>` : '');
  }

  function renderBoard(view, opts = {}) {
    if (!view.root || !shown) return;
    const rm = shown;
    const st = rm.state;
    const phase = viewPhase();
    const r = view.refs;
    view.root.dataset.phase = phase;
    if (r.code) r.code.textContent = code;
    if (r.url) r.url.textContent = joinUrl(code);
    if (r.qr) drawQr(view, joinUrl(code));
    const done = phase === 'done' && !!st.spin;
    if (!playing) wheel.rest(st.spin, { win: done });
    setHtml(r.status, statusHtml(st, phase));
    setHtml(r.hist, st.history.length ? `<span class="rlabel">これまでの出目(左が新しい)</span>${st.history.slice(0, 12).map((n) => discHtml(n)).join('')}` : '');
    if (r.result) { setHtml(r.result, done ? resultHtml(rm) : ''); r.result.hidden = !done; }
    if (!done) hideConfetti();
    const t = L.totals(st);
    const mine = opts.mine || {};
    const bySpot = { ...t.bySpot };
    for (const [s, v] of Object.entries(opts.extra || {})) bySpot[s] = { sum: (bySpot[s] ? bySpot[s].sum : 0) + v, count: 0 }; // まだ届いていない自分の賭けも足す
    if (r.table) WH.renderTable(r.table, { mine, totals: bySpot, win: done ? st.spin.n : null, interactive: !!opts.interactive });
    if (r.tsum) r.tsum.textContent = t.total ? `合計 ${fmt(t.total)}` : '';
    if (r.count) r.count.textContent = `${L.members(rm).length}人`;
    setHtml(r.ranking, rankingHtml(rm, !!opts.isHost));
    if (r.house) r.house.textContent = `配信者(ディーラー)の収支 ${signed(st.house)}`;
  }

  function render() {
    if (room === undefined) return;
    if (!room) {
      if (role === 'stage' || role === 'listener') show('screen-notfound');
      return;
    }
    if (!shown) shown = room;
    if (role === 'host') {
      hostQueue = hostQueue.then(processActions).catch((e) => console.warn('合図の処理に失敗', e));
      renderBoard(hostView, { isHost: true });
      renderHost();
    }
    if (role === 'stage') renderBoard(stageView);
    if (role === 'listener') renderListener();
  }

  /** ミュートでないのに音を鳴らせない間だけ「タップで音をオン」を出す。 */
  function updateAudioBadge() {
    $('audio-badge').hidden = sounds.muted || sounds.ready || !(role === 'host' || role === 'listener');
  }
  sounds.onReadyChange(updateAudioBadge);
  function renderMute() {
    for (const id of ['mute', 'mute-l']) $(id).textContent = sounds.muted ? '🔇' : '🔊';
    updateAudioBadge();
  }

  // ---------- 配信者: 入口 ----------
  function enterHostEntry() {
    const prev = store.get(KEY_HOST);
    $('resume-banner').hidden = !(prev && prev.code && prev.uid === backend.uid);
    show('screen-host-entry');
  }
  async function createRoom() {
    const c = await SY.allocateRoomCode(backend);
    await backend.set(SY.roomPath(c), { hostUid: backend.uid, createdAt: backend.serverTimestamp(), settings: { app: 'roulette' }, state: L.serializeState(L.createState()) });
    store.set(KEY_HOST, { code: c, uid: backend.uid });
    await enterHost(c);
  }

  /** 配信者の画面は1タブだけ(2つ開くと同じ賭けを二重に処理する)。Web Locks でロックを持ち続ける。 */
  function acquireHostLock(c) {
    if (!navigator.locks) return Promise.resolve(true);
    return new Promise((resolve) => {
      navigator.locks.request(`roulette-host-${c}`, { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(false); return undefined; }
        resolve(true);
        return new Promise(() => {}); // ページが閉じるまで保持
      }).catch(() => resolve(true));
    });
  }

  async function enterHost(c) {
    if (!(await acquireHostLock(c))) {
      $('busy-code').textContent = c;
      show('screen-host-busy');
      return;
    }
    role = 'host';
    sounds.setKeepAlive(true);
    bind(hostView, $('screen-host'));
    wheel = WH.create(hostView.refs.wheel, sounds);
    subscribe(c);
    show('screen-host');
    renderMute();
  }

  function enterStage(c) {
    role = 'stage';
    sounds.setMuted(true); // 表示専用は音なし(配信ソフトで二重に鳴らさない)
    const clone = $('screen-host').cloneNode(true);
    clone.id = 'screen-stage';
    for (const el of clone.querySelectorAll('[data-host-only]')) el.remove();
    for (const el of clone.querySelectorAll('[id]')) el.removeAttribute('id');
    $('app').appendChild(clone);
    bind(stageView, clone);
    wheel = WH.create(stageView.refs.wheel, sounds);
    subscribe(c);
    show('screen-stage');
  }

  // ---------- 配信者: 進行(state を書けるのは配信者の画面だけ) ----------
  let hostQueue = Promise.resolve();
  const hostDo = (fn) => { hostQueue = hostQueue.then(fn).catch((e) => { console.warn(e); alert('うまくいきませんでした: ' + SY.explainError(e)); }); return hostQueue; };
  const writeState = (st) => backend.set(path('state'), JSON.parse(JSON.stringify(L.serializeState(st))));

  async function hostSpin() {
    if (playing || !room) return;
    const next = L.spin(room.state, spinRandom());
    if (next) await writeState(next);
  }
  async function hostNext() {
    if (playing || !room || room.state.phase !== 'done') return;
    await writeState(L.nextRound(room.state));
  }
  /**
   * リスナーの合図(賭ける・取り消す・おかわり)を処理する。いま届いている分をまとめて 1 回で書き込む
   * (1 つずつ書くと、人数が多いときに順番待ちで遅れる)。受け付けた分のチップの動きと、合図の片づけは同じ書き込みなので、二重に数えない。
   */
  async function processActions() {
    if (!room || !room.actions) return;
    let st = room.state;
    const upd = {};
    for (const [uid, a] of Object.entries(room.actions)) {
      const p = (room.players || {})[uid];
      const op = a && a.type === 'roll' ? L.decodeOp(a.at) : null;
      const patch = p && typeof p.name === 'string' && p.name && !p.banned ? L.applyOp(st, uid, op) : null;
      upd[`actions/${uid}`] = null;
      if (!patch) continue;
      st = L.applyPatch(st, patch);
      for (const [k, v] of Object.entries(patch)) upd[`state/${k}`] = v;
    }
    await backend.update(SY.roomPath(code), upd);
  }
  async function moderate(act, uid) {
    const p = (room.players || {})[uid] || {};
    if (act === 'hide') { await backend.update(path(`players/${uid}`), { hidden: !p.hidden }); return; }
    if (act === 'ban') {
      const upd = { [`players/${uid}/banned`]: true };
      if (room.state.phase === 'bet' && L.stakeOf(room.state, uid) > 0) upd[`state/bets/${uid}`] = null; // 置いてある賭けは片づける
      await backend.update(SY.roomPath(code), upd);
    }
  }

  function renderHost() {
    const phase = viewPhase();
    const spinBtn = $('spin');
    spinBtn.hidden = phase === 'done';
    spinBtn.disabled = phase !== 'bet';
    spinBtn.textContent = phase === 'spin' ? '回っています…' : '💗 ベット締め切り → 回す';
    $('next').hidden = phase !== 'done';
    $('reset-chips').disabled = phase === 'spin';
    const t = L.totals(room.state);
    $('spin-hint').textContent = phase === 'bet'
      ? (t.players ? `${t.players}人が賭けています。そろったら「回す」を押してね` : 'リスナーがスマホでチップを賭けます。そろったら「回す」を押してね')
      : phase === 'done' ? '「次のゲームへ」で、テーブルを片づけて賭けの受付を始めます' : '';
  }

  // ---------- リスナー ----------
  let join = { name: '', char: ICONS[Math.floor(Math.random() * ICONS.length)].id };
  let joined = false;       // 参加したことがある(online を管理する)
  let chipValue = L.CHIP_VALUES.includes(store.get(KEY_CHIP)) ? store.get(KEY_CHIP) : L.CHIP_VALUES[0];
  const keyListener = () => `roulette.listener.${code}`;
  const isPlayer = () => !!(room && (room.players || {})[backend.uid] && (room.players || {})[backend.uid].name);

  // まだ配信者に届いていない自分の操作。通信の決まりで一度に送れる合図は 1 つなので、順番に 1 つずつ送る。
  //   queue: これから送る賭け(場所 → チップ。同じ場所はまとめる) / special: 取り消し・おかわり / inflight: 送って返事を待っているもの
  const pend = { queue: new Map(), special: null, inflight: null, round: 0, absent: false, timer: 0 };
  const pendingBets = () => {
    const out = {};
    for (const [s, v] of pend.queue) out[s] = (out[s] || 0) + v;
    if (pend.inflight && pend.inflight.code < L.SPOT_COUNT) out[pend.inflight.code] = (out[pend.inflight.code] || 0) + pend.inflight.amount;
    return out;
  };
  const pendingSum = () => Object.values(pendingBets()).reduce((s, v) => s + v, 0);

  function sendOp(opCode, amount) {
    const round = room.state.round;
    pend.inflight = { code: opCode, amount, round };
    pend.absent = false;
    clearTimeout(pend.timer);
    pend.timer = setTimeout(() => { if (pend.inflight) { pend.absent = true; render(); } }, WAIT_HOST_MS);
    backend.set(path(`actions/${backend.uid}`), { type: 'roll', at: L.encodeOp(round, opCode, amount) })
      .catch((e) => { console.warn('合図を送れませんでした', e); pend.inflight = null; pend.queue.clear(); pend.special = null; toast('送れませんでした。電波を確かめてね'); render(); });
  }
  /** 次の合図を送る(返事待ちが無いときだけ)。 */
  function pump() {
    if (pend.inflight || !room) return;
    if (pend.special !== null) { const c = pend.special; pend.special = null; sendOp(c, 0); return; }
    if (room.state.phase !== 'bet') { pend.queue.clear(); return; }
    const first = pend.queue.entries().next();
    if (first.done) return;
    const [spot, amount] = first.value;
    pend.queue.delete(spot);
    sendOp(spot, amount);
  }
  /** 部屋の最新が届くたびに、返事待ちの片づけと次の送信をする。 */
  function syncPending() {
    if (pend.inflight && !(room.actions && room.actions[backend.uid])) { pend.inflight = null; pend.absent = false; clearTimeout(pend.timer); } // 配信者が受け取った
    const st = room.state;
    if (st.round !== pend.round || st.phase !== 'bet') {
      if (pend.queue.size && pend.round === st.round) toast('ベットは締め切られました');
      pend.queue.clear();
    }
    pend.round = st.round;
    pump();
  }

  function tapSpot(spot) {
    if (!room || playing || room.state.phase !== 'bet' || !isPlayer()) return;
    const avail = L.chipsOf(room.state, backend.uid) - pendingSum();
    if (avail < chipValue) { toast(avail < L.MIN_BET ? 'チップがありません' : `チップが足りません(のこり ${fmt(avail)})`); return; }
    pend.queue.set(spot, (pend.queue.get(spot) || 0) + chipValue);
    sounds.chip();
    pump();
    render();
  }
  function clearBets() {
    if (!room || room.state.phase !== 'bet') return;
    pend.queue.clear();
    if (L.stakeOf(room.state, backend.uid) > 0 || pend.inflight) pend.special = L.OP.CLEAR;
    pump();
    render();
  }
  function rebuy() {
    if (!room || !L.isBroke(room.state, backend.uid)) return;
    pend.special = L.OP.REBUY;
    pump();
    render();
  }

  function renderJoin() {
    $('join-code').textContent = code;
    setAvatar($('join-avatar'), join.char, colorFor(backend.uid));
    if ($('join-name').value !== join.name) $('join-name').value = join.name;
    const grid = $('icons');
    if (!grid.firstChild) {
      for (const c of ICONS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'icon-pick';
        b.dataset.char = c.id;
        b.textContent = c.e;
        b.setAttribute('aria-label', `アイコン ${c.e}`);
        grid.appendChild(b);
      }
    }
    for (const b of grid.children) b.setAttribute('aria-pressed', String(b.dataset.char === join.char));
  }

  async function enterListenerEntry(c) {
    role = 'listener';
    code = c;
    const r = await backend.get(SY.roomPath(c));
    if (!r || !r.hostUid) { show('screen-notfound'); return; }
    if (r.state && r.state.phase === 'closed') { show('screen-closed'); return; }
    const me = (r.players || {})[backend.uid];
    if (me && me.banned) { show('screen-banned'); return; }
    if (!me && Object.keys(r.presence || {}).length > MAX_PRESENCE) { show('screen-full'); return; }
    // 接続のたび(初回と回線が戻ったとき)に presence/online を立て直し、切断時の後始末を登録し直す
    backend.onConnected(async (ok) => {
      if (!ok) return;
      try {
        await backend.set(path(`presence/${backend.uid}`), true);
        await backend.onDisconnectRemove(path(`presence/${backend.uid}`));
        if (joined) {
          await backend.update(path(`players/${backend.uid}`), { online: true });
          await backend.onDisconnectSet(path(`players/${backend.uid}/online`), false);
        }
      } catch (e) { console.warn('presence の更新に失敗', e); }
    });
    if (me && me.name) { // 再読み込み: 参加済みなら自分の画面へ直接戻る
      joined = true;
      await backend.update(path(`players/${backend.uid}`), { online: true });
      await backend.onDisconnectSet(path(`players/${backend.uid}/online`), false);
      enterListener();
      return;
    }
    const saved = store.get(keyListener());
    if (saved && typeof saved === 'object') { join.name = safeName(saved.name); if (validChar(saved.char)) join.char = saved.char; }
    renderJoin();
    show('screen-join');
  }

  async function joinRoom() {
    join.name = safeName($('join-name').value) || 'リスナー';
    const base = path(`players/${backend.uid}`);
    await backend.update(base, { name: join.name, char: join.char, joinedAt: backend.serverTimestamp(), online: true });
    await backend.onDisconnectSet(`${base}/online`, false);
    joined = true;
    store.set(keyListener(), join);
    enterListener();
  }

  function enterListener() {
    role = 'listener';
    if (!listenerView.root) {
      bind(listenerView, $('screen-listener'));
      wheel = WH.create(listenerView.refs.wheel, sounds);
      const box = $('chip-values');
      for (const v of L.CHIP_VALUES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `chipbtn c${v}`;
        b.dataset.v = String(v);
        b.textContent = String(v);
        b.setAttribute('aria-label', `${v} チップを選ぶ`);
        box.appendChild(b);
      }
      subscribe(code);
    }
    show('screen-listener');
    renderMute();
    render();
  }

  function renderListener() {
    const live = room.state;
    const uid = backend.uid;
    const me = (room.players || {})[uid] || null;
    if (me && me.banned) { show('screen-banned'); return; }
    if (live.phase === 'closed') { show('screen-closed'); return; }
    const player = !!(me && me.name);
    const phase = viewPhase();
    const betting = phase === 'bet' && player;
    const pb = betting ? pendingBets() : {};
    const st = shown.state; // 玉が止まるまで、チップや結果は古いまま
    const confirmed = L.betsOf(st, uid);
    const mine = { ...confirmed };
    for (const [s, v] of Object.entries(pb)) mine[s] = (mine[s] || 0) + v;
    renderBoard(listenerView, { mine: player ? mine : {}, extra: pb, interactive: betting });

    sounds.setKeepAlive(false); // リスナーは無音を流さない(聴いている音楽を止めない)
    updateAudioBadge();
    const pendSum = Object.values(pb).reduce((s, v) => s + v, 0);
    const chips = L.chipsOf(st, uid) - pendSum;
    const stake = Object.values(mine).reduce((s, v) => s + v, 0);
    const broke = player && !playing && L.isBroke(live, uid) && pend.special === null && !pend.inflight;
    let big = '見ているだけ';
    let sub = '「参加する」を押すと、チップをもらって賭けられます';
    let mood = '';
    if (player) {
      if (phase === 'spin') { big = 'ノーモアベット!'; sub = stake ? `${fmt(stake)} チップを賭けました。玉の行方は…` : '今回は賭けていません'; }
      else if (phase === 'done') {
        const res = L.results(st)[uid];
        if (!res) { big = '今回は賭けていません'; sub = '次のゲームをお待ちください'; }
        else if (res.net > 0) { big = `🎉 当たり! ${signed(res.net)}`; sub = `${fmt(res.stake)} 賭けて ${fmt(res.payout)} もどりました`; mood = 'won'; }
        else if (res.net === 0) { big = 'ひきわけ ±0'; sub = `${fmt(res.stake)} 賭けて ${fmt(res.payout)} もどりました`; }
        else { big = `ざんねん… ${signed(res.net)}`; sub = res.payout ? `${fmt(res.stake)} 賭けて ${fmt(res.payout)} もどりました` : '次のゲームでとりかえそう'; mood = 'lost'; }
      } else if (pend.absent) { big = '配信者の画面を待っています…'; sub = '配信者の画面が開いていないと賭けられません'; }
      else if (broke) { big = 'チップがなくなりました'; sub = '「おかわり」でもう一度もらえます'; }
      else if (stake) { big = `${fmt(stake)} チップを賭けています`; sub = 'さらに置く・「取り消す」でやり直せます'; }
      else { big = 'ベットしてね!'; sub = 'チップをえらんで、テーブルの場所をタップ'; mood = 'turn'; }
    }
    $('my-status').textContent = big;
    $('my-sub').textContent = sub;
    const card = document.querySelector('.mystatus');
    card.classList.toggle('turn', mood === 'turn');
    card.classList.toggle('won', mood === 'won');
    card.classList.toggle('lost', mood === 'lost');
    if (player) setAvatar($('my-avatar'), me.char, colorFor(uid));
    $('my-avatar').hidden = !player;
    $('my-chips-box').hidden = !player;
    $('my-chips').textContent = fmt(chips);
    $('betbar').hidden = !betting || broke;
    for (const b of $('chip-values').children) {
      const v = Number(b.dataset.v);
      b.setAttribute('aria-pressed', String(v === chipValue));
      b.disabled = v > chips;
    }
    $('clear-bets').disabled = stake === 0;
    $('rebuy').hidden = !broke;
    $('rejoin').hidden = player;
  }

  // ---------- 初期化 ----------
  async function main() {
    try {
      backend = await connect();
    } catch (e) {
      console.warn('接続できません', e);
      if (ROOM_PARAM) { $('connect-error').textContent = SY.explainError(e); show('screen-connect-failed'); }
      else { $('setup-error').textContent = SY.explainError(e); show('screen-setup-needed'); }
      return;
    }
    if (ROOM_PARAM && !ROOM_OK) { show('screen-notfound'); return; }
    if (ROOM_PARAM && IS_STAGE) { enterStage(ROOM_PARAM); return; }
    if (ROOM_PARAM) {
      try { await enterListenerEntry(ROOM_PARAM); } catch (e) { console.warn(e); $('connect-error').textContent = SY.explainError(e); show('screen-connect-failed'); }
      return;
    }
    const prev = store.get(KEY_HOST);
    if (prev && prev.code && prev.uid === backend.uid) { // 再読み込み: 前回の部屋へ直接戻る
      const r = await backend.get(SY.roomPath(prev.code));
      if (r && r.hostUid === backend.uid && (!r.state || r.state.phase !== 'closed')) { await enterHost(prev.code); return; }
      store.del(KEY_HOST);
    }
    enterHostEntry();
  }

  const fail = (what) => (e) => { console.warn(e); alert(`${what}: ${SY.explainError(e)}`); };

  // 入口
  $('create-room').addEventListener('click', () => { $('create-room').disabled = true; createRoom().catch(fail('部屋を作れませんでした')).finally(() => { $('create-room').disabled = false; }); });
  $('resume-room').addEventListener('click', () => { const prev = store.get(KEY_HOST); if (prev && prev.code) enterHost(prev.code); });
  $('enter-code').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const c = $('enter-code-input').value.trim().toUpperCase();
    if (!SY.CODE_RE.test(c)) { toast('部屋コードは4文字です'); return; }
    location.href = joinUrl(c);
  });

  // 配信者の操作
  $('spin').addEventListener('click', () => { $('spin').disabled = true; hostDo(hostSpin).then(render); });
  $('next').addEventListener('click', () => hostDo(hostNext));
  $('reset-chips').addEventListener('click', () => {
    if (playing || !confirm('全員のチップを 1,000 に戻します。置いてある賭けと「おかわり」の回数も消えます。よろしいですか?')) return;
    hostDo(() => writeState(L.resetChips(room.state)));
  });
  $('ranking').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const uid = btn.closest('.member-row').dataset.uid;
    if (btn.dataset.act === 'ban' && !confirm('この人をブロックしますか?(この部屋に入れなくなります)')) return;
    hostDo(() => moderate(btn.dataset.act, uid));
  });
  $('copy-url').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(joinUrl(code)); toast('リスナー用のURLをコピーしました'); } catch { toast('コピーできませんでした。URLを長押ししてコピーしてください'); }
  });
  $('close-room').addEventListener('click', async () => {
    if (!confirm('部屋を閉じますか? リスナーには「終了しました」と表示されます')) return;
    await hostDo(() => writeState(L.close(room.state)));
    store.del(KEY_HOST);
    location.search = MOCK ? '?mock=1' : '';
  });

  // リスナーの操作
  $('icons').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-char]');
    if (b) { join.char = b.dataset.char; renderJoin(); }
  });
  $('join-name').addEventListener('input', () => { join.name = $('join-name').value; });
  $('join-enter').addEventListener('click', () => { $('join-enter').disabled = true; joinRoom().catch(fail('参加できませんでした')).finally(() => { $('join-enter').disabled = false; }); });
  $('join-watch').addEventListener('click', () => enterListener());
  $('rejoin').addEventListener('click', () => { renderJoin(); show('screen-join'); });
  $('my-table').addEventListener('click', (ev) => {
    const cell = ev.target.closest('[data-spot]');
    if (cell && !cell.disabled) tapSpot(Number(cell.dataset.spot));
  });
  $('chip-values').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-v]');
    if (!b || b.disabled) return;
    chipValue = Number(b.dataset.v);
    store.set(KEY_CHIP, chipValue);
    render();
  });
  $('clear-bets').addEventListener('click', clearBets);
  $('rebuy').addEventListener('click', rebuy);

  // 音: ミュートの切り替えと、最初のタップ・キー操作・タブに戻ったときの解錠
  for (const id of ['mute', 'mute-l']) $(id).addEventListener('click', () => { sounds.setMuted(!sounds.muted); store.set(KEY_MUTED, sounds.muted); renderMute(); });
  document.addEventListener('pointerdown', () => sounds.unlock());
  document.addEventListener('touchend', () => sounds.unlock());
  document.addEventListener('keydown', () => sounds.unlock());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sounds.unlock(); });
  renderMute();

  main();
})();
