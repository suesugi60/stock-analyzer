// 部屋の状態を SQLite に読み書きする。Durable Object が休止してもここにあるものは残る。

export class Store {
  constructor(sql) {
    this.sql = sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS players (
        id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL, blocked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT, player_id INTEGER NOT NULL,
        count INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS requests_player ON requests (player_id);
      CREATE TABLE IF NOT EXISTS cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT, player_id INTEGER NOT NULL,
        no INTEGER NOT NULL, numbers TEXT NOT NULL, bingo_at INTEGER);
      CREATE INDEX IF NOT EXISTS cards_player ON cards (player_id);
      CREATE TABLE IF NOT EXISTS draws (seq INTEGER PRIMARY KEY, n INTEGER NOT NULL UNIQUE, at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_fail (ip TEXT PRIMARY KEY, fails INTEGER NOT NULL, until_ms INTEGER NOT NULL);
    `);
  }

  all(query, ...args) { return this.sql.exec(query, ...args).toArray(); }
  one(query, ...args) { return this.all(query, ...args)[0] ?? null; }
  run(query, ...args) { this.sql.exec(query, ...args); }

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
  playerByHash(tokenHash) { return this.one('SELECT id, name, blocked FROM players WHERE token_hash = ?', tokenHash); }

  // ---- 番号 ----
  draws() { return this.all('SELECT seq, n, at_ms FROM draws ORDER BY seq'); }
}
