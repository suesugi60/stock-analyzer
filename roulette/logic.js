// ===== カジノ式ルーレットのロジック(純粋関数。画面にも通信にも触らない) =====
// ヨーロピアン式(0 が 1 つ、0〜36 の 37 マス)。チップは遊び用の点数。
// 角度は「度」。盤の上の位置は、真上(12時)を 0 として時計回りに数える。
const RouletteLogic = (() => {
  'use strict';

  const START_CHIPS = 1000;        // 最初に持っているチップ(おかわりでもこの数に戻る)
  const MIN_BET = 10;              // 賭けの最小単位
  const CHIP_VALUES = [10, 50, 100, 500];
  const MAX_CHIPS = 999999999;
  const MAX_HISTORY = 20;          // 残す出目の数
  const SETTLE_MS = 1600;          // 玉がマスに収まってから盤が止まるまで

  // 盤の数字の並び(真上から時計回り)
  const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
  const POCKET = 360 / WHEEL.length;
  const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const R_TRACK = 91.5;            // 玉が走る外周の半径(盤の絵と同じ単位)
  const R_REST = 64;               // 玉がマスに収まったときの半径

  const mod = (a, n) => ((a % n) + n) % n;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isInt = (v) => Number.isInteger(v);
  const toArray = (v) => (Array.isArray(v) ? v : isObj(v) ? Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]) : []);
  const validNumber = (n) => isInt(n) && n >= 0 && n <= 36;
  /** 'red' | 'black' | 'green'(0 だけ)。 */
  const colorOf = (n) => (n === 0 ? 'green' : RED.has(n) ? 'red' : 'black');

  // ---------- 賭ける場所 ----------
  // 0〜36: その数字 / 37 赤 / 38 黒 / 39 奇数 / 40 偶数 / 41 前半(1〜18) / 42 後半(19〜36)
  // 43〜45: 1〜12・13〜24・25〜36 / 46〜48: たて1列(3で割った余りが 1・2・0 の数字)
  const SPOT = { RED: 37, BLACK: 38, ODD: 39, EVEN: 40, LOW: 41, HIGH: 42, DOZEN: 43, COLUMN: 46 };
  const SPOT_COUNT = 49;
  const validSpot = (s) => isInt(s) && s >= 0 && s < SPOT_COUNT;
  /** 出た数字 n で、場所 spot は当たりか。0 が出たら、数字の 0 以外は全部はずれ。 */
  function spotWins(spot, n) {
    if (spot <= 36) return spot === n;
    if (n === 0) return false;
    switch (spot) {
      case SPOT.RED: return RED.has(n);
      case SPOT.BLACK: return !RED.has(n);
      case SPOT.ODD: return n % 2 === 1;
      case SPOT.EVEN: return n % 2 === 0;
      case SPOT.LOW: return n <= 18;
      case SPOT.HIGH: return n >= 19;
      default: break;
    }
    if (spot >= SPOT.DOZEN && spot < SPOT.DOZEN + 3) return Math.ceil(n / 12) - 1 === spot - SPOT.DOZEN;
    if (spot >= SPOT.COLUMN && spot < SPOT.COLUMN + 3) return (n - 1) % 3 === spot - SPOT.COLUMN;
    return false;
  }
  /** 当たったとき、賭けたチップが何倍になって戻るか(賭けた分を含む)。数字 36倍・3択 3倍・2択 2倍。 */
  const spotPays = (spot) => (spot <= 36 ? 36 : spot >= SPOT.DOZEN ? 3 : 2);
  function spotLabel(spot) {
    if (spot <= 36) return String(spot);
    if (spot >= SPOT.COLUMN) return `たて${spot - SPOT.COLUMN + 1}列目`;
    if (spot >= SPOT.DOZEN) return ['1〜12', '13〜24', '25〜36'][spot - SPOT.DOZEN];
    return { [SPOT.RED]: '赤', [SPOT.BLACK]: '黒', [SPOT.ODD]: '奇数', [SPOT.EVEN]: '偶数', [SPOT.LOW]: '1〜18', [SPOT.HIGH]: '19〜36' }[spot];
  }
  /** 出た数字の説明: 「赤・奇数・1〜18」。0 は「みどり」。 */
  function describe(n) {
    if (n === 0) return 'みどり';
    return `${RED.has(n) ? '赤' : '黒'}・${n % 2 ? '奇数' : '偶数'}・${n <= 18 ? '1〜18' : '19〜36'}`;
  }
  const spotKey = (spot) => `s${spot}`; // 数字だけのキーは保存先で配列に化けるので頭に s を付ける
  function parseKey(k) {
    const m = /^s(\d{1,2})$/.exec(String(k));
    const s = m ? Number(m[1]) : -1;
    return validSpot(s) ? s : -1;
  }

  // ---------- リスナーから配信者への合図(数 1 つに詰める) ----------
  // いまの通信の決まりでは、リスナーが配信者へ送れるのは「数 1 つ」だけ。そこで「何回戦・何をする・いくら」を 1 つの数に詰める。
  //   数 = (回戦 × 100 + 種類) × 10,000,000 + チップ数   種類: 0〜48 賭ける場所 / 90 賭けを全部取り消す / 91 おかわり
  const OP = { CLEAR: 90, REBUY: 91 };
  const ROUND_MOD = 100000;
  const AMOUNT_MOD = 10000000;
  const MAX_AMOUNT = AMOUNT_MOD - 1;
  function encodeOp(round, code, amount = 0) { return (mod(round, ROUND_MOD) * 100 + code) * AMOUNT_MOD + amount; }
  function decodeOp(at) {
    if (!Number.isSafeInteger(at) || at < 0) return null;
    const amount = at % AMOUNT_MOD;
    const rest = Math.floor(at / AMOUNT_MOD);
    const code = rest % 100;
    const round = Math.floor(rest / 100);
    if (round >= ROUND_MOD || !(validSpot(code) || code === OP.CLEAR || code === OP.REBUY)) return null;
    return { round, code, amount };
  }

  // ---------- state ----------
  function createState() {
    return { phase: 'bet', round: 1, chips: {}, rebuys: {}, bets: {}, spin: null, history: [], house: 0 };
  }
  function normalizeSpin(raw) {
    if (!isObj(raw)) return null;
    const { id, n, ms, w0, wd, r0, bt } = raw;
    if (!isInt(id) || id < 1 || !validNumber(n)) return null;
    if (![ms, w0, wd, r0, bt].every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
    if (ms < 200 || ms > 30000 || Math.abs(wd) > 36000 || Math.abs(w0) > 36000 || Math.abs(r0) > 36000 || bt < 0 || bt > 60) return null;
    return { id, n, ms, w0, wd, r0, bt };
  }
  /** 同期で届いた state を、必ず同じ形にそろえる(欠け・壊れ・いたずらに耐える)。 */
  function normalizeState(raw) {
    const r = isObj(raw) ? raw : {};
    const amounts = (src, max) => {
      const out = {};
      if (isObj(src)) for (const [k, v] of Object.entries(src)) if (isInt(v) && v >= 0 && v <= max) out[k] = v;
      return out;
    };
    const bets = {};
    if (isObj(r.bets)) {
      for (const [uid, b] of Object.entries(r.bets)) {
        if (!isObj(b)) continue;
        const mine = {};
        for (const [k, v] of Object.entries(b)) { const s = parseKey(k); if (s >= 0 && isInt(v) && v > 0 && v <= MAX_CHIPS) mine[s] = v; }
        if (Object.keys(mine).length) bets[uid] = mine;
      }
    }
    return {
      phase: r.phase === 'closed' ? 'closed' : r.phase === 'done' ? 'done' : 'bet',
      round: isInt(r.round) && r.round >= 1 ? r.round : 1,
      chips: amounts(r.chips, MAX_CHIPS),
      rebuys: amounts(r.rebuys, 9999),
      bets,
      spin: normalizeSpin(r.spin),
      history: toArray(r.history).filter(validNumber).slice(0, MAX_HISTORY),
      house: isInt(r.house) ? r.house : 0,
    };
  }
  /** 保存する形(賭けのキーに s を付ける)。normalizeState の逆。 */
  function serializeState(st) {
    const bets = {};
    for (const [uid, b] of Object.entries(st.bets)) { bets[uid] = {}; for (const [s, v] of Object.entries(b)) bets[uid][spotKey(s)] = v; }
    return { ...st, bets };
  }

  // ---------- チップと賭け ----------
  const chipsOf = (st, uid) => (Object.hasOwn(st.chips, uid) ? st.chips[uid] : START_CHIPS);
  const betsOf = (st, uid) => (Object.hasOwn(st.bets, uid) ? st.bets[uid] : {});
  const sum = (obj) => Object.values(obj).reduce((s, v) => s + v, 0);
  const stakeOf = (st, uid) => sum(betsOf(st, uid));
  /** もう賭けられない(チップが最小単位に足りず、テーブルにも置いていない)。おかわりできる。 */
  const isBroke = (st, uid) => chipsOf(st, uid) < MIN_BET && (st.phase !== 'bet' || stakeOf(st, uid) === 0);
  /** 場所ごとの合計と人数、全体の合計。 */
  function totals(st) {
    const bySpot = {};
    let total = 0;
    let players = 0;
    for (const b of Object.values(st.bets)) {
      players++;
      for (const [s, v] of Object.entries(b)) {
        const t = bySpot[s] || (bySpot[s] = { sum: 0, count: 0 });
        t.sum += v; t.count++; total += v;
      }
    }
    return { bySpot, total, players };
  }

  /**
   * リスナーの合図 1 つを state に当てはめる。受け付けたら「書きかえる場所 → 値」の表を返す(state からの相対パス)。
   * 受け付けられない(回戦がちがう・締め切り後・チップが足りない など)なら null。
   */
  function applyOp(st, uid, op) {
    if (!op || op.round !== mod(st.round, ROUND_MOD)) return null;
    const chips = chipsOf(st, uid);
    if (op.code === OP.REBUY) {
      if (!isBroke(st, uid)) return null;
      return { [`chips/${uid}`]: START_CHIPS, [`rebuys/${uid}`]: (st.rebuys[uid] || 0) + 1 };
    }
    if (st.phase !== 'bet') return null;
    const mine = betsOf(st, uid);
    if (op.code === OP.CLEAR) {
      const stake = sum(mine);
      return stake ? { [`bets/${uid}`]: null, [`chips/${uid}`]: chips + stake } : null;
    }
    if (!validSpot(op.code)) return null;
    const a = op.amount;
    if (!isInt(a) || a < MIN_BET || a % MIN_BET !== 0 || a > chips) return null;
    return { [`bets/${uid}/${spotKey(op.code)}`]: (mine[op.code] || 0) + a, [`chips/${uid}`]: chips - a };
  }
  /** applyOp の表を state に当てはめた結果(テスト用)。 */
  function applyPatch(st, patch) {
    const next = { ...st, chips: { ...st.chips }, rebuys: { ...st.rebuys }, bets: { ...st.bets } };
    for (const [path, v] of Object.entries(patch)) {
      const [top, uid, key] = path.split('/');
      if (top === 'bets') {
        if (key === undefined) { if (v === null) delete next.bets[uid]; continue; }
        next.bets[uid] = { ...(next.bets[uid] || {}), [parseKey(key)]: v };
      } else if (top === 'chips' || top === 'rebuys') next[top][uid] = v;
    }
    return next;
  }

  /** 出た数字 n での精算。uid → { stake 賭けた合計, payout 戻る合計, net 増減, hits 当たった場所 }。 */
  function settle(bets, n) {
    const out = {};
    for (const [uid, b] of Object.entries(bets)) {
      let stake = 0;
      let payout = 0;
      const hits = [];
      for (const [s, v] of Object.entries(b)) {
        const spot = Number(s);
        stake += v;
        if (spotWins(spot, n)) { payout += v * spotPays(spot); hits.push(spot); }
      }
      out[uid] = { stake, payout, net: payout - stake, hits };
    }
    return out;
  }

  // ---------- 盤と玉の動き ----------
  /** 数字 n のマスの中心の角度(盤の上で、真上から時計回り)。 */
  const pocketAngle = (n) => WHEEL.indexOf(n) * POCKET;
  /** 盤の上の角度 rel にあるマスの数字。 */
  const numberAt = (rel) => WHEEL[mod(Math.round(mod(rel, 360) / POCKET), WHEEL.length)];

  /**
   * 1 回の回転を決める。出る数字(n)を先に決め、玉がそのマスに収まるように動きを逆算する。
   *   ms 全体の時間 / w0 盤の最初の角度 / wd 盤が回る量(反時計回りなので負) / r0 玉の最初の位置(盤から見た角度) / bt 玉が盤の上を回る周数
   */
  function planSpin(prev, rng = Math.random) {
    const n = Math.min(36, Math.floor(rng() * 37));
    const w0 = prev ? mod(prev.w0 + prev.wd, 360) : 0;
    return { n, ms: 9000 + Math.floor(rng() * 1500), w0, wd: -(540 + Math.floor(rng() * 360)), r0: Math.floor(rng() * 360), bt: 9 + Math.floor(rng() * 4) };
  }
  /**
   * 回り始めてから elapsed ミリ秒の姿。
   *   wheel 盤の角度 / rel 盤から見た玉の角度 / ball 画面での玉の角度 / r 玉の半径 / settled 玉がマスに収まったか
   * 玉は外周を時計回りに走り、だんだん遅くなって内側へ落ち、はねてからマスに収まる。そのあとは盤と一緒に回る。
   */
  function pose(spin, elapsed) {
    const T = spin.ms;
    const Tb = T - Math.min(SETTLE_MS, T * 0.18);
    const t = Math.min(T, Math.max(0, elapsed));
    const wheel = spin.w0 + spin.wd * (1 - Math.pow(1 - t / T, 2));
    const relEnd = spin.r0 + spin.bt * 360 + mod(pocketAngle(spin.n) - spin.r0, 360);
    let rel = relEnd;
    let r = R_REST;
    if (t < Tb) {
      const x = t / Tb;
      rel = spin.r0 + (relEnd - spin.r0) * (1 - Math.pow(1 - x, 2.4));
      const DROP = 0.6; // ここまでは外周を走る
      if (x <= DROP) r = R_TRACK;
      else {
        const u = (x - DROP) / (1 - DROP);
        const base = R_TRACK - (R_TRACK - R_REST) * (u * u * (3 - 2 * u));
        const bump = 3 * Math.abs(Math.sin(u * Math.PI * 4)) * Math.pow(1 - u, 1.5);
        r = Math.min(R_TRACK, base + bump);
      }
    }
    return { wheel, rel, ball: wheel + rel, r, settled: t >= Tb };
  }

  // ---------- 進行(state を書けるのは配信者の画面だけ) ----------
  /**
   * 賭けを締め切って回す。出る数字・精算後のチップ・出目の記録までを 1 回の書き込みで決める
   * (途中で配信者の画面が落ちても、食い違わない)。賭けの受付中でなければ null。
   */
  function spin(st, rng = Math.random) {
    if (st.phase !== 'bet') return null;
    const plan = planSpin(st.spin, rng);
    const res = settle(st.bets, plan.n);
    const chips = { ...st.chips };
    let house = st.house;
    for (const [uid, r] of Object.entries(res)) { chips[uid] = Math.min(MAX_CHIPS, chipsOf(st, uid) + r.payout); house += r.stake - r.payout; }
    return { ...st, phase: 'done', spin: { id: st.round, ...plan }, chips, house, history: [plan.n, ...st.history].slice(0, MAX_HISTORY) };
  }
  /** 次のゲームへ(テーブルの賭けを片づけて、受付を始める)。 */
  const nextRound = (st) => (st.phase === 'done' ? { ...st, phase: 'bet', round: st.round + 1, bets: {} } : st);
  /** 全員のチップを最初の数に戻す(置いてある賭けも片づける)。 */
  const resetChips = (st) => ({ ...st, chips: {}, rebuys: {}, bets: {}, house: 0 });
  const close = (st) => ({ ...st, phase: 'closed' });
  /** 出た結果(done のときだけ)。uid → settle の結果。 */
  const results = (st) => (st.phase === 'done' && st.spin ? settle(st.bets, st.spin.n) : {});

  /** 参加している人(名前を登録していて、ブロックされていない人)。参加した順。 */
  function members(room) {
    const players = room && isObj(room.players) ? room.players : {};
    return Object.keys(players)
      .filter((uid) => isObj(players[uid]) && typeof players[uid].name === 'string' && players[uid].name && !players[uid].banned)
      .map((uid) => {
        const p = players[uid];
        return { uid, name: String(p.name).slice(0, 12), char: p.char, hidden: p.hidden === true, online: p.online !== false, joinedAt: Number(p.joinedAt) || 0 };
      })
      .sort((a, b) => (a.joinedAt - b.joinedAt) || (a.uid < b.uid ? -1 : 1));
  }
  /** 順位表。受付中はテーブルに置いた分も持ちチップに数える(置いただけで順位が下がらないように)。 */
  function ranking(room) {
    const st = room.state;
    return members(room)
      .map((m) => ({ ...m, chips: chipsOf(st, m.uid) + (st.phase === 'bet' ? stakeOf(st, m.uid) : 0), rebuys: st.rebuys[m.uid] || 0 }))
      .sort((a, b) => (b.chips - a.chips) || (a.rebuys - b.rebuys) || (a.joinedAt - b.joinedAt));
  }

  return {
    START_CHIPS, MIN_BET, CHIP_VALUES, MAX_AMOUNT, MAX_HISTORY, SETTLE_MS, WHEEL, POCKET, RED, R_TRACK, R_REST, SPOT, SPOT_COUNT, OP,
    mod, colorOf, validSpot, spotWins, spotPays, spotLabel, describe, spotKey, parseKey, encodeOp, decodeOp,
    createState, normalizeState, serializeState, chipsOf, betsOf, stakeOf, isBroke, totals, applyOp, applyPatch, settle,
    pocketAngle, numberAt, planSpin, pose, spin, nextRound, resetChips, close, results, members, ranking,
  };
})();
if (typeof module !== 'undefined') module.exports = RouletteLogic;
