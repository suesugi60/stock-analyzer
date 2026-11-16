// ===== 画面の部品: ミニサイコロ・投げの履歴・役の順位・ルール表・対戦の記録(HTML 文字列を作る純粋関数) =====
// ブラウザでは globalThis.ChinchiroWidgets、Node では require で読める。DOM に触らない。
const ChinchiroWidgets = (() => {
  'use strict';
  const A = typeof ChinchiroAnim !== 'undefined' ? ChinchiroAnim : require('./anim.js');
  const L = typeof ChinchiroLogic !== 'undefined' ? ChinchiroLogic : require('./logic.js');

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const okDie = (n) => Number.isInteger(n) && n >= 1 && n <= 6;

  /** 1 つのミニサイコロ。出目が不正なら「?」。 */
  function dieHtml(n) {
    if (!okDie(n)) return '<span class="mdice bad" data-n="?">?</span>';
    return `<span class="mdice" data-n="${n}">${A.PIPS[n].map(([r, c]) => `<i style="grid-area:${r}/${c}"></i>`).join('')}</span>`;
  }
  /** 3 つのミニサイコロ。 */
  function diceHtml(dice) {
    const d = Array.isArray(dice) ? dice : [];
    return [0, 1, 2].map((i) => dieHtml(d[i])).join('');
  }

  const throwLabel = (t) => (t.shonben ? 'ションベン' : t.hand ? t.hand.label : '目なし');
  /** 対戦中の 1〜3 投目(投げた順)。 */
  function throwsHtml(throws) {
    if (!Array.isArray(throws) || !throws.length) return '';
    return `<div class="throws">${throws.map((t, i) => `<span class="throw"><b>${i + 1}</b>${diceHtml(t.dice)}<em>${esc(throwLabel(t))}</em></span>`).join('')}</div>`;
  }

  /** 役の一覧(倍率はロジックから取るので表とルールが食い違わない)。 */
  function hands() {
    const pay = L.penaltyMult(L.HIFUMI);
    return [
      { name: 'ピンゾロ', dice: [1, 1, 1], mult: L.evaluate([1, 1, 1]).mult, note: 'いちばん強い' },
      { name: 'ゾロ目', dice: [6, 6, 6], mult: L.evaluate([6, 6, 6]).mult, note: '2〜6 のゾロ目。大きい数が強い' },
      { name: 'シゴロ', dice: [4, 5, 6], mult: L.evaluate([4, 5, 6]).mult, note: '4・5・6' },
      { name: '目', dice: [2, 2, 5], mult: L.evaluate([2, 2, 5]).mult, note: '同じ数2つ + 別の数1つ(例は 5の目)。6が強く1が弱い' },
      { name: '目なし', dice: [2, 4, 6], again: true, note: '役なし。負けではなく、役が出るまで振り直し' },
      { name: 'ヒフミ', dice: [1, 2, 3], lose: true, pay, note: `${pay}倍払う` },
      { name: 'ションベン', dice: null, lose: true, pay: 1, note: '器から飛び出し(たまに)' },
    ];
  }

  /** 1 行の順位表(配信画面用)。 */
  function legendHtml() {
    const parts = hands().filter((h) => h.name !== 'ションベン' && !h.again)
      .map((h) => (h.lose ? (h.pay > 1 ? `${h.name} ×${h.pay}払い` : h.name) : `${h.name} ×${h.mult}`));
    return `<span class="legend-text">${parts.map(esc).join(' ＞ ')}</span>`;
  }

  const drinkLabel = (settings) => (L.DRINK_UNITS[settings.drinkUnit] || L.DRINK_UNITS.sip).label;
  /** ルール表(オーバーレイの中身)。部屋の設定で実際に動く点・飲みも書く。 */
  function rulesHtml(settings) {
    const s = settings && typeof settings === 'object' ? settings : {};
    const mode = s.mode === 'drink' || s.mode === 'both' ? s.mode : 'points';
    const unit = L.POINT_UNITS.includes(s.unit) ? s.unit : L.POINT_UNITS[0];
    const usePts = mode !== 'drink';
    const useDr = mode !== 'points';
    const dl = drinkLabel(s);
    const rows = hands().map((h) => `<tr><td>${h.dice ? diceHtml(h.dice) : '<span class="mdice-out">🥣→</span>'}</td><th>${esc(h.name)}</th><td class="mult">${h.again ? '振り直し' : h.lose ? '負け' : `×${h.mult}`}</td><td class="note">${esc(h.note)}</td></tr>`).join('');
    const room = [];
    if (usePts) room.push(`持ち点 ${L.startPoints(s)}`, `1戦 ${unit}点 × 倍率`);
    if (useDr) room.push(`飲みは ${dl} × 倍率`);
    const ex = [];
    if (usePts) ex.push(`${unit * 2}点払${useDr ? 'って' : 'う'}`);
    if (useDr) ex.push(`${dl} × 2 飲む`);
    return `<h3 class="rules-title">📖 ルール</h3>
<p class="rules-lead">強い順。勝った側の倍率(または負けた役の罰)ぶん、負けた側が払う。</p>
<table class="rules-table">${rows}</table>
<ul class="rules-flow">
<li>親(配信者)が先に振って役を決める → 子(リスナー)が振る。目なしは何度でも振り直し。</li>
<li>親が負け役なら子は振らずに勝ち。同じ役は引き分けで、両方もう一度。</li>
<li>払う倍率は、勝った役の倍率と負けた役の罰(ヒフミ=${L.penaltyMult(L.HIFUMI)})の大きい方。</li>
</ul>
<p class="rules-room">この部屋: ${esc(room.join(' ・ '))}</p>
<p class="rules-ex">例: 親がシゴロ(×2)で勝ち → 子は ${esc(ex.join(' '))}</p>`;
  }

  /** 対戦の記録(新しい順)。自分の行は .mine、非表示の人は ？？？。 */
  function logHtml(log, opts = {}) {
    if (!Array.isArray(log) || !log.length) return '<div class="empty-note">まだ対戦がありません</div>';
    const o = opts || {};
    const settings = o.settings || {};
    const players = o.players || {};
    const mode = settings.mode === 'drink' || settings.mode === 'both' ? settings.mode : 'points';
    const usePts = mode !== 'drink';
    const useDr = mode !== 'points';
    const side = (x) => (x ? `${diceHtml(x.dice)}<em>${esc(x.hand ? x.hand.label : '目なし')}</em>` : '<em>(振らず)</em>');
    return log.map((e) => {
      const p = Object.hasOwn(players, e.uid) ? players[e.uid] : null;
      const name = p && p.hidden ? '？？？' : (e.name || 'リスナー');
      const winner = e.w === 'parent' ? '親の勝ち' : `${name}の勝ち`;
      const pts = usePts ? `<span class="lpt ${e.pt > 0 ? 'plus' : e.pt < 0 ? 'minus' : ''}">${e.pt > 0 ? '+' : ''}${Number(e.pt) || 0}点</span>` : '';
      const dr = useDr && e.dr ? `<span class="ldr">🍺×${Number(e.dr)}</span>` : '';
      const round = e.round > 1 ? `<small>${Number(e.round)}回戦</small>` : '';
      return `<div class="log-row${e.uid === o.meUid ? ' mine' : ''}"><span class="ln">#${Number(e.n) || ''}</span><span class="lside"><b>親</b>${side(e.p)}</span><span class="lvs">vs</span><span class="lside"><b>${esc(name)}</b>${side(e.c)}</span><span class="lres">→ ${esc(winner)} ×${Number(e.m) || 1}${round}</span>${pts}${dr}</div>`;
    }).join('');
  }

  return { esc, dieHtml, diceHtml, throwsHtml, legendHtml, rulesHtml, logHtml, hands };
})();
if (typeof module !== 'undefined') module.exports = ChinchiroWidgets;
