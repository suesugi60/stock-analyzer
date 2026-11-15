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

  return { DRINK_UNITS, POINT_UNITS, SHONBEN_RATE, NONE, SHONBEN, HIFUMI, evaluate, penaltyMult, judge, resultDeltas, rollDice };
})();
if (typeof module !== 'undefined') module.exports = ChinchiroLogic;
