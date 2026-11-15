// ===== チンチロの純粋ロジック(役の判定・勝敗・支払い・部屋の状態遷移) =====
// ブラウザでは globalThis.ChinchiroLogic、Node では require で読める。DOM・通信に依存しない。
const ChinchiroLogic = (() => {
  'use strict';

  const DRINK_UNITS = { sip: { label: '1口' }, half: { label: '半分' }, glass: { label: '1杯' } };
  const POINT_UNITS = [10, 20, 50];
  const SHONBEN_RATE = 0.03;

  // 負け役(出た瞬間に手番終了)
  const NONE = Object.freeze({ type: 'none', value: 0, mult: 1, label: '目なし', lose: true, rank: 0 });
  const SHONBEN = Object.freeze({ type: 'shonben', value: 0, mult: 1, label: 'ションベン', lose: true, rank: -1 });
  const HIFUMI = Object.freeze({ type: 'hifumi', value: 0, mult: 1, label: 'ヒフミ', lose: true, rank: -2 });

  function checkDice(dice) {
    if (!Array.isArray(dice) || dice.length !== 3) throw new Error('サイコロは3つ');
    for (const d of dice) if (!Number.isInteger(d) || d < 1 || d > 6) throw new Error('出目が不正: ' + d);
  }

  /** 3つの出目から役を返す。役なしは null。 */
  function evaluate(dice) {
    checkDice(dice);
    const s = dice.slice().sort((a, b) => a - b);
    if (s[0] === s[1] && s[1] === s[2]) {
      if (s[0] === 1) return { type: 'pinzoro', value: 1, mult: 5, label: 'ピンゾロ', lose: false, rank: 1000 };
      return { type: 'zoro', value: s[0], mult: 3, label: `${s[0]}ゾロ`, lose: false, rank: 900 + s[0] };
    }
    if (s[0] === 4 && s[1] === 5 && s[2] === 6) return { type: 'shigoro', value: 0, mult: 2, label: 'シゴロ', lose: false, rank: 800 };
    if (s[0] === 1 && s[1] === 2 && s[2] === 3) return { ...HIFUMI };
    if (s[0] === s[1]) return me(s[2]);
    if (s[1] === s[2]) return me(s[0]);
    return null;
  }

  function me(x) { return { type: 'me', value: x, mult: 1, label: `${x}の目`, lose: false, rank: 100 + x }; }

  /** 負けた側が余計に払う倍率(ヒフミだけ2)。 */
  function penaltyMult(hand) { return hand && hand.type === 'hifumi' ? 2 : 1; }

  /** 親の役と子の役(子が振っていなければ null)から勝敗と支払い倍率を返す。 */
  function judge(parentHand, childHand) {
    if (parentHand.lose) return { winner: 'child', mult: penaltyMult(parentHand) };
    if (!childHand) throw new Error('子の役がありません');
    if (childHand.lose) return { winner: 'parent', mult: Math.max(parentHand.mult, penaltyMult(childHand)) };
    if (parentHand.rank === childHand.rank) return { winner: 'draw', mult: 0 };
    return parentHand.rank > childHand.rank
      ? { winner: 'parent', mult: Math.max(parentHand.mult, penaltyMult(childHand)) }
      : { winner: 'child', mult: Math.max(childHand.mult, penaltyMult(parentHand)) };
  }

  /** 結果と部屋設定から、親と子それぞれの増減を返す。 */
  function resultDeltas(result, settings) {
    const zero = () => ({ points: 0, drinks: 0, wins: 0, losses: 0 });
    const parent = zero();
    const child = zero();
    if (result.winner === 'draw') return { parent, child };
    const usePoints = settings.mode === 'points' || settings.mode === 'both';
    const useDrink = settings.mode === 'drink' || settings.mode === 'both';
    const pts = usePoints ? settings.unit * result.mult : 0;
    const drinks = useDrink ? result.mult : 0;
    const [win, lose] = result.winner === 'parent' ? [parent, child] : [child, parent];
    win.points = pts; win.wins = 1;
    lose.points = pts === 0 ? 0 : -pts; lose.losses = 1; lose.drinks = drinks; // 0 のとき -0 にしない
    return { parent, child };
  }

  /** 出目を決める。rng() は [0,1)。最初の rng でションベン判定、続く3つで出目、最後に演出用の seed。 */
  function rollDice(rng = Math.random) {
    const shonben = rng() < SHONBEN_RATE;
    const dice = [0, 0, 0].map(() => 1 + Math.floor(rng() * 6));
    const seed = Math.floor(rng() * 2 ** 31);
    return { dice, seed, shonben };
  }

  // ---------- 部屋の状態遷移(親機だけが実行し、結果を同期先に書く) ----------
  const MAX_THROWS = 3;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const emptySide = () => ({ throws: [], hand: null, done: false });

  function createState() {
    return { seq: 0, phase: 'lobby', match: null, result: null, host: { points: 100, wins: 0, losses: 0, drinks: 0 }, lastThrow: null };
  }

  /** 同期先(Firebase)は空配列や null を保存しないので、読み戻した状態の欠けを補う。 */
  function normalizeState(state) {
    const st = state && typeof state === 'object' ? clone(state) : {};
    const base = createState();
    st.seq = Number.isInteger(st.seq) ? st.seq : base.seq;
    st.phase = st.phase || base.phase;
    st.match = st.match && typeof st.match === 'object' ? st.match : null;
    st.result = st.result && typeof st.result === 'object' ? st.result : null;
    st.host = { ...base.host, ...(st.host || {}) };
    st.lastThrow = st.lastThrow && typeof st.lastThrow === 'object' ? st.lastThrow : null;
    if (st.match) {
      st.match.round = Number.isInteger(st.match.round) ? st.match.round : 1;
      for (const k of ['parent', 'child']) {
        const side = st.match[k] || {};
        st.match[k] = { throws: Array.isArray(side.throws) ? side.throws : [], hand: side.hand || null, done: !!side.done };
      }
    }
    return st;
  }

  function bump(state) { const s = normalizeState(state); s.seq += 1; return s; }

  function startMatch(state, childUid) {
    const cur = normalizeState(state);
    if (cur.phase === 'parent' || cur.phase === 'child') throw new Error('対戦中は始められません');
    const s = bump(state);
    s.phase = 'parent';
    s.result = null;
    s.match = { childUid, round: 1, parent: emptySide(), child: emptySide() };
    return s;
  }

  function canThrow(raw, by) {
    const state = normalizeState(raw);
    if (!state.match) return false;
    if (by === 'parent') return state.phase === 'parent' && !state.match.parent.done;
    if (by === 'child') return state.phase === 'child' && !state.match.child.done;
    return false;
  }

  /** 1投を反映する。結果が出たら result も返す(state.result にも入る)。 */
  function applyThrow(state, by, roll, settings, now = Date.now()) {
    if (!canThrow(state, by)) throw new Error(`${by} は今振れません`);
    const s = bump(state);
    const side = s.match[by];
    let hand = roll.shonben ? { ...SHONBEN } : evaluate(roll.dice);
    if (!hand && side.throws.length + 1 >= MAX_THROWS) hand = { ...NONE };
    const thr = { dice: roll.dice.slice(), seed: roll.seed, shonben: !!roll.shonben, hand, at: now };
    side.throws.push(thr);
    s.lastThrow = { by, seq: s.seq, throw: thr };
    let result = null;
    if (hand) {
      side.hand = hand;
      side.done = true;
      if (by === 'parent') {
        if (hand.lose) result = finish(s, settings);
        else s.phase = 'child';
      } else {
        const verdict = judge(s.match.parent.hand, hand);
        if (verdict.winner === 'draw') {
          s.match.round += 1;
          s.match.parent = emptySide();
          s.match.child = emptySide();
          s.phase = 'parent';
        } else {
          result = finish(s, settings);
        }
      }
    }
    return { state: s, result };
  }

  function finish(s, settings) {
    const parentHand = s.match.parent.hand;
    const childHand = s.match.child.hand;
    const verdict = judge(parentHand, childHand);
    const deltas = resultDeltas(verdict, settings);
    const result = { winner: verdict.winner, mult: verdict.mult, parentHand, childHand, deltas, childUid: s.match.childUid };
    s.host.points += deltas.parent.points;
    s.host.wins += deltas.parent.wins;
    s.host.losses += deltas.parent.losses;
    s.host.drinks += deltas.parent.drinks;
    s.result = result;
    s.phase = 'result';
    return result;
  }

  function nextMatch(state) {
    const s = bump(state);
    s.phase = 'lobby';
    s.match = null;
    s.result = null;
    return s;
  }

  return {
    DRINK_UNITS, POINT_UNITS, SHONBEN_RATE, MAX_THROWS, NONE, SHONBEN, HIFUMI,
    evaluate, penaltyMult, judge, resultDeltas, rollDice,
    createState, normalizeState, startMatch, canThrow, applyThrow, nextMatch,
  };
})();
if (typeof module !== 'undefined') module.exports = ChinchiroLogic;
