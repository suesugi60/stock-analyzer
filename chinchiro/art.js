// ===== キャラクターとアイコンの絵(インラインSVG) =====
const SugorokuArt = (() => {
  'use strict';
  const N = '#2b2d5c';
  const S3 = `stroke="${N}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"`;
  const SKIN = '#ffe3c8';
  const wrap = (inner, vb = '0 0 100 100') => `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${inner}</svg>`;
  const head = (fill, cy = 58, r = 29) => `<circle cx="50" cy="${cy}" r="${r}" fill="${fill}" ${S3}/>`;
  const eyes = (y = 58, dx = 12, r = 4.2) => [-dx, dx].map((d) =>
    `<circle cx="${50 + d}" cy="${y}" r="${r}" fill="${N}"/><circle cx="${50 + d - 1.4}" cy="${y - 1.4}" r="1.5" fill="#fff"/>`).join('');
  const blush = (y = 66, dx = 20, r = 5) => [-dx, dx].map((d) => `<circle cx="${50 + d}" cy="${y}" r="${r}" fill="#ff8fa3" opacity=".75"/>`).join('');
  const smile = (y = 70, w = 6) => `<path d="M${50 - w} ${y} Q50 ${y + 6} ${50 + w} ${y}" fill="none" ${S3}/>`;
  const openMouth = (y = 70) => `<path d="M43 ${y} Q50 ${y + 10} 57 ${y} Z" fill="#c0392b" ${S3}/>`;
  const collar = (fill) => `<path d="M28 100 L50 84 L72 100 Z" fill="${fill}" ${S3}/><path d="M38 100 L50 91 L62 100 Z" fill="#fff"/>`;

  const CHAR_ART = {
    momotaro: () => wrap(
      head(SKIN) +
      `<path d="M22 52 Q28 28 50 27 Q72 28 78 52 Q64 44 50 46 Q36 44 22 52 Z" fill="#3a2e2e" ${S3}/>` +
      `<path d="M50 27 q-2 -8 5 -13" fill="none" ${S3}/>` +
      `<rect x="19" y="44" width="62" height="10" rx="4" fill="#fff" ${S3}/>` +
      `<path d="M81 47 l11 -6 l-3 9 l9 3 l-17 1 Z" fill="#fff" ${S3}/>` +
      `<circle cx="50" cy="49" r="3.5" fill="#ff4d4d"/>` +
      eyes(62) + blush(69) + smile(73) +
      `<circle cx="85" cy="25" r="9" fill="#ffb3c6" ${S3}/><path d="M85 17 v8" fill="none" ${S3}/><path d="M85 19 q6 -7 11 -2 q-6 4 -11 2 Z" fill="#2ec27e" ${S3}/>` +
      collar('#3b8cff')),
    kintaro: () => wrap(
      head(SKIN, 60) +
      `<path d="M21 60 A29 29 0 0 1 79 60 L79 62 L72 56 L65 62 L58 56 L51 62 L44 56 L37 62 L30 56 L23 62 L21 62 Z" fill="#3a2e2e" ${S3}/>` +
      eyes(69, 12) + blush(75, 21, 6) + smile(79, 6) +
      `<path d="M33 86 h34 v14 h-34 Z" fill="#ff4d4d" ${S3}/>` +
      `<text x="50" y="99" font-size="13" font-weight="900" text-anchor="middle" fill="#ffd93d" font-family="sans-serif">金</text>`),
    urashima: () => wrap(
      head(SKIN, 60, 28) +
      `<path d="M8 46 L50 16 L92 46 Z" fill="#e8c36a" ${S3}/><path d="M8 46 Q50 56 92 46 Q50 52 8 46 Z" fill="#d9ad4f" ${S3}/>` +
      eyes(63) + blush(70) + smile(74) +
      `<path d="M92 94 L98 46" fill="none" ${S3}/><path d="M98 46 q4 14 -5 24" fill="none" stroke="${N}" stroke-width="2"/>` +
      `<ellipse cx="16" cy="90" rx="10" ry="7" fill="#2ec27e" ${S3}/><circle cx="27" cy="88" r="4" fill="#7ed957" ${S3}/>` +
      collar('#2ec27e')),
    kaguya: () => wrap(
      `<path d="M20 50 Q20 20 50 20 Q80 20 80 50 L83 100 L17 100 Z" fill="#2b2d5c" ${S3}/>` +
      head(SKIN, 58, 27) +
      `<path d="M23 54 Q29 32 50 31 Q71 32 77 54 Q64 46 57 56 Q50 42 43 56 Q36 46 23 54 Z" fill="#2b2d5c"/>` +
      eyes(61) + blush(68, 19) +
      `<path d="M46 73 Q50 77 54 73 Z" fill="#ff4d4d" ${S3}/>` +
      `<circle cx="77" cy="36" r="5" fill="#ffd93d" ${S3}/><path d="M77 41 l-4 10 M77 41 l4 10" fill="none" ${S3}/>` +
      `<path d="M26 100 L50 82 L74 100 Z" fill="#ff8fa3" ${S3}/><path d="M38 100 L50 91 L62 100 Z" fill="#fff"/>`),
    issun: () => wrap(
      head(SKIN, 63, 24) +
      `<path d="M23 56 A27 27 0 0 1 77 56 Z" fill="#c0392b" ${S3}/><rect x="19" y="53" width="62" height="7" rx="3" fill="#e74c3c" ${S3}/>` +
      `<path d="M33 42 q8 -9 18 -9" fill="none" stroke="#fff" stroke-width="3" opacity=".7" stroke-linecap="round"/>` +
      eyes(66, 10, 3.8) + blush(72, 16, 4.5) + smile(75, 5) +
      `<path d="M84 95 L97 48" stroke="${N}" stroke-width="6" stroke-linecap="round"/><path d="M84 95 L97 48" stroke="#dfe3f0" stroke-width="3" stroke-linecap="round"/>` +
      `<path d="M80 90 l10 3" ${S3}/>` +
      collar('#3b8cff')),
    akaoni: () => wrap(
      `<path d="M34 36 L29 12 L45 31 Z" fill="#ffd93d" ${S3}/><path d="M66 36 L71 12 L55 31 Z" fill="#ffd93d" ${S3}/>` +
      head('#ff4d4d') +
      `<path d="M23 48 Q22 32 36 34 Q40 22 52 26 Q64 20 68 32 Q80 32 77 48 Q50 38 23 48 Z" fill="#3a2e2e" ${S3}/>` +
      `<path d="M33 53 l12 4 M67 53 l-12 4" fill="none" ${S3}/>` +
      eyes(63) + blush(70, 21) +
      `<path d="M40 72 Q50 82 60 72 Z" fill="#c0392b" ${S3}/><path d="M43 72 l3 6 l3 -6 Z" fill="#fff"/><path d="M51 72 l3 6 l3 -6 Z" fill="#fff"/>` +
      `<path d="M28 100 L50 84 L72 100 Z" fill="#ffd93d" ${S3}/><path d="M36 100 l6 -10 M48 100 l4 -14 M60 100 l-5 -10" stroke="${N}" stroke-width="3" stroke-linecap="round"/>`),
    aooni: () => wrap(
      `<path d="M43 34 L50 10 L57 34 Z" fill="#ffd93d" ${S3}/>` +
      head('#3b8cff') +
      `<path d="M23 48 Q22 32 36 34 Q40 22 52 26 Q64 20 68 32 Q80 32 77 48 Q50 38 23 48 Z" fill="#2b2d5c" ${S3}/>` +
      `<path d="M33 53 l12 4 M67 53 l-12 4" fill="none" ${S3}/>` +
      eyes(63) + blush(70, 21) +
      `<path d="M40 72 Q50 80 60 72" fill="none" ${S3}/><path d="M43 73 l3 6 l3 -6 Z" fill="#fff" stroke="${N}" stroke-width="2"/><path d="M51 73 l3 6 l3 -6 Z" fill="#fff" stroke="${N}" stroke-width="2"/>` +
      `<path d="M28 100 L50 84 L72 100 Z" fill="#ffd93d" ${S3}/><path d="M36 100 l6 -10 M48 100 l4 -14 M60 100 l-5 -10" stroke="${N}" stroke-width="3" stroke-linecap="round"/>`),
    inu: () => wrap(
      `<ellipse cx="21" cy="54" rx="9" ry="17" fill="#b5651d" ${S3} transform="rotate(14 21 54)"/><ellipse cx="79" cy="54" rx="9" ry="17" fill="#b5651d" ${S3} transform="rotate(-14 79 54)"/>` +
      head('#fff4e0') +
      `<circle cx="63" cy="58" r="10" fill="#b5651d"/>` +
      eyes(59) + blush(67, 21) +
      `<ellipse cx="50" cy="69" rx="5" ry="3.5" fill="${N}"/><path d="M50 72 v3 M44 77 q6 5 12 0" fill="none" ${S3}/>` +
      `<path d="M47 78 q3 7 6 0 Z" fill="#ff8fa3" ${S3}/>` +
      `<rect x="30" y="86" width="40" height="8" rx="4" fill="#ff4d4d" ${S3}/><circle cx="50" cy="94" r="4" fill="#ffd93d" ${S3}/>`),
    saru: () => wrap(
      `<circle cx="20" cy="54" r="9" fill="#c47a3a" ${S3}/><circle cx="20" cy="54" r="4.5" fill="${SKIN}"/><circle cx="80" cy="54" r="9" fill="#c47a3a" ${S3}/><circle cx="80" cy="54" r="4.5" fill="${SKIN}"/>` +
      head('#c47a3a') +
      `<ellipse cx="50" cy="62" rx="20" ry="17" fill="${SKIN}" ${S3}/>` +
      eyes(58, 9, 4) + `<circle cx="47" cy="67" r="1.6" fill="${N}"/><circle cx="53" cy="67" r="1.6" fill="${N}"/>` + smile(72, 6) + blush(68, 15, 4.5) +
      `<path d="M78 86 q13 -14 7 -28" fill="none" stroke="${N}" stroke-width="9" stroke-linecap="round"/><path d="M78 86 q13 -14 7 -28" fill="none" stroke="#ffd93d" stroke-width="5" stroke-linecap="round"/>`),
    kiji: () => wrap(
      `<ellipse cx="44" cy="25" rx="4" ry="9" fill="#ffd93d" ${S3} transform="rotate(-25 44 25)"/><ellipse cx="54" cy="24" rx="4" ry="9" fill="#ff6b35" ${S3} transform="rotate(10 54 24)"/>` +
      head('#2ea86f') +
      `<path d="M24 56 Q50 40 76 56 Q50 68 24 56 Z" fill="#ff4d4d" ${S3}/>` +
      eyes(56, 13, 4) +
      `<path d="M42 64 L58 64 L50 78 Z" fill="#ffd93d" ${S3}/>` +
      blush(72, 21) +
      `<path d="M23 78 Q50 92 77 78" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>`),
    kappa: () => wrap(
      head('#7ed957') +
      `<path d="M22 50 Q22 30 50 29 Q78 30 78 50 L72 45 L66 51 L60 45 L54 51 L48 45 L42 51 L36 45 L30 51 L24 45 Z" fill="#2e8b57" ${S3}/>` +
      `<ellipse cx="50" cy="31" rx="15" ry="5.5" fill="#ffd93d" ${S3}/><ellipse cx="50" cy="30" rx="10" ry="2.5" fill="#fff6c2"/>` +
      eyes(61) + blush(69, 21) +
      `<path d="M43 69 L57 69 L50 78 Z" fill="#ffd93d" ${S3}/>` +
      `<path d="M26 100 Q50 80 74 100 Z" fill="#2e8b57" ${S3}/><path d="M38 100 q12 -10 24 0" fill="none" ${S3}/>`),
    binbo: () => wrap(
      `<path d="M20 52 L15 32 L30 41 L33 21 L44 36 L52 17 L58 36 L68 23 L71 40 L85 31 L80 52 Z" fill="#8d7b6a" ${S3}/>` +
      head('#e9e6f2') +
      eyes(60) +
      `<rect x="31" y="50" width="14" height="8" fill="#e9e6f2"/><rect x="55" y="50" width="14" height="8" fill="#e9e6f2"/>` +
      `<path d="M31 58 h14 M55 58 h14" fill="none" ${S3}/>` +
      `<path d="M42 73 q4 -4 8 0 q4 4 8 0" fill="none" ${S3}/>` +
      `<circle cx="40" cy="79" r="1.2" fill="${N}"/><circle cx="46" cy="81" r="1.2" fill="${N}"/><circle cx="54" cy="81" r="1.2" fill="${N}"/><circle cx="60" cy="79" r="1.2" fill="${N}"/>` +
      `<rect x="63" y="63" width="10" height="9" fill="#b5651d" ${S3}/><path d="M65 63 v-3 M71 72 v3" ${S3}/>` +
      `<path d="M33 62 q-3 7 0 9 q3 -2 0 -9 Z" fill="#8ecdfb" ${S3}/>` +
      `<path d="M26 100 L34 88 L42 100 L50 88 L58 100 L66 88 L74 100 Z" fill="#8d7b6a" ${S3}/>`),
  };

  const mug = (x, y, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})">` +
    `<path d="M30 10 h7 a7 7 0 0 1 0 14 h-7" fill="#fff" ${S3}/>` +
    `<rect x="4" y="4" width="28" height="30" rx="5" fill="#ffb703" ${S3}/>` +
    `<circle cx="9" cy="4" r="6" fill="#fff" ${S3}/><circle cx="18" cy="1" r="7" fill="#fff" ${S3}/><circle cx="27" cy="4" r="6" fill="#fff" ${S3}/>` +
    `<circle cx="12" cy="24" r="2" fill="#fff" opacity=".8"/><circle cx="22" cy="18" r="1.6" fill="#fff" opacity=".8"/></g>`;
  const star = (x, y, s = 1) => `<path transform="translate(${x} ${y}) scale(${s})" d="M0 -8 l2.4 5.2 l5.6 .8 l-4 4 l1 5.6 l-5 -2.6 l-5 2.6 l1 -5.6 l-4 -4 l5.6 -.8 Z" fill="#ffd93d" ${S3}/>`;
  const ICON_ART = {
    self: () => wrap(mug(12, 14), '0 0 64 64'),
    all: () => wrap(`<g transform="rotate(-18 20 40)">${mug(4, 20, .8)}</g><g transform="rotate(18 44 40)">${mug(30, 20, .8)}</g>${star(32, 12, 1)}${star(10, 14, .55)}${star(54, 14, .55)}`, '0 0 64 64'),
    pick: () => wrap(
      `<rect x="26" y="26" width="32" height="11" rx="5.5" fill="${SKIN}" ${S3}/>` +
      `<rect x="8" y="22" width="28" height="30" rx="9" fill="${SKIN}" ${S3}/>` +
      `<path d="M20 33 h10 M20 41 h10" fill="none" ${S3}/><path d="M14 22 q6 -9 13 0" fill="${SKIN}" ${S3}/>`, '0 0 64 64'),
    chug: () => wrap(
      `<path d="M32 6 C26 18 14 22 14 38 a18 18 0 0 0 36 0 c0 -10 -6 -14 -9 -21 c-2 6 -5 8 -7 6 c4 -8 2 -14 -2 -17 Z" fill="#ff6b35" ${S3}/>` +
      `<path d="M32 30 c-5 6 -8 10 -8 16 a8 8 0 0 0 16 0 c0 -6 -3 -10 -8 -16 Z" fill="#ffd93d"/>`, '0 0 64 64'),
    rest: () => wrap(
      `<ellipse cx="30" cy="56" rx="22" ry="4.5" fill="#fff" ${S3}/>` +
      `<path d="M14 28 h32 v12 a16 16 0 0 1 -32 0 Z" fill="#7ed957" ${S3}/><ellipse cx="30" cy="28" rx="16" ry="4.5" fill="#b7e4a3" ${S3}/>` +
      `<path d="M46 32 h5 a6 6 0 0 1 0 12 h-5" fill="#fff" ${S3}/>` +
      `<path d="M22 20 q4 -5 0 -11 M32 20 q4 -5 0 -11" fill="none" stroke="${N}" stroke-width="3" stroke-linecap="round" opacity=".6"/>`, '0 0 64 64'),
    start: () => wrap(`<path d="M18 8 v50" stroke="${N}" stroke-width="5" stroke-linecap="round"/><path d="M21 10 h32 l-9 11 l9 11 h-32 Z" fill="#ff4d4d" ${S3}/>`, '0 0 64 64'),
    goal: () => wrap(
      `<path d="M18 8 v50" stroke="${N}" stroke-width="5" stroke-linecap="round"/><path d="M21 10 h34 v24 h-34 Z" fill="#fff" ${S3}/>` +
      [[21, 10], [38, 10], [29.5, 18], [46.5, 18], [21, 26], [38, 26]].map(([x, y]) => `<rect x="${x}" y="${y}" width="8.5" height="8" fill="${N}"/>`).join(''), '0 0 64 64'),
  };
  return { CHAR_ART, ICON_ART };
})();
if (typeof module !== 'undefined') module.exports = SugorokuArt;
