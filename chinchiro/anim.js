// ===== サイコロの場面(器に3つ投げる)と音 =====
// 演出の乱数は throwObj.seed だけから作るので、全端末で同じ映像になる。
const ChinchiroAnim = (() => {
  'use strict';

  const PIPS = { 1: [[2, 2]], 2: [[1, 3], [3, 1]], 3: [[1, 3], [2, 2], [3, 1]], 4: [[1, 1], [1, 3], [3, 1], [3, 3]],
    5: [[1, 1], [1, 3], [2, 2], [3, 1], [3, 3]], 6: [[1, 1], [1, 3], [2, 1], [2, 3], [3, 1], [3, 3]] };
  // 面 F を正面に向ける回転(度)。面の配置: 1=前 6=後 2=右 5=左 3=上 4=下
  const FINAL_ROT = { 1: [0, 0], 6: [0, 180], 2: [0, -90], 5: [0, 90], 3: [-90, 0], 4: [90, 0] };
  const FLOOR = { cx: 240, cy: 160, rx: 150, ry: 42 }; // 器の底(テーブル座標)
  const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function mulberry32(seed) {
    let a = (Number(seed) || 0) >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function validDice(d) {
    return Array.isArray(d) && d.length === 3 && d.every((x) => Number.isInteger(x) && x >= 1 && x <= 6);
  }

  // ---------- 音(その場で合成) ----------
  function createSounds() {
    let ctx = null;
    let muted = false;
    let unlocked = false;
    const ac = () => {
      try {
        ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
      } catch { return null; }
    };
    function noise(dur, freq, q, vol) {
      const c = ac(); if (!c || muted) return;
      const len = Math.floor(c.sampleRate * dur);
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
      const src = c.createBufferSource(); src.buffer = buf;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
      const g = c.createGain(); g.gain.value = vol;
      src.connect(bp).connect(g).connect(c.destination); src.start();
    }
    function tone(freq, dur, vol, type = 'triangle') {
      const c = ac(); if (!c || muted) return;
      const t = c.currentTime;
      const o = c.createOscillator(); o.type = type; o.frequency.value = freq;
      const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
    }
    return {
      /** iOS Safari 対策: ユーザー操作の中で AudioContext を作って起こす。 */
      unlock() { const c = ac(); if (c) unlocked = true; },
      get unlocked() { return unlocked; },
      clack(vol = 1) { noise(0.06, 2000 + Math.random() * 800, 1.5, 0.55 * vol); tone(2500 + Math.random() * 500, 0.09, 0.16 * vol); },
      rattle(ms = 600) { const n = Math.floor(ms / 70); for (let i = 0; i < n; i++) setTimeout(() => noise(0.03, 3000, 2, 0.22), i * 70 + Math.random() * 25); },
      chime(kind) {
        const seq = kind === 'gold' ? [880, 1108, 1318, 1760, 2217] : kind === 'rainbow' ? [659, 784, 988, 1175] : [523, 659, 784];
        seq.forEach((f, i) => setTimeout(() => tone(f, 0.5, 0.18, 'sine'), i * 90));
      },
      thud() { tone(110, 0.3, 0.35, 'sine'); noise(0.12, 300, 0.8, 0.35); },
      thunder() { noise(0.7, 140, 0.4, 0.8); tone(55, 0.7, 0.45, 'sawtooth'); },
      roll() { tone(520, 0.12, 0.12, 'square'); setTimeout(() => tone(660, 0.12, 0.12, 'square'), 90); },
      setMuted(b) { muted = !!b; },
      get muted() { return muted; },
    };
  }

  // ---------- 場面 ----------
  function createDiceStage(root, sounds) {
    root.classList.add('stage');
    root.innerHTML = `
      <div class="thrower"><span class="avatar lg" data-char=""></span><div class="bubble"></div><div class="hand"><i class="mini"></i><i class="mini"></i><i class="mini"></i></div></div>
      <div class="scaler"><div class="table">
        <div class="bowl-back"></div>
        <div class="dice-layer"></div>
        <div class="bowl-front"></div>
        <div class="fx-layer"></div>
        <div class="result-stamp" data-hand=""></div>
      </div></div>
      <div class="hint">タップで飛ばす</div>`;
    const el = {
      avatar: root.querySelector('.avatar'), bubble: root.querySelector('.bubble'), hand: root.querySelector('.hand'),
      scaler: root.querySelector('.scaler'), table: root.querySelector('.table'), dice: root.querySelector('.dice-layer'),
      fx: root.querySelector('.fx-layer'), stamp: root.querySelector('.result-stamp'),
    };
    let running = null; // { anims: Animation[], timers: number[], skipped, resolveSkip }

    function fit() {
      const w = root.clientWidth || 480;
      const s = Math.min(1, w / 480);
      el.scaler.style.transform = `scale(${s})`;
      el.scaler.style.height = `${300 * s}px`;
    }
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(root);
    fit();

    function renderPips(face, n) {
      face.innerHTML = '';
      for (const [r, c] of PIPS[n]) {
        const pip = document.createElement('span');
        pip.className = 'pip';
        pip.style.gridArea = `${r} / ${c}`;
        face.appendChild(pip);
      }
    }
    function makeDie() {
      const wrap = document.createElement('div');
      wrap.className = 'die-wrap';
      wrap.innerHTML = '<div class="cube-tilt"><div class="cube"></div></div>';
      const cube = wrap.querySelector('.cube');
      for (let f = 1; f <= 6; f++) {
        const face = document.createElement('div');
        face.className = `face f${f}`;
        renderPips(face, f);
        cube.appendChild(face);
      }
      const shadow = document.createElement('div');
      shadow.className = 'cube-shadow';
      return { wrap, cube, shadow };
    }

    function reset() {
      if (running) { for (const a of running.anims) a.cancel(); for (const t of running.timers) clearTimeout(t); running = null; }
      el.dice.innerHTML = '';
      el.fx.innerHTML = '';
      el.stamp.textContent = '';
      el.stamp.dataset.hand = '';
      el.table.className = 'table';
      el.hand.classList.remove('rattle');
      root.classList.remove('playing');
    }

    function setThrower(t) {
      if (t && t.char && typeof SugorokuArt !== 'undefined' && Object.hasOwn(SugorokuArt.CHAR_ART, t.char)) {
        el.avatar.innerHTML = SugorokuArt.CHAR_ART[t.char]();
        el.avatar.dataset.char = t.char;
        el.avatar.style.setProperty('--c', t.color || '#2b2d5c');
        el.avatar.hidden = false;
      } else {
        el.avatar.hidden = true;
      }
      el.bubble.textContent = t && t.name ? `${t.name} さんが振る!` : '';
    }

    // 待ち。skip() されたら即座に起こす
    const sleep = (ms) => new Promise((r) => {
      const run = running;
      const id = setTimeout(r, ms);
      if (run) { run.timers.push(id); run.wakers.push(r); }
    });
    const pointIn = (rnd, rmin, rmax) => {
      const a = rnd() * Math.PI * 2;
      const r = rmin + rnd() * (rmax - rmin);
      return { x: Math.cos(a) * FLOOR.rx * r, y: Math.sin(a) * FLOOR.ry * r };
    };
    function landingSpots(rnd) {
      const spots = [];
      for (let i = 0; i < 3; i++) {
        let p = pointIn(rnd, 0.15, 0.85);
        for (let k = 0; k < 60; k++) {
          if (spots.every((q) => Math.hypot(q.x - p.x, (q.y - p.y) * 2.0) >= 84)) break;
          p = pointIn(rnd, 0.15, 0.9);
        }
        spots.push(p);
      }
      return spots;
    }

    /** 1つのサイコロの軌道(テーブル座標。器の底中心が原点)。 */
    function pathFor(rnd, i, land, out) {
      const start = { x: -300 + i * 18, y: -250 - i * 10 };
      if (!out) {
        const p1 = pointIn(rnd, 0.5, 0.95);
        const p2 = pointIn(rnd, 0.3, 0.9);
        const p3 = { x: (p2.x + land.x) / 2 + (rnd() - 0.5) * 30, y: (p2.y + land.y) / 2 + (rnd() - 0.5) * 12 };
        return [
          { p: start, h: 0, off: 0 },
          { p: p1, h: 0, off: 0.26 }, { p: mid(p1, p2), h: 95, off: 0.37 },
          { p: p2, h: 0, off: 0.48 }, { p: mid(p2, p3), h: 50, off: 0.58 },
          { p: p3, h: 0, off: 0.68 }, { p: mid(p3, land), h: 22, off: 0.76 },
          { p: land, h: 0, off: 0.86 }, { p: land, h: 6, off: 0.92 }, { p: land, h: 0, off: 1 },
        ];
      }
      // ションベン: 縁で跳ねて外へ飛び出し、机を転がって画面外へ
      const rim = { x: 120 + rnd() * 30, y: -30 };
      return [
        { p: start, h: 0, off: 0 },
        { p: rim, h: 0, off: 0.26 }, { p: { x: 230, y: 40 }, h: 80, off: 0.40 },
        { p: { x: 300, y: 125 }, h: 0, off: 0.55 }, { p: { x: 360, y: 150 }, h: 26, off: 0.66 },
        { p: { x: 420, y: 175 }, h: 0, off: 0.78 }, { p: { x: 520, y: 200 }, h: 0, off: 1 },
      ];
    }
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

    function buildFrames(path, face, rnd, out) {
      const [fx, fy] = FINAL_ROT[face] || [0, 0];
      const wrapF = []; const cubeF = []; const shadowF = [];
      let rx = rnd() * 360; let ry = rnd() * 360;
      const n = path.length;
      path.forEach((k, idx) => {
        const easing = k.h > 0 ? 'ease-in' : 'ease-out';
        wrapF.push({ transform: `translate(${k.p.x}px, ${k.p.y - k.h}px)`, offset: k.off, easing, opacity: out && idx === n - 1 ? 0 : 1 });
        const last = idx >= n - 2 && !out;
        if (!last) { rx += 120 + rnd() * 160; ry += 140 + rnd() * 200; }
        const rot = last ? `rotateX(${fx + 1080}deg) rotateY(${fy + 1440}deg)` : `rotateX(${rx}deg) rotateY(${ry}deg)`;
        cubeF.push({ transform: rot, offset: k.off, easing: 'linear' });
        const s = Math.max(0.35, 1 - k.h / 150);
        shadowF.push({ transform: `translate(${k.p.x}px, ${k.p.y}px) scale(${s})`, opacity: out && idx === n - 1 ? 0 : 0.12 + 0.28 * s, offset: k.off, easing });
      });
      return { wrapF, cubeF, shadowF };
    }

    function fxFlash(kind, ms = 700) {
      const f = document.createElement('div'); f.className = `flash ${kind}`; el.fx.appendChild(f);
      f.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, fill: 'forwards' });
    }
    function fxRing(kind) {
      const r = document.createElement('div'); r.className = `ring ${kind}`; el.fx.appendChild(r);
      r.animate([{ transform: 'scale(.2)', opacity: 1 }, { transform: 'scale(3.2)', opacity: 0 }], { duration: 900, easing: 'ease-out', fill: 'forwards' });
    }
    function fxParticles(rnd, n, colors, star) {
      for (let i = 0; i < n; i++) {
        const p = document.createElement('i');
        p.className = 'particle' + (star ? ' star' : '');
        p.style.background = colors[i % colors.length];
        el.fx.appendChild(p);
        const a = rnd() * Math.PI * 2; const d = 90 + rnd() * 160;
        p.animate([
          { transform: 'translate(0,0) rotate(0deg) scale(1)', opacity: 1 },
          { transform: `translate(${Math.cos(a) * d}px, ${Math.sin(a) * d * 0.7 + 40}px) rotate(${rnd() * 720}deg) scale(.4)`, opacity: 0 },
        ], { duration: 800 + rnd() * 500, easing: 'cubic-bezier(.2,.8,.4,1)', fill: 'forwards' });
      }
    }

    function stampFor(hand, remaining) {
      if (!hand) return { text: remaining > 0 ? `目なし… あと${remaining}投` : '目なし…', key: 'none' };
      switch (hand.type) {
        case 'pinzoro': return { text: 'ピンゾロ!!', key: 'pinzoro' };
        case 'zoro': return { text: `${hand.value}ゾロ!`, key: 'zoro' };
        case 'shigoro': return { text: 'シゴロ!', key: 'shigoro' };
        case 'me': return { text: `${hand.value}の目`, key: 'me' };
        case 'hifumi': return { text: 'ヒフミ…', key: 'hifumi' };
        case 'shonben': return { text: 'ションベン!', key: 'shonben' };
        default: return { text: remaining > 0 ? `目なし… あと${remaining}投` : '目なし…', key: 'none' };
      }
    }

    function showResult(throwObj, opts, dies, rnd, skipped) {
      const { text, key } = stampFor(throwObj.shonben ? { type: 'shonben' } : throwObj.hand, opts.remaining ?? 0);
      el.stamp.textContent = text;
      el.stamp.dataset.hand = key;
      if (skipped) return;
      const colors = ['#ffd93d', '#ff4d4d', '#2ec27e', '#3b8cff', '#b56cff', '#fff'];
      switch (key) {
        case 'pinzoro': fxFlash('gold', 900); fxParticles(rnd, 28, ['#ffd93d', '#ffe978', '#fff', '#ff9f1c'], true); sounds.chime('gold'); break;
        case 'zoro': fxRing('rainbow'); fxParticles(rnd, 14, colors, true); sounds.chime('rainbow'); break;
        case 'shigoro': fxFlash('blue', 600); fxParticles(rnd, 14, ['#8ed0ff', '#fff', '#3b8cff'], false); sounds.chime('blue'); break;
        case 'me': {
          const d = throwObj.dice; const odd = d[0] === d[1] ? 2 : d[0] === d[2] ? 1 : 0;
          if (dies[odd]) dies[odd].cube.classList.add('pulse');
          sounds.roll(); break;
        }
        case 'none': sounds.thud(); break;
        case 'hifumi': el.table.classList.add('dark'); sounds.thunder(); break;
        case 'shonben': sounds.thud(); break;
        default: break;
      }
    }

    /** 投げる。opts: { thrower:{name,char,color}, remaining, reduced }。タップで skip。 */
    async function play(throwObj, opts = {}) {
      reset();
      setThrower(opts.thrower);
      root.classList.add('playing');
      const run = { anims: [], timers: [], wakers: [], skipped: false };
      running = run;
      const dice = throwObj && throwObj.dice;
      if (!validDice(dice)) { // 壊れたデータ: 演出せず「?」を少し見せる
        el.stamp.textContent = '?';
        el.stamp.dataset.hand = 'invalid';
        await sleep(800);
        if (run !== running) return;
        root.classList.remove('playing');
        running = null;
        return;
      }
      const rnd = mulberry32(throwObj.seed);
      const reduced = opts.reduced || reducedMotion();
      const outIdx = throwObj.shonben ? Math.floor(rnd() * 3) : -1;
      const spots = landingSpots(rnd);
      const dies = [];
      for (let i = 0; i < 3; i++) {
        const d = makeDie();
        el.dice.appendChild(d.shadow);
        el.dice.appendChild(d.wrap);
        d.wrap.style.transform = 'translate(-300px, -250px)';
        d.shadow.style.opacity = '0';
        dies.push(d);
      }
      // 構え(手の中でカラカラ)
      if (!reduced) {
        el.hand.classList.add('rattle');
        sounds.rattle(550);
        await sleep(550);
        if (run !== running) return;
        el.hand.classList.remove('rattle');
      }
      // 投げ込み〜跳ねる〜止まる(飛ばされていたら一瞬で終える)
      const quick = reduced || run.skipped;
      const D = quick ? 1 : 1500;
      const decider = throwObj.hand && (throwObj.hand.type === 'me' || throwObj.hand.type === 'zoro' || throwObj.hand.type === 'pinzoro') && outIdx < 0 ? 2 : -1;
      const finished = [];
      dies.forEach((d, i) => {
        const out = i === outIdx;
        const path = pathFor(rnd, i, spots[i], out);
        const { wrapF, cubeF, shadowF } = buildFrames(path, dice[i], rnd, out);
        const delay = quick ? 0 : i * 90;
        const o = { duration: D, delay, fill: 'forwards' };
        const a1 = d.wrap.animate(wrapF, o); const a2 = d.cube.animate(cubeF, o); const a3 = d.shadow.animate(shadowF, o);
        run.anims.push(a1, a2, a3);
        finished.push(a1.finished.catch(() => {}));
        if (!quick) {
          for (const k of path) {
            if (k.h === 0 && k.off > 0 && k.off < 1) run.timers.push(setTimeout(() => {
              sounds.clack(1 - k.off * 0.6);
              if (k.off < 0.5) { el.table.classList.add('shake'); setTimeout(() => el.table.classList.remove('shake'), 200); }
            }, delay + D * k.off));
          }
          if (out) run.timers.push(setTimeout(() => { d.wrap.classList.add('out'); d.cube.classList.add('out'); el.fx.appendChild(d.wrap); }, delay + D * 0.42));
          if (i === decider) run.timers.push(setTimeout(() => {
            if (run.skipped) return;
            for (const a of [a1, a2, a3]) a.playbackRate = 0.4;
            el.table.classList.add('zoom');
          }, delay + D * 0.68));
        }
      });
      await Promise.all(finished);
      if (run !== running) return;
      el.table.classList.remove('zoom');
      dies.forEach((d, i) => { d.cube.dataset.face = dice[i]; if (i === outIdx) { d.wrap.classList.add('out'); d.cube.classList.add('out'); } });
      showResult(throwObj, opts, dies, rnd, run.skipped || quick);
      await sleep(run.skipped || quick ? 250 : 1100);
      if (run === running) { root.classList.remove('playing'); running = null; }
    }

    function skip() {
      if (!running) return;
      running.skipped = true;
      for (const t of running.timers) clearTimeout(t);
      running.timers = [];
      for (const w of running.wakers) w();
      running.wakers = [];
      el.hand.classList.remove('rattle');
      el.table.classList.remove('zoom');
      for (const a of running.anims) { a.playbackRate = 1; try { a.finish(); } catch { /* 未開始なら無視 */ } }
    }

    /** 「振る」を押してから親機の返事が来るまでの待ち: 手の中でカラカラ。 */
    function showWaiting(thrower) {
      reset();
      setThrower(thrower);
      el.bubble.textContent = `${thrower && thrower.name ? thrower.name + ' さんが' : ''}振っています…`;
      el.hand.classList.add('rattle');
      root.classList.add('playing');
      sounds.rattle(600);
    }

    root.addEventListener('click', skip);
    return { play, skip, reset, showWaiting, el };
  }

  /** 数字を from から to まで動かして見せる(点数のカウントアップ)。 */
  function countUp(el, from, to, ms = 600) {
    const start = performance.now();
    const f = Number(from) || 0;
    const t = Number(to) || 0;
    if (ms <= 0 || f === t) { el.textContent = String(t); return; }
    const step = (now) => {
      const k = Math.min(1, (now - start) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = String(Math.round(f + (t - f) * e));
      if (k < 1) requestAnimationFrame(step);
      else el.textContent = String(t);
    };
    el.textContent = String(f);
    requestAnimationFrame(step);
  }

  return { createSounds, createDiceStage, countUp, mulberry32, FINAL_ROT, PIPS };
})();
if (typeof module !== 'undefined') module.exports = ChinchiroAnim;
