// 部屋(Durable Object)。全員と WebSocket でつながり、状態を持つ。
// 抽選・カードの生成・ビンゴの判定はすべてここで行う。
import { DurableObject } from 'cloudflare:workers';
import { Store } from './store.mjs';
import { isValidToken } from '../public/logic.mjs';

const AUTH_MAX_FAILS = 5;        // 合言葉をこの回数続けて間違えると
const AUTH_LOCK_MS = 5 * 60_000; // この時間、その接続元からは入れない

const PLAYER_TYPES = new Set(['request', 'cancel']);
const HOST_TYPES = new Set([
  'accepting', 'delay', 'approve', 'approve_all', 'reject', 'draw', 'call', 'undo',
  'block', 'unblock', 'new_round', 'reset_all',
]);

const encoder = new TextEncoder();

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

async function sha256Hex(text) {
  return [...(await sha256(text))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 長さや内容で処理時間が変わらないよう、ハッシュ同士を比べる。
async function sameSecret(a, b) {
  return crypto.subtle.timingSafeEqual(await sha256(a), await sha256(b));
}

function send(ws, message) {
  try { ws.send(JSON.stringify(message)); } catch { /* 閉じた接続は無視する */ }
}

export class BingoRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql);
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: 'new', ip: request.headers.get('CF-Connecting-IP') || 'unknown' });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { msg = null; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') {
      send(ws, { t: 'error', code: 'bad_message' });
      return;
    }

    const att = ws.deserializeAttachment() ?? { role: 'new', ip: 'unknown' };
    if (msg.t === 'hello') return this.#hello(ws, att, msg);
    if (msg.t === 'auth') return this.#auth(ws, att, msg);
    if (HOST_TYPES.has(msg.t)) {
      if (att.role !== 'host') { send(ws, { t: 'error', code: 'forbidden' }); return; }
      return;
    }
    if (PLAYER_TYPES.has(msg.t)) {
      if (att.role !== 'player') { send(ws, { t: 'error', code: 'need_hello' }); return; }
      return;
    }
    send(ws, { t: 'error', code: 'bad_message' });
  }

  webSocketClose(ws, code, reason) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch { /* すでに閉じている */ }
  }

  webSocketError() { /* 切断と同じ扱い。再接続は相手がする。 */ }

  // ---- リスナー ----

  async #hello(ws, att, msg) {
    if (!isValidToken(msg.token)) { send(ws, { t: 'error', code: 'bad_message' }); return; }
    const th = await sha256Hex(msg.token);
    const player = this.store.playerByHash(th);
    ws.serializeAttachment({ role: 'player', th, pid: player ? player.id : null, ip: att.ip });
    send(ws, { t: 'state', ...this.#publicState(), you: this.#you(player) });
  }

  #publicState() {
    const draws = this.store.draws();
    const last = draws[draws.length - 1];
    return {
      accepting: this.store.accepting(),
      delay: this.store.delay(),
      draws: draws.map((d) => d.n),
      lastAge: last ? Math.max(0, Date.now() - last.at_ms) : null,
      winners: [],
    };
  }

  #you(player) {
    if (!player) return { name: null, blocked: false, pending: null, rejected: false, cards: [] };
    return { name: player.name, blocked: !!player.blocked, pending: null, rejected: false, cards: [] };
  }

  // ---- 主催者 ----

  async #auth(ws, att, msg) {
    const password = this.env.HOST_PASSWORD;
    if (!password) { send(ws, { t: 'auth_fail', reason: 'unset' }); return; }

    const now = Date.now();
    const state = this.store.authState(att.ip);
    if (state && state.until_ms > now) { send(ws, { t: 'auth_fail', reason: 'locked' }); return; }

    const ok = typeof msg.password === 'string' && (await sameSecret(msg.password, password));
    if (!ok) {
      const fails = (state ? state.fails : 0) + 1;
      if (fails >= AUTH_MAX_FAILS) this.store.setAuthState(att.ip, 0, now + AUTH_LOCK_MS);
      else this.store.setAuthState(att.ip, fails, 0);
      send(ws, { t: 'auth_fail', reason: 'wrong' });
      return;
    }

    this.store.clearAuthState(att.ip);
    ws.serializeAttachment({ role: 'host', ip: att.ip });
    send(ws, this.#hostState());
  }

  #hostState() {
    const pub = this.#publicState();
    return {
      t: 'host', accepting: pub.accepting, delay: pub.delay, draws: pub.draws, winners: pub.winners,
      requests: [], players: [], blocked: [],
    };
  }
}
