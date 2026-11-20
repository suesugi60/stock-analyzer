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
      { name: '目なし', dice: [2, 4, 6], weakest: true, mult: L.NONE.mult, note: `${L.MAX_THROWS}投しても役なし。いちばん弱い役(相手も目なしなら引き分け)` },
      { name: 'ヒフミ', dice: [1, 2, 3], lose: true, pay, note: `${pay}倍払う` },
      { name: 'ションベン', dice: null, lose: true, pay: 1, note: '器から飛び出し(たまに)' },
    ];
  }

  /** 1 行の順位表(配信画面用)。 */
  function legendHtml() {
    const parts = hands().filter((h) => h.name !== 'ションベン')
      .map((h) => (h.weakest ? h.name : h.lose ? (h.pay > 1 ? `${h.name} ×${h.pay}払い` : h.name) : `${h.name} ×${h.mult}`));
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
    const rows = hands().map((h) => `<tr><td>${h.dice ? diceHtml(h.dice) : '<span class="mdice-out">🥣→</span>'}</td><th>${esc(h.name)}</th><td class="mult">${h.weakest ? '最弱' : h.lose ? '負け' : `×${h.mult}`}</td><td class="note">${esc(h.note)}</td></tr>`).join('');
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
<li>親(配信者)が先に振って役を決める → 子(リスナー)が振る。各${L.MAX_THROWS}投まで。${L.MAX_THROWS}投で役が出なければ「目なし」(いちばん弱い)。</li>
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

  /**
   * 誰がどうやって勝ったかを文にする。names = { host, child }(伏せる名前は呼び出し側で ？？？ にしておく)。
   * @returns {{ headline: string, why: string, pay: string }}
   */
  function resultSummary(result, names, settings) {
    const s = settings && typeof settings === 'object' ? settings : {};
    const mode = s.mode === 'drink' || s.mode === 'both' ? s.mode : 'points';
    const unit = L.POINT_UNITS.includes(s.unit) ? s.unit : L.POINT_UNITS[0];
    const host = (names && names.host) || '配信者';
    const child = (names && names.child) || '挑戦者';
    const ph = result.parentHand || null;
    const ch = result.childHand || null;
    if (result.winner === 'draw') return { headline: '引き分け! もう一度', why: ph ? `${ph.label} 同士` : '', pay: '' };
    const parentWon = result.winner === 'parent';
    const winName = parentWon ? host : child;
    const loseName = parentWon ? child : host;
    const winHand = parentWon ? ph : ch;
    const loseHand = parentWon ? ch : ph;
    let why = '';
    if (loseHand && loseHand.lose) {
      const pen = L.penaltyMult(loseHand);
      why = `${loseName} は${loseHand.label}(負け${pen > 1 ? `・${pen}倍払い` : ''})${ch ? '' : `。${child} は振らずに勝ち`}`;
    } else if (winHand && loseHand) {
      why = `${winHand.label}(×${winHand.mult}) ＞ ${loseHand.label}${loseHand.type === 'none' ? '' : `(×${loseHand.mult})`}`;
    }
    const pay = [];
    if (mode !== 'drink') pay.push(`${loseName} → ${winName} に ${unit * result.mult}点`);
    if (mode !== 'points') pay.push(`${loseName} が ${drinkLabel(s)} × ${result.mult} 飲む`);
    return { headline: `${winName} の勝ち!`, why, pay: pay.join(' ・ ') };
  }

  /** 0 以上の整数だけ通す(壊れた値は 0)。 */
  const count = (v) => (Number.isInteger(v) && v > 0 ? v : 0);

  /**
   * 相手ごとの戦歴。対戦は必ず「配信者 対 リスナー1人」なので、リスナーの勝ち負けを裏返すと配信者から見た勝ち負けになる。
   * 対戦した人だけを、対戦の多い順 → 名前順で返す。非表示の人は名前を ？？？ に、ブロックした人は出さない。
   * @returns {{ uid: string, name: string, char: string, hidden: boolean, wins: number, losses: number, games: number }[]}
   */
  function versusList(players) {
    if (!players || typeof players !== 'object') return [];
    const list = [];
    for (const [uid, p] of Object.entries(players)) {
      if (!p || typeof p !== 'object' || p.banned) continue;
      const wins = count(p.losses);
      const losses = count(p.wins);
      if (wins + losses === 0) continue;
      const name = p.hidden ? '？？？' : (typeof p.name === 'string' && p.name ? p.name : 'リスナー');
      list.push({ uid, name, char: p.char, hidden: !!p.hidden, wins, losses, games: wins + losses });
    }
    return list.sort((a, b) => b.games - a.games || a.name.localeCompare(b.name, 'ja') || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
  }

  /** リスナー1人との戦歴を「2勝1敗」(配信者から見て)にする。まだ対戦が無ければ空文字。 */
  function versusText(player) {
    if (!player || typeof player !== 'object') return '';
    const wins = count(player.losses);
    const losses = count(player.wins);
    return wins + losses === 0 ? '' : `${wins}勝${losses}敗`;
  }

  return { esc, dieHtml, diceHtml, throwsHtml, legendHtml, rulesHtml, logHtml, hands, resultSummary, versusList, versusText };
})();
if (typeof module !== 'undefined') module.exports = ChinchiroWidgets;
