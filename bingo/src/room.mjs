// 部屋(Durable Object)。全員と WebSocket でつながり、状態を持つ。
// 抽選・カードの生成・ビンゴの判定はすべてここで行う。
import { DurableObject } from 'cloudflare:workers';
import { Store } from './store.mjs';
import {
  LIMITS, DELAYS, isValidToken, isValidCount, normalizeName, makeCard, analyzeCard, cryptoRng,
} from '../public/logic.mjs';

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
  try { ws.send(typeof message === 'string' ? message : JSON.stringify(message)); } catch { /* 閉じた接続は無視する */ }
}

function fail(ws, code) { send(ws, { t: 'error', code }); }

export class BingoRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new Store(ctx.storage);
    this.cardsMax = Number(env.CARDS_MAX) || LIMITS.CARDS_MAX;
    this.pendingMax = Number(env.PENDING_MAX) || LIMITS.PENDING_MAX;

    // 誰がどの接続か。休止から戻ったときは、接続に付けておいた情報から作り直す。
    this.hosts = new Set();
    this.byToken = new Map(); // 合い札のハッシュ → その人の接続(タブごとに1つ)
    for (const ws of ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.role === 'host') this.hosts.add(ws);
      else if (att?.role === 'player') this.#remember(att.th, ws);
    }
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
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return fail(ws, 'bad_message');

    const att = ws.deserializeAttachment() ?? { role: 'new', ip: 'unknown' };
    if (msg.t === 'hello') return this.#hello(ws, att, msg);
    if (msg.t === 'auth') return this.#auth(ws, att, msg);

    if (HOST_TYPES.has(msg.t)) {
      if (att.role !== 'host') return fail(ws, 'forbidden');
      switch (msg.t) {
        case 'accepting': return this.#setAccepting(ws, msg);
        case 'delay': return this.#setDelay(ws, msg);
        case 'approve': return this.#approve(ws, msg);
        case 'approve_all': return this.#approveAll();
        case 'reject': return this.#reject(ws, msg);
        case 'reset_all': return this.#resetAll();
        default: return undefined;
      }
    }
    if (PLAYER_TYPES.has(msg.t)) {
      if (att.role !== 'player') return fail(ws, 'need_hello');
      if (msg.t === 'request') return this.#request(ws, att, msg);
      return this.#cancel(ws, att);
    }
    return fail(ws, 'bad_message');
  }

  webSocketClose(ws, code, reason) {
    this.#forget(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch { /* すでに閉じている */ }
  }

  webSocketError(ws) { this.#forget(ws); }

  // ---- 接続の管理と送信 ----

  #remember(th, ws) {
    let set = this.byToken.get(th);
    if (!set) { set = new Set(); this.byToken.set(th, set); }
    set.add(ws);
  }

  #forget(ws) {
    this.hosts.delete(ws);
    const att = ws.deserializeAttachment();
    if (att?.th) {
      const set = this.byToken.get(att.th);
      if (set) { set.delete(ws); if (set.size === 0) this.byToken.delete(att.th); }
    }
  }

  #toHosts(message) {
    const text = JSON.stringify(message);
    for (const ws of this.hosts) send(ws, text);
  }

  #toPlayers(message) {
    const text = JSON.stringify(message);
    for (const set of this.byToken.values()) for (const ws of set) send(ws, text);
  }

  // その人のすべてのタブに、その人自身の状態を送る。
  #sendYou(th) {
    const set = this.byToken.get(th);
    if (!set) return;
    const text = JSON.stringify({ t: 'you', you: this.#you(this.store.playerByHash(th)) });
    for (const ws of set) send(ws, text);
  }

  // ---- 状態の組み立て ----

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
    const latest = this.store.latestRequest(player.id);
    return {
      name: player.name,
      blocked: !!player.blocked,
      pending: latest?.status === 'pending' ? latest.count : null,
      rejected: latest?.status === 'rejected',
      cards: this.store.cardsOf(player.id).map(({ no, numbers }) => ({ no, numbers })),
    };
  }

  // カードを持つ人ごとの集計。bingo: ビンゴしたカードの枚数 / reach: ビンゴしておらずリーチのカードの枚数。
  #playerSummaries() {
    const called = new Set(this.store.draws().map((d) => d.n));
    const byPid = new Map();
    for (const card of this.store.allCards()) {
      let p = byPid.get(card.pid);
      if (!p) { p = { pid: card.pid, name: card.name, cards: 0, bingo: 0, reach: 0 }; byPid.set(card.pid, p); }
      const a = analyzeCard(card.numbers, called);
      p.cards++;
      if (a.lines > 0) p.bingo++;
      else if (a.reach > 0) p.reach++;
    }
    return [...byPid.values()];
  }

  #hostState() {
    const pub = this.#publicState();
    return {
      t: 'host', accepting: pub.accepting, delay: pub.delay, draws: pub.draws, winners: pub.winners,
      requests: this.store.pendingRequests(), players: this.#playerSummaries(), blocked: [],
    };
  }

  // ---- リスナー ----

  async #hello(ws, att, msg) {
    if (!isValidToken(msg.token)) return fail(ws, 'bad_message');
    const th = await sha256Hex(msg.token);
    this.#forget(ws);
    ws.serializeAttachment({ role: 'player', th, ip: att.ip });
    this.#remember(th, ws);
    send(ws, { t: 'state', ...this.#publicState(), you: this.#you(this.store.playerByHash(th)) });
  }

  #request(ws, att, msg) {
    let player = this.store.playerByHash(att.th);
    if (player?.blocked) return fail(ws, 'blocked');
    if (!this.store.accepting()) return fail(ws, 'closed');

    // カードを1枚でも持ったら名前は変えられない。
    const hasCards = player ? this.store.cardCountOf(player.id) > 0 : false;
    const name = hasCards ? player.name : normalizeName(msg.name);
    if (!name) return fail(ws, 'bad_name');
    if (!isValidCount(msg.count)) return fail(ws, 'bad_count');
    if (player && this.store.latestRequest(player.id)?.status === 'pending') return fail(ws, 'already_pending');
    if (this.store.pendingCount() >= this.pendingMax) return fail(ws, 'busy');

    const req = this.store.atomic(() => {
      let pid;
      if (!player) pid = this.store.createPlayer(att.th, name);
      else { pid = player.id; if (player.name !== name) this.store.renamePlayer(pid, name); }
      return { id: this.store.createRequest(pid, msg.count), pid, name, count: msg.count };
    });
    this.#toHosts({ t: 'req_add', req });
    this.#sendYou(att.th);
    return undefined;
  }

  #cancel(ws, att) {
    const player = this.store.playerByHash(att.th);
    const latest = player ? this.store.latestRequest(player.id) : null;
    if (latest?.status !== 'pending') return fail(ws, 'no_pending');
    this.store.setRequestStatus(latest.id, 'canceled');
    this.#toHosts({ t: 'req_del', id: latest.id });
    this.#sendYou(att.th);
    return undefined;
  }

  // ---- 主催者 ----

  async #auth(ws, att, msg) {
    const password = this.env.HOST_PASSWORD;
    if (!password) return send(ws, { t: 'auth_fail', reason: 'unset' });

    const now = Date.now();
    const state = this.store.authState(att.ip);
    if (state && state.until_ms > now) return send(ws, { t: 'auth_fail', reason: 'locked' });

    const ok = typeof msg.password === 'string' && (await sameSecret(msg.password, password));
    if (!ok) {
      const fails = (state ? state.fails : 0) + 1;
      if (fails >= AUTH_MAX_FAILS) this.store.setAuthState(att.ip, 0, now + AUTH_LOCK_MS);
      else this.store.setAuthState(att.ip, fails, 0);
      return send(ws, { t: 'auth_fail', reason: 'wrong' });
    }

    this.store.clearAuthState(att.ip);
    this.#forget(ws);
    ws.serializeAttachment({ role: 'host', ip: att.ip });
    this.hosts.add(ws);
    return send(ws, this.#hostState());
  }

  #setAccepting(ws, msg) {
    if (typeof msg.on !== 'boolean') return fail(ws, 'bad_message');
    this.store.setMeta('accepting', msg.on ? '1' : '0');
    this.#toPlayers({ t: 'accepting', on: msg.on });
    this.#toHosts(this.#hostState());
    return undefined;
  }

  #setDelay(ws, msg) {
    if (!DELAYS.includes(msg.sec)) return fail(ws, 'bad_delay');
    this.store.setMeta('delay', msg.sec);
    this.#toPlayers({ t: 'delay', sec: msg.sec });
    this.#toHosts(this.#hostState());
    return undefined;
  }

  // 申請を許可して count 枚のカードを作る。呼ぶ側が上限を確かめておく。
  #issue(req, count) {
    const cards = [];
    for (let i = 0; i < count; i++) cards.push(makeCard(cryptoRng));
    this.store.atomic(() => {
      this.store.setRequestStatus(req.id, 'approved');
      this.store.addCards(req.pid, cards);
    });
  }

  #approve(ws, msg) {
    if (!isValidCount(msg.count)) return fail(ws, 'bad_count');
    const req = Number.isInteger(msg.id) ? this.store.pendingRequest(msg.id) : null;
    if (!req) return fail(ws, 'not_found');
    if (this.store.cardCount() + msg.count > this.cardsMax) return fail(ws, 'cards_full');

    this.#issue(req, msg.count);
    this.#toHosts({ t: 'req_del', id: req.id });
    this.#toHosts({ t: 'player', player: this.#playerSummaries().find((p) => p.pid === req.pid) });
    this.#sendYou(this.store.playerById(req.pid).token_hash);
    return undefined;
  }

  // 届いた順に許可し、部屋全体の上限に達したら止まる。
  #approveAll() {
    let total = this.store.cardCount();
    const done = [];
    for (const req of this.store.pendingRequests()) {
      if (total + req.count > this.cardsMax) break;
      this.#issue(req, req.count);
      total += req.count;
      done.push(req.pid);
    }
    for (const pid of done) this.#sendYou(this.store.playerById(pid).token_hash);
    this.#toHosts(this.#hostState());
  }

  #reject(ws, msg) {
    const req = Number.isInteger(msg.id) ? this.store.pendingRequest(msg.id) : null;
    if (!req) return fail(ws, 'not_found');
    this.store.setRequestStatus(req.id, 'rejected');
    this.#toHosts({ t: 'req_del', id: req.id });
    this.#sendYou(this.store.playerById(req.pid).token_hash);
    return undefined;
  }

  #resetAll() {
    this.store.resetAll();
    this.#toPlayers({ t: 'reset' });
    this.#toHosts(this.#hostState());
  }
}
