// 部屋(Durable Object)。全員と WebSocket でつながり、状態を持つ。
// 抽選・カードの生成・ビンゴの判定はすべてここで行う。
import { DurableObject } from 'cloudflare:workers';
import { Store } from './store.mjs';
import {
  LIMITS, DELAYS, MAX_NUMBER, WINNERS_SHOWN, isValidToken, isValidCount, normalizeName, makeCard, analyzeCard,
  pickUncalled, rankWinners, cryptoRng,
} from '../public/logic.mjs';

const MAX_MESSAGE = 2048;        // これより長いメッセージを送る接続は閉じる
const RATE_WINDOW_MS = 10_000;   // この間に
const RATE_MAX = 30;             // これより多く送る接続は閉じる(主催者は対象外)
const PASSWORD_MIN = 8;          // 画面から決める合言葉の長さ
const PASSWORD_MAX = 100;
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
  return toHex(await sha256(text));
}

// 長さや内容で処理時間が変わらないよう、ハッシュ同士を比べる。
async function sameSecret(a, b) {
  return crypto.subtle.timingSafeEqual(await sha256(a), await sha256(b));
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
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
    // SQLite から読んだものの控え。休止すると消えるので、なければ読み直す。
    // 書き込むたびに、古くなった分を捨てる。
    this.cache = {};
    this.rate = new WeakMap(); // 接続ごとの送信回数。消えてよい。
    // 接続が生きているかの確認。部屋を起こさずに返事をする。
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));

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
    const att = ws.deserializeAttachment() ?? { role: 'new', ip: 'unknown' };
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return this.#drop(ws, 1009, 'message too big');
    if (att.role !== 'host' && this.#tooFast(ws)) return this.#drop(ws, 1008, 'too many messages');

    let msg;
    try { msg = JSON.parse(raw); } catch { msg = null; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return fail(ws, 'bad_message');

    if (msg.t === 'hello') return this.#hello(ws, att, msg);
    if (msg.t === 'auth') return this.#auth(ws, att, msg);
    if (msg.t === 'host_status') return send(ws, { t: 'host_status', setup: !this.#hasPassword() });
    if (msg.t === 'setup') return this.#setup(ws, msg);

    if (HOST_TYPES.has(msg.t)) {
      if (att.role !== 'host') return fail(ws, 'forbidden');
      switch (msg.t) {
        case 'accepting': return this.#setAccepting(ws, msg);
        case 'delay': return this.#setDelay(ws, msg);
        case 'approve': return this.#approve(ws, msg);
        case 'approve_all': return this.#approveAll(ws);
        case 'reject': return this.#reject(ws, msg);
        case 'draw': return this.#draw(ws);
        case 'call': return this.#call(ws, msg);
        case 'undo': return this.#undo(ws);
        case 'block': return this.#block(ws, msg);
        case 'unblock': return this.#unblock(ws, msg);
        case 'new_round': return this.#newRound();
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

  #drop(ws, code, reason) {
    this.#forget(ws);
    try { ws.close(code, reason); } catch { /* すでに閉じている */ }
  }

  #tooFast(ws) {
    const now = Date.now();
    let r = this.rate.get(ws);
    if (!r || now - r.start > RATE_WINDOW_MS) { r = { start: now, count: 0 }; this.rate.set(ws, r); }
    r.count++;
    return r.count > RATE_MAX;
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

  // ---- 控え ----

  #draws() { return (this.cache.draws ??= this.store.draws()); }
  #called() { return new Set(this.#draws().map((d) => d.n)); }
  #winners() { return (this.cache.winners ??= rankWinners(this.store.winnerRows())); }
  // 画面に送る分(先着 WINNERS_SHOWN 枚)
  #shownWinners() { return this.#winners().slice(0, WINNERS_SHOWN); }
  #cards() { return (this.cache.cards ??= this.store.allCards()); }
  #cardTotal() { return (this.cache.total ??= this.store.cardCount()); }

  // ---- 状態の組み立て ----

  #publicState() {
    const draws = this.#draws();
    const last = draws[draws.length - 1];
    return {
      accepting: this.store.accepting(),
      delay: this.store.delay(),
      draws: draws.map((d) => d.n),
      lastAge: last ? Math.max(0, Date.now() - last.at_ms) : null,
      winners: this.#shownWinners(),
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
  #summarize(cards, called) {
    const byPid = new Map();
    for (const card of cards) {
      let p = byPid.get(card.pid);
      if (!p) { p = { pid: card.pid, name: card.name, cards: 0, bingo: 0, reach: 0 }; byPid.set(card.pid, p); }
      const a = analyzeCard(card.numbers, called);
      p.cards++;
      if (a.lines > 0) p.bingo++;
      else if (a.reach > 0) p.reach++;
    }
    return [...byPid.values()];
  }

  #playerSummaries() { return this.#summarize(this.#cards(), this.#called()); }

  // 1人分だけ。全員のカードを読み直さずに済ませる。
  #summaryOf(player) {
    const cards = this.store.cardsOf(player.id).map((c) => ({ ...c, pid: player.id, name: player.name }));
    return this.#summarize(cards, this.#called())[0];
  }

  #hostState() {
    const pub = this.#publicState();
    return {
      t: 'host', accepting: pub.accepting, delay: pub.delay, draws: pub.draws, winners: pub.winners,
      requests: this.store.pendingRequests(), players: this.#playerSummaries(), blocked: this.store.blockedPlayers(),
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

  // 合言葉は2か所のどちらかにある。
  // - Cloudflare のシークレット HOST_PASSWORD(設定されていれば、こちらだけが通る。忘れたときの上書き用)
  // - 主催者画面で最初に決めたもの(塩を付けたハッシュを SQLite に保存)
  #storedPassword() { return this.store.meta('host_pw', null); }
  #hasPassword() { return !!this.env.HOST_PASSWORD || this.#storedPassword() !== null; }

  async #passwordMatches(candidate) {
    if (this.env.HOST_PASSWORD) return sameSecret(candidate, this.env.HOST_PASSWORD);
    const stored = this.#storedPassword();
    if (stored === null) return false;
    const [salt, hash] = stored.split(':');
    return crypto.subtle.timingSafeEqual(await sha256(salt + candidate), fromHex(hash));
  }

  #becomeHost(ws) {
    const att = ws.deserializeAttachment() ?? { ip: 'unknown' };
    this.#forget(ws);
    ws.serializeAttachment({ role: 'host', ip: att.ip });
    this.hosts.add(ws);
    send(ws, this.#hostState());
  }

  // 合言葉がまだどこにもないときだけ、最初に送ってきた人が決められる。
  async #setup(ws, msg) {
    if (this.#hasPassword()) return fail(ws, 'already_set');
    const password = msg.password;
    const length = typeof password === 'string' ? Array.from(password).length : 0;
    if (length < PASSWORD_MIN || length > PASSWORD_MAX) return fail(ws, 'bad_password');

    const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
    const hash = toHex(await sha256(salt + password));
    // ハッシュの計算を待つ間に、別の人が先に決めたかもしれない。保存の直前にもう一度確かめる。
    if (this.#hasPassword()) return fail(ws, 'already_set');
    this.store.setMeta('host_pw', `${salt}:${hash}`);
    return this.#becomeHost(ws);
  }

  async #auth(ws, att, msg) {
    if (!this.#hasPassword()) return send(ws, { t: 'auth_fail', reason: 'unset' });

    const locked = (state) => !!state && state.until_ms > Date.now();
    // すでに入っている主催者は締め出さない(同じ接続元の他人の間違いで、配信中に操作できなくなるのを防ぐ)
    if (locked(this.store.authState(att.ip)) && att.role !== 'host') return send(ws, { t: 'auth_fail', reason: 'locked' });

    const ok = typeof msg.password === 'string' && (await this.#passwordMatches(msg.password));

    // 照合を待つ間に、同じ接続元の別の試行が記録を進めたかもしれないので読み直す
    const role = (ws.deserializeAttachment() ?? att).role;
    const state = this.store.authState(att.ip);
    if (locked(state) && role !== 'host') return send(ws, { t: 'auth_fail', reason: 'locked' });
    if (!ok) {
      // 締め出し中の記録は動かさない(入っている主催者の打ち間違いで、締め出しが解けないように)
      if (!locked(state)) {
        const fails = (state ? state.fails : 0) + 1;
        if (fails >= AUTH_MAX_FAILS) this.store.setAuthState(att.ip, 0, Date.now() + AUTH_LOCK_MS);
        else this.store.setAuthState(att.ip, fails, 0);
      }
      return send(ws, { t: 'auth_fail', reason: 'wrong' });
    }

    // 締め出し中は記録を消さない(入っている主催者の名乗り直しで、他人の締め出しが解けないように)
    if (!locked(state)) this.store.clearAuthState(att.ip);
    return this.#becomeHost(ws);
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
  // 配った時点ですでにそろっているカードがあれば true を返す。
  #issue(req, count) {
    const called = this.#called();
    const seq = this.#draws().length;
    const cards = [];
    for (let i = 0; i < count; i++) {
      const numbers = makeCard(cryptoRng);
      const done = seq > 0 && analyzeCard(numbers, called).lines > 0;
      cards.push({ numbers, bingoAt: done ? seq : null });
    }
    const total = this.#cardTotal();
    this.store.atomic(() => {
      this.store.setRequestStatus(req.id, 'approved');
      this.store.addCards(req.pid, cards);
    });
    this.cache.total = total + count;
    this.cache.cards = undefined;
    this.cache.winners = undefined;
    return cards.some((c) => c.bingoAt !== null);
  }

  #approve(ws, msg) {
    if (!isValidCount(msg.count)) return fail(ws, 'bad_count');
    const req = Number.isInteger(msg.id) ? this.store.pendingRequest(msg.id) : null;
    if (!req) return fail(ws, 'not_found');
    if (this.#cardTotal() + msg.count > this.cardsMax) return fail(ws, 'cards_full');

    const won = this.#issue(req, msg.count);
    const player = this.store.playerById(req.pid);
    this.#toHosts({ t: 'req_del', id: req.id });
    this.#toHosts({ t: 'player', player: this.#summaryOf(player) });
    this.#sendYou(player.token_hash);
    if (won) {
      this.#toPlayers({ t: 'winners', winners: this.#shownWinners() });
      this.#toHosts(this.#hostState());
    }
    return undefined;
  }

  // 届いた順に許可し、部屋全体の上限に達したら止まる。止まったら、押した主催者に知らせる。
  #approveAll(ws) {
    const done = [];
    let won = false;
    let full = false;
    for (const req of this.store.pendingRequests()) {
      if (this.#cardTotal() + req.count > this.cardsMax) { full = true; break; }
      if (this.#issue(req, req.count)) won = true;
      done.push(req.pid);
    }
    for (const pid of done) this.#sendYou(this.store.playerById(pid).token_hash);
    if (won) this.#toPlayers({ t: 'winners', winners: this.#shownWinners() });
    this.#toHosts(this.#hostState());
    if (full) fail(ws, 'cards_full');
  }

  #reject(ws, msg) {
    const req = Number.isInteger(msg.id) ? this.store.pendingRequest(msg.id) : null;
    if (!req) return fail(ws, 'not_found');
    this.store.setRequestStatus(req.id, 'rejected');
    this.#toHosts({ t: 'req_del', id: req.id });
    this.#sendYou(this.store.playerById(req.pid).token_hash);
    return undefined;
  }

  // ---- 番号 ----

  #draw(ws) {
    const n = pickUncalled(this.#called(), cryptoRng);
    if (n === null) return fail(ws, 'all_called');
    return this.#announce(n);
  }

  #call(ws, msg) {
    if (!Number.isInteger(msg.n) || msg.n < 1 || msg.n > MAX_NUMBER) return fail(ws, 'bad_number');
    if (this.#called().has(msg.n)) return fail(ws, 'already_called');
    return this.#announce(msg.n);
  }

  // 番号を発表する。まだビンゴしていないカードのうち、この番号でそろったものを記録する。
  #announce(n) {
    const draws = this.#draws();
    const seq = draws.length + 1;
    const atMs = Date.now();
    const called = this.#called();
    called.add(n);
    const hits = this.#cards().filter((card) =>
      card.bingo_at === null && card.numbers.includes(n) && analyzeCard(card.numbers, called).lines > 0);

    this.store.atomic(() => {
      this.store.addDraw(seq, n, atMs);
      for (const card of hits) this.store.setBingo(card.id, seq);
    });
    draws.push({ seq, n, at_ms: atMs });
    for (const card of hits) card.bingo_at = seq;
    this.cache.winners = undefined;

    this.#toPlayers({ t: 'draw', n, seq, winners: this.#shownWinners().filter((w) => w.at === seq) });
    this.#toHosts(this.#hostState());
    return undefined;
  }

  // 最後の番号を取り消す。その番号で成立したビンゴも取り消す。
  #undo(ws) {
    const draws = this.#draws();
    if (draws.length === 0) return fail(ws, 'nothing_to_undo');
    const { seq, n } = draws[draws.length - 1];
    // この番号の時点でビンゴと記録されたカードのうち、残りの番号だけでもそろっているもの
    // (途中で配られ、配った時点でそろっていたカード)は、ビンゴのまま1つ前の番号に付け替える。
    const remaining = this.#called();
    remaining.delete(n);
    const affected = this.#cards().filter((card) => card.bingo_at === seq);
    const kept = new Set(affected.filter((card) => analyzeCard(card.numbers, remaining).lines > 0));
    this.store.atomic(() => {
      this.store.removeDraw(seq);
      this.store.clearBingoAt(seq);
      for (const card of kept) this.store.setBingo(card.id, seq - 1);
    });
    draws.pop();
    for (const card of affected) card.bingo_at = kept.has(card) ? seq - 1 : null;
    this.cache.winners = undefined;

    this.#toPlayers({ t: 'undo', seq });
    // 一覧の入れ替わり(付け替えや、100枚より後ろからの繰り上がり)があるので、全体を送り直す
    this.#toPlayers({ t: 'winners', winners: this.#shownWinners() });
    this.#toHosts(this.#hostState());
    return undefined;
  }

  // ---- ブロック ----

  #block(ws, msg) {
    const player = Number.isInteger(msg.pid) ? this.store.playerById(msg.pid) : null;
    if (!player) return fail(ws, 'not_found');
    const hadBingo = this.store.cardsOf(player.id).some((card) => card.bingo_at !== null);
    this.store.block(player.id);
    this.cache.cards = undefined;
    this.cache.winners = undefined;
    this.cache.total = undefined;

    this.#sendYou(player.token_hash);
    if (hadBingo) this.#toPlayers({ t: 'winners', winners: this.#shownWinners() });
    this.#toHosts(this.#hostState());
    return undefined;
  }

  #unblock(ws, msg) {
    const player = Number.isInteger(msg.pid) ? this.store.playerById(msg.pid) : null;
    if (!player || !player.blocked) return fail(ws, 'not_found');
    this.store.unblock(player.id);
    this.#sendYou(player.token_hash);
    this.#toHosts(this.#hostState());
    return undefined;
  }

  // ---- リセット ----

  #newRound() {
    this.store.newRound();
    this.cache = {};
    this.#toPlayers({ t: 'round' });
    this.#toHosts(this.#hostState());
  }

  #resetAll() {
    this.store.resetAll();
    this.cache = {};
    this.#toPlayers({ t: 'reset' });
    this.#toHosts(this.#hostState());
  }
}
