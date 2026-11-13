// 主催者画面。
import { connect } from './net.mjs';
import { DELAYS, LIMITS, MAX_NUMBER, WINNERS_SHOWN } from './logic.mjs';
import { el, clear, renderBall, renderWinners, toast, confirmDialog, letterOf } from './view.mjs';

const PASSWORD_KEY = 'bingo.v1.hostpw';

const $ = (id) => document.getElementById(id);
const dom = {
  conn: $('host-conn'), login: $('login'), loginForm: $('login-form'), password: $('password'),
  setup: $('setup'), setupForm: $('setup-form'), newPassword: $('new-password'), newPassword2: $('new-password2'),
  setupBtn: $('setup-btn'), setupError: $('setup-error'),
  loginBtn: $('login-btn'), loginError: $('login-error'), panel: $('panel'),
  toggle: $('accepting-toggle'), totals: $('totals'), delay: $('delay-select'),
  requests: $('requests'), requestsEmpty: $('requests-empty'), approveAll: $('approve-all'),
  current: $('host-current'), drawnCount: $('host-drawn-count'), drawBtn: $('draw-btn'), undoBtn: $('undo-btn'),
  board: $('board'), winnerStats: $('winner-stats'), winners: $('host-winners'), winnersNote: $('host-winners-note'),
  participants: $('participants'), participantsEmpty: $('participants-empty'),
  blockedBox: $('blocked-box'), blocked: $('blocked'),
};

function readPassword() { try { return localStorage.getItem(PASSWORD_KEY); } catch { return null; } }
function savePassword(value) { try { localStorage.setItem(PASSWORD_KEY, value); } catch { /* 保存できなくても動く */ } }
function forgetPassword() { try { localStorage.removeItem(PASSWORD_KEY); } catch { /* 同上 */ } }

let password = readPassword();
let needSetup = null;            // 合言葉をこれから決める必要があるか(null は未確認)
let online = false;
let authed = false;
let snap = null;                 // サーバーから届いた最新の全体
const editedCounts = new Map();  // 申請ID → 主催者が変えた枚数
const requestRows = new Map();   // 申請ID → 行の要素
let busyDraw = false;            // 二度押しで2つ引かないため
let rowLockUntil = 0;            // 申請の行が消えた直後は、許可・却下の押下を受け付けない
let rowLockTimer = null;
let retryTimer = null;           // 締め出し中の入り直し

const PASSWORD_MIN = 8;          // 画面から決める合言葉の長さ(サーバーと同じ値)
const ROW_LOCK_MS = 600;         // 行が消えて次の行が指の下に来たときの、二度押しを防ぐ時間
const LOCKED_RETRY_MS = 30000;   // 締め出されている間、この間隔で入り直しを試す

const AUTH_TEXT = {
  wrong: '合言葉が違います',
  locked: 'まちがいが続いたため、しばらく入れません。5分ほど待ってからお試しください',
};

const ERROR_TEXT = {
  not_found: 'その申請や参加者は、もうありません',
  cards_full: `カードの上限(${LIMITS.CARDS_MAX.toLocaleString()}枚)を超えるため許可できません`,
  bad_count: `枚数は1〜${LIMITS.COUNT_MAX}枚です`,
  already_called: 'その番号はもう出ています',
  all_called: '75個すべて出ました',
  nothing_to_undo: '取り消す番号がありません',
};

const net = connect({
  onOpen(send) {
    // 合言葉を覚えていれば名乗る。なければ、これから決める必要があるかを尋ねる。
    if (password) send({ t: 'auth', password });
    else send({ t: 'host_status' });
    return true;
  },
  onMessage,
  onStatus(isOnline) { online = isOnline; render(); },
});

function onMessage(msg) {
  switch (msg.t) {
    case 'host':
      if (!authed) savePassword(password);
      authed = true;
      busyDraw = false;
      snap = msg;
      break;
    case 'req_add':
      if (!snap) return;
      if (!snap.requests.some((r) => r.id === msg.req.id)) snap.requests.push(msg.req);
      break;
    case 'req_del':
      if (!snap) return;
      snap.requests = snap.requests.filter((r) => r.id !== msg.id);
      editedCounts.delete(msg.id);
      break;
    case 'player': {
      if (!snap) return;
      const i = snap.players.findIndex((p) => p.pid === msg.player.pid);
      if (i >= 0) snap.players[i] = msg.player;
      else snap.players.push(msg.player);
      snap.players.sort((a, b) => a.pid - b.pid);
      break;
    }
    case 'host_status':
      needSetup = msg.setup;
      break;
    case 'auth_fail':
      authed = false;
      snap = null;
      clearTimeout(retryTimer);
      if (msg.reason === 'unset') {
        // まだ誰も合言葉を決めていない。決める画面へ。
        password = null;
        forgetPassword();
        needSetup = true;
        dom.loginError.hidden = true;
        break;
      }
      needSetup = false;
      if (msg.reason === 'locked' && password) {
        // 合言葉は合っているかもしれない(同じ接続元の他人の間違いでも締め出される)。
        // 消さずに持っておき、締め出しが解けたら自動で入り直す。
        retryTimer = setTimeout(() => { if (!authed && password) net.send({ t: 'auth', password }); }, LOCKED_RETRY_MS);
      } else {
        password = null;
        forgetPassword();
      }
      dom.loginError.textContent = AUTH_TEXT[msg.reason] || '入れませんでした';
      dom.loginError.hidden = false;
      break;
    case 'error':
      busyDraw = false;
      dom.setupBtn.disabled = false;
      if (msg.code === 'already_set') {
        // ほかの人が先に決めた(または Cloudflare の設定で決まっている)
        if (!authed) password = null;
        needSetup = false;
        dom.loginError.textContent = 'すでに合言葉が決まっています。合言葉を入れてください';
        dom.loginError.hidden = false;
        break;
      }
      if (msg.code === 'bad_password') {
        dom.setupError.textContent = `合言葉は${PASSWORD_MIN}文字以上にしてください`;
        dom.setupError.hidden = false;
        break;
      }
      // 許可・却下が通らなかった行を、また押せるようにする
      for (const row of requestRows.values()) setRowBusy(row, false);
      // 接続し直したあとなど、主催者として扱われていなければ名乗り直す
      if (msg.code === 'forbidden' && password) { net.send({ t: 'auth', password }); return; }
      toast(ERROR_TEXT[msg.code] || 'うまくいきませんでした。もう一度お試しください');
      break;
    default:
      return;
  }
  render();
}

// ---- 描画 ----

function render() {
  dom.conn.textContent = online ? '接続中' : '再接続中…';
  dom.conn.classList.toggle('off', !online);

  const showPanel = authed && snap !== null;
  const showSetup = !showPanel && needSetup === true;
  // 合言葉の入力を出すのは、決める必要がないと分かっていて、まだ入っていないとき。
  // 名乗っている最中(合言葉を覚えていて、エラーも出ていない)は出さない。
  const waiting = password !== null && dom.loginError.hidden;
  dom.panel.hidden = !showPanel;
  dom.setup.hidden = !showSetup;
  dom.login.hidden = showPanel || showSetup || waiting || (needSetup === null && dom.loginError.hidden);
  dom.loginBtn.disabled = false;
  if (!showPanel) return;

  // 受付
  dom.toggle.setAttribute('aria-pressed', String(snap.accepting));
  dom.toggle.textContent = snap.accepting ? '受付中(押すと締め切る)' : '締め切り中(押すと受付を始める)';
  dom.toggle.classList.toggle('on', snap.accepting);
  const cardTotal = snap.players.reduce((sum, p) => sum + p.cards, 0);
  dom.totals.textContent = `参加 ${snap.players.length}人 / カード ${cardTotal}枚 / 申請 ${snap.requests.length}件`;
  if (document.activeElement !== dom.delay) dom.delay.value = String(snap.delay);

  renderRequests();
  renderNumbers();
  renderWinnersBox();
  renderPeople();
}

function requestRow(req) {
  const row = el('div', { class: 'req', dataset: { id: req.id } },
    el('span', { class: 'req-name', text: req.name }),
    el('span', { class: 'req-stepper' },
      el('button', { type: 'button', class: 'step req-minus', 'aria-label': '1枚へらす', text: '−' }),
      el('span', { class: 'req-count', text: String(req.count) }),
      el('span', { class: 'req-unit', text: '枚' }),
      el('button', { type: 'button', class: 'step req-plus', 'aria-label': '1枚ふやす', text: '＋' })),
    el('span', { class: 'req-actions' },
      el('button', { type: 'button', class: 'btn small primary approve', text: '許可' }),
      el('button', { type: 'button', class: 'btn small ghost reject', text: '却下' }),
      el('button', { type: 'button', class: 'btn small ghost req-block', text: 'ブロック' })));
  return row;
}

function rowsLocked() { return performance.now() < rowLockUntil; }

// 行ごとの「返事待ち」。許可・却下を押した行は、返事が来るまで押せない。
function setRowBusy(row, busy) {
  row.classList.toggle('busy', busy);
  syncRowButtons(row);
}

function syncRowButtons(row) {
  const disabled = row.classList.contains('busy') || rowsLocked();
  for (const button of row.querySelectorAll('.approve, .reject')) button.disabled = disabled;
}

// 行が消えると、下の行が同じ場所に上がってくる(許可・却下のほか、リスナーの取り消しや
// 別の端末の操作でも起きる)。続けて押された分が別の人に効かないよう、少しの間すべての行を押せなくする。
function lockRows() {
  rowLockUntil = performance.now() + ROW_LOCK_MS;
  clearTimeout(rowLockTimer);
  rowLockTimer = setTimeout(() => { for (const row of requestRows.values()) syncRowButtons(row); }, ROW_LOCK_MS + 20);
}

function renderRequests() {
  const ids = new Set(snap.requests.map((r) => r.id));
  for (const [id, row] of requestRows) {
    if (ids.has(id)) continue;
    row.remove();
    requestRows.delete(id);
    lockRows();
  }
  let previous = null;
  for (const req of snap.requests) {
    let row = requestRows.get(req.id);
    if (!row) { row = requestRow(req); requestRows.set(req.id, row); }
    row.querySelector('.req-count').textContent = String(editedCounts.get(req.id) ?? req.count);
    // 届いた順に並べる(すでに正しい位置なら動かさない)
    const expected = previous ? previous.nextSibling : dom.requests.firstChild;
    if (expected !== row) dom.requests.insertBefore(row, expected);
    syncRowButtons(row);
    previous = row;
  }
  dom.requestsEmpty.hidden = snap.requests.length > 0;
  dom.approveAll.disabled = snap.requests.length === 0 || !online;
}

function renderNumbers() {
  const draws = snap.draws;
  const latest = draws.length > 0 ? draws[draws.length - 1] : null;
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
    dom.drawnCount.textContent = `${draws.length}個目`;
  }
  const called = new Set(draws);
  for (const button of dom.board.querySelectorAll('.num')) {
    const isCalled = called.has(Number(button.dataset.n));
    button.classList.toggle('called', isCalled);
    button.classList.toggle('latest', Number(button.dataset.n) === latest);
    button.disabled = isCalled || !online;
  }
  dom.drawBtn.disabled = !online || busyDraw || draws.length >= MAX_NUMBER;
  dom.undoBtn.disabled = !online || draws.length === 0;
}

function renderWinnersBox() {
  const bingo = snap.players.reduce((sum, p) => sum + p.bingo, 0);
  const reach = snap.players.reduce((sum, p) => sum + p.reach, 0);
  dom.winnerStats.textContent = `ビンゴ ${bingo}枚 / リーチ ${reach}枚`;
  renderWinners(dom.winners, snap.winners);
  dom.winnersNote.hidden = snap.winners.length < WINNERS_SHOWN;
}

function renderPeople() {
  clear(dom.participants);
  for (const p of snap.players) {
    const status = el('span', { class: 'p-status' });
    if (p.bingo > 0) status.appendChild(el('span', { class: 'chip chip-bingo', text: `ビンゴ ${p.bingo}` }));
    if (p.reach > 0) status.appendChild(el('span', { class: 'chip chip-reach', text: `リーチ ${p.reach}` }));
    dom.participants.appendChild(el('div', { class: 'participant', dataset: { pid: p.pid } },
      el('span', { class: 'p-name', text: p.name }),
      el('span', { class: 'p-cards', text: `${p.cards}枚` }),
      status,
      el('button', { type: 'button', class: 'btn small ghost block', text: 'ブロック' })));
  }
  dom.participantsEmpty.hidden = snap.players.length > 0;

  clear(dom.blocked);
  for (const b of snap.blocked) {
    dom.blocked.appendChild(el('div', { class: 'blocked-row', dataset: { pid: b.pid } },
      el('span', { class: 'p-name', text: b.name }),
      el('button', { type: 'button', class: 'btn small ghost unblock', text: '解除' })));
  }
  dom.blockedBox.hidden = snap.blocked.length === 0;
}

// ---- 操作 ----

dom.loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = dom.password.value;
  if (value === '') return;
  password = value;
  dom.loginError.hidden = true;
  dom.loginBtn.disabled = true;
  net.send({ t: 'auth', password });
});

dom.setupForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = dom.newPassword.value;
  let problem = null;
  if (Array.from(value).length < PASSWORD_MIN) problem = `合言葉は${PASSWORD_MIN}文字以上にしてください`;
  else if (value !== dom.newPassword2.value) problem = '2つの入力が同じではありません。もう一度入れてください';
  if (problem) {
    dom.setupError.textContent = problem;
    dom.setupError.hidden = false;
    return;
  }
  dom.setupError.hidden = true;
  dom.setupBtn.disabled = true;
  password = value;
  net.send({ t: 'setup', password });
});

$('logout').addEventListener('click', () => {
  forgetPassword();
  location.reload();
});

dom.toggle.addEventListener('click', () => { net.send({ t: 'accepting', on: !snap.accepting }); });
dom.delay.addEventListener('change', () => { net.send({ t: 'delay', sec: Number(dom.delay.value) }); });

dom.requests.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  const row = event.target.closest('.req');
  if (!button || !row) return;
  const id = Number(row.dataset.id);
  const req = snap.requests.find((r) => r.id === id);
  if (!req) return;
  const count = editedCounts.get(id) ?? req.count;
  if (button.classList.contains('req-minus') || button.classList.contains('req-plus')) {
    const next = Math.min(LIMITS.COUNT_MAX, Math.max(1, count + (button.classList.contains('req-plus') ? 1 : -1)));
    editedCounts.set(id, next);
    row.querySelector('.req-count').textContent = String(next);
  } else if (button.classList.contains('approve') || button.classList.contains('reject')) {
    if (rowsLocked()) return;
    setRowBusy(row, true);
    if (button.classList.contains('approve')) net.send({ t: 'approve', id, count });
    else net.send({ t: 'reject', id });
  } else if (button.classList.contains('req-block')) {
    if (await confirmDialog(`${req.name} さんをブロックしますか?この申請は却下され、以後の申請も受け付けません。`, { ok: 'ブロックする' })) {
      net.send({ t: 'block', pid: req.pid });
    }
  }
});

dom.approveAll.addEventListener('click', async () => {
  const count = snap.requests.length;
  if (await confirmDialog(`届いている申請 ${count}件を、申請どおりの枚数ですべて許可しますか?`, { ok: 'すべて許可' })) {
    net.send({ t: 'approve_all' });
  }
});

dom.drawBtn.addEventListener('click', () => {
  busyDraw = true;
  dom.drawBtn.disabled = true;
  net.send({ t: 'draw' });
  setTimeout(() => { if (busyDraw) { busyDraw = false; render(); } }, 3000);
});

dom.undoBtn.addEventListener('click', async () => {
  const latest = snap.draws[snap.draws.length - 1];
  if (await confirmDialog(`直前の番号「${latest}」を取り消しますか?この番号で成立したビンゴも取り消されます。`, { ok: '取り消す' })) {
    net.send({ t: 'undo' });
  }
});

dom.board.addEventListener('click', (event) => {
  const button = event.target.closest('.num');
  if (!button || button.disabled) return;
  net.send({ t: 'call', n: Number(button.dataset.n) });
});

dom.participants.addEventListener('click', async (event) => {
  const button = event.target.closest('.block');
  if (!button) return;
  const pid = Number(button.closest('.participant').dataset.pid);
  const player = snap.players.find((p) => p.pid === pid);
  if (!player) return;
  if (await confirmDialog(`${player.name} さんをブロックしますか?カード ${player.cards}枚は削除され、以後の申請も受け付けません。`, { ok: 'ブロックする' })) {
    net.send({ t: 'block', pid });
  }
});

dom.blocked.addEventListener('click', (event) => {
  const button = event.target.closest('.unblock');
  if (!button) return;
  net.send({ t: 'unblock', pid: Number(button.closest('.blocked-row').dataset.pid) });
});

$('new-round').addEventListener('click', async () => {
  if (await confirmDialog('次のゲームを始めますか?番号とビンゴの記録が消えます。カードと参加者はそのまま残ります。', { ok: '次のゲームへ' })) {
    net.send({ t: 'new_round' });
  }
});

$('reset-all').addEventListener('click', async () => {
  if (await confirmDialog('すべてリセットしますか?番号・カード・申請・参加者がすべて消えます。元には戻せません。', { ok: 'すべて消す' })) {
    net.send({ t: 'reset_all' });
  }
});

// ---- 開始 ----

for (const sec of DELAYS) {
  dom.delay.appendChild(el('option', { value: String(sec), text: sec === 0 ? '遅らせない' : `${sec}秒おくらせる` }));
}
// 盤面: 列(B/I/N/G/O)ごとに15個
for (let n = 1; n <= MAX_NUMBER; n++) {
  dom.board.appendChild(el('button', { type: 'button', class: `num col-${letterOf(n)}`, dataset: { n }, text: String(n) }));
}

render();
