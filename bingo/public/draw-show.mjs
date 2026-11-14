// 抽選機(ガラガラ)の演出。リスナー画面と主催者画面で共用する。
// 玉が中で跳ね回り、1つ転がり出て、番号が見える。画面をタップすると飛ばせる。
import { letterOf } from './view.mjs';

const MIX_MS = 1900;   // 玉が跳ね回る時間
const DROP_MS = 650;   // 玉が1つ出てくる時間
const HOLD_MS = 1100;  // 番号を見せておく時間

// 絵の中の座標(canvas の論理サイズ)
const W = 320;
const H = 300;
const GLOBE = { x: 160, y: 122, r: 104 };
const CHUTE_Y = 236;
const BALL_R = 14;
const BALL_COUNT = 16;

const INK = '#1f2a5c';
const COLORS = { B: '#ff5d5d', I: '#ff9f1c', N: '#14b89a', G: '#3d8bff', O: '#9b5de5' };
const PALETTE = Object.values(COLORS);

let current = null; // 進行中の演出

export function reducedMotion() {
  return !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// 進行中の演出を、その場で終わらせる。
export function cancelDraw() {
  if (current) current.finish();
}

// 番号 n の演出を見せる。終わったとき(飛ばされたとき・打ち切られたときも)に解決する。
// sound: { roll(ms), drop(), reveal(), stop() } を渡すと音を鳴らす。
// 「動きを減らす」設定の端末や、画面が見えていないときは、何も出さずにすぐ解決する。
export function playDraw({ n, sound = null }) {
  cancelDraw();
  const root = document.getElementById('draw-show');
  const canvas = document.getElementById('draw-show-canvas');
  const ballEl = document.getElementById('draw-show-ball');
  const titleEl = document.getElementById('draw-show-title');
  if (!root || !canvas || !canvas.getContext || reducedMotion() || document.visibilityState !== 'visible') {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const letter = letterOf(n);
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = W * dpr;
    canvas.height = H * dpr;

    const balls = makeBalls();
    const startedAt = performance.now();
    let last = startedAt;
    let frame = 0;
    let dropped = false;
    let revealed = false;
    let done = false;

    ballEl.hidden = true;
    ballEl.className = 'ball huge';
    titleEl.textContent = '抽選中…';
    root.hidden = false;
    if (sound) sound.roll(MIX_MS);

    function finish() {
      if (done) return;
      done = true;
      cancelAnimationFrame(frame);
      clearTimeout(safety);
      root.removeEventListener('click', finish);
      root.hidden = true;
      ballEl.hidden = true;
      if (sound) sound.stop();
      if (current && current.finish === finish) current = null;
      resolve();
    }

    function reveal() {
      revealed = true;
      ballEl.className = `ball huge col-${letter} pop`;
      ballEl.dataset.letter = letter;
      ballEl.textContent = String(n);
      ballEl.hidden = false;
      titleEl.textContent = `${letter} の ${n}番!`;
      if (sound) sound.reveal();
    }

    function tick(now) {
      if (done) return;
      const elapsed = now - startedAt;
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;

      // 回している間は勢いよく、玉が出るころには落ち着かせる
      const energy = elapsed < MIX_MS ? 1 : Math.max(0.12, 1 - (elapsed - MIX_MS) / 500);
      step(balls, dt, energy);

      if (!dropped && elapsed >= MIX_MS) {
        dropped = true;
        if (sound) sound.drop();
      }
      const dropT = dropped ? Math.min(1, (elapsed - MIX_MS) / DROP_MS) : -1;
      draw(ctx, dpr, balls, elapsed, energy, dropT, COLORS[letter]);

      if (!revealed && elapsed >= MIX_MS + DROP_MS) reveal();
      if (elapsed >= MIX_MS + DROP_MS + HOLD_MS) { finish(); return; }
      frame = requestAnimationFrame(tick);
    }

    // 描画が止まっても(省電力など)、必ず終わらせる
    const safety = setTimeout(finish, MIX_MS + DROP_MS + HOLD_MS + 1200);
    root.addEventListener('click', finish);
    current = { finish };
    frame = requestAnimationFrame(tick);
  });
}

// ---- 玉の動き ----

function makeBalls() {
  const balls = [];
  for (let i = 0; i < BALL_COUNT; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * (GLOBE.r - BALL_R - 6);
    balls.push({
      x: GLOBE.x + Math.cos(angle) * dist,
      y: GLOBE.y + Math.sin(angle) * dist,
      vx: (Math.random() - 0.5) * 500,
      vy: (Math.random() - 0.5) * 500,
      color: PALETTE[i % PALETTE.length],
    });
  }
  return balls;
}

function step(balls, dt, energy) {
  const limit = GLOBE.r - BALL_R - 3;
  for (const b of balls) {
    const dx = b.x - GLOBE.x;
    const dy = b.y - GLOBE.y;
    const dist = Math.hypot(dx, dy) || 1;
    // 回転でかき混ぜる力(円周の向き)と、重力と、ばらつき
    b.vx += (-dy / dist) * 950 * energy * dt + (Math.random() - 0.5) * 4200 * energy * dt;
    b.vy += (dx / dist) * 950 * energy * dt + (Math.random() - 0.5) * 4200 * energy * dt + 900 * dt;
    const damp = 1 - 1.2 * dt;
    b.vx *= damp;
    b.vy *= damp;
    const max = 140 + 520 * energy;
    const speed = Math.hypot(b.vx, b.vy);
    if (speed > max) { b.vx *= max / speed; b.vy *= max / speed; }
    b.x += b.vx * dt;
    b.y += b.vy * dt;
  }
  // 玉どうしがぶつかったら押し戻す
  for (let i = 0; i < balls.length; i++) {
    for (let j = i + 1; j < balls.length; j++) {
      const a = balls[i];
      const b = balls[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist === 0 || dist >= BALL_R * 2) continue;
      const nx = dx / dist;
      const ny = dy / dist;
      const push = (BALL_R * 2 - dist) / 2;
      a.x -= nx * push; a.y -= ny * push;
      b.x += nx * push; b.y += ny * push;
      const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (rel < 0) {
        a.vx += rel * nx; a.vy += rel * ny;
        b.vx -= rel * nx; b.vy -= rel * ny;
      }
    }
  }
  // 球の内側に収める
  for (const b of balls) {
    const dx = b.x - GLOBE.x;
    const dy = b.y - GLOBE.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= limit) continue;
    const nx = dx / dist;
    const ny = dy / dist;
    b.x = GLOBE.x + nx * limit;
    b.y = GLOBE.y + ny * limit;
    const out = b.vx * nx + b.vy * ny;
    if (out > 0) { b.vx -= 1.85 * out * nx; b.vy -= 1.85 * out * ny; }
  }
}

// ---- 絵 ----

function ball(ctx, x, y, r, color) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = INK;
  ctx.stroke();
  // つや
  ctx.beginPath();
  ctx.arc(x - r * 0.32, y - r * 0.34, r * 0.28, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.fill();
}

function draw(ctx, dpr, balls, elapsed, energy, dropT, pickedColor) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 回している間は、機械ごと小刻みに揺らす
  const shake = energy > 0.5 ? Math.sin(elapsed / 28) * 2.2 : 0;
  ctx.save();
  ctx.translate(shake, Math.cos(elapsed / 33) * (shake ? 1.2 : 0));

  // 台
  ctx.beginPath();
  ctx.moveTo(104, 214);
  ctx.lineTo(216, 214);
  ctx.lineTo(244, 284);
  ctx.lineTo(76, 284);
  ctx.closePath();
  ctx.fillStyle = '#ffd23f';
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = INK;
  ctx.stroke();
  // 玉の出口
  ctx.beginPath();
  ctx.arc(GLOBE.x, CHUTE_Y + 14, 21, 0, Math.PI * 2);
  ctx.fillStyle = INK;
  ctx.fill();

  // ハンドル(回している間だけ回る)
  const turn = energy > 0.5 ? elapsed / 110 : MIX_MS / 110;
  const hubX = GLOBE.x + GLOBE.r + 6;
  const hubY = GLOBE.y + 8;
  const gripX = hubX + Math.cos(turn) * 26;
  const gripY = hubY + Math.sin(turn) * 26;
  ctx.beginPath();
  ctx.moveTo(hubX - 12, hubY);
  ctx.lineTo(hubX, hubY);
  ctx.lineTo(gripX, gripY);
  ctx.lineWidth = 7;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(gripX, gripY, 9, 0, Math.PI * 2);
  ctx.fillStyle = '#ff4d8d';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.stroke();

  // 球(ガラス)
  ctx.beginPath();
  ctx.arc(GLOBE.x, GLOBE.y, GLOBE.r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
  ctx.fill();

  for (const b of balls) ball(ctx, b.x, b.y, BALL_R, b.color);

  ctx.beginPath();
  ctx.arc(GLOBE.x, GLOBE.y, GLOBE.r, 0, Math.PI * 2);
  ctx.lineWidth = 6;
  ctx.strokeStyle = INK;
  ctx.stroke();
  // ガラスのつや
  ctx.beginPath();
  ctx.arc(GLOBE.x, GLOBE.y, GLOBE.r - 14, Math.PI * 1.08, Math.PI * 1.42);
  ctx.lineWidth = 7;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.stroke();

  ctx.restore();

  // 出口から転がり落ちる玉(列の色。番号はまだ見せない)
  if (dropT >= 0 && dropT < 1) {
    const fall = dropT * dropT; // だんだん速く
    const y = CHUTE_Y + 14 + fall * (H - CHUTE_Y + 30);
    const r = BALL_R + 4 + dropT * 6;
    ball(ctx, GLOBE.x + Math.sin(dropT * 5) * 3, y, r, pickedColor);
  }
}
