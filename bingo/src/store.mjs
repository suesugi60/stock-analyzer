// 部屋の状態を SQLite に読み書きする。Durable Object が休止してもここにあるものは残る。

export class Store {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS players (
        id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL, blocked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT, player_id INTEGER NOT NULL,
        count INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS requests_player ON requests (player_id);
      CREATE INDEX IF NOT EXISTS requests_pending ON requests (status) WHERE status = 'pending';
      CREATE TABLE IF NOT EXISTS cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT, player_id INTEGER NOT NULL,
        no INTEGER NOT NULL, numbers TEXT NOT NULL, bingo_at INTEGER);
      CREATE INDEX IF NOT EXISTS cards_player ON cards (player_id);
      CREATE INDEX IF NOT EXISTS cards_bingo ON cards (bingo_at) WHERE bingo_at IS NOT NULL;
      CREATE TABLE IF NOT EXISTS draws (seq INTEGER PRIMARY KEY, n INTEGER NOT NULL UNIQUE, at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_fail (ip TEXT PRIMARY KEY, fails INTEGER NOT NULL, until_ms INTEGER NOT NULL);
    `);
  }

  all(query, ...args) { return this.sql.exec(query, ...args).toArray(); }
  one(query, ...args) { return this.all(query, ...args)[0] ?? null; }
  run(query, ...args) { this.sql.exec(query, ...args); }
  // 途中で失敗したら、まとめて取り消す。
  atomic(fn) { return this.storage.transactionSync(fn); }

  // ---- 設定 ----
  meta(key, fallback) {
    const row = this.one('SELECT v FROM meta WHERE k = ?', key);
    return row ? row.v : fallback;
  }
  setMeta(key, value) {
    this.run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', key, String(value));
  }
  accepting() { return this.meta('accepting', '0') === '1'; }
  delay() { return Number(this.meta('delay', '0')); }

  // ---- 合言葉の失敗の記録 ----
  authState(ip) { return this.one('SELECT fails, until_ms FROM auth_fail WHERE ip = ?', ip); }
  setAuthState(ip, fails, untilMs) {
    this.run(
      'INSERT INTO auth_fail (ip, fails, until_ms) VALUES (?, ?, ?) ON CONFLICT (ip) DO UPDATE SET fails = excluded.fails, until_ms = excluded.until_ms',
      ip, fails, untilMs);
  }
  clearAuthState(ip) { this.run('DELETE FROM auth_fail WHERE ip = ?', ip); }

  // ---- 参加者 ----
  playerByHash(tokenHash) {
    return this.one('SELECT id, token_hash, name, blocked FROM players WHERE token_hash = ?', tokenHash);
  }
  playerById(id) { return this.one('SELECT id, token_hash, name, blocked FROM players WHERE id = ?', id); }
  createPlayer(tokenHash, name) {
    return this.one('INSERT INTO players (token_hash, name) VALUES (?, ?) RETURNING id', tokenHash, name).id;
  }
  renamePlayer(id, name) { this.run('UPDATE players SET name = ? WHERE id = ?', name, id); }
  blockedPlayers() { return this.all('SELECT id AS pid, name FROM players WHERE blocked = 1 ORDER BY id'); }
  // ブロック: 申請中の申請は却下、カードは削除、以後の申請は受け付けない。
  block(playerId) {
    this.atomic(() => {
      this.run('UPDATE players SET blocked = 1 WHERE id = ?', playerId);
      this.run("UPDATE requests SET status = 'rejected' WHERE player_id = ? AND status = 'pending'", playerId);
      this.run('DELETE FROM cards WHERE player_id = ?', playerId);
    });
  }
  unblock(playerId) { this.run('UPDATE players SET blocked = 0 WHERE id = ?', playerId); }

  // ---- 申請 ----
  latestRequest(playerId) {
    return this.one('SELECT id, count, status FROM requests WHERE player_id = ? ORDER BY id DESC LIMIT 1', playerId);
  }
  pendingRequest(id) {
    return this.one(
      `SELECT r.id, r.player_id AS pid, p.name, r.count FROM requests r JOIN players p ON p.id = r.player_id
       WHERE r.id = ? AND r.status = 'pending'`, id);
  }
  pendingRequests() {
    return this.all(
      `SELECT r.id, r.player_id AS pid, p.name, r.count FROM requests r JOIN players p ON p.id = r.player_id
       WHERE r.status = 'pending' ORDER BY r.id`);
  }
  pendingCount() { return this.one("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'").c; }
  createRequest(playerId, count) {
    return this.one("INSERT INTO requests (player_id, count, status) VALUES (?, ?, 'pending') RETURNING id", playerId, count).id;
  }
  setRequestStatus(id, status) { this.run('UPDATE requests SET status = ? WHERE id = ?', status, id); }

  // ---- カード ----
  cardsOf(playerId) {
    return this.all('SELECT id, no, numbers, bingo_at FROM cards WHERE player_id = ? ORDER BY no', playerId)
      .map((row) => ({ ...row, numbers: JSON.parse(row.numbers) }));
  }
  cardCount() { return this.one('SELECT COUNT(*) AS c FROM cards').c; }
  cardCountOf(playerId) { return this.one('SELECT COUNT(*) AS c FROM cards WHERE player_id = ?', playerId).c; }
  // ブロックされていない人の全カード。名前付き。
  allCards() {
    return this.all(
      `SELECT c.id, c.player_id AS pid, p.name, c.no, c.numbers, c.bingo_at FROM cards c JOIN players p ON p.id = c.player_id
       ORDER BY c.player_id, c.no`)
      .map((row) => ({ ...row, numbers: JSON.parse(row.numbers) }));
  }
  // cards: { numbers, bingoAt }[]。bingoAt は配った時点でそろっていれば、その時点の番号の個数。
  addCards(playerId, cards) {
    let no = this.one('SELECT COALESCE(MAX(no), 0) AS m FROM cards WHERE player_id = ?', playerId).m;
    for (const card of cards) {
      no++;
      this.run('INSERT INTO cards (player_id, no, numbers, bingo_at) VALUES (?, ?, ?, ?)',
        playerId, no, JSON.stringify(card.numbers), card.bingoAt);
    }
  }
  setBingo(cardId, seq) { this.run('UPDATE cards SET bingo_at = ? WHERE id = ?', seq, cardId); }
  clearBingoAt(seq) { this.run('UPDATE cards SET bingo_at = NULL WHERE bingo_at = ?', seq); }
  // ビンゴしたカード。at は何個目の番号で達成したか。
  winnerRows() {
    return this.all(
      `SELECT c.id, p.name, c.no, c.bingo_at AS at FROM cards c JOIN players p ON p.id = c.player_id
       WHERE c.bingo_at IS NOT NULL`);
  }

  // ---- 番号 ----
  draws() { return this.all('SELECT seq, n, at_ms FROM draws ORDER BY seq'); }
  addDraw(seq, n, atMs) { this.run('INSERT INTO draws (seq, n, at_ms) VALUES (?, ?, ?)', seq, n, atMs); }
  removeDraw(seq) { this.run('DELETE FROM draws WHERE seq = ?', seq); }

  // ---- リセット ----
  // 次のゲーム: 番号とビンゴの記録だけ消す。
  newRound() {
    this.atomic(() => {
      this.run('DELETE FROM draws');
      this.run('UPDATE cards SET bingo_at = NULL WHERE bingo_at IS NOT NULL');
    });
  }
  resetAll() {
    this.atomic(() => {
      this.run('DELETE FROM draws');
      this.run('DELETE FROM cards');
      this.run('DELETE FROM requests');
      this.run('DELETE FROM players');
    });
  }
}
