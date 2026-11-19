// ===== ルーレットのロジック(純粋関数。画面にも通信にも触らない) =====
// 角度は「度」。盤の上の位置は、針(右・3時)の向きを 0 として時計回りに数える。
// 盤を R 度だけ時計回りに回すと、盤の上の角度 θ の場所は画面の θ + R に来る。針が指すのは θ ≡ -R の場所。
const RouletteLogic = (() => {
  'use strict';

  const MAX_ITEMS = 30;    // 項目の数
  const MAX_LABEL = 20;    // 項目の文字数
  const MAX_WEIGHT = 9;    // 当たりやすさ(1〜9)
  const MAX_HISTORY = 30;  // 残す記録の数
  const MAX_SEGS = 120;    // 盤に並べる数の上限(抽選の人数)
  // 盤の色(ピンク基調。こい色とうすい色を交互に並べて、隣どうしの境目が分かるようにする)
  const COLORS = ['#ff4f93', '#ffc7dc', '#ff85b3', '#c9a7ff', '#ff6f91', '#ffe7a3', '#f04bb0', '#ffb0cf', '#ff9e80', '#b784f5'];

  const PRESETS = {
    atari: { label: '当たりはずれ', items: [{ t: '大当たり', w: 1 }, { t: 'はずれ', w: 3 }, { t: '当たり', w: 2 }, { t: 'はずれ', w: 3 }, { t: '当たり', w: 2 }, { t: 'はずれ', w: 3 }] },
    batsu: { label: '罰ゲーム', items: ['モノマネ', '変顔', '早口ことば', '一発ギャグ', '秘密をひとつ', '歌をワンフレーズ', 'セーフ!', 'もう一回まわす'].map((t) => ({ t, w: 1 })) },
    nomi: { label: '飲み', drink: true, items: ['1口', '2口', '半分', '1杯', 'セーフ!', 'みんなで乾杯', '配信者が飲む', '水を飲む'].map((t) => ({ t, w: 1 })) },
    number: { label: '数字 1〜6', items: ['1', '2', '3', '4', '5', '6'].map((t) => ({ t, w: 1 })) },
    yesno: { label: 'はい・いいえ', items: ['はい', 'いいえ', 'はい', 'いいえ'].map((t) => ({ t, w: 1 })) },
  };

  const mod = (a, n) => ((a % n) + n) % n;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const int = (v, d = 0) => (Number.isInteger(v) ? v : d);
  /** Firebase は配列を「番号がキーのオブジェクト」で返すことがあるので、どちらでも配列にする。 */
  const toArray = (v) => (Array.isArray(v) ? v : isObj(v) ? Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]) : []);

  function cutLabel(s, max) {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    const chars = Array.from(t);
    return chars.length > max ? chars.slice(0, max).join('') : t;
  }
  function weight(w) {
    const n = Math.floor(Number(w));
    return Number.isFinite(n) ? Math.min(MAX_WEIGHT, Math.max(1, n)) : 1;
  }

  /** 項目の一覧を、保存してよい形にそろえる(空は捨てる)。 */
  function sanitizeItems(items) {
    const out = [];
    for (const it of toArray(items)) {
      const raw = isObj(it) ? it : typeof it === 'string' ? { t: it, w: 1 } : null;
      if (!raw) continue;
      const t = cutLabel(raw.t, MAX_LABEL);
      if (!t) continue;
      out.push({ t, w: weight(raw.w) });
      if (out.length >= MAX_ITEMS) break;
    }
    return out;
  }

  function createState() {
    return { phase: 'open', seq: 0, kind: 'items', items: sanitizeItems(PRESETS.atari.items), removeHit: false, removeWinner: true, turn: null, spin: null, dismissed: 0, won: {}, history: [] };
  }

  function normalizeSegs(raw) {
    const out = [];
    for (const s of toArray(raw)) {
      if (!isObj(s)) continue;
      const seg = { t: cutLabel(s.t, 40) || '？', w: weight(s.w) };
      if (typeof s.u === 'string' && s.u) seg.u = s.u;
      out.push(seg);
      if (out.length >= MAX_SEGS) break;
    }
    return out;
  }
  function normalizeSpin(raw) {
    if (!isObj(raw)) return null;
    const segs = normalizeSegs(raw.segs);
    const id = int(raw.id, 0);
    const { index, from, to, ms } = raw;
    if (segs.length < 2 || id < 1) return null;
    if (!Number.isInteger(index) || index < 0 || index >= segs.length) return null;
    if (![from, to, ms].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    if (ms < 300 || ms > 20000 || Math.abs(to) > 1e7 || Math.abs(from) > 1e7) return null;
    const spin = { id, kind: raw.kind === 'names' ? 'names' : 'items', segs, index, from, to, ms, byName: cutLabel(raw.byName, 12) };
    if (typeof raw.by === 'string' && raw.by) spin.by = raw.by;
    return spin;
  }
  function normalizeHistory(raw) {
    const out = [];
    for (const h of toArray(raw)) {
      if (!isObj(h)) continue;
      const e = { id: int(h.id, 0), k: h.k === 'names' ? 'names' : 'items', t: cutLabel(h.t, 40) || '？', c: mod(int(h.c, 0), COLORS.length), by: cutLabel(h.by, 12) };
      if (typeof h.u === 'string' && h.u) e.u = h.u;
      out.push(e);
      if (out.length >= MAX_HISTORY) break;
    }
    return out;
  }
  /** 同期で届いた state を、必ず同じ形にそろえる(欠け・壊れ・いたずらに耐える)。 */
  function normalizeState(raw) {
    const r = isObj(raw) ? raw : {};
    const won = {};
    if (isObj(r.won)) for (const [k, v] of Object.entries(r.won)) if (v === true) won[k] = true;
    return {
      phase: r.phase === 'closed' ? 'closed' : 'open',
      seq: Math.max(0, int(r.seq, 0)),
      kind: r.kind === 'names' ? 'names' : 'items',
      items: sanitizeItems(r.items),
      removeHit: r.removeHit === true,
      removeWinner: r.removeWinner !== false,
      turn: typeof r.turn === 'string' && r.turn ? r.turn : null,
      spin: normalizeSpin(r.spin),
      dismissed: Math.max(0, int(r.dismissed, 0)),
      won,
      history: normalizeHistory(r.history),
    };
  }

  // ---------- 盤に並べるもの ----------
  const itemSegs = (items) => sanitizeItems(items).map(({ t, w }) => ({ t, w }));

  /** 参加している人(参加した順)。ブロックした人と、名前を登録していない人は入らない。 */
  function entrants(room) {
    const players = (room && isObj(room.players)) ? room.players : {};
    const queue = (room && isObj(room.queue)) ? room.queue : {};
    const won = (room && room.state && isObj(room.state.won)) ? room.state.won : {};
    return Object.keys(queue)
      .filter((uid) => isObj(players[uid]) && !players[uid].banned)
      .map((uid) => {
        const p = players[uid];
        return { uid, name: cutLabel(p.name, 12) || 'リスナー', char: p.char, hidden: p.hidden === true, online: p.online !== false, won: won[uid] === true, joinedAt: Number((queue[uid] || {}).joinedAt) || 0 };
      })
      .sort((a, b) => (a.joinedAt - b.joinedAt) || (a.uid < b.uid ? -1 : 1));
  }
  /** リスナー抽選の盤: 参加している人の名前。「次から外す」がオンなら当選済みの人は入らない。 */
  function nameSegs(room) {
    const st = room && room.state ? room.state : {};
    return entrants(room)
      .filter((e) => !(st.removeWinner !== false && e.won))
      .slice(0, MAX_SEGS)
      .map((e) => ({ t: e.hidden ? '？？？' : e.name, w: 1, u: e.uid }));
  }
  /** いま回したら使われる盤。 */
  const liveSegs = (room) => (room && room.state && room.state.kind === 'names' ? nameSegs(room) : itemSegs(room && room.state ? room.state.items : []));

  // ---------- 角度 ----------
  /** 各項目の境目の角度。[0, …, 360](項目数 + 1 個)。 */
  function segBounds(segs) {
    const total = segs.reduce((s, x) => s + weight(x.w), 0);
    const out = [0];
    let acc = 0;
    segs.forEach((x, i) => { acc += weight(x.w); out.push(i === segs.length - 1 ? 360 : (acc / total) * 360); });
    return out;
  }
  /** r(0 以上 1 未満)から、当たりやすさに比例して項目を選ぶ。 */
  function pickIndex(segs, r) {
    const total = segs.reduce((s, x) => s + weight(x.w), 0);
    let acc = 0;
    for (let i = 0; i < segs.length; i++) { acc += weight(segs[i].w); if (r * total < acc) return i; }
    return segs.length - 1;
  }
  /** 盤を rotation 度回したとき、針が指している項目の番号。 */
  function indexAt(segs, rotation) {
    if (!segs.length) return -1;
    const b = segBounds(segs);
    const theta = mod(-rotation, 360);
    for (let i = 0; i < segs.length; i++) if (theta < b[i + 1]) return i;
    return segs.length - 1;
  }
  /** 隣どうし(最後と最初も)が同じ色にならないように色の番号を決める。 */
  function colorIndex(i, n) {
    const len = COLORS.length;
    const c = i % len;
    return n > 1 && i === n - 1 && c === 0 ? Math.floor(len / 2) : c;
  }

  /**
   * 1 回の回転を決める。どこに止まるか(index)を先に決め、そこへ止まる角度(to)を逆算する。
   * 3 回に 1 回くらいは境目の近くに止めて「隣かも…」とハラハラさせる(それでも境目からは離す)。
   */
  function planSpin(segs, from, rng = Math.random) {
    if (!Array.isArray(segs) || segs.length < 2) return null;
    const index = pickIndex(segs, rng());
    const near = rng() < 0.33;
    const side = rng() < 0.5;
    const jitter = rng();
    const frac = near ? (side ? 0.08 + jitter * 0.09 : 0.83 + jitter * 0.09) : 0.2 + jitter * 0.6;
    const b = segBounds(segs);
    const theta = b[index] + (b[index + 1] - b[index]) * frac;
    const turns = 5 + Math.floor(rng() * 3);
    const to = from + turns * 360 + mod(-theta - from, 360);
    const ms = 6500 + Math.floor(rng() * 1500);
    return { index, from, to, ms };
  }
  /** 回り始めてから elapsed ミリ秒の角度。じわっと動き出し、最後はゆっくり止まる。 */
  function angleAt(spin, elapsed) {
    const t = Math.min(1, Math.max(0, elapsed / spin.ms));
    if (t >= 1) return spin.to;
    const p = 1 - Math.pow(1 - Math.pow(t, 1.3), 3);
    return spin.from + (spin.to - spin.from) * p;
  }

  // ---------- 進行(state を書けるのは配信者の画面だけ) ----------
  const showingResult = (st) => !!(st && st.spin) && st.dismissed !== st.spin.id;
  const restAngle = (st) => (st && st.spin ? mod(st.spin.to, 360) : 0);
  const winnerOf = (st) => (st && st.spin ? st.spin.segs[st.spin.index] : null);

  /**
   * 回す。結果・記録・「消していく」「次から外す」までを 1 回の書き込みで決める
   * (途中で配信者の画面が落ちても、食い違わない)。回せないときは null。
   */
  function startSpin(st, segs, opts = {}) {
    const plan = planSpin(segs, restAngle(st), opts.rng || Math.random);
    if (!plan) return null;
    const id = st.seq + 1;
    const hit = segs[plan.index];
    const byName = cutLabel(opts.byName, 12);
    const spin = { id, kind: st.kind, segs: segs.map((s) => (s.u ? { t: s.t, w: s.w, u: s.u } : { t: s.t, w: s.w })), index: plan.index, from: plan.from, to: plan.to, ms: plan.ms, byName };
    if (opts.by) spin.by = opts.by;
    const entry = { id, k: st.kind, t: hit.t, c: colorIndex(plan.index, segs.length), by: byName };
    if (hit.u) entry.u = hit.u;
    const next = { ...st, seq: id, spin, turn: null, history: [entry, ...st.history].slice(0, MAX_HISTORY) };
    if (st.kind === 'names' && hit.u) next.won = { ...st.won, [hit.u]: true };
    if (st.kind === 'items' && st.removeHit) next.items = sanitizeItems(st.items).filter((_, i) => i !== plan.index);
    return next;
  }
  const dismiss = (st) => ({ ...st, dismissed: st.spin ? st.spin.id : st.dismissed });
  const setKind = (st, kind) => dismiss({ ...st, kind: kind === 'names' ? 'names' : 'items' });
  const setItems = (st, items) => ({ ...st, items: sanitizeItems(items) });
  const setOption = (st, key, value) => (key === 'removeHit' || key === 'removeWinner' ? { ...st, [key]: value === true } : st);
  const setTurn = (st, uid) => ({ ...st, turn: typeof uid === 'string' && uid ? uid : null });
  const resetWon = (st) => ({ ...st, won: {} });
  const close = (st) => ({ ...st, phase: 'closed', turn: null });

  return {
    MAX_ITEMS, MAX_LABEL, MAX_WEIGHT, MAX_HISTORY, MAX_SEGS, COLORS, PRESETS,
    mod, cutLabel, sanitizeItems, createState, normalizeState,
    itemSegs, entrants, nameSegs, liveSegs,
    segBounds, pickIndex, indexAt, colorIndex, planSpin, angleAt,
    showingResult, restAngle, winnerOf, startSpin, dismiss, setKind, setItems, setOption, setTurn, resetWon, close,
  };
})();
if (typeof module !== 'undefined') module.exports = RouletteLogic;
