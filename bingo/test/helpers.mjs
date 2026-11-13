// テスト用の共通部品。ローカルの wrangler dev を起動し、WebSocket で話す。
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LINES, FREE } from '../public/logic.mjs';

export const HOST_PASSWORD = 'test-password';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(ROOT, 'node_modules', '.bin', 'wrangler');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// persistTo: 保存先のフォルダ(省略すると新しい一時フォルダ)。vars: 追加の環境変数。
export async function startServer({ persistTo, vars = {} } = {}) {
  const dir = persistTo ?? (await mkdtemp(path.join(tmpdir(), 'bingo-test-')));
  const port = await freePort();
  const inspectorPort = await freePort();
  const args = [
    'dev', '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', String(inspectorPort),
    '--persist-to', dir,
  ];
  // 値が null の変数は渡さない(未設定の状態を試すため)。
  for (const [k, v] of Object.entries({ HOST_PASSWORD, ...vars })) {
    if (v !== null) args.push('--var', `${k}:${v}`);
  }
  const child = spawn(WRANGLER, args, {
    cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', FORCE_COLOR: '0' },
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  let exited = false;
  const exit = new Promise((resolve) => child.on('exit', () => { exited = true; resolve(); }));

  const http = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  for (;;) {
    if (exited) throw new Error('wrangler dev が終了しました:\n' + log);
    try {
      const res = await fetch(http + '/ws');
      if (res.status === 426) break;
    } catch { /* まだ起動していない */ }
    if (Date.now() > deadline) throw new Error('wrangler dev が起動しません:\n' + log);
    await sleep(150);
  }

  return {
    http,
    ws: `ws://127.0.0.1:${port}/ws`,
    persistTo: dir,
    log: () => log,
    async stop() {
      if (exited) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* すでに終了 */ }
      await Promise.race([exit, sleep(5000)]);
      if (!exited) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 同上 */ } await exit; }
    },
  };
}

const openClients = new Set();

export class Client {
  constructor(ws) {
    this.ws = ws;
    this.queue = [];
    this.waiters = [];
    this.isClosed = false;
    this.closeWaiters = [];
    ws.addEventListener('message', (e) => this.#push(JSON.parse(e.data)));
    ws.addEventListener('close', () => {
      this.isClosed = true;
      openClients.delete(this);
      for (const w of this.closeWaiters) w();
    });
  }

  static open(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.addEventListener('open', () => {
        const c = new Client(ws);
        openClients.add(c);
        resolve(c);
      }, { once: true });
      ws.addEventListener('error', () => reject(new Error('接続できません: ' + wsUrl)), { once: true });
    });
  }

  #push(msg) {
    const i = this.waiters.findIndex((w) => w.t === msg.t);
    if (i >= 0) {
      const [w] = this.waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      this.queue.push(msg);
    }
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }
  sendRaw(str) { this.ws.send(str); }

  // 種類 t の、まだ受け取っていない最初のメッセージ。
  next(t, ms = 3000) {
    const i = this.queue.findIndex((m) => m.t === t);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { t, resolve };
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`"${t}" が ${ms}ms 以内に届きません。届いたもの: ${JSON.stringify(this.queue).slice(0, 500)}`));
      }, ms);
      this.waiters.push(w);
    });
  }

  // 種類 t が ms の間に届かないこと。
  async none(t, ms = 300) {
    await sleep(ms);
    const hit = this.queue.find((m) => m.t === t);
    if (hit) throw new Error(`"${t}" は届かないはずが届きました: ${JSON.stringify(hit).slice(0, 300)}`);
  }

  drain() { this.queue.length = 0; }

  closed(ms = 3000) {
    if (this.isClosed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`接続が ${ms}ms 以内に閉じません`)), ms);
      this.closeWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  close() { try { this.ws.close(); } catch { /* すでに閉じている */ } }
}

export function closeAll() {
  for (const c of [...openClients]) c.close();
  openClients.clear();
}

export function randomToken() { return randomBytes(32).toString('hex'); }

export async function joinPlayer(server, token = randomToken()) {
  const c = await Client.open(server.ws);
  c.send({ t: 'hello', token });
  const state = await c.next('state');
  return { c, token, state };
}

export async function joinHost(server) {
  const c = await Client.open(server.ws);
  c.send({ t: 'auth', password: HOST_PASSWORD });
  const snap = await c.next('host');
  return { c, snap };
}

// 主催者で入り、すべて消して受付中・遅れなしにする。
export async function fresh(server) {
  const { c } = await joinHost(server);
  c.send({ t: 'reset_all' });
  await c.next('host');
  c.send({ t: 'delay', sec: 0 });
  await c.next('host');
  c.send({ t: 'accepting', on: true });
  const snap = await c.next('host');
  return { c, snap };
}

// 申請 → 許可 → その人の you(カード入り)を返す。
export async function grant(host, player, name, count) {
  player.send({ t: 'request', name, count });
  const { req } = await host.next('req_add');
  await player.next('you');
  host.send({ t: 'approve', id: req.id, count });
  await host.next('req_del');
  await host.next('player');
  const { you } = await player.next('you');
  return { ...you, pid: req.pid };
}

// そのカードの LINES[lineIndex] をそろえるのに必要な番号(FREE を除く)。
export function lineNumbers(numbers, lineIndex = 0) {
  return LINES[lineIndex].map((i) => numbers[i]).filter((n) => n !== FREE);
}

// 2枚のカードが同じ縦の列で共通の番号を持つなら、同時にビンゴさせる番号の順を返す。
export function findTie(a, b) {
  for (let col = 0; col < 5; col++) {
    const la = lineNumbers(a, 5 + col);
    const lb = lineNumbers(b, 5 + col);
    const last = la.find((n) => lb.includes(n));
    if (last === undefined) continue;
    const pre = [...new Set([...la, ...lb])].filter((n) => n !== last);
    return { pre, last };
  }
  return null;
}
