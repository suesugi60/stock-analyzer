// index.html が読み込む JS/CSS に、中身から作った印(?v=…)を付ける。
// 印が同じ間、ブラウザは手元の控え(最長 10 分)を使い続けることがある。中身が変わると印も変わるので、
// 公開したあとにページを再読み込みすれば、必ず新しいファイルが読み込まれる。
// JS/CSS を変えたら: node roulette/test/stamp-version.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
/** 印を付けるファイル(firebase-config.js は利用者ごとの設定なので付けない)。 */
export const STAMPED = ['style.css', 'logic.js', 'sync.js', 'wheel.js', 'app.js'];

/** html の中の読み込み(href="…" / src="…")を、いまの中身の印に付け替えた html を返す。 */
export function stamp(html, read = (name) => readFileSync(join(APP_DIR, name))) {
  let out = html;
  for (const name of STAMPED) {
    const v = createHash('sha256').update(read(name)).digest('hex').slice(0, 10);
    const re = new RegExp(`(href|src)="${name.replace('.', '\\.')}(\\?v=[0-9a-f]*)?"`);
    if (!re.test(out)) throw new Error(`index.html に ${name} の読み込みが見つからない`);
    out = out.replace(re, `$1="${name}?v=${v}"`);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = join(APP_DIR, 'index.html');
  const before = readFileSync(file, 'utf8');
  const after = stamp(before);
  if (after !== before) writeFileSync(file, after);
  console.log(after === before ? '印は最新です' : 'index.html の印を更新しました');
}
