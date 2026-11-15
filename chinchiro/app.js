// ===== 表示層: 役割の判定、親機・リスナー・表示専用の画面 =====
(() => {
  'use strict';
  const L = ChinchiroLogic;
  const SY = ChinchiroSync;
  const params = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const MOCK = params.get('mock') === '1';
  const ROOM_PARAM = (params.get('room') || '').toUpperCase();
  const IS_STAGE = params.get('stage') === '1';
  const KEY_HOST = 'chinchiro.host';
  const KEY_SETUP = 'chinchiro.setup';
  const KEY_MUTED = 'chinchiro.muted';

  const CHARACTERS = [
    { id: 'momotaro', name: 'ももたろう' }, { id: 'kintaro', name: 'きんたろう' }, { id: 'urashima', name: 'うらしまたろう' },
    { id: 'kaguya', name: 'かぐやひめ' }, { id: 'issun', name: 'いっすんぼうし' }, { id: 'akaoni', name: 'あかおに' },
    { id: 'aooni', name: 'あおおに' }, { id: 'inu', name: 'いぬ' }, { id: 'saru', name: 'さる' },
    { id: 'kiji', name: 'きじ' }, { id: 'kappa', name: 'かっぱ' }, { id: 'binbo', name: 'びんぼうがみ' },
  ];
  const CHAR_NAME = Object.fromEntries(CHARACTERS.map((c) => [c.id, c.name]));
  const COLORS = ['#ff4d4d', '#3b8cff', '#2ec27e', '#ffd93d', '#b56cff', '#ff9f1c', '#4dd4e8', '#ff7bd2'];
  const MODE_LABEL = { points: { label: '点数', hint: '持ち点100から' }, drink: { label: '飲み', hint: '負けたら飲む' }, both: { label: '両方', hint: '点数も飲みも' } };

  const store = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できなくても動く */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* 同上 */ } },
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const safeName = (s) => String(s ?? '').trim().slice(0, 12);

  const sounds = ChinchiroAnim.createSounds();
  sounds.setMuted(store.get(KEY_MUTED) === true);
  const stage = ChinchiroAnim.createDiceStage($('stage'), sounds);

  function show(id) {
    for (const s of document.querySelectorAll('#app > .screen')) s.hidden = s.id !== id;
    window.scrollTo(0, 0);
  }
  function setAvatar(el, charId, color) {
    const art = SugorokuArt.CHAR_ART[charId] ? SugorokuArt.CHAR_ART[charId]() : '';
    el.dataset.char = charId || '';
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
    stage.play({ dice, seed, shonben, hand }, { thrower: { name: 'デモ', char: 'momotaro', color: '#ff4d4d' }, remaining });
    if (params.get('skip') === '1') stage.skip();
    return;
  }

  // ---------- 接続 ----------
  let backend = null;
  let code = null;       // いまの部屋コード
  let room = null;       // 同期された部屋データ(rooms/{code})
  let role = null;       // 'host' | 'stage' | 'listener'
  let unsubRoom = null;

  async function connect() {
    if (MOCK) return SY.createBackend({ kind: 'mock', storage: localStorage, uidStorage: sessionStorage });
    return SY.createBackend({ kind: 'firebase', config: window.FIREBASE_CONFIG });
  }

  function subscribe(c) {
    if (unsubRoom) unsubRoom();
    code = c;
    unsubRoom = backend.watch(`rooms/${c}`, (r) => { room = r; render(); });
  }

  // ---------- キャラ選択画面(共通) ----------
  let pickCb = null;
  function openPick(current, title, cb) {
    pickCb = cb;
    setAvatar($('pick-avatar'), current, '#ff4d4d');
    $('pick-title').textContent = title;
    $('pick-hint').textContent = `いまは「${CHAR_NAME[current] || ''}」。好きなキャラをタップしてね`;
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
  let setup = { name: '', char: 'momotaro', mode: 'points', unit: 10, drinkUnit: 'sip' };

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
    renderChoices($('mode-choices'), Object.entries(MODE_LABEL).map(([k, v]) => ({ attr: 'mode', value: k, label: v.label, hint: v.hint })), setup.mode, (v) => { setup.mode = v; });
    renderChoices($('unit-choices'), L.POINT_UNITS.map((u) => ({ attr: 'unit', value: u, label: `${u}点`, hint: '×倍率' })), setup.unit, (v) => { setup.unit = Number(v); });
    renderChoices($('drink-choices'), Object.entries(L.DRINK_UNITS).map(([k, v]) => ({ attr: 'drink', value: k, label: v.label, hint: '×倍率' })), setup.drinkUnit, (v) => { setup.drinkUnit = v; });
  }

  function enterHostEntry() {
    const saved = store.get(KEY_SETUP);
    if (saved && typeof saved === 'object') {
      if (typeof saved.name === 'string') setup.name = safeName(saved.name);
      if (CHAR_NAME[saved.char]) setup.char = saved.char;
      if (MODE_LABEL[saved.mode]) setup.mode = saved.mode;
      if (L.POINT_UNITS.includes(saved.unit)) setup.unit = saved.unit;
      if (L.DRINK_UNITS[saved.drinkUnit]) setup.drinkUnit = saved.drinkUnit;
    }
    renderEntry();
    const prev = store.get(KEY_HOST);
    $('resume-banner').hidden = !(prev && prev.code && prev.uid === backend.uid);
    show('screen-host-entry');
  }

  async function createRoom() {
    setup.name = safeName($('host-name').value) || '配信者';
    const c = SY.roomCode();
    const settings = { mode: setup.mode, unit: setup.unit, drinkUnit: setup.drinkUnit, hostName: setup.name, hostChar: setup.char };
    await backend.set(`rooms/${c}`, { hostUid: backend.uid, createdAt: backend.now(), settings, state: L.createState() });
    store.set(KEY_SETUP, setup);
    store.set(KEY_HOST, { code: c, uid: backend.uid });
    enterHost(c);
  }

  // ---------- 親機: 本体 ----------
  const hostView = { root: null, refs: {} };
  const stageView = { root: null, refs: {} };
  function bind(view, root) {
    view.root = root;
    view.refs = {};
    for (const el of root.querySelectorAll('[data-ref]')) view.refs[el.dataset.ref] = el;
  }

  function enterHost(c) {
    role = 'host';
    bind(hostView, $('screen-host'));
    subscribe(c);
    show('screen-host');
    renderMute();
  }

  function enterStage(c) {
    role = 'stage';
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
  function drawQr(canvas, text) {
    if (!canvas || qrDrawnFor === text) return;
    if (!window.QRCode || typeof window.QRCode.toCanvas !== 'function') { canvas.hidden = true; return; }
    qrDrawnFor = text;
    window.QRCode.toCanvas(canvas, text, { width: 84, margin: 1 }, (err) => { if (err) canvas.hidden = true; });
  }

  function unitLabel(settings) { return (L.DRINK_UNITS[settings.drinkUnit] || L.DRINK_UNITS.sip).label; }

  function fighterHtml(cls, char, color, name, sub, handText, handSub, turn, extraCls = '') {
    return `<div class="fighter ${cls} ${turn ? 'turn' : ''} ${extraCls}">
      <span class="avatar" data-char="${esc(char)}" style="--c:${esc(color)}">${SugorokuArt.CHAR_ART[char] ? SugorokuArt.CHAR_ART[char]() : ''}</span>
      <div class="fname">${esc(name)}</div><div class="fsub">${esc(sub)}</div>
      <div class="fhand">${esc(handText)}${handSub ? `<small>${esc(handSub)}</small>` : ''}</div></div>`;
  }

  function sideText(side) {
    if (!side) return ['', ''];
    if (side.hand) return [side.hand.label + (side.hand.lose ? '' : ` (×${side.hand.mult})`), `${side.throws.length}投目`];
    if (side.throws.length) return [`目なし… あと${L.MAX_THROWS - side.throws.length}投`, ''];
    return ['', ''];
  }

  function renderBoard(view, readonly) {
    if (!view.root || !room) return;
    const r = view.refs;
    const st = room.state || L.createState();
    const settings = room.settings || {};
    const players = room.players || {};
    if (r.code) r.code.textContent = code;
    if (r.url) r.url.textContent = joinUrl(code);
    if (r.qr) drawQr(r.qr, joinUrl(code));
    // 配信者の成績
    if (r.record) {
      const h = st.host || {};
      const parts = [];
      if (settings.mode !== 'drink') parts.push(`${h.points ?? 100}点`);
      parts.push(`${h.wins ?? 0}勝${h.losses ?? 0}敗`);
      if (settings.mode !== 'points') parts.push(`飲んだ ${h.drinks ?? 0}${unitLabel(settings)}`);
      r.record.innerHTML = `${esc(settings.hostName || '配信者')}<small>${esc(parts.join(' ・ '))}</small>`;
    }
    // 対戦の場
    if (r.arena) {
      const m = st.match;
      const child = m ? players[m.childUid] : null;
      const [ph, phs] = sideText(m && m.parent);
      const [ch, chs] = sideText(m && m.child);
      let center = '<div class="vs">VS</div>';
      let status = '';
      if (st.phase === 'lobby') status = Object.keys(room.queue || {}).length ? (readonly ? '次の対決を待っています' : '「対決スタート」で先頭の人と対決') : '挑戦者を待っています';
      else if (st.phase === 'parent') status = `親の番(${m.parent.throws.length}/${L.MAX_THROWS})`;
      else if (st.phase === 'child') status = `${child ? child.name : '挑戦者'} さんの番(${m.child.throws.length}/${L.MAX_THROWS})`;
      else if (st.phase === 'result' && st.result) {
        const res = st.result;
        center = `<div class="vs">${res.winner === 'draw' ? '引き分け' : `×${res.mult}`}</div>`;
        status = res.winner === 'parent' ? `${settings.hostName || '配信者'} の勝ち!` : res.winner === 'child' ? `${child ? child.name : '挑戦者'} さんの勝ち!` : 'もう一度!';
      } else if (st.phase === 'closed') status = '部屋は閉じました';
      const res = st.phase === 'result' ? st.result : null;
      r.arena.innerHTML =
        fighterHtml('host', settings.hostChar, '#ff4d4d', settings.hostName || '配信者', '親', ph, phs, st.phase === 'parent', res && res.winner === 'parent' ? 'winner' : '') +
        `<div class="center">${center}<span class="status">${esc(status)}</span></div>` +
        (child
          ? fighterHtml('child', child.char, colorFor(m.childUid), child.hidden ? '？？？' : child.name, `挑戦者 ${m.round > 1 ? `(${m.round}回戦)` : ''}`, ch, chs, st.phase === 'child', res && res.winner === 'child' ? 'winner' : '')
          : fighterHtml('child empty', 'binbo', '#ccc', '挑戦者', '順番待ちから', '', '', false));
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
        const pts = settings.mode !== 'drink' ? `${p.points ?? 100}点` : `${p.wins ?? 0}勝${p.losses ?? 0}敗`;
        row.innerHTML = `<span class="rno">${i + 1}</span><span class="avatar sm" style="--c:${colorFor(uid)}">${SugorokuArt.CHAR_ART[p.char] ? SugorokuArt.CHAR_ART[p.char]() : ''}</span>` +
          `<span class="qname">${p.hidden ? '？？？' : esc(p.name)}${p.online === false ? ' <span class="offline">オフライン</span>' : ''}</span><span class="qpts">${esc(pts)}</span>`;
        if (!readonly) row.insertAdjacentHTML('beforeend', `<button class="btn skip" data-act="skip">飛ばす</button><button class="btn hide" data-act="hide">${p.hidden ? '表示' : '非表示'}</button><button class="btn ban" data-act="ban">ブロック</button>`);
        r.queue.appendChild(row);
      });
    }
    // ランキング(点数モード)
    if (r['ranking-box']) r['ranking-box'].hidden = settings.mode === 'drink';
    if (r.ranking && settings.mode !== 'drink') {
      const rows = Object.entries(players).filter(([, p]) => !p.hidden && !p.banned && p.points !== undefined)
        .map(([uid, p]) => ({ uid, name: p.name, points: p.points, char: p.char }));
      rows.push({ uid: 'host', name: settings.hostName || '配信者', points: (st.host || {}).points ?? 100, char: settings.hostChar, host: true });
      rows.sort((a, b) => b.points - a.points);
      r.ranking.innerHTML = rows.slice(0, 11).map((p, i) => `<div class="rank-row2"><span class="rno">${i + 1}</span><span class="avatar sm" style="--c:${p.host ? '#ff4d4d' : colorFor(p.uid)}">${SugorokuArt.CHAR_ART[p.char] ? SugorokuArt.CHAR_ART[p.char]() : ''}</span><span class="qname">${esc(p.name)}${p.host ? ' (配信者)' : ''}</span><span class="qpts">${p.points}点</span></div>`).join('');
    }
  }

  function renderHostControls() {
    if (role !== 'host' || !room) return;
    const st = room.state || {};
    const hasQueue = Object.keys(room.queue || {}).length > 0;
    $('start-match').hidden = !(st.phase === 'lobby' && hasQueue);
    $('host-roll').hidden = st.phase !== 'parent';
    $('roll-for-child').hidden = true;
    $('next-match').hidden = st.phase !== 'result';
    $('rematch').hidden = st.phase !== 'result';
  }

  function renderMute() { $('mute').textContent = sounds.muted ? '🔇' : '🔊'; }

  function render() {
    if (!room) {
      if (role === 'stage' && stageView.refs.arena) stageView.refs.arena.innerHTML = '<div class="empty-note">この部屋は見つかりません</div>';
      return;
    }
    if (role === 'host') { renderBoard(hostView, false); renderHostControls(); }
    if (role === 'stage') renderBoard(stageView, true);
  }

  // ---------- 初期化 ----------
  async function main() {
    try {
      backend = await connect();
    } catch (e) {
      console.warn('接続できません', e);
      show('screen-setup-needed');
      return;
    }
    if (ROOM_PARAM && IS_STAGE) { enterStage(ROOM_PARAM); return; }
    if (ROOM_PARAM) { show('screen-setup-needed'); return; } // リスナー画面は次の段階で
    enterHostEntry();
  }

  $('host-avatar').addEventListener('click', () => openPick(setup.char, '配信者のキャラクター', (id) => { setup.char = id; renderEntry(); show('screen-host-entry'); }));
  $('pick-back').addEventListener('click', () => { pickCb = null; show(role === 'listener' ? 'screen-join' : 'screen-host-entry'); });
  $('host-name').addEventListener('input', () => { setup.name = $('host-name').value; });
  $('create-room').addEventListener('click', () => createRoom().catch((e) => alert('部屋を作れませんでした: ' + e.message)));
  $('resume-room').addEventListener('click', () => { const prev = store.get(KEY_HOST); if (prev && prev.code) enterHost(prev.code); });
  $('mute').addEventListener('click', () => { sounds.setMuted(!sounds.muted); store.set(KEY_MUTED, sounds.muted); renderMute(); });
  $('close-room').addEventListener('click', async () => {
    if (!confirm('部屋を閉じますか? リスナーには「終了しました」と表示されます')) return;
    await backend.update(`rooms/${code}/state`, { phase: 'closed' });
    store.del(KEY_HOST);
    location.search = MOCK ? '?mock=1' : '';
  });

  main();
})();
