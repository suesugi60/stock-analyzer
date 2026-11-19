// ===== 盤の絵・回る演出・音 =====
// 盤(SVG)は RouletteLogic の角度の決まりどおりに描く: 針は右(3時)、0 度から時計回りに項目が並ぶ。
// 文字は中心から外へ向かって書くので、針の位置(右)に来た項目は横書きでそのまま読める。
const RouletteWheel = (() => {
  'use strict';
  const L = (typeof module !== 'undefined' && module.exports) ? require('./logic.js') : RouletteLogic;

  const R = 96;          // 盤の半径(SVG の単位)
  const LABEL_OUT = 90;  // 文字の外側の端
  const LABEL_IN = 22;   // 文字がここより内側に入らない(中心の飾りに隠れる)
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const rad = (deg) => (deg * Math.PI) / 180;
  const f2 = (n) => Number(n.toFixed(2));

  /** 文字の幅(全角を 1 として)。半角英数は細い。 */
  function emWidth(label) {
    let w = 0;
    for (const ch of Array.from(String(label))) w += ch.codePointAt(0) < 0x2000 ? 0.6 : 1;
    return Math.max(w, 0.6);
  }
  /** 扇形(sweep 度)に収まる文字の大きさ。長い・細いほど小さくなる。 */
  function labelSize(label, sweep) {
    const em = emWidth(label);
    let size = Math.min(13, (LABEL_OUT - LABEL_IN) / em);
    for (let i = 0; i < 40; i++) {
      const inner = LABEL_OUT - em * size;
      const room = sweep >= 180 ? Infinity : 2 * inner * Math.sin(rad(sweep) / 2);
      if (size * 1.15 <= room) break;
      size *= 0.92;
    }
    return f2(Math.max(size, 1.5));
  }

  /**
   * 盤の SVG(文字列)。segs: [{ t, w }]、win: 当たった項目の番号(無ければ -1)、empty: 項目が無いときの案内。
   */
  function wheelSvg(segs, opts = {}) {
    const win = Number.isInteger(opts.win) ? opts.win : -1;
    const n = segs.length;
    const head = '<svg viewBox="-112 -112 224 224" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">';
    if (n === 0) {
      return `${head}<circle r="${R}" fill="#fff0f6" stroke="#fff" stroke-width="2"/>` +
        `<text x="0" y="-34" text-anchor="middle" font-size="11" font-weight="900" fill="#a56a88">${esc(opts.empty || '')}</text></svg>`;
    }
    const b = L.segBounds(segs);
    const line = n > 60 ? 0.3 : n > 30 ? 0.7 : 1.6;
    let wedges = '';
    let labels = '';
    let ring = ''; // 当たった項目を囲む線(うすい色の項目でも、どれが当たりか分かるように)
    for (let i = 0; i < n; i++) {
      const a0 = b[i];
      const a1 = b[i + 1];
      const color = L.COLORS[L.colorIndex(i, n)];
      const cls = win < 0 ? 'seg' : i === win ? 'seg win' : 'seg dim';
      if (n === 1) {
        wedges += `<circle class="${cls}" data-i="0" r="${R}" fill="${color}" stroke="#fff" stroke-width="${line}"/>`;
      } else {
        const x0 = f2(R * Math.cos(rad(a0))), y0 = f2(R * Math.sin(rad(a0)));
        const x1 = f2(R * Math.cos(rad(a1))), y1 = f2(R * Math.sin(rad(a1)));
        const d = `M0 0L${x0} ${y0}A${R} ${R} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}Z`;
        wedges += `<path class="${cls}" data-i="${i}" d="${d}" fill="${color}" stroke="#fff" stroke-width="${line}" stroke-linejoin="round"/>`;
        if (i === win) ring = `<path class="win-ring" d="${d}" fill="none" stroke="#ff2e88" stroke-width="${n > 30 ? 1.5 : 3.5}" stroke-linejoin="round"/>`;
      }
      const size = labelSize(segs[i].t, a1 - a0);
      const mid = f2((a0 + a1) / 2);
      labels += `<text class="${win >= 0 && i !== win ? 'lbl dim' : 'lbl'}" transform="rotate(${mid})" x="${LABEL_OUT}" y="0" dy="0.35em" text-anchor="end" font-size="${size}" stroke-width="${f2(size * 0.24)}">${esc(segs[i].t)}</text>`;
    }
    return `${head}<g class="segs">${wedges}</g>${ring}<g class="lbls" font-weight="900" fill="#fff" stroke="#8a1e55" stroke-linejoin="round" paint-order="stroke">${labels}</g></svg>`;
  }

  /** ふち(電球つき)。回らない。 */
  function rimSvg() {
    let bulbs = '';
    const N = 24;
    for (let i = 0; i < N; i++) {
      const a = rad((360 / N) * i + 7.5);
      bulbs += `<circle class="bulb ${i % 2 ? 'b' : 'a'}" cx="${f2(101.5 * Math.cos(a))}" cy="${f2(101.5 * Math.sin(a))}" r="3.4"/>`;
    }
    return '<svg viewBox="-112 -112 224 224" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<defs><linearGradient id="rl-rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9cc6"/><stop offset=".5" stop-color="#ff4c95"/><stop offset="1" stop-color="#ff7fb3"/></linearGradient></defs>' +
      `<circle r="109" fill="#fff"/><circle r="107" fill="url(#rl-rim)"/><circle r="97.6" fill="#fff"/>${bulbs}</svg>`;
  }
  /** 中心の飾り。回らない。 */
  function hubSvg() {
    return '<svg viewBox="-112 -112 224 224" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<circle r="18" fill="#ff4c95"/><circle r="15.5" fill="#fff"/>' +
      '<path d="M0 8.5C-11 0.5 -9.5 -8.5 -4.2 -8.5C-1.6 -8.5 0 -6.4 0 -4.8C0 -6.4 1.6 -8.5 4.2 -8.5C9.5 -8.5 11 0.5 0 8.5Z" fill="#ff2e88"/>' +
      '<circle cx="-4.3" cy="-4.6" r="1.5" fill="#fff" opacity=".85"/></svg>';
  }
  /** 針(右から中心を向く三角)。 */
  function pointerSvg() {
    return '<svg viewBox="0 0 30 26" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2.5 13L26 3Q29 13 26 23Z" fill="#ff2e88" stroke="#fff" stroke-width="3" stroke-linejoin="round"/><circle cx="22" cy="13" r="2.6" fill="#fff"/></svg>';
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
      /** 針が項目の境目をはじく「カチッ」。slow(0〜1)が大きいほど低く重く。 */
      tick(slow = 0) { ensure((c) => { noiseAt(c, 0.035, 2600 - slow * 900, 1.4, 0.55); toneAt(c, 1500 - slow * 500, 0, 0.04, 0.12, 'square'); }); },
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
      /** 結果のファンファーレ。 */
      fanfare() {
        ensure((c) => {
          [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => toneAt(c, f, i * 0.11, 0.22, 0.2));
          [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f) => { toneAt(c, f, 0.48, 0.9, 0.11); toneAt(c, f * 2, 0.48, 0.5, 0.03, 'square'); });
          noiseAt(c, 0.25, 6000, 0.7, 0.18);
        });
      },
      /** 「あなたの番」の知らせ。 */
      chime() { ensure((c) => { toneAt(c, 880, 0, 0.18, 0.2); toneAt(c, 1174.7, 0.14, 0.3, 0.2); }); },
    };
  }

  // ---------- 盤(画面の部品) ----------
  /**
   * container の中に盤を作る。
   *   setWheel(segs, { rotation, win, empty }): 止まっている盤を描く(同じ内容なら描き直さない)
   *   spin(spin, { quick }): 回す。止まったら解決する Promise を返す(途中で次の spin / stop が来たらそこで終わる)
   */
  function create(container, sounds) {
    container.innerHTML =
      '<div class="wheel-wrap"><div class="rays"></div><div class="rim"></div><div class="wheel-rot"></div><div class="hub"></div><div class="pointer"></div></div>';
    const wrap = container.firstChild;
    const rot = wrap.querySelector('.wheel-rot');
    const pointer = wrap.querySelector('.pointer');
    wrap.querySelector('.rim').innerHTML = rimSvg();
    wrap.querySelector('.hub').innerHTML = hubSvg();
    pointer.innerHTML = pointerSvg();
    let drawnKey = null;
    let current = null; // 回っている最中の { finish }
    let flapAnim = null;

    const setRotation = (deg) => { rot.style.transform = `rotate(${deg}deg)`; rot.dataset.deg = String(Math.round(deg * 100) / 100); };
    function draw(segs, win, empty) {
      const key = JSON.stringify([segs.map((s) => [s.t, s.w]), win, empty || '']);
      if (key !== drawnKey) { drawnKey = key; rot.innerHTML = wheelSvg(segs, { win, empty }); }
      wrap.dataset.count = String(segs.length);
    }
    function flap() {
      if (typeof pointer.animate !== 'function') return;
      try { if (flapAnim) flapAnim.cancel(); flapAnim = pointer.animate([{ transform: 'translateY(-50%) rotate(-20deg)' }, { transform: 'translateY(-50%) rotate(0deg)' }], { duration: 130, easing: 'ease-out' }); } catch { /* 飾りなので無視 */ }
    }
    function stop() { if (current) current.finish(); }

    function setWheel(segs, opts = {}) {
      if (current) return; // 回っている間は触らない
      const win = Number.isInteger(opts.win) ? opts.win : -1;
      draw(segs, win, opts.empty);
      setRotation(segs.length ? (opts.rotation || 0) : 0);
      wrap.classList.toggle('done', win >= 0);
    }

    function spin(spinRec, opts = {}) {
      stop();
      const ms = opts.quick ? 160 : spinRec.ms;
      const rec = { from: spinRec.from, to: spinRec.to, ms };
      draw(spinRec.segs, -1, '');
      setRotation(rec.from);
      wrap.classList.remove('done');
      wrap.classList.add('spinning');
      sounds.whoosh();
      return new Promise((resolve) => {
        const t0 = performance.now();
        let lastIdx = L.indexAt(spinRec.segs, rec.from);
        let lastTick = 0;
        let raf = 0;
        let timer = 0;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          cancelAnimationFrame(raf);
          clearTimeout(timer);
          setRotation(rec.to);
          wrap.classList.remove('spinning', 'tense');
          current = null;
          resolve();
        };
        const frame = (now) => {
          if (done) return;
          const el = now - t0;
          if (el >= ms) { finish(); return; }
          const a = L.angleAt(rec, el);
          setRotation(a);
          const idx = L.indexAt(spinRec.segs, a);
          if (idx !== lastIdx) {
            lastIdx = idx;
            flap();
            if (now - lastTick > 40) { lastTick = now; sounds.tick(el / ms); }
          }
          wrap.classList.toggle('tense', el / ms > 0.7);
          raf = requestAnimationFrame(frame);
        };
        current = { finish };
        raf = requestAnimationFrame(frame);
        timer = setTimeout(finish, ms + 500); // 裏のタブなどで描画が止まっていても必ず終わる
      });
    }

    return { setWheel, spin, stop, get spinning() { return !!current; }, el: wrap };
  }

  return { wheelSvg, labelSize, emWidth, silentWav, createSounds, create };
})();
if (typeof module !== 'undefined') module.exports = RouletteWheel;
