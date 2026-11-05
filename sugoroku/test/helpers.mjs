import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
export const INDEX_HTML = join(here, '..', 'index.html');

/** index.html から <script id="sugoroku-logic"> を抜き出して評価し、Sugoroku を返す。 */
export function loadSugoroku() {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const m = html.match(/<script id="sugoroku-logic">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('index.html に <script id="sugoroku-logic"> がない');
  // 同じレルムで評価する(別コンテキストだと配列の prototype が違い deepEqual が通らない)
  return vm.runInThisContext(m[1] + '\n;Sugoroku', { filename: INDEX_HTML });
}

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
