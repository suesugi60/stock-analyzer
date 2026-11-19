import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
export const APP_DIR = join(here, '..');
const require = createRequire(import.meta.url);

/** roulette/logic.js を読む(CJS export)。 */
export function loadLogic() { return require('../logic.js'); }
/** roulette/sync.js を読む(CJS export)。 */
export function loadSync() { return require('../sync.js'); }
/** roulette/wheel.js を読む(CJS export)。 */
export function loadWheel() { return require('../wheel.js'); }

/** 固定シードの疑似乱数(mulberry32)。[0,1) を返す関数。 */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 条件が真になるまで待つ(最大 ms)。 */
export async function waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

/** roulette/ をローカル HTTP で配る(Playwright 用)。 */
export async function serve(dir = APP_DIR) {
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = join(dir, path);
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      const ext = file.slice(file.lastIndexOf('.'));
      res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: () => new Promise((r) => server.close(r)) };
}
