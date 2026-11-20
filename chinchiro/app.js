// ===== 表示層: 役割の判定、親機・リスナー・表示専用の画面 =====
(() => {
  'use strict';
  const L = ChinchiroLogic;
  const W = ChinchiroWidgets;
  const SY = ChinchiroSync;
  const params = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const MOCK = params.get('mock') === '1';
  const ROOM_PARAM = (params.get('room') || '').toUpperCase();
  const ROOM_OK = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/.test(ROOM_PARAM);
  const IS_STAGE = params.get('stage') === '1';
  const QUICK = params.get('quick') === '1'; // 演出を一瞬で終える(テスト用)
  const SHARED_UID = params.get('shareduid') === '1'; // mock で uid をタブ間で共有(テスト用)
  const KEY_HOST = 'chinchiro.host';
  const KEY_SETUP = 'chinchiro.setup';
  const KEY_MUTED = 'chinchiro.muted';
  const MAX_PRESENCE = 80; // 無料枠(同時100接続)の安全装置
  const PROXY_ROLL_MS = Number(params.get('proxy')) || 20000; // 子が反応しないとき「代わりに振る」を出すまで
  const WAIT_HOST_MS = Number(params.get('waitms')) || 6000; // 「振る」に親機が応えないとき案内を出すまで
  const WATCH_MS = Number(params.get('watchms')) || 15000;    // 親機が演出を見終わった印(state.watched)が来ないとき、諦めて振れるようにするまで

  const CHARACTERS = [
    { id: 'momotaro', name: 'ももたろう' }, { id: 'kintaro', name: 'きんたろう' }, { id: 'urashima', name: 'うらしまたろう' },
    { id: 'kaguya', name: 'かぐやひめ' }, { id: 'issun', name: 'いっすんぼうし' }, { id: 'akaoni', name: 'あかおに' },
    { id: 'aooni', name: 'あおおに' }, { id: 'inu', name: 'いぬ' }, { id: 'saru', name: 'さる' },
    { id: 'kiji', name: 'きじ' }, { id: 'kappa', name: 'かっぱ' }, { id: 'binbo', name: 'びんぼうがみ' },
  ];
  const CHAR_NAME = Object.fromEntries(CHARACTERS.map((c) => [c.id, c.name]));
  const validChar = (id) => typeof id === 'string' && Object.hasOwn(CHAR_NAME, id) && Object.hasOwn(SugorokuArt.CHAR_ART, id);
  const charArt = (id) => (validChar(id) ? SugorokuArt.CHAR_ART[id]() : SugorokuArt.CHAR_ART.binbo());
  const charName = (id) => (validChar(id) ? CHAR_NAME[id] : '');
  const COLORS = ['#ff4d4d', '#3b8cff', '#2ec27e', '#ffd93d', '#b56cff', '#ff9f1c', '#4dd4e8', '#ff7bd2'];
  const MODE_LABEL = { points: { label: '点数', hint: '持ち点から増減' }, drink: { label: '飲み', hint: '負けたら飲む' }, both: { label: '両方', hint: '点数も飲みも' } };
  const startPts = (settings) => L.startPoints(settings); // 部屋の持ち点(古い部屋は 100)

  const store = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できなくても動く */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* 同上 */ } },
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const safeName = (s) => String(s ?? '').trim().slice(0, 12);

  // 役名のコール: voice/<キー>.mp3(または .m4a)があればその声、無ければ端末の読み上げ。
  // ファイルは起動時に一度だけ調べ、あったものだけ登録する(同じオブジェクトを渡すので後から増やせる)。
  const voiceFiles = {};
  const voiceReady = (async () => {
    if (typeof fetch !== 'function' || location.protocol === 'file:') return;
    await Promise.all(Object.keys(ChinchiroAnim.VOICE_LINES).map(async (key) => {
      const found = await Promise.all(['mp3', 'm4a'].map(async (ext) => {
        const u = `voice/${key}.${ext}`;
        try { return (await fetch(u, { method: 'HEAD' })).ok ? u : null; } catch { return null; }
      }));
      const url = found.find(Boolean);
      if (url) voiceFiles[key] = url;
    }));
  })();
  const sounds = ChinchiroAnim.createSounds({ voiceFiles, voiceReady });
  // 消音は覚えない: 開き直したら必ず音が出る(前に消音にしたのを忘れて「最初から鳴らない」にならないように)。前の版が保存した値は消す
  store.del(KEY_MUTED);
  const stage = ChinchiroAnim.createDiceStage($('stage'), sounds);

  function show(id) {
    for (const s of document.querySelectorAll('#app > .screen')) s.hidden = s.id !== id;
    window.scrollTo(0, 0);
  }
  function setAvatar(el, charId, color) {
    const art = charArt(charId);
    el.dataset.char = validChar(charId) ? charId : '';
    el.style.setProperty('--c', color || '#2b2d5c');
    el.innerHTML = art;
  }
  function colorFor(uid) { let h = 0; for (const ch of String(uid)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; }

  // ---------- デモ(演出の確認用): ?demo=1&dice=4,5,6&seed=7[&shonben=1][&remaining=2][&skip=1] ----------
  if (params.get('demo') === '1') {
    show('__none__');
    $('stage-overlay').hidden = false;
    const dice = (params.get('dice') || '1,2,3').split(',').map((x) => (x === '' ? NaN : Number(x)));
    const seed = Number(params.get('seed') || 1);
    const shonben = params.get('shonben') === '1';
    const remaining = Number(params.get('remaining') ?? 2);
    let hand = null;
    try { hand = shonben ? { ...L.SHONBEN } : L.evaluate(dice); } catch { hand = null; }
    if (!hand && !shonben && remaining === 0) hand = { ...L.NONE };
    if (params.get('intro') === '1') { // 対決スタートの演出だけ見る
      stage.playIntro({ name: '配信者', char: 'momotaro', color: '#ff4d4d' }, { name: 'リスナー', char: 'kappa', color: '#3b8cff' }, { reduced: QUICK });
      window.ChinchiroDemo = { stage };
      return;
    }
    const reach = params.get('reach'); // デモだけ: リーチの強さを固定(0〜3)
    stage.play({ dice, seed, shonben, hand }, { thrower: { name: 'デモ', char: 'momotaro', color: '#ff4d4d' }, remaining, reduced: QUICK, forceReach: reach === null ? undefined : Number(reach) });
    if (params.get('skip') === '1') stage.skip();
    window.ChinchiroDemo = { stage }; // デモ画面のコンソールから投げ直せる
    return;
  }

  // ---------- 接続 ----------
  let backend = null;
  let code = null;       // いまの部屋コード
  let room = null;       // 同期された部屋データ(rooms/{code})。親機の進行はこれを使う
  let shown = null;      // 画面に出している部屋データ。サイコロが止まるまで古いまま(先バレ防止)
  let role = null;       // 'host' | 'stage' | 'listener'
  let unsubRoom = null;

  async function connect() {
    if (MOCK) return SY.createBackend({ kind: 'mock', storage: localStorage, uidStorage: SHARED_UID ? localStorage : sessionStorage });
    return SY.createBackend({ kind: 'firebase', config: window.FIREBASE_CONFIG });
  }

  function subscribe(c) {
    if (unsubRoom) unsubRoom();
    code = c;
    unsubRoom = backend.watch(`rooms/${c}`, (r) => {
      room = r ? { ...r, state: L.normalizeState(r.state) } : r;
      const intro = room ? maybePlayIntro() : false;     // 対決スタートの登場シーン
      const started = room ? maybePlayThrow() : false; // 新しい投げは演出が終わるまで画面を更新しない
      const result = room ? maybePlayResult() : false; // 決着・引き分けの結果シーン
      if (!intro && !started && !result && !playing) shown = room;
      render();
    });
  }

  // ---------- キャラ選択画面(共通) ----------
  let pickCb = null;
  function openPick(current, title, cb) {
    pickCb = cb;
    setAvatar($('pick-avatar'), current, '#ff4d4d');
    $('pick-title').textContent = title;
    $('pick-hint').textContent = `いまは「${charName(current)}」。好きなキャラをタップしてね`;
    const grid = $('picks');
    grid.innerHTML = '';
    for (const c of CHARACTERS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pick' + (current === c.id ? ' selected' : '');
      b.dataset.char = c.id;
      b.innerHTML = `${SugorokuArt.CHAR_ART[c.id]()}<span>${c.name}</span>`;
      b.addEventListener('click', () => { const f = pickCb; pickCb = null; f(c.id); });
      grid.appendChild(b);
    }
    show('screen-pick');
  }

  // ---------- 親機: 入口 ----------
  let setup = { name: '', char: 'momotaro', mode: 'points', unit: 10, drinkUnit: 'sip', startPoints: 100, customStart: '' };
  /** 設定画面の持ち点(自由入力は 1〜99999 の整数だけ採用、それ以外は 100)。 */
  function chosenStart() {
    if (setup.startPoints !== 'custom') return L.startPoints({ startPoints: setup.startPoints });
    const raw = String($('start-custom').value ?? '').trim();
    return L.startPoints({ startPoints: /^\d+$/.test(raw) ? Number(raw) : NaN });
  }

  function renderChoices(el, items, current, onPick) {
    el.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'choice';
      b.dataset[it.attr] = it.value;
      b.setAttribute('aria-pressed', String(String(it.value) === String(current)));
      b.innerHTML = `<span class="big">${esc(it.label)}</span><span class="hint">${esc(it.hint || '')}</span>`;
      b.addEventListener('click', () => { onPick(it.value); renderEntry(); });
      el.appendChild(b);
    }
  }

  function renderEntry() {
    setAvatar($('host-avatar'), setup.char, '#ff4d4d');
    if ($('host-name').value !== setup.name) $('host-name').value = setup.name;
    renderChoices($('mode-choices'), Object.entries(MODE_LABEL).map(([k, v]) => ({ attr: 'mode', value: k, label: v.label, hint: k === 'points' ? `持ち点${chosenStart()}から` : v.hint })), setup.mode, (v) => { setup.mode = v; });
    renderChoices($('start-choices'), L.START_POINTS.map((p) => ({ attr: 'start', value: p, label: `${p}点`, hint: 'みんなこの点から' })).concat([{ attr: 'start', value: 'custom', label: '自由', hint: '好きな点' }]), setup.startPoints, (v) => { setup.startPoints = v === 'custom' ? 'custom' : Number(v); });
    $('start-custom-row').hidden = setup.startPoints !== 'custom';
    renderChoices($('unit-choices'), L.POINT_UNITS.map((u) => ({ attr: 'unit', value: u, label: `${u}点`, hint: '×倍率' })), setup.unit, (v) => { setup.unit = Number(v); });
    renderChoices($('drink-choices'), Object.entries(L.DRINK_UNITS).map(([k, v]) => ({ attr: 'drink', value: k, label: v.label, hint: '×倍率' })), setup.drinkUnit, (v) => { setup.drinkUnit = v; });
  }

  function enterHostEntry() {
    const saved = store.get(KEY_SETUP);
    if (saved && typeof saved === 'object') {
      if (typeof saved.name === 'string') setup.name = safeName(saved.name);
      if (validChar(saved.char)) setup.char = saved.char;
      if (MODE_LABEL[saved.mode]) setup.mode = saved.mode;
      if (L.POINT_UNITS.includes(saved.unit)) setup.unit = saved.unit;
      if (L.DRINK_UNITS[saved.drinkUnit]) setup.drinkUnit = saved.drinkUnit;
      if (L.START_POINTS.includes(saved.startPoints) || saved.startPoints === 'custom') setup.startPoints = saved.startPoints;
      if (typeof saved.customStart === 'string') { setup.customStart = saved.customStart; $('start-custom').value = saved.customStart; }
    }
    renderEntry();
    $('start-custom').addEventListener('input', () => { setup.customStart = $('start-custom').value; renderEntry(); });
    const prev = store.get(KEY_HOST);
    $('resume-banner').hidden = !(prev && prev.code && prev.uid === backend.uid);
    show('screen-host-entry');
  }

  async function createRoom() {
    setup.name = safeName($('host-name').value) || '配信者';
    const c = await SY.allocateRoomCode(backend);
    const start = chosenStart();
    const settings = { mode: setup.mode, unit: setup.unit, drinkUnit: setup.drinkUnit, hostName: setup.name, hostChar: setup.char, startPoints: start };
    await backend.set(`rooms/${c}`, { hostUid: backend.uid, createdAt: backend.serverTimestamp(), settings, state: L.createState(start) });
    store.set(KEY_SETUP, setup);
    store.set(KEY_HOST, { code: c, uid: backend.uid });
    await enterHost(c);
  }

  // ---------- 親機: 本体 ----------
  const hostView = { root: null, refs: {} };
  const stageView = { root: null, refs: {} };
  function bind(view, root) {
    view.root = root;
    view.refs = {};
    for (const el of root.querySelectorAll('[data-ref]')) view.refs[el.dataset.ref] = el;
  }

  /** 親機は1タブだけ(同じブラウザで2つ開くと出目が食い違う)。Web Locks でロックを持ち続ける。 */
  function acquireHostLock(c) {
    if (!navigator.locks) return Promise.resolve(true);
    return new Promise((resolve) => {
      navigator.locks.request(`chinchiro-host-${c}`, { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(false); return undefined; }
        resolve(true);
        return new Promise(() => {}); // ページが閉じるまで保持
      }).catch(() => resolve(true));
    });
  }

  /** ミュートでないのに効果音を鳴らせない(AudioContext が起きていない)間だけ「タップで音をオン」を出す。 */
  function updateAudioBadge() {
    const el = $('audio-badge'); if (!el) return;
    el.hidden = sounds.muted || sounds.ready || !(role === 'host' || role === 'listener');
  }
  sounds.onReadyChange(updateAudioBadge);

  async function enterHost(c) {
    if (!(await acquireHostLock(c))) {
      $('busy-code').textContent = c;
      show('screen-host-busy');
      return;
    }
    role = 'host';
    sounds.setKeepAlive(true);
    bind(hostView, $('screen-host'));
    subscribe(c);
    show('screen-host');
    renderMute();
  }

  function enterStage(c) {
    role = 'stage';
    sounds.setMuted(true); // 表示専用は音なし(配信ソースで二重に鳴らさない)
    renderMute();
    const clone = $('screen-host').cloneNode(true);
    clone.id = 'screen-stage';
    for (const b of clone.querySelectorAll('button')) b.remove();
    for (const el of clone.querySelectorAll('[id]')) el.removeAttribute('id');
    $('app').appendChild(clone);
    bind(stageView, clone);
    subscribe(c);
    show('screen-stage');
  }

  function joinUrl(c) {
    const u = new URL(location.href);
    u.search = '';
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
    const urlEl = view.refs.url;
    if (!canvas) return;
    if (!window.QRCode || typeof window.QRCode.toCanvas !== 'function') {
      loadQrLib();
      canvas.hidden = true;
      if (urlEl) urlEl.classList.add('big'); // QR が無いときは URL を大きく
      return;
    }
    if (qrDrawnFor === text) return;
    qrDrawnFor = text;
    canvas.hidden = false;
    if (urlEl) urlEl.classList.remove('big');
    window.QRCode.toCanvas(canvas, text, { width: 84, margin: 1 }, (err) => { if (err) { canvas.hidden = true; if (urlEl) urlEl.classList.add('big'); } });
  }

  function unitLabel(settings) { return (L.DRINK_UNITS[settings.drinkUnit] || L.DRINK_UNITS.sip).label; }

  function fighterHtml(cls, char, color, name, sub, handText, handSub, turn, extraCls = '', throwsHtml = '') {
    return `<div class="fighter ${cls} ${turn ? 'turn' : ''} ${extraCls}">
      <span class="avatar" data-char="${validChar(char) ? char : ''}" style="--c:${esc(color)}">${charArt(char)}</span>
      <div class="fname">${esc(name)}</div><div class="fsub">${esc(sub)}</div>
      <div class="fhand">${esc(handText)}${handSub ? `<small>${esc(handSub)}</small>` : ''}</div>${throwsHtml}</div>`;
  }

  function sideText(side) {
    if (!side) return ['', ''];
    if (side.hand) return [side.hand.label + (side.hand.lose || side.hand.type === 'none' ? '' : ` (×${side.hand.mult})`), `${side.throws.length}投目`];
    if (side.throws.length) return [Number.isFinite(L.MAX_THROWS) ? `目なし… あと${L.MAX_THROWS - side.throws.length}投` : '目なし… 振り直し', `${side.throws.length}投目`];
    return ['', ''];
  }

  let confettiSeq = null;
  function showConfetti() {
    const box = $('confetti');
    box.innerHTML = '';
    const colors = ['#ff4d4d', '#3b8cff', '#2ec27e', '#ffd93d', '#b56cff', '#ff9f1c', '#fff'];
    for (let i = 0; i < 50; i++) {
      const piece = document.createElement('i');
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = colors[i % colors.length];
      piece.style.animationDelay = `${Math.random() * 1.2}s`;
      piece.style.animationDuration = `${2.2 + Math.random() * 1.4}s`;
      piece.style.transform = `rotate(${Math.random() * 360}deg)`;
      box.appendChild(piece);
    }
    box.hidden = false;
  }

  // 点数のカウントアップ(前回の値から動かす。QUICK や動きを減らす設定では即表示)
  const lastNums = new WeakMap();
  function animateNums(root) {
    for (const el of root.querySelectorAll('.num[data-v]')) {
      const to = Number(el.dataset.v);
      const key = root.id || root.dataset.ref || 'x';
      const prev = lastNums.get(root) || {};
      const from = prev[key + el.dataset.k] ?? to;
      prev[key + el.dataset.k] = to;
      lastNums.set(root, prev);
      if (QUICK || matchMedia('(prefers-reduced-motion: reduce)').matches || from === to) el.textContent = String(to);
      else ChinchiroAnim.countUp(el, from, to, 700);
    }
  }

  function renderBoard(view, readonly) {
    if (!view.root || !shown) return;
    const room = shown; // 画面用(演出が終わるまで古い状態)
    const r = view.refs;
    const st = room.state || L.createState();
    const settings = room.settings || {};
    const players = room.players || {};
    if (r.code) r.code.textContent = code;
    if (r.url) r.url.textContent = joinUrl(code);
    if (r.qr) drawQr(view, joinUrl(code));
    // 配信者の成績
    if (r.record) {
      const h = st.host || {};
      const parts = [];
      if (settings.mode !== 'drink') parts.push(`<span class="num" data-v="${h.points ?? startPts(settings)}">${h.points ?? startPts(settings)}</span>点`);
      parts.push(`${h.wins ?? 0}勝${h.losses ?? 0}敗`);
      if (settings.mode !== 'points') parts.push(`飲んだ ${esc(unitLabel(settings))} × ${h.drinks ?? 0}`);
      r.record.innerHTML = `${esc(settings.hostName || '配信者')}<small>${parts.join(' ・ ')}</small>`;
      animateNums(r.record);
    }
    // 対戦の場
    if (r.arena) {
      const m = st.match;
      const child = m ? players[m.childUid] : null;
      const childName = child ? (child.hidden ? '？？？' : (child.name || 'リスナー')) : '挑戦者';
      const [ph, phs] = sideText(m && m.parent);
      const [ch, chs] = sideText(m && m.child);
      let center = '<div class="vs">VS</div>';
      let status = '';
      let drink = '';
      if (st.phase === 'lobby') status = Object.keys(room.queue || {}).length ? (readonly ? '次の対決を待っています' : '「対決スタート」で先頭の人と対決') : '挑戦者を待っています';
      else if (st.phase === 'parent') status = (m.round > 1 && m.parent.throws.length === 0 ? `引き分け → もう一度! (${m.round}回戦) ` : '') + `親の番(${m.parent.throws.length + 1}/${L.MAX_THROWS}投)`;
      else if (st.phase === 'child') status = `${childName} さんの番(${m.child.throws.length + 1}/${L.MAX_THROWS}投)`;
      else if (st.phase === 'result' && st.result) {
        const res = st.result;
        const sum = W.resultSummary(res, { host: settings.hostName || '配信者', child: childName }, settings);
        center = `<div class="win-name">${esc(sum.headline)}</div><div class="why">${esc(sum.why)}</div>`;
        status = '';
        drink = sum.pay;
      } else if (st.phase === 'closed') status = '部屋は閉じました';
      const res = st.phase === 'result' ? st.result : null;
      // この相手とのこれまでの戦歴(配信者から見た勝ち負け)
      const rec = child ? W.versusText(child) : '';
      const h2h = !child ? '' : rec ? `<span class="h2h">これまで ${esc(settings.hostName || '配信者')} の <b>${esc(rec)}</b></span>` : '<span class="h2h">はじめての対戦</span>';
      const arenaHtml =
        fighterHtml('host', settings.hostChar, '#ff4d4d', settings.hostName || '配信者', '親', ph, phs, st.phase === 'parent', res && res.winner === 'parent' ? 'winner' : '', W.throwsHtml(m && m.parent.throws)) +
        `<div class="center">${center}<span class="status">${esc(status)}</span>${drink ? `<span class="drink">${esc(drink)}</span>` : ''}${h2h}</div>` +
        (child
          ? fighterHtml('child', child.char, colorFor(m.childUid), childName, `挑戦者 ${m.round > 1 ? `(${m.round}回戦)` : ''}`, ch, chs, st.phase === 'child', res && res.winner === 'child' ? 'winner' : '', W.throwsHtml(m && m.child.throws))
          : fighterHtml('child empty', 'binbo', '#ccc', '挑戦者', '順番待ちから', '', '', false));
      if (r.arena.dataset.last !== arenaHtml) { r.arena.innerHTML = arenaHtml; r.arena.dataset.last = arenaHtml; }
    }
    if (r.legend && !r.legend.innerHTML) r.legend.innerHTML = W.legendHtml();
    if (r.log) {
      const logHtml = W.logHtml(st.log, { meUid: backend.uid, players, settings });
      if (r.log.dataset.last !== logHtml) { r.log.innerHTML = logHtml; r.log.dataset.last = logHtml; }
    }
    // 結果の紙吹雪(全端末。結果ごとに1回)
    if (st.phase === 'result' && st.result && st.result.winner !== 'draw') {
      if (confettiSeq !== st.seq) { confettiSeq = st.seq; showConfetti(); }
    } else if (!$('confetti').hidden) {
      $('confetti').hidden = true;
      $('confetti').innerHTML = '';
    }
    // 順番待ち
    if (r.queue) {
      const q = Object.entries(room.queue || {}).filter(([uid]) => players[uid] && !players[uid].banned).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
      r.queue.innerHTML = q.length ? '' : '<div class="empty-note">まだ誰もいません。QR か URL から参加してもらおう</div>';
      q.forEach(([uid, _q], i) => {
        const p = players[uid];
        const row = document.createElement('div');
        row.className = 'queue-row';
        row.dataset.uid = uid;
        const pts = settings.mode !== 'drink' ? `${p.points ?? startPts(settings)}点` : `${p.wins ?? 0}勝${p.losses ?? 0}敗`;
        row.innerHTML = `<span class="rno">${i + 1}</span><span class="avatar sm" style="--c:${colorFor(uid)}">${charArt(p.char)}</span>` +
          `<span class="qname">${p.hidden ? '？？？' : esc(p.name || 'リスナー')}${p.online === false ? ' <span class="offline">オフライン</span>' : ''}</span><span class="qpts">${esc(pts)}</span>`;
        if (!readonly) row.insertAdjacentHTML('beforeend', `<span class="qacts"><button class="btn skip" data-act="skip">飛ばす</button><button class="btn hide" data-act="hide">${p.hidden ? '表示' : '非表示'}</button><button class="btn ban" data-act="ban">ブロック</button></span>`);
        r.queue.appendChild(row);
      });
    }
    // 戦歴(相手ごと。配信者から見た勝ち負け。いま対戦している相手は色を付ける)
    if (r.versus) {
      const nowUid = st.match && (st.phase === 'parent' || st.phase === 'child' || st.phase === 'result') ? st.match.childUid : null;
      const list = W.versusList(players);
      const html = list.length
        ? list.map((v) => `<div class="rank-row2${v.uid === nowUid ? ' now' : ''}"><span class="avatar sm" style="--c:${colorFor(v.uid)}">${charArt(v.char)}</span><span class="qname">${esc(v.name)}</span><span class="vrec">${v.wins}勝${v.losses}敗</span></div>`).join('')
        : '<div class="empty-note">まだ対戦がありません</div>';
      if (r.versus.dataset.last !== html) { r.versus.innerHTML = html; r.versus.dataset.last = html; }
    }
    // ランキング(点数モード)
    if (r['ranking-box']) r['ranking-box'].hidden = settings.mode === 'drink';
    if (r.ranking && settings.mode !== 'drink') {
      const rows = Object.entries(players).filter(([, p]) => !p.hidden && !p.banned && p.points !== undefined)
        .map(([uid, p]) => ({ uid, name: p.name, points: p.points, char: p.char }));
      rows.sort((a, b) => b.points - a.points);
      const hostRow = { uid: 'host', name: settings.hostName || '配信者', points: (st.host || {}).points ?? startPts(settings), char: settings.hostChar, host: true };
      const top = rows.slice(0, 10);
      const all = rows.concat([hostRow]).sort((a, b) => b.points - a.points);
      const hostRank = all.findIndex((p) => p.host) + 1;
      const shown = top.concat([{ ...hostRow, rankNo: hostRank }]).sort((a, b) => b.points - a.points);
      r.ranking.innerHTML = shown.map((p, i) => `<div class="rank-row2"><span class="rno">${p.rankNo || i + 1}</span><span class="avatar sm" style="--c:${p.host ? '#ff4d4d' : colorFor(p.uid)}">${charArt(p.char)}</span><span class="qname">${esc(p.name || 'リスナー')}${p.host ? ' (配信者)' : ''}</span><span class="qpts">${p.points}点</span></div>`).join('');
    }
  }

  let childTurnKey = null;
  let childTurnSince = 0;
  let proxyTimer = null;
  function renderHostControls() {
    if (role !== 'host' || !shown) return;
    const room = shown;
    const st = room.state || {};
    const hasQueue = Object.keys(room.queue || {}).length > 0;
    const child = st.match && (room.players || {})[st.match.childUid];
    $('start-match').hidden = playing || !(st.phase === 'lobby' && hasQueue);
    $('host-roll').hidden = playing || st.phase !== 'parent';
    if (st.phase === 'child' && st.match) {
      const key = String(st.seq);
      if (childTurnKey !== key) {
        childTurnKey = key;
        childTurnSince = Date.now();
        clearTimeout(proxyTimer);
        proxyTimer = setTimeout(renderHostControls, PROXY_ROLL_MS + 50);
      }
      $('roll-for-child').hidden = playing || Date.now() - childTurnSince < PROXY_ROLL_MS;
    } else {
      childTurnKey = null;
      $('roll-for-child').hidden = true;
    }
    $('next-match').hidden = playing || st.phase !== 'result';
    $('rematch').hidden = playing || st.phase !== 'result' || !child || child.banned;
    $('reset-scores').hidden = playing || !(st.phase === 'lobby' || st.phase === 'result');
  }

  function renderMute() {
    const b = $('mute');
    b.textContent = sounds.muted ? '🔇 消音中' : '🔊'; // 消音中は文字と色ではっきり見せる(絵文字だけだと気づきにくい)
    b.classList.toggle('muted', sounds.muted);
    b.setAttribute('aria-pressed', String(sounds.muted));
    $('stage-overlay').dataset.muted = String(sounds.muted);
    updateAudioBadge();
  }

  function render() {
    if (!room) {
      if (role === 'stage' && stageView.refs.arena) stageView.refs.arena.innerHTML = '<div class="empty-note">この部屋は見つかりません</div>';
      return;
    }
    if (!shown) shown = room;
    // リスナーの「振る」要求は、親機が自分の演出を見終わってから処理する(演出の途中で相手の番にならない)
    if (role === 'host' && !playing) hostQueue = hostQueue.then(processActions).catch((e) => console.warn('要求の処理に失敗', e));
    if (role === 'host') { renderBoard(hostView, false); renderHostControls(); markWatched(); }
    if (role === 'stage') renderBoard(stageView, true);
    if (role === 'listener') { renderBoard(listenerView, true); renderListener(); }
  }

  // ---------- 親機: 荒らし対策(飛ばす・非表示・ブロック) ----------
  async function moderate(act, uid) {
    if (act === 'skip') await backend.remove(`rooms/${code}/queue/${uid}`);
    if (act === 'hide') { const p = (room.players || {})[uid] || {}; await backend.update(`rooms/${code}/players/${uid}`, { hidden: !p.hidden }); }
    if (act === 'ban') { await backend.update(`rooms/${code}/players/${uid}`, { banned: true }); await backend.remove(`rooms/${code}/queue/${uid}`); }
  }

  // ---------- リスナー ----------
  const listenerView = { root: null, refs: {} };
  let join = { name: '', char: 'momotaro' };
  let joined = false; // 列に並んだことがある(online を管理する)
  let lastTurnKey = null;
  const keyListener = () => `chinchiro.listener.${code}`;

  function renderJoin() {
    $('join-code').textContent = code;
    setAvatar($('join-avatar'), join.char, colorFor(backend.uid));
    if ($('join-name').value !== join.name) $('join-name').value = join.name;
  }

  let joinSettings = null; // 参加画面(まだ room を購読していない)でルール表に使う、その部屋の設定
  async function enterListenerEntry(c) {
    role = 'listener';
    code = c;
    const r = await backend.get(`rooms/${c}`);
    if (!r || !r.hostUid) { show('screen-notfound'); return; }
    joinSettings = r.settings || null;
    const me = (r.players || {})[backend.uid];
    if (me && me.banned) { show('screen-banned'); return; }
    const presence = Object.keys(r.presence || {}).length;
    if (!me && presence > MAX_PRESENCE) { show('screen-full'); return; }
    // 接続のたび(初回と回線が戻ったとき)に presence/online を立て直し、切断時の後始末を登録し直す
    backend.onConnected(async (ok) => {
      if (!ok) return;
      try {
        await backend.set(`rooms/${c}/presence/${backend.uid}`, true);
        await backend.onDisconnectRemove(`rooms/${c}/presence/${backend.uid}`);
        if (joined) {
          await backend.update(`rooms/${c}/players/${backend.uid}`, { online: true });
          await backend.onDisconnectSet(`rooms/${c}/players/${backend.uid}/online`, false);
        }
      } catch (e) { console.warn('presence の更新に失敗', e); }
    });
    if (me) { // 再読み込み: 参加済みなら自分の画面へ直接戻る
      joined = true;
      await backend.update(`rooms/${c}/players/${backend.uid}`, { online: true });
      await backend.onDisconnectSet(`rooms/${c}/players/${backend.uid}/online`, false);
      enterListener(c);
      return;
    }
    const saved = store.get(keyListener());
    if (saved && typeof saved === 'object') { join.name = safeName(saved.name); if (validChar(saved.char)) join.char = saved.char; }
    renderJoin();
    show('screen-join');
  }

  async function challenge() {
    join.name = safeName($('join-name').value) || 'リスナー';
    const base = `rooms/${code}/players/${backend.uid}`;
    await backend.update(base, { name: join.name, char: join.char, joinedAt: backend.serverTimestamp(), online: true });
    await backend.set(`rooms/${code}/queue/${backend.uid}`, { joinedAt: backend.serverTimestamp() });
    await backend.onDisconnectSet(`${base}/online`, false);
    joined = true;
    store.set(keyListener(), join);
    enterListener(code);
  }

  async function requeue() {
    await backend.set(`rooms/${code}/queue/${backend.uid}`, { joinedAt: backend.serverTimestamp() });
  }

  function enterListener(c) {
    role = 'listener';
    bind(listenerView, $('screen-listener'));
    subscribe(c);
    show('screen-listener');
  }

  function renderListener() {
    if (!shown) return;
    const room = shown;
    const me = (room.players || {})[backend.uid] || null;
    const st = room.state || {};
    const settings = room.settings || {};
    if (me && me.banned) { show('screen-banned'); return; }
    if (st.phase === 'closed') { show('screen-closed'); return; }
    const queue = Object.entries(room.queue || {}).filter(([uid]) => (room.players || {})[uid] && !(room.players || {})[uid].banned)
      .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0)).map(([uid]) => uid);
    const pos = queue.indexOf(backend.uid);
    const inMatch = st.match && st.match.childUid === backend.uid;
    sounds.setKeepAlive(!!inMatch); // 自分の対戦中だけ無音ループ(見ているだけの人の音楽を止めない)
    updateAudioBadge();
    let status = '見るだけ';
    if (inMatch) status = st.phase === 'child' ? 'あなたの番!' : st.phase === 'parent' ? (st.match.round > 1 && st.match.parent.throws.length === 0 ? '引き分け! もう一度。親が振っています…' : '親が振っています…') : '結果';
    else if (pos >= 0) status = `あなたは ${pos + 1} 番目`;
    else if (me) status = '順番待ちから抜けています';
    $('my-status').textContent = status;
    const box = document.querySelector('.mystatus');
    const myTurn = !!(inMatch && st.phase === 'child');
    box.classList.toggle('turn', myTurn);
    const turnKey = myTurn ? `${st.seq}` : null;
    if (turnKey && turnKey !== lastTurnKey) { try { navigator.vibrate?.(200); } catch { /* 非対応 */ } sounds.roll(); }
    lastTurnKey = turnKey;
    if (me) {
      setAvatar($('my-avatar'), me.char, colorFor(backend.uid));
      $('my-avatar').hidden = false;
      const parts = [];
      if (settings.mode !== 'drink') parts.push(`<span class="num" data-v="${me.points ?? startPts(settings)}">${me.points ?? startPts(settings)}</span>点`);
      parts.push(`${me.wins ?? 0}勝${me.losses ?? 0}敗`);
      if (settings.mode !== 'points') parts.push(`飲んだ ${esc(unitLabel(settings))} × ${me.drinks ?? 0}`);
      $('my-record').innerHTML = `${esc(me.name || 'リスナー')} ・ ${parts.join(' ・ ')}`;
      animateNums($('my-record'));
    } else {
      $('my-avatar').hidden = true;
      $('my-record').textContent = '';
    }
    if (inMatch && st.phase === 'result' && st.result) {
      const res = st.result;
      let text = res.winner === 'child' ? 'あなたの勝ち!' : res.winner === 'parent' ? 'あなたの負け…' : '引き分け、もう一度!';
      if (res.winner === 'parent' && settings.mode !== 'points') text += ` ${unitLabel(settings)} × ${res.mult} 飲む!`;
      $('my-status').textContent = text;
    }
    $('requeue').hidden = !(me && pos < 0 && !inMatch);
    $('leave').hidden = !(pos >= 0);
    const lastSeq = (st.lastThrow && st.lastThrow.seq) || 0;
    if (rollRequested && lastSeq > rollReqSeq) rollRequested = false;
    if (hostAbsentSeq !== null && st.seq !== hostAbsentSeq) hostAbsentSeq = null;
    if (hostAbsentSeq !== null) $('my-status').textContent = '配信者の画面を待っています…';
    // 親機が演出を見終わる(state.watched が seq に追いつく)まで振れない。親機が落ちたときは WATCH_MS で諦める
    const hostDone = (st.watched || 0) >= st.seq || waitedTooLong(st.seq);
    const myTurnNow = inMatch && L.canThrow(st, 'child') && !playing;
    if (myTurnNow && !hostDone && hostAbsentSeq === null) $('my-status').textContent = '配信者の画面の演出中…';
    const canRoll = myTurnNow && hostDone;
    $('listener-roll').hidden = !canRoll;
    $('listener-roll').disabled = rollRequested;
    $('listener-roll').textContent = rollRequested ? '振っています…' : '🎲 振る';
  }

  let seqSeen = { seq: null, at: 0 };
  function waitedTooLong(seq) {
    if (seqSeen.seq !== seq) { seqSeen = { seq, at: Date.now() }; setTimeout(() => { if (room && room.state.seq === seq) renderListener(); }, WATCH_MS + 50); }
    return Date.now() - seqSeen.at > WATCH_MS;
  }

  // ---------- リスナー: 振る要求 ----------
  let rollRequested = false;
  let rollReqSeq = 0;
  let hostAbsentSeq = null; // この seq のまま親機が応えない
  async function listenerRoll() {
    if (rollRequested || !room || playing || !L.canThrow(room.state, 'child') || room.state.match.childUid !== backend.uid) return;
    rollRequested = true;
    rollReqSeq = (room.state.lastThrow && room.state.lastThrow.seq) || 0;
    const reqStateSeq = room.state.seq;
    renderListener();
    // 親機の返事が来るまで、手の中でサイコロを振っている演出
    const me = (room.players || {})[backend.uid] || {};
    stage.showWaiting({ name: me.hidden ? '？？？' : (me.name || 'あなた'), char: me.char, color: colorFor(backend.uid) });
    $('stage-overlay').hidden = false;
    await backend.set(`rooms/${code}/actions/${backend.uid}`, { type: 'roll', at: backend.serverTimestamp() });
    setTimeout(() => {
      if (!rollRequested || !room || room.state.seq !== reqStateSeq) return; // もう処理された
      rollRequested = false;
      hostAbsentSeq = reqStateSeq;
      if (!playing) { stage.reset(); $('stage-overlay').hidden = true; }
      renderListener();
    }, WAIT_HOST_MS);
  }

  // ---------- 投げの再生(全端末で同じ映像) ----------
  let playedSeq = null;   // 再生済みの lastThrow.seq
  let playing = false;
  let pendingThrow = null;
  let pendingIntro = null;
  let pendingResult = null;
  let resultKey = null;   // 結果シーンを出した state.seq
  let introKey = null;    // 登場シーンを出した対戦(childUid:開始時の seq)
  let introInit = false;
  /** 表示用の名前(非表示の人は ？？？)。 */
  function displayName(uid, players, fallback) {
    const p = (players || {})[uid];
    return p ? (p.hidden ? '？？？' : (p.name || fallback)) : fallback;
  }
  /** 決着(phase=result)か引き分けの再戦開始なら結果シーンを予約する。途中から開いた端末は出さない。 */
  function maybePlayResult() {
    const st = room.state;
    const m = st && st.match;
    const settings = room.settings || {};
    const players = room.players || {};
    const finished = !!(st.phase === 'result' && st.result && m);
    const drawn = !!(m && st.phase === 'parent' && m.round > 1 && m.parent.throws.length === 0 && m.lastDraw);
    const key = finished || drawn ? `${st.seq}` : null;
    if (resultKey === null) { resultKey = key || '0'; return false; }
    if (!key || key === resultKey) return false;
    resultKey = key;
    const hostName = settings.hostName || '配信者';
    const childName = displayName(m.childUid, players, 'リスナー');
    const result = finished ? st.result : { winner: 'draw', mult: 0, parentHand: m.lastDraw.parent, childHand: m.lastDraw.child };
    const sum = W.resultSummary(result, { host: hostName, child: childName }, settings);
    const side = (s, hand) => ({ handLabel: hand ? hand.label : (s.throws.length ? '目なし' : ''), diceHtml: s.throws.length ? W.diceHtml(s.throws[s.throws.length - 1].dice) : '' });
    const childP = players[m.childUid];
    pendingResult = {
      ...sum, winner: result.winner,
      parent: { name: hostName, char: settings.hostChar, color: '#ff4d4d', ...side(m.parent, result.parentHand) },
      child: { name: childName, char: childP && validChar(childP.char) ? childP.char : 'binbo', color: colorFor(m.childUid), ...side(m.child, result.childHand) },
    };
    if (drawn) { pendingResult.parent.diceHtml = ''; pendingResult.child.diceHtml = ''; pendingResult.parent.handLabel = result.parentHand ? result.parentHand.label : ''; pendingResult.child.handLabel = result.childHand ? result.childHand.label : ''; }
    runPlayback();
    return true;
  }
  /** 新しい対戦が始まった(親の1投目の前)なら登場シーンを予約する。途中から開いた端末は出さない。 */
  function maybePlayIntro() {
    const st = room.state;
    const m = st && st.match;
    const fresh = !!(m && st.phase === 'parent' && m.round === 1 && m.parent.throws.length === 0);
    const key = fresh ? `${m.childUid}:${st.seq}` : null;
    if (!introInit) { introInit = true; introKey = key; return false; }
    if (!fresh || key === introKey) return false;
    introKey = key;
    const settings = room.settings || {};
    const child = (room.players || {})[m.childUid];
    pendingIntro = {
      parent: { name: settings.hostName || '配信者', char: settings.hostChar, color: '#ff4d4d' },
      child: { name: child ? (child.hidden ? '？？？' : (child.name || 'リスナー')) : '挑戦者', char: child && validChar(child.char) ? child.char : 'binbo', color: colorFor(m.childUid) },
    };
    runPlayback(true);
    return true;
  }
  function maybePlayThrow() {
    const st = room.state;
    const lt = st && st.lastThrow;
    const seq = (lt && lt.seq) || 0;
    if (playedSeq === null) { playedSeq = seq; return false; } // 途中から開いた端末は最後の投げを再生しない
    if (!lt || seq <= playedSeq) return false;
    playedSeq = seq;
    const settings = room.settings || {};
    const child = st.match ? (room.players || {})[st.match.childUid] : null;
    const thrower = lt.by === 'parent'
      ? { name: settings.hostName || '配信者', char: settings.hostChar, color: '#ff4d4d' }
      : { name: child ? (child.hidden ? '？？？' : (child.name || 'リスナー')) : '挑戦者', char: child && validChar(child.char) ? child.char : 'binbo', color: colorFor(st.match ? st.match.childUid : '') };
    const side = st.match && st.match[lt.by];
    const remaining = side && side.throws.length ? (Number.isFinite(L.MAX_THROWS) ? L.MAX_THROWS - side.throws.length : Infinity) : 0;
    pendingThrow = { throwObj: lt.throw, thrower, remaining };
    runPlayback(true);
    return true;
  }
  /**
   * 予約した場面(登場・投げ・結果)を順に再生する。
   * skipCurrent: 再生中の場面を飛ばして次へ進むか。新しい投げ・新しい対戦が来たときだけ true。
   * 結果シーンは、勝負を決めた投げと同じ更新で届く。ここで飛ばすと、その投げの演出(振る・跳ねる・音)が丸ごと消えるので、飛ばさず後ろに並べる。
   */
  async function runPlayback(skipCurrent = false) {
    if (playing) { if (skipCurrent) stage.skip(); return; }
    playing = true;
    renderControlsOnly();
    while (pendingIntro || pendingThrow || pendingResult) {
      $('stage-overlay').hidden = false;
      if (pendingIntro) {
        const i = pendingIntro;
        pendingIntro = null;
        try { await stage.playIntro(i.parent, i.child, { reduced: QUICK }); } catch (e) { console.warn('登場シーンに失敗', e); }
        continue;
      }
      if (pendingThrow) {
        const t = pendingThrow;
        pendingThrow = null;
        try { await stage.play(t.throwObj, { thrower: t.thrower, remaining: t.remaining, reduced: QUICK }); } catch (e) { console.warn('演出に失敗', e); }
        continue;
      }
      const r = pendingResult;
      pendingResult = null;
      try { await stage.playResult(r, { reduced: QUICK }); } catch (e) { console.warn('結果シーンに失敗', e); }
    }
    $('stage-overlay').hidden = true;
    playing = false;
    shown = room; // 止まったので最新を見せる
    render();
  }
  /** 親機: 今の state(seq)まで演出を見終わったことを書く。リスナーはこれを待ってから振れる。 */
  let watchedSent = null;
  function markWatched() {
    if (role !== 'host' || !room || !room.state || playing || pendingIntro || pendingThrow || pendingResult) return;
    const seq = room.state.seq;
    if ((room.state.watched || 0) >= seq || watchedSent === seq) return;
    watchedSent = seq;
    backend.update(`rooms/${code}/state`, { watched: seq }).catch((e) => { watchedSent = null; console.warn('watched の書き込みに失敗', e); });
  }
  function renderControlsOnly() {
    if (role === 'host') renderHostControls();
    if (role === 'listener' && room) renderListener();
  }

  // ---------- 親機: 対戦の進行(state を書けるのは親機だけ) ----------
  let hostQueue = Promise.resolve();
  const hostDo = (fn) => { hostQueue = hostQueue.then(fn).catch((e) => { console.warn(e); alert('進行に失敗しました: ' + SY.explainError(e)); }); return hostQueue; };
  const writeState = (st) => backend.set(`rooms/${code}/state`, st);

  async function hostStartMatch(uid) {
    const cur = room.state;
    if (cur.phase !== 'lobby' && cur.phase !== 'result') return; // 二度押し・遅れて届いた要求は無視
    const st = L.startMatch(cur, uid);
    await backend.update(`rooms/${code}`, { state: st, [`queue/${uid}`]: null }); // 列からの削除と対戦開始を1回で
  }
  /** 全員の点数を持ち点に戻し、勝敗・飲みを 0 にする(1 回の書き込みで)。 */
  async function hostResetScores() {
    const cur = room.state;
    if (cur.phase === 'parent' || cur.phase === 'child') return;
    const start = startPts(room.settings);
    const upd = { state: L.resetScores(cur, start) };
    for (const uid of Object.keys(room.players || {})) {
      upd[`players/${uid}/points`] = start;
      upd[`players/${uid}/wins`] = 0;
      upd[`players/${uid}/losses`] = 0;
      upd[`players/${uid}/drinks`] = 0;
    }
    await backend.update(`rooms/${code}`, upd);
  }
  async function hostThrowAndSettle(by) {
    const st = room.state;
    if (!L.canThrow(st, by)) return;
    const roll = L.rollDice(Math.random);
    const cp = st.match ? (room.players || {})[st.match.childUid] || {} : {};
    const { state, result } = L.applyThrow(st, by, roll, room.settings, Date.now(), { childName: cp.name || '' });
    if (!result) { await writeState(state); return; }
    // 結果の書き込みと子の点数の更新を1回で(途中で親機が落ちても食い違わない)
    const p = (room.players || {})[result.childUid] || {};
    const d = result.deltas.child;
    await backend.update(`rooms/${code}`, {
      state,
      [`players/${result.childUid}/points`]: (p.points ?? startPts(room.settings)) + d.points,
      [`players/${result.childUid}/wins`]: (p.wins ?? 0) + d.wins,
      [`players/${result.childUid}/losses`]: (p.losses ?? 0) + d.losses,
      [`players/${result.childUid}/drinks`]: (p.drinks ?? 0) + d.drinks,
    });
  }
  /** リスナーの「振る」要求を処理する。手番の子の要求だけ受け付け、それ以外は捨てる。 */
  async function processActions() {
    if (!room || !room.actions) return;
    for (const [uid, a] of Object.entries(room.actions)) {
      const st = room.state;
      const isTurn = a && a.type === 'roll' && st.phase === 'child' && st.match && st.match.childUid === uid && L.canThrow(st, 'child');
      await backend.remove(`rooms/${code}/actions/${uid}`);
      if (isTurn) await hostThrowAndSettle('child');
    }
  }
  function firstInQueue() {
    const players = room.players || {};
    const q = Object.entries(room.queue || {}).filter(([uid]) => players[uid] && !players[uid].banned).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
    return q.length ? q[0][0] : null;
  }

  // ---------- 初期化 ----------
  async function main() {
    try {
      backend = await connect();
    } catch (e) {
      console.warn('接続できません', e);
      if (ROOM_PARAM) { $('connect-error').textContent = SY.explainError(e); show('screen-connect-failed'); } // リスナーには設定の話はしない
      else { $('setup-error').textContent = SY.explainError(e); $('setup-headline').textContent = window.FIREBASE_CONFIG ? 'Firebase に接続できませんでした。' : 'まだ Firebase の設定がありません。'; show('screen-setup-needed'); }
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
      const r = await backend.get(`rooms/${prev.code}`);
      if (r && r.hostUid === backend.uid && (!r.state || r.state.phase !== 'closed')) { await enterHost(prev.code); return; }
      store.del(KEY_HOST);
    }
    enterHostEntry();
  }

  $('host-avatar').addEventListener('click', () => openPick(setup.char, '配信者のキャラクター', (id) => { setup.char = id; renderEntry(); show('screen-host-entry'); }));
  $('pick-back').addEventListener('click', () => { pickCb = null; show(role === 'listener' ? 'screen-join' : 'screen-host-entry'); });
  $('join-avatar').addEventListener('click', () => openPick(join.char, 'あなたのキャラクター', (id) => { join.char = id; renderJoin(); show('screen-join'); }));
  $('join-name').addEventListener('input', () => { join.name = $('join-name').value; });
  $('join-challenge').addEventListener('click', () => challenge().catch((e) => alert('参加できませんでした: ' + SY.explainError(e))));
  $('join-watch').addEventListener('click', () => enterListener(code));
  $('requeue').addEventListener('click', () => requeue().catch((e) => alert('並べませんでした: ' + e.message)));
  $('leave').addEventListener('click', () => backend.remove(`rooms/${code}/queue/${backend.uid}`));
  $('queue').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]'); if (!btn) return;
    const uid = btn.closest('.queue-row').dataset.uid;
    moderate(btn.dataset.act, uid).catch((e) => alert('操作できませんでした: ' + e.message));
  });
  $('host-name').addEventListener('input', () => { setup.name = $('host-name').value; });
  $('create-room').addEventListener('click', () => createRoom().catch((e) => alert('部屋を作れませんでした: ' + SY.explainError(e))));
  // ルール表(オーバーレイ)。部屋があればその設定、無ければ設定画面の値で作る
  function openRules() {
    const settings = room && room.settings ? room.settings : joinSettings || { mode: setup.mode, unit: setup.unit, drinkUnit: setup.drinkUnit, startPoints: chosenStart() };
    $('rules-body').innerHTML = W.rulesHtml(settings);
    $('rules').hidden = false;
  }
  function closeRules() { $('rules').hidden = true; }
  for (const id of ['rules-btn', 'rules-btn-l', 'rules-link']) $(id).addEventListener('click', (ev) => { ev.preventDefault(); openRules(); });
  $('rules-close').addEventListener('click', closeRules);
  $('rules').addEventListener('click', (ev) => { if (ev.target === $('rules')) closeRules(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !$('rules').hidden) closeRules(); });
  $('resume-room').addEventListener('click', () => { const prev = store.get(KEY_HOST); if (prev && prev.code) enterHost(prev.code); });
  // 音の解錠と再開: 最初のタップ(iOS)、キー操作、タブに戻ったとき(電話などの割り込み後)
  document.addEventListener('pointerdown', () => sounds.unlock());
  document.addEventListener('touchend', () => sounds.unlock());
  document.addEventListener('keydown', () => sounds.unlock());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sounds.unlock(false); });
  renderMute();
  $('start-match').addEventListener('click', () => { $('start-match').hidden = true; hostDo(() => { const uid = firstInQueue(); if (uid) return hostStartMatch(uid); }); });
  $('host-roll').addEventListener('click', () => { $('host-roll').hidden = true; hostDo(() => hostThrowAndSettle('parent')); });
  $('roll-for-child').addEventListener('click', () => { $('roll-for-child').hidden = true; hostDo(() => hostThrowAndSettle('child')); });
  $('next-match').addEventListener('click', () => hostDo(() => writeState(L.nextMatch(room.state))));
  $('reset-scores').addEventListener('click', () => {
    if (!confirm('全員の点数を持ち点に戻し、勝敗と飲んだ数も 0 にします。よろしいですか?(対戦の記録は残ります)')) return;
    hostDo(hostResetScores);
  });
  $('rematch').addEventListener('click', () => hostDo(() => { const uid = room.state.match && room.state.match.childUid; if (uid) return hostStartMatch(uid); }));
  $('listener-roll').addEventListener('click', () => listenerRoll().catch((e) => alert('振れませんでした: ' + e.message)));
  $('mute').addEventListener('click', () => {
    sounds.setMuted(!sounds.muted);
    renderMute();
    if (!sounds.muted) { sounds.unlock(); sounds.chime(); } // 戻したときは確認の音を鳴らす(鳴らなければパソコン側の音量・消音が原因)
  });
  $('close-room').addEventListener('click', async () => {
    if (!confirm('部屋を閉じますか? リスナーには「終了しました」と表示されます')) return;
    await backend.update(`rooms/${code}/state`, { phase: 'closed' });
    store.del(KEY_HOST);
    location.search = MOCK ? '?mock=1' : '';
  });

  main();
})();
