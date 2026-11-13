// ビンゴの純粋関数。サーバー(Durable Object)・ブラウザ・テストで共用する。
// DOM にも Workers 固有の API にも依存しない。

export const FREE = 0;
export const MAX_NUMBER = 75;
export const LIMITS = Object.freeze({ NAME_MAX: 20, COUNT_MAX: 50, CARDS_MAX: 5000, PENDING_MAX: 1000 });
export const DELAYS = Object.freeze([0, 3, 5, 8, 10, 15, 20, 30]);

const SIZE = 5;
const CENTER = 12;
const PER_COLUMN = 15;

// 縦5・横5・斜め2。添字は行優先(0〜24)。
export const LINES = (() => {
  const lines = [];
  for (let r = 0; r < SIZE; r++) lines.push([0, 1, 2, 3, 4].map((c) => r * SIZE + c));
  for (let c = 0; c < SIZE; c++) lines.push([0, 1, 2, 3, 4].map((r) => r * SIZE + c));
  lines.push([0, 6, 12, 18, 24]);
  lines.push([4, 8, 12, 16, 20]);
  return lines;
})();

// rng() は [0,1) を返す関数。
export function makeCard(rng) {
  const card = new Array(SIZE * SIZE).fill(FREE);
  for (let col = 0; col < SIZE; col++) {
    const pool = [];
    for (let i = 1; i <= PER_COLUMN; i++) pool.push(col * PER_COLUMN + i);
    for (let row = 0; row < SIZE; row++) {
      const pick = pool.splice(Math.floor(rng() * pool.length), 1)[0];
      card[row * SIZE + col] = pick;
    }
  }
  card[CENTER] = FREE;
  return card;
}

// lines: そろった列の数 / reach: あと1個の列の数 / need: 最も近い列の残り個数(ビンゴなら0)
export function analyzeCard(numbers, called) {
  const marked = numbers.map((n) => n === FREE || called.has(n));
  let lines = 0;
  let reach = 0;
  let need = SIZE;
  for (const line of LINES) {
    let missing = 0;
    for (const i of line) if (!marked[i]) missing++;
    if (missing === 0) lines++;
    else if (missing === 1) reach++;
    if (missing < need) need = missing;
  }
  return { marked, lines, reach, need };
}

export function pickUncalled(called, rng) {
  const rest = [];
  for (let n = 1; n <= MAX_NUMBER; n++) if (!called.has(n)) rest.push(n);
  if (rest.length === 0) return null;
  return rest[Math.floor(rng() * rest.length)];
}

// 制御文字と、表示の向きを変える制御文字を除く。
const STRIP = /[\p{Cc}‪-‮⁦-⁩]/gu;

export function normalizeName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(STRIP, '').trim();
  const length = Array.from(name).length;
  if (length < 1 || length > LIMITS.NAME_MAX) return null;
  return name;
}

export function isValidCount(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= LIMITS.COUNT_MAX;
}

export function isValidToken(v) {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

// rows: { id, name, no, at }。at(何個目の番号で達成したか)、id の順。同じ at は同順位(1,1,3)。
export function rankWinners(rows) {
  const sorted = [...rows].sort((a, b) => a.at - b.at || a.id - b.id);
  const out = [];
  let rank = 0;
  let prevAt = null;
  sorted.forEach((row, index) => {
    if (row.at !== prevAt) { rank = index + 1; prevAt = row.at; }
    out.push({ rank, name: row.name, no: row.no, at: row.at });
  });
  return out;
}

// テスト用の固定乱数(mulberry32)。
export function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function cryptoRng() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 4294967296;
}
