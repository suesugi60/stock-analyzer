// ===== 盤の絵・玉が転がる演出・音・賭けるテーブルの絵 =====
// 盤(SVG)は RouletteLogic の角度の決まりどおりに描く: 真上が 0 度、時計回りに 0, 32, 15, … と並ぶ。
const RouletteWheel = (() => {
  'use strict';
  const L = (typeof module !== 'undefined' && module.exports) ? require('./logic.js') : RouletteLogic;

  const VIEW = '-112 -112 224 224';
  const R_OUT = 84;   // 数字のマスの外側
  const R_IN = 55;    // 数字のマスの内側(ここから中は円すい)
  const R_NUM = 76;   // 数字を書く半径
  // ピンク基調でも赤・黒・みどりが分かる色
  const FILL = { red: '#ff2457', black: '#3a1535', green: '#12b886' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const rad = (deg) => (deg * Math.PI) / 180;
  const f2 = (n) => Number(n.toFixed(2));
  /** 真上を 0 度として時計回りの角度 a、半径 r の点。 */
  const pt = (r, a) => `${f2(r * Math.sin(rad(a)))} ${f2(-r * Math.cos(rad(a)))}`;
  /** 角度 a0〜a1、半径 r1〜r2 の扇形(ドーナツの一切れ)。 */
  const sector = (a0, a1, r1, r2) => `M${pt(r2, a0)}A${r2} ${r2} 0 0 1 ${pt(r2, a1)}L${pt(r1, a1)}A${r1} ${r1} 0 0 0 ${pt(r1, a0)}Z`;

  /** 回る部分: 数字のマス 37 個と、まん中の円すい。win に数字を渡すと、そのマスを囲む。 */
  function wheelSvg(win = null) {
    let pockets = '';
    let nums = '';
    let ring = '';
    L.WHEEL.forEach((n, i) => {
      const mid = i * L.POCKET;
      const a0 = mid - L.POCKET / 2;
      const a1 = mid + L.POCKET / 2;
      const d = sector(a0, a1, R_IN, R_OUT);
      pockets += `<path class="pocket ${L.colorOf(n)}" data-n="${n}" d="${d}" fill="${FILL[L.colorOf(n)]}" stroke="#ffe3ef" stroke-width=".7"/>`;
      nums += `<text transform="rotate(${f2(mid)}) translate(0 ${-R_NUM})" dy=".36em">${n}</text>`;
      if (n === win) ring = `<path class="win-ring" d="${d}" fill="none" stroke="#fff" stroke-width="2.6" stroke-linejoin="round"/>`;
    });
    let spokes = '';
    for (let k = 0; k < 8; k++) spokes += `<path d="M${pt(16, k * 45)}L${pt(R_IN - 3, k * 45)}" stroke="#ffb3d1" stroke-width="2.2" stroke-linecap="round"/>`;
    return `<svg viewBox="${VIEW}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
      '<defs><radialGradient id="rl-cone"><stop offset="0" stop-color="#fff"/><stop offset=".55" stop-color="#ffe3ef"/><stop offset="1" stop-color="#ff9cc6"/></radialGradient></defs>' +
      `<g class="pockets">${pockets}</g>` +
      `<circle r="${(R_IN + 12)}" fill="none" stroke="rgba(40,10,35,.28)" stroke-width="11"/>` + // 玉が収まるくぼみの影
      `<g class="nums" font-size="7.4" font-weight="900" text-anchor="middle" fill="#fff">${nums}</g>${ring}` +
      `<circle r="${R_IN}" fill="url(#rl-cone)" stroke="#fff" stroke-width="1.4"/>${spokes}` +
      '<circle r="16" fill="#ff4c95" stroke="#fff" stroke-width="2"/>' +
      '<path d="M0 8C-10.5 0.5 -9 -8 -4 -8C-1.5 -8 0 -6 0 -4.5C0 -6 1.5 -8 4 -8C9 -8 10.5 0.5 0 8Z" fill="#fff"/></svg>';
  }

  /** 回らない部分: ふち(電球つき)と、玉が走る外周。 */
  function rimSvg() {
    let bulbs = '';
    const N = 24;
    for (let i = 0; i < N; i++) { const [x, y] = pt(104, (360 / N) * i + 7.5).split(' '); bulbs += `<circle class="bulb ${i % 2 ? 'b' : 'a'}" cx="${x}" cy="${y}" r="2.9"/>`; }
    let studs = '';
    for (let k = 0; k < 8; k++) studs += `<path transform="rotate(${k * 45 + 22.5}) translate(0 -${L.R_TRACK})" d="M0 -3.4L1.9 0L0 3.4L-1.9 0Z" fill="#ffd166" stroke="#fff" stroke-width=".5"/>`;
    return `<svg viewBox="${VIEW}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
      '<defs><linearGradient id="rl-rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9cc6"/><stop offset=".5" stop-color="#ff4c95"/><stop offset="1" stop-color="#ff7fb3"/></linearGradient>' +
      '<radialGradient id="rl-track"><stop offset=".8" stop-color="#ffd6e7"/><stop offset=".92" stop-color="#fff5f9"/><stop offset="1" stop-color="#ffc2da"/></radialGradient></defs>' +
      `<circle r="110" fill="#fff"/><circle r="108.5" fill="url(#rl-rim)"/><circle r="99.5" fill="#fff"/><circle r="98.5" fill="url(#rl-track)"/>${studs}${bulbs}</svg>`;
  }
  /** 玉。 */
  function ballSvg() {
    return `<svg viewBox="${VIEW}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
      '<defs><radialGradient id="rl-ball" cx=".35" cy=".3"><stop offset="0" stop-color="#fff"/><stop offset=".7" stop-color="#f4f0f2"/><stop offset="1" stop-color="#cbb5c0"/></radialGradient></defs>' +
      '<g class="ball" visibility="hidden"><ellipse cx=".8" cy="1.6" rx="4.4" ry="3.6" fill="rgba(40,10,35,.3)"/><circle r="4.3" fill="url(#rl-ball)" stroke="#b592a5" stroke-width=".5"/></g></svg>';
  }

  // ---------- 賭けるテーブル ----------
  /** チップの数の短い書き方(1500 → 1.5千、12000 → 1.2万)。 */
  function shortAmount(v) {
    if (v >= 10000) return `${f2(Math.floor(v / 1000) / 10)}万`;
    if (v >= 1000) return `${f2(Math.floor(v / 100) / 10)}千`;
    return String(v);
  }
  /**
   * テーブルの HTML。たて長(スマホ向き): 上に 0、その下に 1〜36 が 3 列、左に 2択と 3択、下に「たて1列」。
   *   mine: 自分の賭け { 場所: チップ }(配信者・表示専用では空)
   *   totals: みんなの合計 { 場所: { sum, count } }
   *   win: 出た数字(結果が出ているときだけ。当たった場所が光る)
   *   interactive: 押せるか
   */
  /** 1 つの場所の見た目(クラスとチップ)。 */
  function cellState(spot, base, m) {
    const own = (m.mine && m.mine[spot]) || 0;
    const all = m.totals && m.totals[spot] ? m.totals[spot].sum : 0;
    const others = all - own;
    const win = Number.isInteger(m.win) ? m.win : null;
    const hit = win !== null && L.spotWins(spot, win);
    let chips = '';
    if (own > 0) chips += `<span class="chip mine" data-v="${own}">${shortAmount(own)}</span>`;
    if (others > 0) chips += `<span class="chip all" data-v="${others}">${shortAmount(others)}</span>`;
    return { cls: `cell ${base}${hit ? ' win' : win !== null ? ' lose' : ''}${own > 0 ? ' has-mine' : ''}`, chips };
  }
  const tableClass = (m) => `rtable${Number.isInteger(m.win) ? ' settled' : ''}`;
  function tableHtml(m = {}) {
    const cell = (spot, base, row, col, label, sub = '') => {
      const st = cellState(spot, base, m);
      return `<button type="button" class="${st.cls}" data-spot="${spot}" data-base="${base}" style="grid-row:${row};grid-column:${col}"${m.interactive ? '' : ' disabled'}` +
        ` aria-label="${esc(L.spotLabel(spot))} に賭ける(当たると${L.spotPays(spot)}倍)">` +
        `<span class="lab">${esc(label)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}<span class="chips">${st.chips}</span></button>`;
    };
    let html = '<div class="corner" style="grid-row:1;grid-column:1 / 3">当たると<br>何倍?</div>';
    html += cell(0, 'num green zero', '1', '3 / 6', '0', '36倍');
    for (let n = 1; n <= 36; n++) html += cell(n, `num ${L.colorOf(n)}`, String(1 + Math.ceil(n / 3)), String(3 + ((n - 1) % 3)), String(n));
    const S = L.SPOT;
    [[S.LOW, '1〜18', 'out'], [S.EVEN, '偶数', 'out'], [S.RED, '赤', 'out red'], [S.BLACK, '黒', 'out black'], [S.ODD, '奇数', 'out'], [S.HIGH, '19〜36', 'out']]
      .forEach(([spot, label, cls], i) => { html += cell(spot, cls, `${2 + i * 2} / span 2`, '1', label, '2倍'); });
    ['1〜12', '13〜24', '25〜36'].forEach((label, d) => { html += cell(S.DOZEN + d, 'out dozen', `${2 + d * 4} / span 4`, '2', label, '3倍'); });
    html += '<div class="corner" style="grid-row:14;grid-column:1 / 3">たて1列 →</div>';
    for (let c = 0; c < 3; c++) html += cell(S.COLUMN + c, 'out column', '14', String(3 + c), '↑この列', '3倍');
    return `<div class="${tableClass(m)}">${html}</div>`;
  }
  /**
   * container の中のテーブルを m の内容にする。2 回目からは作り直さず、変わったところだけ書きかえる
   * (ほかの人の賭けが届くたびに作り直すと、押している最中のボタンが消えてタップを取りこぼす)。
   */
  function renderTable(container, m = {}) {
    const root = container.firstElementChild;
    if (!root || !root.classList.contains('rtable')) { container.innerHTML = tableHtml(m); return; }
    const cls = tableClass(m);
    if (root.className !== cls) root.className = cls;
    for (const btn of root.querySelectorAll('[data-spot]')) {
      const st = cellState(Number(btn.dataset.spot), btn.dataset.base, m);
      if (btn.className !== st.cls) btn.className = st.cls;
      const box = btn.lastElementChild;
      if (box.__last !== st.chips && box.innerHTML !== st.chips) box.innerHTML = st.chips;
      box.__last = st.chips;
      if (btn.disabled !== !m.interactive) btn.disabled = !m.interactive;
    }
  }

  // ---------- 音(Web Audio。ファイルは使わない) ----------
  /** 無音の WAV(data URI)。iPhone の消音スイッチが入っていても鳴るよう、裏で流し続ける用。 */
  function silentWav(seconds) {
    const rate = 8000;
    const n = Math.floor(rate * seconds);
    const bytes = new Uint8Array(44 + n);
    const dv = new DataView(bytes.buffer);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true); dv.setUint32(28, rate, true);
    dv.setUint16(32, 1, true); dv.setUint16(34, 8, true); str(36, 'data'); dv.setUint32(40, n, true);
    bytes.fill(0x80, 44);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return 'data:audio/wav;base64,' + btoa(bin);
  }

  function createSounds() {
    let ctx = null;
    let muted = false;
    let unlocked = false;
    let keepAlive = false;
    let loopEl = null;
    const readyCbs = [];
    const isReady = () => !!ctx && ctx.state === 'running';
    const notify = () => { const r = isReady(); for (const f of readyCbs) { try { f(r); } catch { /* 画面側の都合 */ } } };
    const ac = () => {
      try {
        if (!ctx) {
          ctx = new (window.AudioContext || window.webkitAudioContext)();
          if (typeof ctx.addEventListener === 'function') ctx.addEventListener('statechange', notify);
        }
        return ctx;
      } catch { return null; }
    };
    const tryResume = (c) => { let p; try { p = c.resume(); } catch { p = null; } return Promise.resolve(p); };
    /** 鳴らす直前の保険: 眠っていたら起こし、300ms 以内に起きたときだけ鳴らす(あとでまとめて鳴らさない)。 */
    function ensure(fn) {
      if (muted) return;
      const c = ac(); if (!c) return;
      if (c.state === 'running') { fn(c); return; }
      let late = false;
      const timer = setTimeout(() => { late = true; }, 300);
      tryResume(c).then(() => { clearTimeout(timer); if (!late && c.state === 'running' && !muted) fn(c); notify(); }, () => {});
    }
    function startLoop() {
      if (typeof window === 'undefined' || typeof window.Audio !== 'function') return;
      try {
        if (!loopEl) {
          loopEl = new window.Audio();
          loopEl.loop = true;
          loopEl.setAttribute('playsinline', '');
          loopEl.src = silentWav(0.5);
        }
        if (loopEl.paused !== false) { const p = loopEl.play(); if (p && p.catch) p.catch(() => {}); }
      } catch { /* 再生できなければ次の操作で */ }
    }
    function stopLoop() { if (loopEl) { try { loopEl.pause(); } catch { /* 無視 */ } } }
    function toneAt(c, freq, at, dur, vol, type = 'triangle') {
      const t = c.currentTime + at;
      const o = c.createOscillator(); o.type = type; o.frequency.value = freq;
      const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.012); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.03);
    }
    function noiseAt(c, dur, freq, q, vol) {
      const len = Math.max(1, Math.floor(c.sampleRate * dur));
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
      const src = c.createBufferSource(); src.buffer = buf;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
      const g = c.createGain(); g.gain.value = vol;
      src.connect(bp).connect(g).connect(c.destination); src.start();
    }
    return {
      /** 音を使えるようにする。最初のタップ・キー操作の中で呼ぶ(ブラウザは一度触るまで音を出さない)。 */
      unlock() {
        const c = ac();
        if (c) { unlocked = true; if (c.state !== 'running') tryResume(c).then(notify, () => {}); }
        if (keepAlive) startLoop();
      },
      get ready() { return isReady(); },
      get muted() { return muted; },
      onReadyChange(cb) { if (typeof cb === 'function') readyCbs.push(cb); },
      setMuted(b) { muted = !!b; },
      /** 無音を流し続けて、iPhone の消音スイッチが入っていても鳴るようにする(その間、聴いていた音楽は止まる)。 */
      setKeepAlive(b) { keepAlive = !!b; if (keepAlive) { if (unlocked) startLoop(); } else stopLoop(); },
      /** 玉が走る「コロコロ」。slow(0〜1)が大きいほど低く。 */
      roll(slow = 0) { ensure((c) => noiseAt(c, 0.03, 3200 - slow * 1400, 2.2, 0.32)); },
      /** 玉がマスの仕切りではねる「カチッ」。 */
      clack(vol = 1) { ensure((c) => { noiseAt(c, 0.05, 2200, 1.3, 0.6 * vol); toneAt(c, 1900, 0, 0.05, 0.14 * vol, 'square'); }); },
      /** 回り始めの「シュッ」。 */
      whoosh() {
        ensure((c) => {
          const t = c.currentTime;
          const o = c.createOscillator(); o.type = 'sawtooth';
          o.frequency.setValueAtTime(180, t); o.frequency.exponentialRampToValueAtTime(1100, t + 0.45);
          const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400;
          const g = c.createGain(); g.gain.setValueAtTime(0.16, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
          o.connect(lp).connect(g).connect(c.destination); o.start(t); o.stop(t + 0.55);
        });
      },
      /** 当たりのファンファーレ。 */
      fanfare() {
        ensure((c) => {
          [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => toneAt(c, f, i * 0.11, 0.22, 0.2));
          [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f) => { toneAt(c, f, 0.48, 0.9, 0.11); toneAt(c, f * 2, 0.48, 0.5, 0.03, 'square'); });
          noiseAt(c, 0.25, 6000, 0.7, 0.18);
        });
      },
      /** 結果が出た合図(当たりでも はずれでもない人・配信者の画面)。 */
      ding() { ensure((c) => { toneAt(c, 1046.5, 0, 0.5, 0.18); toneAt(c, 1568, 0.02, 0.6, 0.1); }); },
      /** はずれ。 */
      lose() { ensure((c) => { toneAt(c, 392, 0, 0.22, 0.16); toneAt(c, 311.1, 0.2, 0.4, 0.16); }); },
      /** チップを置く「チャリ」。 */
      chip() { ensure((c) => { noiseAt(c, 0.04, 5200, 3, 0.4); toneAt(c, 2637, 0.01, 0.07, 0.07); }); },
    };
  }

  // ---------- 盤(画面の部品) ----------
  /**
   * container の中に盤を作る。
   *   rest(spin, { win }): 止まっている姿を描く(spin が無ければ玉は出さない。win=true で出たマスを囲む)
   *   spin(spin, { quick }): 回す。止まったら解決する Promise を返す(途中で次の spin / stop が来たらそこで終わる)
   */
  function create(container, sounds) {
    container.innerHTML = '<div class="wheel-wrap"><div class="rays"></div><div class="rim"></div><div class="wheel-rot"></div><div class="ball-layer"></div></div>';
    const wrap = container.firstChild;
    const rot = wrap.querySelector('.wheel-rot');
    wrap.querySelector('.rim').innerHTML = rimSvg();
    wrap.querySelector('.ball-layer').innerHTML = ballSvg();
    const ball = wrap.querySelector('.ball');
    let drawnWin; // undefined: まだ描いていない
    let current = null;

    function draw(win) {
      if (win !== drawnWin) { drawnWin = win; rot.innerHTML = wheelSvg(win); }
    }
    function place(p) {
      rot.style.transform = `rotate(${p.wheel}deg)`;
      ball.setAttribute('transform', `translate(${pt(p.r, p.ball)})`);
      ball.setAttribute('visibility', 'visible');
    }
    function stop() { if (current) current.finish(); }

    function rest(spinRec, opts = {}) {
      if (current) return; // 回っている間は触らない
      draw(spinRec && opts.win ? spinRec.n : null);
      wrap.classList.toggle('done', !!(spinRec && opts.win));
      wrap.dataset.n = spinRec ? String(spinRec.n) : '';
      if (spinRec) place(L.pose(spinRec, spinRec.ms));
      else { rot.style.transform = 'rotate(0deg)'; ball.setAttribute('visibility', 'hidden'); }
    }

    function spin(spinRec, opts = {}) {
      stop();
      const rec = opts.quick ? { ...spinRec, ms: 320 } : spinRec;
      draw(null);
      wrap.classList.remove('done');
      wrap.classList.add('spinning');
      wrap.dataset.n = '';
      sounds.whoosh();
      return new Promise((resolve) => {
        const t0 = performance.now();
        let lastPocket = Math.floor(rec.r0 / L.POCKET);
        let lastSound = 0;
        let raf = 0;
        let timer = 0;
        let done = false;
        let wasSettled = false;
        const finish = () => {
          if (done) return;
          done = true;
          cancelAnimationFrame(raf);
          clearTimeout(timer);
          place(L.pose(rec, rec.ms));
          wrap.classList.remove('spinning', 'tense');
          wrap.dataset.n = String(rec.n);
          current = null;
          resolve();
        };
        const frame = (now) => {
          if (done) return;
          const el = now - t0;
          if (el >= rec.ms) { finish(); return; }
          const p = L.pose(rec, el);
          place(p);
          const pocket = Math.floor(p.rel / L.POCKET);
          if (pocket !== lastPocket) {
            lastPocket = pocket;
            if (now - lastSound > 45) {
              lastSound = now;
              if (p.r < L.R_TRACK - 1) sounds.clack(0.5 + 0.5 * (el / rec.ms)); // マスの上ではねる
              else sounds.roll(el / rec.ms);
            }
          }
          if (p.settled && !wasSettled) { wasSettled = true; sounds.clack(1); }
          wrap.classList.toggle('tense', p.r < L.R_TRACK - 1 && !p.settled);
          raf = requestAnimationFrame(frame);
        };
        current = { finish };
        place(L.pose(rec, 0));
        raf = requestAnimationFrame(frame);
        timer = setTimeout(finish, rec.ms + 500); // 裏のタブなどで描画が止まっていても必ず終わる
      });
    }

    return { rest, spin, stop, get spinning() { return !!current; }, el: wrap };
  }

  return { wheelSvg, rimSvg, tableHtml, renderTable, shortAmount, silentWav, createSounds, create, FILL };
})();
if (typeof module !== 'undefined') module.exports = RouletteWheel;
