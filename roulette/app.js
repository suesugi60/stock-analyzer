// ===== 表示層: 役割の判定、配信者・リスナー・表示専用の画面 =====
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
  const KEY_HOST = 'roulette.host';
  const KEY_MUTED = 'roulette.muted';
  const MAX_PRESENCE = 80; // 無料枠(同時100接続)の安全装置
  const WAIT_HOST_MS = Number(params.get('waitms')) || 6000; // 「回す」に配信者の画面が応えないとき案内を出すまで
  const SAVE_MS = 350;     // 項目を打ち終えてから保存するまで
  const MAX_ROWS = 100;    // 参加者の一覧に出す人数

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
  /** 同じ中身なら DOM を触らない(ボタンを押している最中に作り直さない)。 */
  function setHtml(el, html) { if (el && el.__last !== html) { el.__last = html; el.innerHTML = html; } }
  /** 結果を決める乱数。端末の暗号用の乱数を使う(無ければ Math.random)。 */
  const fairRandom = () => {
    try { return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296; } catch { return Math.random(); }
  };

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
  let shown = null;     // 画面に出している部屋。盤が止まるまで古いまま(結果の先バレ防止)
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
    render();
  }

  /** 非表示にされた人の名前は、盤・結果・記録のどこでも ？？？ にする。 */
  const isHidden = (players, uid) => !!(uid && players && players[uid] && players[uid].hidden);
  const displaySegs = (segs, players) => segs.map((s) => (isHidden(players, s.u) ? { ...s, t: '？？？' } : s));

  /** 新しい回転を再生する。止まるまで画面の一覧は古いまま、止まったら最新に切り替えて結果を出す。 */
  async function play(sp) {
    const token = ++playToken;
    playing = true;
    hideConfetti();
    await wheel.spin({ ...sp, segs: displaySegs(sp.segs, room.players) }, { quick: QUICK });
    if (token !== playToken) return; // もっと新しい回転に替わった
    playing = false;
    shown = room;
    render();
    if (room && L.showingResult(room.state) && room.state.spin.id === sp.id) celebrate(sp);
  }

  const CONFETTI = ['#ff2e88', '#ff8ab5', '#ffffff', '#ffd166', '#c9a7ff', '#ff6f91'];
  function hideConfetti() { const box = $('confetti'); if (!box.hidden) { box.hidden = true; box.innerHTML = ''; } }
  function celebrate(sp) {
    sounds.fanfare();
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
    const hit = sp.segs[sp.index];
    if (role === 'listener' && hit && hit.u === backend.uid) { try { navigator.vibrate?.([200, 100, 200]); } catch { /* 非対応 */ } }
  }

  // ---------- 画面の共通部分(盤・結果・参加者・記録) ----------
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

  const nameOf = (players, uid, fallback = 'リスナー') => {
    const p = players && players[uid];
    return p ? (p.hidden ? '？？？' : (safeName(p.name) || fallback)) : fallback;
  };

  function statusHtml(rm) {
    const live = room.state;
    const players = rm.players || {};
    if (playing && live.spin) {
      const who = live.spin.by ? `${esc(nameOf(room.players, live.spin.by, live.spin.byName || 'リスナー'))} さんが回しています…` : '回っています…';
      return `<span class="spinning-note">${who}</span>`;
    }
    const st = rm.state;
    if (live.turn) return `💗 <b>${esc(nameOf(players, live.turn))}</b> さんの番(スマホで回せます)`;
    if (st.kind === 'names') {
      const all = L.entrants(rm);
      const target = L.nameSegs(rm).length;
      const out = all.length - target;
      return `🙋 リスナー抽選 ・ 対象 <b>${target}</b>人${out > 0 ? ` <small>(当選済みの ${out}人は対象外)</small>` : ''}`;
    }
    return `🎀 お題ルーレット ・ <b>${st.items.length}</b>項目`;
  }

  function resultHtml(st, players) {
    const sp = st.spin;
    const hit = sp.segs[sp.index];
    const sizeCls = (text) => { const n = Array.from(text).length; return n > 14 ? ' xlong' : n > 8 ? ' long' : ''; };
    if (sp.kind === 'names') {
      const p = hit.u ? players[hit.u] : null;
      const name = isHidden(players, hit.u) ? '？？？' : hit.t;
      return `<div class="rcap">🎉 当たり!</div><div class="rwho"><span class="avatar lg" style="--c:${colorFor(hit.u)}">${iconOf(p && p.char)}</span>` +
        `<div class="rbig${sizeCls(name)}" data-uid="${esc(hit.u || '')}">${esc(name)}<small> さん</small></div></div>`;
    }
    const by = sp.by ? nameOf(players, sp.by, sp.byName || 'リスナー') : '';
    return `<div class="rcap">結果は…</div><div class="rbig${sizeCls(hit.t)}">${esc(hit.t)}</div>` +
      (by ? `<div class="rsub">${esc(by)} さんが回しました</div>` : '');
  }

  function membersHtml(rm, isHost) {
    const list = L.entrants(rm);
    if (!list.length) return '<div class="empty-note">まだ誰もいません。QR か URL から入ってもらおう</div>';
    const turn = room.state.turn;
    const rows = list.slice(0, MAX_ROWS).map((e) => {
      const tags = (turn === e.uid ? '<span class="tag turn">回す番</span>' : '') + (e.won ? '<span class="tag won">当選済み</span>' : '') + (e.online ? '' : '<span class="tag off">オフライン</span>');
      const acts = isHost
        ? `<span class="qacts"><button type="button" class="btn" data-act="turn">回してもらう</button><button type="button" class="btn" data-act="hide">${e.hidden ? '表示' : '非表示'}</button>` +
          '<button type="button" class="btn" data-act="kick">外す</button><button type="button" class="btn ban" data-act="ban">ブロック</button></span>'
        : '';
      return `<div class="member-row${e.uid === backend.uid ? ' me' : ''}${turn === e.uid ? ' turn' : ''}" data-uid="${esc(e.uid)}">` +
        `<span class="avatar sm" style="--c:${colorFor(e.uid)}">${iconOf(e.char)}</span><span class="qname">${e.hidden ? '？？？' : esc(e.name)}${tags}</span>${acts}</div>`;
    }).join('');
    return rows + (list.length > MAX_ROWS ? `<div class="empty-note">ほか ${list.length - MAX_ROWS}人</div>` : '');
  }

  function historyHtml(st, players) {
    if (!st.history.length) return '<div class="empty-note">まだありません</div>';
    return st.history.map((h) => {
      const text = h.k === 'names' ? `🙋 ${esc(isHidden(players, h.u) ? '？？？' : h.t)} さん` : esc(h.t);
      return `<div class="hist-row"><span class="rno">${h.id}</span><span class="dot" style="background:${L.COLORS[h.c]}"></span><span class="qname">${text}</span>` +
        (h.by ? `<small>${esc(h.by)} さんが回した</small>` : '') + '</div>';
    }).join('');
  }

  function renderBoard(view, isHost) {
    if (!view.root || !shown) return;
    const rm = shown;
    const st = rm.state;
    const players = rm.players || {};
    const r = view.refs;
    if (r.code) r.code.textContent = code;
    if (r.url) r.url.textContent = joinUrl(code);
    if (r.qr) drawQr(view, joinUrl(code));
    const result = !playing && L.showingResult(st);
    if (!playing) {
      if (result) wheel.setWheel(displaySegs(st.spin.segs, players), { rotation: st.spin.to, win: st.spin.index });
      else wheel.setWheel(L.liveSegs(rm), { rotation: L.restAngle(st), empty: st.kind === 'names' ? '参加者を待っています' : '項目を入れてね' });
    }
    if (r.result) { setHtml(r.result, result ? resultHtml(st, players) : ''); r.result.hidden = !result; }
    if (!result || playing) hideConfetti();
    setHtml(r.status, statusHtml(rm));
    if (r.count) r.count.textContent = `${L.entrants(rm).length}人`;
    setHtml(r.members, membersHtml(rm, isHost));
    setHtml(r.history, historyHtml(st, players));
  }

  function render() {
    if (room === undefined) return;
    if (!room) {
      if (role === 'stage' || role === 'listener') show('screen-notfound');
      return;
    }
    if (!shown) shown = room;
    // リスナーの「回す」要求は、配信者の画面の演出が終わってから処理する
    if (role === 'host' && !playing) hostQueue = hostQueue.then(processActions).catch((e) => console.warn('要求の処理に失敗', e));
    if (role === 'host') { renderBoard(hostView, true); renderHost(); }
    if (role === 'stage') renderBoard(stageView, false);
    if (role === 'listener') { renderBoard(listenerView, false); renderListener(); }
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
    await backend.set(SY.roomPath(c), { hostUid: backend.uid, createdAt: backend.serverTimestamp(), settings: { app: 'roulette' }, state: L.createState() });
    store.set(KEY_HOST, { code: c, uid: backend.uid });
    await enterHost(c);
  }

  /** 配信者の画面は1タブだけ(2つ開くと同じ「回す」を二重に処理する)。Web Locks でロックを持ち続ける。 */
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
    buildPresets();
    subscribe(c);
    show('screen-host');
    renderMute();
  }

  function enterStage(c) {
    role = 'stage';
    sounds.setMuted(true); // 表示専用は音なし(配信ソフトで二重に鳴らさない)
    const clone = $('screen-host').cloneNode(true);
    clone.id = 'screen-stage';
    for (const el of clone.querySelectorAll('button, input, label, [data-host-only]')) el.remove();
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
  const writeState = (st) => backend.set(path('state'), JSON.parse(JSON.stringify(st)));

  async function hostSpin(byUid) {
    if (playing || !room || room.state.phase !== 'open') return;
    const segs = L.liveSegs(room);
    const next = L.startSpin(room.state, segs, { by: byUid || null, byName: byUid ? nameOf(room.players, byUid) : '', rng: fairRandom });
    if (next) await writeState(next);
  }
  /** リスナーの「回す」要求を処理する。指名されている人の要求だけ受け付け、それ以外は捨てる。 */
  async function processActions() {
    if (!room || !room.actions) return;
    for (const [uid, a] of Object.entries(room.actions)) {
      await backend.remove(path(`actions/${uid}`));
      if (a && a.type === 'roll' && room.state.turn === uid && !playing) await hostSpin(uid);
    }
  }
  async function moderate(act, uid) {
    const p = (room.players || {})[uid] || {};
    if (act === 'turn') { await writeState(L.setTurn(room.state, uid)); return; }
    if (act === 'hide') { await backend.update(path(`players/${uid}`), { hidden: !p.hidden }); return; }
    if (act === 'ban') await backend.update(path(`players/${uid}`), { banned: true });
    if (act === 'kick' || act === 'ban') {
      await backend.remove(path(`queue/${uid}`));
      if (room.state.turn === uid) await writeState(L.setTurn(room.state, null));
    }
  }

  // ---------- 配信者: 中身の編集 ----------
  // 打った内容は ed.items に持ち、少し待ってからまとめて保存する。保存が届くまでは同期で上書きしない。
  const ed = { items: null, dirty: false, rev: 0, timer: 0 };
  const sameItems = (a, b) => JSON.stringify(L.sanitizeItems(a)) === JSON.stringify(L.sanitizeItems(b));
  function paintDots() {
    const valid = ed.items.map((it) => !!L.cutLabel(it.t, L.MAX_LABEL));
    const n = valid.filter(Boolean).length;
    let k = 0;
    $('items').querySelectorAll('.item-row').forEach((row, i) => { row.querySelector('.dot').style.background = valid[i] ? L.COLORS[L.colorIndex(k++, n)] : '#f1dbe6'; });
  }
  function renderEditorRows() {
    $('items').innerHTML = ed.items.map((it, i) => `<div class="item-row" data-i="${i}"><span class="dot"></span>` +
      `<input class="item-text" type="text" maxlength="${L.MAX_LABEL}" value="${esc(it.t)}" placeholder="項目 ${i + 1}" aria-label="項目 ${i + 1}">` +
      '<button type="button" class="btn wbtn" data-act="minus" aria-label="当たりにくくする">−</button>' +
      `<span class="wnum" title="当たりやすさ">${it.w}</span>` +
      '<button type="button" class="btn wbtn" data-act="plus" aria-label="当たりやすくする">＋</button>' +
      '<button type="button" class="btn wbtn del" data-act="del" aria-label="この項目を消す">✕</button></div>').join('');
    $('add-item').disabled = ed.items.length >= L.MAX_ITEMS;
    paintDots();
  }
  function syncEditor() {
    if (playing) return; // 回っている間は、消える項目を先に見せない
    if (ed.items === null || (!ed.dirty && !sameItems(ed.items, room.state.items))) {
      ed.items = room.state.items.map((x) => ({ ...x }));
      renderEditorRows();
    }
  }
  function touchItems() { ed.dirty = true; ed.rev++; clearTimeout(ed.timer); ed.timer = setTimeout(saveItems, SAVE_MS); }
  function saveItems() {
    clearTimeout(ed.timer);
    if (!ed.dirty) return hostQueue;
    const rev = ed.rev;
    return hostDo(async () => {
      if (!sameItems(ed.items, room.state.items)) await writeState(L.setItems(room.state, ed.items));
      if (ed.rev === rev) ed.dirty = false;
    });
  }
  function buildPresets() {
    const box = $('presets');
    if (box.querySelector('button')) return;
    for (const [key, p] of Object.entries(L.PRESETS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-ghost';
      b.dataset.preset = key;
      b.textContent = p.label;
      box.appendChild(b);
    }
  }
  const looksLikeDrink = (items) => items.some((it) => /飲|乾杯|[0-9０-９一二三半]\s*(口|杯)/.test(it.t));

  function renderHost() {
    const st = room.state; // ボタンの出し分けは最新の状態で決める
    const result = !playing && L.showingResult(st);
    for (const b of $('kind-switch').querySelectorAll('[data-kind]')) { b.setAttribute('aria-pressed', String(b.dataset.kind === st.kind)); b.disabled = playing; }
    const segs = L.liveSegs(room);
    const canSpin = !playing && segs.length >= 2;
    const spinBtn = $('spin');
    spinBtn.disabled = !canSpin;
    spinBtn.textContent = playing ? '回っています…' : st.turn ? '代わりに回す' : '💗 回す';
    let hint = '';
    if (!playing && segs.length < 2) hint = st.kind === 'names' ? '抽選の対象が2人以上になると回せます' : '項目を2つ以上入れると回せます';
    else if (!playing && st.turn) hint = `${nameOf(room.players, st.turn)} さんのスマホに「回す」ボタンが出ています`;
    $('spin-hint').textContent = hint;
    $('dismiss').hidden = !result;
    const hit = result ? L.winnerOf(st) : null;
    $('winner-spin').hidden = !(result && st.spin.kind === 'names' && hit && hit.u && L.entrants(room).some((e) => e.uid === hit.u));
    $('cancel-turn').hidden = playing || !st.turn;
    $('opt-remove-hit').checked = st.removeHit;
    $('opt-remove-winner').checked = st.removeWinner;
    $('reset-won').hidden = Object.keys(st.won).length === 0;
    $('editor-box').classList.toggle('busy', playing);
    syncEditor();
    $('drink-note').hidden = !looksLikeDrink(st.items);
  }

  // ---------- リスナー ----------
  let join = { name: '', char: ICONS[Math.floor(Math.random() * ICONS.length)].id };
  let joined = false;       // 参加したことがある(online を管理する)
  let lastTurn = false;
  let spinRequested = false;
  let reqSeq = 0;
  let hostAbsent = false;   // 「回す」に配信者の画面が応えない
  const keyListener = () => `roulette.listener.${code}`;

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
    if (me) { // 再読み込み: 参加済みなら自分の画面へ直接戻る
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
    await backend.set(path(`queue/${backend.uid}`), { joinedAt: backend.serverTimestamp() });
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
      subscribe(code);
    }
    show('screen-listener');
    renderMute();
    render();
  }

  function renderListener() {
    const live = room.state;
    const me = (room.players || {})[backend.uid] || null;
    if (me && me.banned) { show('screen-banned'); return; }
    if (live.phase === 'closed') { show('screen-closed'); return; }
    const inQueue = !!me && !!(room.queue || {})[backend.uid];
    const myTurn = live.turn === backend.uid && !playing;
    sounds.setKeepAlive(myTurn); // 自分が回す番のときだけ無音を流す(見ているだけの人の音楽を止めない)
    updateAudioBadge();
    if (myTurn && !lastTurn) { try { navigator.vibrate?.(200); } catch { /* 非対応 */ } sounds.chime(); }
    lastTurn = myTurn;
    if (live.turn !== backend.uid || live.seq !== reqSeq) spinRequested = false;
    if (live.turn !== backend.uid) hostAbsent = false;

    const st = shown.state; // 「当たり」は盤が止まってから出す
    const hit = !playing && L.showingResult(st) ? L.winnerOf(st) : null;
    let big = '見ているだけ';
    let sub = '「参加する」を押すと、抽選に当たったり、回す役に選ばれたりします';
    if (myTurn) { big = 'あなたの番! ルーレットを回して!'; sub = hostAbsent ? '配信者の画面を待っています…' : '下の「回す!」を押してね'; }
    else if (hit && hit.u === backend.uid) { big = '🎉 当たり! あなたが選ばれました!'; sub = ''; }
    else if (inQueue) {
      const out = st.kind === 'names' && st.removeWinner && st.won[backend.uid];
      big = out ? '当選済み' : st.kind === 'names' ? '抽選に参加中! 当たるかも' : '参加中';
      sub = out ? '次の抽選からは対象外です(配信者が元に戻すこともあります)' : `${me.name} さん ・ 回す役に選ばれることもあります`;
    } else if (me) { big = '参加していません'; sub = 'もう一度入るなら「参加する」'; }
    $('my-status').textContent = big;
    $('my-sub').textContent = sub;
    document.querySelector('.mystatus').classList.toggle('turn', myTurn);
    document.querySelector('.mystatus').classList.toggle('won', !!(hit && hit.u === backend.uid));
    if (me) setAvatar($('my-avatar'), me.char, colorFor(backend.uid));
    $('my-avatar').hidden = !me;
    $('listener-spin').hidden = !myTurn;
    $('listener-spin').disabled = spinRequested;
    $('listener-spin').textContent = spinRequested ? '回しています…' : '💗 回す!';
    $('rejoin').hidden = inQueue;
    $('leave').hidden = !inQueue;
  }

  async function listenerSpin() {
    if (spinRequested || !room || playing || room.state.turn !== backend.uid) return;
    spinRequested = true;
    hostAbsent = false;
    reqSeq = room.state.seq;
    renderListener();
    await backend.set(path(`actions/${backend.uid}`), { type: 'roll', at: backend.serverTimestamp() });
    const seq = reqSeq;
    setTimeout(() => {
      if (!spinRequested || !room || room.state.seq !== seq) return; // もう処理された
      spinRequested = false;
      hostAbsent = true;
      renderListener();
    }, WAIT_HOST_MS);
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
  $('spin').addEventListener('click', () => { $('spin').disabled = true; saveItems(); hostDo(() => hostSpin(null)).then(render); }); // 回せなかったときもボタンを元に戻す
  $('dismiss').addEventListener('click', () => hostDo(() => writeState(L.dismiss(room.state))));
  $('cancel-turn').addEventListener('click', () => hostDo(() => writeState(L.setTurn(room.state, null))));
  $('winner-spin').addEventListener('click', () => hostDo(() => {
    const hit = L.winnerOf(room.state);
    if (hit && hit.u) return writeState(L.setTurn(L.setKind(room.state, 'items'), hit.u));
  }));
  $('kind-switch').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-kind]');
    if (!b || playing) return;
    saveItems();
    hostDo(() => writeState(L.setKind(room.state, b.dataset.kind)));
  });
  $('opt-remove-hit').addEventListener('change', (ev) => hostDo(() => writeState(L.setOption(room.state, 'removeHit', ev.target.checked))));
  $('opt-remove-winner').addEventListener('change', (ev) => hostDo(() => writeState(L.setOption(room.state, 'removeWinner', ev.target.checked))));
  $('reset-won').addEventListener('click', () => hostDo(() => writeState(L.resetWon(room.state))));
  $('members').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const uid = btn.closest('.member-row').dataset.uid;
    if (btn.dataset.act === 'ban' && !confirm('この人をブロックしますか?(この部屋に入れなくなります)')) return;
    hostDo(() => moderate(btn.dataset.act, uid));
  });
  $('items').addEventListener('input', (ev) => {
    const row = ev.target.closest('.item-row');
    if (!row || !ev.target.classList.contains('item-text')) return;
    ed.items[Number(row.dataset.i)].t = ev.target.value;
    paintDots();
    touchItems();
  });
  $('items').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const row = btn.closest('.item-row');
    const i = Number(row.dataset.i);
    const act = btn.dataset.act;
    if (act === 'del') { ed.items.splice(i, 1); renderEditorRows(); }
    else {
      ed.items[i].w = Math.min(L.MAX_WEIGHT, Math.max(1, ed.items[i].w + (act === 'plus' ? 1 : -1)));
      row.querySelector('.wnum').textContent = String(ed.items[i].w);
    }
    touchItems();
    saveItems();
  });
  $('add-item').addEventListener('click', () => {
    if (ed.items.length >= L.MAX_ITEMS) return;
    ed.items.push({ t: '', w: 1 });
    renderEditorRows();
    const inputs = $('items').querySelectorAll('.item-text');
    inputs[inputs.length - 1].focus();
  });
  $('presets').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-preset]');
    if (!b || playing) return;
    const p = L.PRESETS[b.dataset.preset];
    if (!p || !confirm(`いまの中身を「${p.label}」の見本と入れ替えます。よろしいですか?`)) return;
    ed.items = L.sanitizeItems(p.items);
    renderEditorRows();
    touchItems();
    saveItems();
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
  $('rejoin').addEventListener('click', () => {
    if (!(room && (room.players || {})[backend.uid])) { renderJoin(); show('screen-join'); return; } // 見るだけの人は名前を決めてから
    backend.set(path(`queue/${backend.uid}`), { joinedAt: backend.serverTimestamp() }).catch(fail('参加できませんでした'));
  });
  $('leave').addEventListener('click', () => backend.remove(path(`queue/${backend.uid}`)).catch(fail('操作できませんでした')));
  $('listener-spin').addEventListener('click', () => listenerSpin().catch(fail('回せませんでした')));

  // 音: ミュートの切り替えと、最初のタップ・キー操作・タブに戻ったときの解錠
  for (const id of ['mute', 'mute-l']) $(id).addEventListener('click', () => { sounds.setMuted(!sounds.muted); store.set(KEY_MUTED, sounds.muted); renderMute(); });
  document.addEventListener('pointerdown', () => sounds.unlock());
  document.addEventListener('touchend', () => sounds.unlock());
  document.addEventListener('keydown', () => sounds.unlock());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sounds.unlock(); });
  renderMute();

  main();
})();
