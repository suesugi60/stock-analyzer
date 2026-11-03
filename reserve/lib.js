// 純粋なロジック(ブラウザ操作なし)。tablecheck_reserve.js から使う。

const REQUIRED_PROFILE = [
  ['sei', 'TC_SEI', '姓(漢字)'],
  ['mei', 'TC_MEI', '名(漢字)'],
  ['sei-kana', 'TC_SEI_KANA', 'せい(ふりがな)'],
  ['mei-kana', 'TC_MEI_KANA', 'めい(ふりがな)'],
  ['phone', 'TC_PHONE', '携帯電話'],
  ['email', 'TC_EMAIL', 'メールアドレス'],
];
const OPTIONAL_PROFILE = [
  ['allergy', 'TC_ALLERGY', 'なし'],
  ['hilton', 'TC_HILTON', '会員ではない'],
];

function pad2(n) { return String(n).padStart(2, '0'); }

function toIso(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new Error(`存在しない日付です: ${y}-${pad2(m)}-${pad2(d)}`);
  }
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

// 入力例: 2026-11-20 / 2026/11/20 / 2026年11月20日 / 11/20 / 11月20日
// 年省略時は today 以降で最初に来るその月日。today は 'YYYY-MM-DD'(JST基準の日付)。
function parseDate(input, today) {
  const s = String(input).trim().replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  let m;
  if ((m = s.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/))) {
    const iso = toIso(+m[1], +m[2], +m[3]);
    if (iso < today) throw new Error(`過去の日付です: ${iso}`);
    return iso;
  }
  if ((m = s.match(/^(\d{1,2})[/月](\d{1,2})日?$/))) {
    const ty = +today.slice(0, 4);
    let iso = toIso(ty, +m[1], +m[2]);
    if (iso < today) iso = toIso(ty + 1, +m[1], +m[2]);
    return iso;
  }
  throw new Error(`日付を読み取れません: ${input} (例: 11/20, 2026-11-20)`);
}

// 入力例: 19:00 / 9:00 / 19時 / 19時半 / 19時15分 / 1900 → 'HH:MM'
function parseTime(input) {
  const s = String(input).trim().replace(/[０-９：]/g, c => c === '：' ? ':' : String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  let m, h, min;
  if ((m = s.match(/^(\d{1,2}):(\d{2})$/))) { h = +m[1]; min = +m[2]; }
  else if ((m = s.match(/^(\d{1,2})時(半|(\d{1,2})分?)?$/))) { h = +m[1]; min = m[2] === '半' ? 30 : (m[3] ? +m[3] : 0); }
  else if ((m = s.match(/^(\d{2})(\d{2})$/))) { h = +m[1]; min = +m[2]; }
  else throw new Error(`時刻を読み取れません: ${input} (例: 19:00, 19時半)`);
  if (h > 23 || min > 59) throw new Error(`時刻の範囲が不正です: ${input}`);
  return `${pad2(h)}:${pad2(min)}`;
}

// plans: [{ name, visible, ... }] → { plan, coverCharge } | null
// 優先順: 「お席のみのご予約」そのもの → 窓側以外の「お席のみ」 → 【窓側確約】(カバーチャージあり)
function chooseSeatOnlyPlan(plans) {
  const vis = plans.filter(p => p.visible && /お席のみ/.test(p.name));
  const exact = vis.find(p => p.name.trim() === 'お席のみのご予約');
  if (exact) return { plan: exact, coverCharge: false };
  const plain = vis.find(p => !/窓側/.test(p.name));
  if (plain) return { plan: plain, coverCharge: false };
  const window = vis.find(p => /窓側/.test(p.name));
  if (window) return { plan: window, coverCharge: true };
  return null;
}

// CLI引数 > 環境変数 > 既定値。必須が欠けていれば全部まとめて例外。
function resolveProfile(args, env) {
  const p = {};
  const missing = [];
  for (const [key, envName, label] of REQUIRED_PROFILE) {
    const v = args[key] || env[envName];
    if (v && String(v).trim()) p[key] = String(v).trim(); else missing.push(`--${key} (${label}, 環境変数 ${envName})`);
  }
  for (const [key, envName, dflt] of OPTIONAL_PROFILE) {
    p[key] = (args[key] || env[envName] || dflt).toString().trim();
  }
  if (missing.length) throw new Error('予約者情報が足りません: ' + missing.join(', '));
  return p;
}

// --key value / --flag  → { key: value, flag: true }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`不明な引数: ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const DEFAULT_SHOP = 'terrace'; // 指定が無ければ KANADE TERRACE

module.exports = { parseDate, parseTime, chooseSeatOnlyPlan, resolveProfile, parseArgs, REQUIRED_PROFILE, DEFAULT_SHOP };
