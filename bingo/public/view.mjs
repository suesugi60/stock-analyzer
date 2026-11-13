// 画面の部品。リスナー画面と主催者画面で共用する。
// 利用者が入力した文字列(名前)は、必ずテキストとして入れる。innerHTML は使わない。
import { analyzeCard, FREE, LINES } from './logic.mjs';

export const LETTERS = 'BINGO';
export function letterOf(n) { return LETTERS[Math.floor((n - 1) / 15)]; }

// el('div', { class: 'x', text: '...' }, child, '文字列')。文字列の子はテキストノードになる。
export function el(tag, attrs = null, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'hidden' || key === 'disabled') node[key] = true;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

// 番号の玉。列の文字(B/I/N/G/O)は CSS が data-letter から描く。
export function renderBall(n, extraClass = '') {
  const letter = letterOf(n);
  return el('span', { class: `ball col-${letter} ${extraClass}`.trim(), dataset: { letter }, text: String(n) });
}

// existing を渡すと、その要素を作り直さずに更新する(穴が開く動きを見せるため)。
export function renderCard(card, called, existing = null) {
  const a = analyzeCard(card.numbers, called);
  let root = existing;
  if (!root) {
    root = el('article', { class: 'card', dataset: { no: card.no } },
      el('header', { class: 'card-head' },
        el('span', { class: 'card-title', text: `カード${card.no}` }),
        el('span', { class: 'card-badge' })),
      el('div', { class: 'card-letters', 'aria-hidden': 'true' },
        ...LETTERS.split('').map((letter) => el('span', { class: `col-${letter}`, text: letter }))),
      el('div', { class: 'grid' },
        ...card.numbers.map((n, i) => el('span', {
          class: `cell col-${LETTERS[i % 5]}` + (n === FREE ? ' free' : ''),
          text: n === FREE ? 'FREE' : String(n),
        }))));
  }

  const inLine = new Set();  // そろった列のマス
  const waiting = new Set(); // リーチの列の、まだ開いていないマス
  for (const line of LINES) {
    const open = line.filter((i) => !a.marked[i]);
    if (open.length === 0) line.forEach((i) => inLine.add(i));
    else if (open.length === 1) waiting.add(open[0]);
  }

  const cells = root.querySelectorAll('.cell');
  a.marked.forEach((marked, i) => {
    const cell = cells[i];
    const was = cell.classList.contains('marked');
    cell.classList.toggle('marked', marked);
    cell.classList.toggle('pop', marked && !was && existing !== null);
    cell.classList.toggle('line', inLine.has(i));
    cell.classList.toggle('wait', waiting.has(i));
  });

  root.classList.toggle('bingo', a.lines > 0);
  root.classList.toggle('reach', a.lines === 0 && a.reach > 0);
  const badge = root.querySelector('.card-badge');
  if (a.lines > 1) badge.textContent = `BINGO! ${a.lines}列`;
  else if (a.lines === 1) badge.textContent = 'BINGO!';
  else if (a.reach > 0) badge.textContent = 'リーチ!';
  else badge.textContent = `あと${a.need}つ`;
  return root;
}

// winners: { rank, name, no, at }[]
export function renderWinners(listEl, winners) {
  clear(listEl);
  for (const w of winners) {
    listEl.appendChild(el('li', null,
      el('span', { class: 'w-rank', text: `${w.rank}位` }),
      el('span', { class: 'w-name', text: w.name }),
      el('span', { class: 'w-card', text: `カード${w.no}` }),
      el('span', { class: 'w-at', text: `${w.at}個目` })));
  }
}

let toastTimer = null;
export function toast(message) {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3500);
}

// ページ内の確認。window.confirm はアプリ内ブラウザで出ないことがあるので使わない。
export function confirmDialog(message, { ok = 'はい', cancel = 'やめる' } = {}) {
  const dialog = document.getElementById('dialog');
  const okBtn = document.getElementById('dialog-ok');
  const cancelBtn = document.getElementById('dialog-cancel');
  document.getElementById('dialog-message').textContent = message;
  okBtn.textContent = ok;
  cancelBtn.textContent = cancel;
  dialog.hidden = false;
  cancelBtn.focus();
  return new Promise((resolve) => {
    const finish = (answer) => {
      dialog.hidden = true;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(answer);
    };
    const onKey = (event) => { if (event.key === 'Escape') finish(false); };
    okBtn.onclick = () => finish(true);
    cancelBtn.onclick = () => finish(false);
    document.addEventListener('keydown', onKey);
  });
}
