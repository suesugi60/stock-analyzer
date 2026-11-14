// リスナー画面。
import { connect } from './net.mjs';
import { analyzeCard, normalizeName, isValidCount, isValidToken, LIMITS, WINNERS_SHOWN } from './logic.mjs';
import { el, clear, renderBall, renderCard, renderWinners, renderWaiting, toast, confirmDialog } from './view.mjs';
import { playDraw, cancelDraw } from './draw-show.mjs';

const TOKEN_KEY = 'bingo.v1.token';
const EMPTY_YOU = { name: null, blocked: false, pending: null, rejected: false, cards: [] };

const $ = (id) => document.getElementById(id);
const dom = {
  conn: $('conn'), current: $('current'), drawnCount: $('drawn-count'),
  status: $('status'), form: $('form'), nameRow: $('name-row'), name: $('name'), count: $('count'),
  requestBtn: $('request-btn'), moreClose: $('more-close'), cancelBtn: $('cancel-btn'), moreBtn: $('more-btn'),
  storageNote: $('storage-note'), mine: $('mine'), summary: $('summary'), cards: $('cards'),
  winnersBox: $('winners-box'), winners: $('winners'), winnersNote: $('winners-note'),
  waitingBox: $('waiting-box'), waitingList: $('waiting-list'), waitingNote: $('waiting-note'),
  historyBox: $('history-box'), history: $('history'),
  copyLink: $('copy-link'), linkText: $('link-text'), celebrate: $('celebrate'),
};

const state = {
  ready: false,      // 最初の状態を受け取ったか
  online: false,
  accepting: false,
  delay: 0,          // 反映の遅れ(秒)
  draws: [],         // サーバーが発表した番号(すべて)
  shown: 0,          // そのうち、画面に見せてよい個数
  winners: [],
  waiting: { list: [], total: 0 }, // リーチの人(画面に見せている分)
  you: EMPTY_YOU,
  moreOpen: false,   // 「追加で申請する」を開いているか
  sending: false,    // 申請・取り消しの返事を待っているか
};

let token = null;
let net = null;
let linkToken = null;           // 引き継ぎリンクで渡された合い札(まだ切り替えていない)
const revealTimers = new Map(); // 何個目の番号か → タイマー
// 「何個目の番号まで出た時点か」→ リーチの人の一覧。まだ見せていない番号の分を、ここで待たせる。
const pendingWaiting = new Map();
let showingSeq = null;          // いま抽選の演出を見せている番号(何個目か)
let showToken = 0;              // 演出の打ち切りを見分けるための通し番号
const cardNodes = new Map();    // カード番号 → 要素
let knownBingo = null;          // 前回の描画でビンゴしていたカード番号(初回は null)
let lastShown = 0;

// ---- 合い札(このブラウザが誰かを示す秘密の文字列) ----

function readStored() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function store(value) {
  try { localStorage.setItem(TOKEN_KEY, value); return localStorage.getItem(TOKEN_KEY) === value; } catch { return false; }
}

function newToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// 引き継ぎリンク(#k=合い札)で開かれたら、その合い札を使う。アドレス欄からはすぐ消す。
// このブラウザにすでに別の合い札があるときは、まずそちらでつなぎ、
// カードや申請を持っているかを見てから切り替える(considerHandover)。
function resolveToken() {
  const match = /^#k=([0-9a-f]{64})$/.exec(location.hash);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  const saved = readStored();
  const stored = isValidToken(saved) ? saved : null;

  let chosen = stored;
  if (match && !stored) chosen = match[1];
  else if (match && match[1] !== stored) linkToken = match[1];
  if (!chosen) chosen = newToken();
  if (!store(chosen)) dom.storageNote.hidden = false;
  return chosen;
}

// いまの合い札でカードも申請も持っていなければ、黙って切り替える。持っていれば確かめる。
async function considerHandover(candidate, you) {
  if (you.cards.length > 0 || you.pending !== null) {
    const have = you.cards.length > 0 ? `${you.name} さんのカード ${you.cards.length}枚` : `${you.name} さんの申請`;
    const ok = await confirmDialog(
      `このブラウザには ${have} が保存されています。引き継ぎリンクのカードに切り替えますか?(いまのカードは、このブラウザでは見られなくなります)`,
      { ok: '切り替える', cancel: 'いまのまま' });
    if (!ok) return;
  }
  token = candidate;
  if (!store(token)) dom.storageNote.hidden = false;
  knownBingo = null; // 切り替えた直後は祝わない
  state.moreOpen = false;
  net.send({ t: 'hello', token });
}

// ---- 反映の遅れ ----

function clearReveals() {
  for (const timer of revealTimers.values()) clearTimeout(timer);
  revealTimers.clear();
}

// 見せてよい番号が進んだら、そこまでの時点のリーチの一覧に切り替える。
function advanceWaiting() {
  let best = -1;
  for (const seq of pendingWaiting.keys()) if (seq <= state.shown && seq > best) best = seq;
  if (best >= 0) state.waiting = pendingWaiting.get(best);
  for (const seq of [...pendingWaiting.keys()]) if (seq <= state.shown) pendingWaiting.delete(seq);
}

// 見せている途中の演出を打ち切る。その番号は、演出の続きとしては出さない。
function stopShow() {
  showToken++;
  showingSeq = null;
  cancelDraw();
}

// seq 個目の番号を見せる。抽選機の演出を挟み、終わってから穴を開ける。
function reveal(seq) {
  revealTimers.delete(seq);
  if (seq > state.draws.length || seq <= state.shown) { render(); return; }
  // 前の番号の演出がまだ続いていたら、その番号は先に出してしまう
  if (showingSeq !== null && showingSeq < seq && showingSeq <= state.draws.length) {
    state.shown = Math.max(state.shown, showingSeq);
    advanceWaiting();
  }
  const token = ++showToken;
  showingSeq = seq;
  render();
  playDraw({ n: state.draws[seq - 1] }).then(() => {
    if (token !== showToken) return; // 取り消しや取り直しで打ち切られた
    showingSeq = null;
    if (seq <= state.draws.length && seq > state.shown) { state.shown = seq; advanceWaiting(); }
    render();
  });
}

function scheduleReveal(seq, waitMs) {
  clearTimeout(revealTimers.get(seq));
  if (waitMs <= 0) { revealTimers.delete(seq); reveal(seq); return; }
  revealTimers.set(seq, setTimeout(() => reveal(seq), waitMs));
}

// ---- サーバーからのメッセージ ----

const ERROR_TEXT = {
  closed: 'いまは受付していません',
  already_pending: 'すでに申請中です',
  bad_name: '名前は1〜20文字で入れてください',
  bad_count: `枚数は1〜${LIMITS.COUNT_MAX}枚で入れてください`,
  blocked: '申請できません',
  busy: '混み合っています。少し待ってからもう一度お試しください',
  no_pending: '取り消せる申請がありません',
};

function onMessage(msg) {
  switch (msg.t) {
    case 'state': {
      clearReveals();
      stopShow();
      state.ready = true;
      state.accepting = msg.accepting;
      state.delay = msg.delay;
      state.draws = msg.draws;
      state.winners = msg.winners;
      state.you = msg.you;
      state.sending = false;
      // 最後の1個だけ、発表からの経過時間に応じて待つ。それ以前はすぐ見せる。
      const total = msg.draws.length;
      const wait = total > 0 && msg.lastAge !== null ? state.delay * 1000 - msg.lastAge : 0;
      pendingWaiting.clear();
      if (wait > 0 && state.shown < total) {
        state.shown = total - 1;
        // リーチの一覧も、最後の番号と一緒に出す(それまでは、いま見せている一覧のまま)
        pendingWaiting.set(total, msg.waiting);
        scheduleReveal(total, wait);
      } else {
        state.shown = total;
        state.waiting = msg.waiting;
      }
      if (linkToken) {
        const candidate = linkToken;
        linkToken = null;
        considerHandover(candidate, msg.you);
      }
      break;
    }
    case 'you':
      state.you = msg.you;
      state.sending = false;
      if (msg.you.pending !== null || msg.you.blocked) state.moreOpen = false;
      break;
    case 'draw':
      state.draws.length = Math.min(state.draws.length, msg.seq - 1);
      state.draws[msg.seq - 1] = msg.n;
      state.winners = state.winners.filter((w) => w.at < msg.seq).concat(msg.winners);
      pendingWaiting.set(msg.seq, msg.waiting);
      scheduleReveal(msg.seq, state.delay * 1000);
      return; // 描画は reveal がする
    case 'undo':
      clearTimeout(revealTimers.get(msg.seq));
      revealTimers.delete(msg.seq);
      if (showingSeq !== null && showingSeq >= msg.seq) stopShow();
      for (const seq of [...pendingWaiting.keys()]) if (seq >= msg.seq) pendingWaiting.delete(seq);
      state.draws.length = Math.min(state.draws.length, msg.seq - 1);
      state.winners = state.winners.filter((w) => w.at < msg.seq);
      state.shown = Math.min(state.shown, state.draws.length);
      break;
    case 'winners':
      state.winners = msg.winners;
      break;
    case 'waiting':
      // その時点の番号まで見せていれば、すぐ切り替える。まだなら、その番号が出るときまで待たせる。
      if (msg.seq <= state.shown) state.waiting = msg.waiting;
      else pendingWaiting.set(msg.seq, msg.waiting);
      break;
    case 'accepting':
      state.accepting = msg.on;
      break;
    case 'delay':
      state.delay = msg.sec;
      break;
    case 'round':
      clearReveals();
      stopShow();
      pendingWaiting.clear();
      state.waiting = { list: [], total: 0 };
      state.draws = [];
      state.winners = [];
      state.shown = 0;
      break;
    case 'reset':
      clearReveals();
      stopShow();
      pendingWaiting.clear();
      state.waiting = { list: [], total: 0 };
      state.draws = [];
      state.winners = [];
      state.shown = 0;
      state.you = EMPTY_YOU;
      state.moreOpen = false;
      state.sending = false;
      break;
    case 'error':
      state.sending = false;
      toast(ERROR_TEXT[msg.code] || 'うまくいきませんでした。もう一度お試しください');
      break;
    default:
      return;
  }
  render();
}

// ---- 描画 ----

function render() {
  const you = state.you;
  const called = new Set(state.draws.slice(0, state.shown));
  const hasCards = you.cards.length > 0;

  // 接続
  dom.conn.textContent = state.online ? '接続中' : '再接続中…';
  dom.conn.classList.toggle('off', !state.online);

  // いまの番号
  const latest = state.shown > 0 ? state.draws[state.shown - 1] : null;
  if (latest === null) {
    dom.current.className = 'ball big empty';
    dom.current.removeAttribute('data-letter');
    dom.current.textContent = '–';
    dom.drawnCount.textContent = 'まだ番号は出ていません';
  } else {
    const ball = renderBall(latest, 'big');
    dom.current.className = ball.className;
    dom.current.dataset.letter = ball.dataset.letter;
    dom.current.textContent = String(latest);
    dom.drawnCount.textContent = `${state.shown}個目`;
    if (state.shown !== lastShown) {
      dom.current.classList.remove('flash');
      void dom.current.offsetWidth; // 動きをやり直す
      dom.current.classList.add('flash');
    }
  }
  lastShown = state.shown;

  // これまでの番号(新しい順)
  clear(dom.history);
  for (let i = state.shown - 1; i >= 0; i--) {
    dom.history.appendChild(renderBall(state.draws[i], 'small'));
    dom.history.appendChild(document.createTextNode(' '));
  }
  dom.historyBox.hidden = state.shown === 0;

  // 申請まわり
  const canAsk = state.ready && !you.blocked && you.pending === null;
  const showForm = canAsk && (!hasCards || state.moreOpen);
  let status = '';
  if (!state.ready) status = '接続しています…';
  else if (you.blocked) status = '申請できません';
  else if (you.pending !== null) status = `主催者の許可を待っています(${you.pending}枚)`;
  else if (!hasCards) {
    if (you.rejected) status = state.accepting ? '今回は見送られました。もう一度申請できます' : '今回は見送られました。いまは受付していません';
    else if (!state.accepting) status = 'いまは受付していません。配信で受付が始まるまでお待ちください';
    else status = '名前とほしい枚数を入れて申請してください。主催者が許可するとカードが届きます';
  } else if (state.moreOpen && !state.accepting) status = 'いまは受付していません';
  dom.status.textContent = status;
  dom.status.hidden = status === '';

  dom.form.hidden = !showForm;
  dom.nameRow.hidden = hasCards; // カードを持ったら名前は変えられない
  if (!hasCards && you.name && dom.name.value === '' && document.activeElement !== dom.name) dom.name.value = you.name;
  dom.requestBtn.disabled = !state.online || !state.accepting || state.sending;
  dom.requestBtn.textContent = hasCards ? '追加で申請する' : '申請する';
  dom.moreClose.hidden = !hasCards;
  dom.cancelBtn.hidden = !(state.ready && you.pending !== null && !you.blocked);
  dom.cancelBtn.disabled = !state.online || state.sending;
  dom.moreBtn.hidden = !(canAsk && hasCards && !state.moreOpen && state.accepting);
  // 出すものが何もなければ枠ごと隠す。「追加で申請する」だけなら枠なしで小さく出す。
  const entry = $('entry');
  const onlyMore = status === '' && dom.form.hidden && dom.cancelBtn.hidden && dom.storageNote.hidden;
  entry.hidden = onlyMore && dom.moreBtn.hidden;
  entry.classList.toggle('compact', onlyMore);
  dom.moreBtn.classList.toggle('small', onlyMore);

  // カード
  const nowBingo = new Set();
  const analyzed = you.cards.map((card) => {
    const a = analyzeCard(card.numbers, called);
    if (a.lines > 0) nowBingo.add(card.no);
    return { card, a };
  });
  // ビンゴ → あと少しの順 → 配られた順
  analyzed.sort((x, y) => (x.a.need - y.a.need) || (x.card.no - y.card.no));
  const keep = new Set();
  for (const { card } of analyzed) {
    keep.add(card.no);
    let node = cardNodes.get(card.no);
    // 別のカードに入れ替わっていたら作り直す(すべてリセットのあとなど)
    if (node && node.dataset.numbers !== card.numbers.join(',')) { node.remove(); node = null; }
    const fresh = renderCard(card, called, node || null);
    fresh.dataset.numbers = card.numbers.join(',');
    cardNodes.set(card.no, fresh);
    dom.cards.appendChild(fresh); // 並べ替えも兼ねる
  }
  for (const [no, node] of cardNodes) if (!keep.has(no)) { node.remove(); cardNodes.delete(no); }

  dom.mine.hidden = !hasCards;
  if (hasCards) {
    const reachCount = analyzed.filter((x) => x.a.lines === 0 && x.a.reach > 0).length;
    clear(dom.summary);
    dom.summary.appendChild(el('span', { class: 'summary-name', text: you.name }));
    dom.summary.appendChild(document.createTextNode(` さんのカード ${you.cards.length}枚`));
    if (nowBingo.size > 0) dom.summary.appendChild(el('span', { class: 'chip chip-bingo', text: `ビンゴ ${nowBingo.size}` }));
    if (reachCount > 0) dom.summary.appendChild(el('span', { class: 'chip chip-reach', text: `リーチ ${reachCount}` }));
  }

  // 新しくビンゴしたら祝う(開いた直後は祝わない)
  if (knownBingo !== null) {
    for (const no of nowBingo) if (!knownBingo.has(no)) { celebrate(); break; }
  }
  if (state.ready) knownBingo = nowBingo;

  // リーチの人と待ち番号
  renderWaiting(dom.waitingList, dom.waitingNote, state.waiting);
  dom.waitingBox.hidden = state.waiting.list.length === 0;

  // ビンゴした人(見せてよい番号までの分)
  const visibleWinners = state.winners.filter((w) => w.at <= state.shown);
  renderWinners(dom.winners, visibleWinners);
  dom.winnersBox.hidden = visibleWinners.length === 0;
  dom.winnersNote.hidden = visibleWinners.length < WINNERS_SHOWN;
}

let celebrateTimer = null;
function celebrate() {
  clear(dom.celebrate);
  dom.celebrate.appendChild(el('span', { class: 'celebrate-text', text: 'BINGO!' }));
  const colors = ['B', 'I', 'N', 'G', 'O'];
  for (let i = 0; i < 28; i++) {
    const piece = el('i', { class: `confetti col-${colors[i % 5]}` });
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.animationDelay = `${Math.random() * 0.6}s`;
    piece.style.animationDuration = `${1.6 + Math.random() * 1.2}s`;
    dom.celebrate.appendChild(piece);
  }
  dom.celebrate.hidden = false;
  clearTimeout(celebrateTimer);
  celebrateTimer = setTimeout(() => { dom.celebrate.hidden = true; }, 3200);
}

// ---- 操作 ----

function clampCount(value) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(LIMITS.COUNT_MAX, Math.max(1, Math.round(value)));
}

$('count-minus').addEventListener('click', () => { dom.count.value = String(clampCount(Number(dom.count.value) - 1)); });
$('count-plus').addEventListener('click', () => { dom.count.value = String(clampCount(Number(dom.count.value) + 1)); });

dom.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const hasCards = state.you.cards.length > 0;
  const name = hasCards ? state.you.name : normalizeName(dom.name.value);
  if (!name) { toast(ERROR_TEXT.bad_name); dom.name.focus(); return; }
  const count = Number(dom.count.value);
  if (dom.count.value.trim() === '' || !isValidCount(count)) { toast(ERROR_TEXT.bad_count); dom.count.focus(); return; }
  state.sending = true;
  net.send({ t: 'request', name, count });
  render();
});

dom.cancelBtn.addEventListener('click', () => {
  state.sending = true;
  net.send({ t: 'cancel' });
  render();
});

dom.moreBtn.addEventListener('click', () => { state.moreOpen = true; dom.count.value = '1'; render(); });
dom.moreClose.addEventListener('click', () => { state.moreOpen = false; render(); });
dom.celebrate.addEventListener('click', () => { dom.celebrate.hidden = true; });

dom.copyLink.addEventListener('click', async () => {
  const link = `${location.origin}/#k=${token}`;
  dom.linkText.value = link;
  dom.linkText.hidden = false;
  try {
    await navigator.clipboard.writeText(link);
    toast('コピーしました');
  } catch {
    dom.linkText.focus();
    dom.linkText.select();
    toast('下のリンクを長押ししてコピーしてください');
  }
});

// ---- 開始 ----

function start() {
  token = resolveToken();
  net = connect({
    onOpen: (send) => send({ t: 'hello', token }),
    onMessage,
    onStatus: (online) => { state.online = online; if (!online) state.sending = false; render(); },
  });
}

// すでに開いているページに引き継ぎリンクを貼り付けたときは、読み込み直して合い札を取り込む。
window.addEventListener('hashchange', () => { if (location.hash.startsWith('#k=')) location.reload(); });

render();
start();
