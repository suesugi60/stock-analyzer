// ===== サイコロの場面(器に3つ投げる)と音 =====
// 演出の乱数は throwObj.seed だけから作るので、全端末で同じ映像になる。
const ChinchiroAnim = (() => {
  'use strict';

  const PIPS = { 1: [[2, 2]], 2: [[1, 3], [3, 1]], 3: [[1, 3], [2, 2], [3, 1]], 4: [[1, 1], [1, 3], [3, 1], [3, 3]],
    5: [[1, 1], [1, 3], [2, 2], [3, 1], [3, 3]], 6: [[1, 1], [1, 3], [2, 1], [2, 3], [3, 1], [3, 3]] };
  // 面 F を正面に向ける回転(度)。面の配置: 1=前 6=後 2=右 5=左 3=上 4=下
  const FINAL_ROT = { 1: [0, 0], 6: [0, 180], 2: [0, -90], 5: [0, 90], 3: [-90, 0], 4: [90, 0] };
  const FLOOR = { cx: 240, cy: 160, rx: 150, ry: 42 }; // 器の底(テーブル座標)
  const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function mulberry32(seed) {
    let a = (Number(seed) || 0) >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function validDice(d) {
    return Array.isArray(d) && d.length === 3 && d.every((x) => Number.isInteger(x) && x >= 1 && x <= 6);
  }

  // ---------- 声 ----------
  /** 役ごとの読み上げ文言。キーはそのまま音声ファイル名(voice/<キー>.mp3 / .m4a)になる。 */
  const VOICE_LINES = {
    pinzoro: 'ピンゾロ！',
    zoro2: '2ゾロ！', zoro3: '3ゾロ！', zoro4: '4ゾロ！', zoro5: '5ゾロ！', zoro6: '6ゾロ！',
    shigoro: 'シゴロ！',
    me1: '1の目', me2: '2の目', me3: '3の目', me4: '4の目', me5: '5の目', me6: '6の目',
    none: '目なし',
    hifumi: 'ヒフミ…',
    shonben: 'ションベン！',
  };
  /** 役(logic の hand。ションベンは {type:'shonben'})→ VOICE_LINES のキー。 */
  function voiceKeyFor(hand) {
    if (!hand || !hand.type) return 'none';
    if (hand.type === 'zoro' || hand.type === 'me') {
      const k = `${hand.type}${hand.value}`;
      return Object.hasOwn(VOICE_LINES, k) ? k : 'none';
    }
    return Object.hasOwn(VOICE_LINES, hand.type) ? hand.type : 'none';
  }
  /** 自然に聞こえる順の既知の日本語音声名(前にあるほど優先)。 */
  const VOICE_PREFERENCE = ['Google 日本語', 'Nanami', 'Keita', 'Kyoko', 'O-ren', 'O-Ren', 'Hattori', 'Ayumi', 'Haruka', 'Ichiro', 'Sayaka', 'Otoya'];
  /**
   * speechSynthesis.getVoices() の中から、いちばん人間らしい日本語の声を選ぶ。
   * 拡張/プレミアム/ニューラル系(iOS の「拡張」、Edge の「Natural」など)> 知られた自然な声 > その他の日本語。無ければ null。
   */
  function pickVoice(voices) {
    const ja = (voices || []).filter((v) => v && /^ja/i.test(String(v.lang || '')));
    if (!ja.length) return null;
    const score = (v) => {
      const uri = String(v.voiceURI || '').toLowerCase();
      const name = String(v.name || '');
      let s = 0;
      if (/premium|enhanced|natural|neural|wavenet|siri/.test(uri) || /natural|enhanced|premium|拡張/i.test(name)) s += 100;
      const i = VOICE_PREFERENCE.findIndex((p) => name.includes(p));
      if (i >= 0) s += 50 - i;
      return s;
    };
    return ja.map((v, i) => ({ v, i, s: score(v) })).sort((a, b) => b.s - a.s || a.i - b.i)[0].v;
  }

  // ---------- リーチ(最後の1個をどれにするか・演出の強さ) ----------
  /** レベル 0〜3(なし/ノーマル/スーパー/激アツ)の重み。結果ごとに引くので「強い役ほど激アツが出やすいが確定ではない」。 */
  const REACH_WEIGHTS = { pinzoro: [0, 5, 25, 70], zoro: [0, 20, 45, 35], shigoro: [0, 25, 45, 30], me: [70, 22, 6, 2], noneShigoro: [75, 18, 5, 2], hifumi: [10, 30, 60, 0], nonePinch: [80, 15, 5, 0] };
  /** 溜めの長さ(2 個目が止まってから最後の 1 個を落とすまで)。 */
  const REACH_HOLD_MS = { 1: 900, 2: 1800, 3: 2800 };
  const NO_REACH = () => ({ lastIdx: 2, kind: null, level: 0, pinch: false });
  const hi = (x) => x >= 4;
  const lo = (x) => x <= 3;
  /** 先に止まる 2 個だけから見える形(結果は見ない)。 */
  function visibleKind(a, b) {
    if (a === b) return a === 1 ? 'pinzoro' : 'zoro';
    if (hi(a) && hi(b)) return 'shigoro';
    if (lo(a) && lo(b)) return 'pinch';
    return null;
  }
  function outcomeOf(d) {
    const s = d.slice().sort((x, y) => x - y);
    if (s[0] === s[1] && s[1] === s[2]) return s[0] === 1 ? 'pinzoro' : 'zoro';
    if (s[0] === 4 && s[1] === 5 && s[2] === 6) return 'shigoro';
    if (s[0] === 1 && s[1] === 2 && s[2] === 3) return 'hifumi';
    if (s[0] === s[1] || s[1] === s[2]) return 'me';
    return 'none';
  }
  /**
   * 最後に止めるサイコロとリーチの強さを seed から決める(全端末で同じ)。
   * 止まる順は「形が見える順」と「見えない順」を混ぜ、順番そのものが結果を確定させないようにする。
   * @returns {{ lastIdx: number, kind: 'pinzoro'|'zoro'|'shigoro'|'pinch'|null, level: 0|1|2|3, pinch: boolean }}
   */
  function reachPlan(dice, shonben, seed, force) {
    if (shonben || !validDice(dice)) return NO_REACH();
    const rnd = mulberry32(((Number(seed) || 0) ^ 0x9e3779b9) >>> 0);
    const flip = rnd() < 0.5; // 順番の表裏
    const pick = rnd();       // 候補からの選択
    const roll = rnd();       // レベル
    const out = outcomeOf(dice);
    let candidates;
    if (out === 'me') {
      const odd = dice[0] === dice[1] ? 2 : dice[0] === dice[2] ? 1 : 0;
      candidates = flip ? [odd] : [0, 1, 2].filter((i) => i !== odd); // 表: 違う1つが最後(ゾロ目リーチ) / 裏: ペアの片方が最後
    } else if (out === 'none') {
      const his = [0, 1, 2].filter((i) => hi(dice[i]));
      const majority = his.length === 2 ? his : [0, 1, 2].filter((i) => lo(dice[i]));
      const minority = [0, 1, 2].filter((i) => !majority.includes(i));
      candidates = flip ? minority : majority; // 表: 多数派が先(シゴロリーチ/ピンチ) / 裏: 混ざった2つが先
    } else {
      candidates = [0, 1, 2];
    }
    const lastIdx = candidates[Math.min(candidates.length - 1, Math.floor(pick * candidates.length))];
    const [a, b] = [0, 1, 2].filter((i) => i !== lastIdx).map((i) => dice[i]);
    const kind = visibleKind(a, b);
    let level = 0;
    if (kind) {
      const w = REACH_WEIGHTS[out === 'none' ? (kind === 'pinch' ? 'nonePinch' : 'noneShigoro') : out];
      const total = w.reduce((t, x) => t + x, 0);
      let acc = 0;
      level = 3;
      for (let i = 0; i < 4; i++) { acc += w[i]; if (roll * total < acc) { level = i; break; } }
    }
    if (Number.isInteger(force) && force >= 0 && force <= 3) level = force;
    if (kind === 'pinch') level = Math.min(level, 2);
    return { lastIdx, kind, level, pinch: kind === 'pinch' };
  }

  // ---------- 音(その場で合成) ----------
  /** 0.5 秒の無音 WAV。ループ再生して iOS にページを「再生中」と思わせ、消音スイッチでも Web Audio を鳴らす。 */
  const SILENT_LOOP = 'data:audio/wav;base64,UklGRsQPAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YaAPAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';
  /** 約50msの無音 WAV。iOS で <audio> をユーザー操作中に一度鳴らして「解錠」するために使う。 */
  const SILENT_WAV = 'data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';

  /**
   * @param {{voiceFiles?: Record<string,string>}} [opts]
   *   voiceFiles: VOICE_LINES のキー → 音声ファイルURL。あればそれを再生し、無いキーは端末の読み上げに切り替える。
   *   (後から同じオブジェクトに追加しても反映される)
   */
  function createSounds(opts = {}) {
    const voiceFiles = (opts && opts.voiceFiles) || {};
    const voiceMissing = new Set();
    let voiceEl = null;      // 音声ファイル再生用に使い回す <audio>(iOS の解錠を保つため1つだけ)
    let voiceText = null;    // 再生に失敗したとき読み上げに切り替える文言
    let voiceCache = null;   // pickVoice の結果
    const synth = () => (typeof window !== 'undefined' && window.speechSynthesis) || null;
    if (synth() && typeof synth().addEventListener === 'function') synth().addEventListener('voiceschanged', () => { voiceCache = null; });
    function chosenVoice() {
      if (voiceCache) return voiceCache;
      try { voiceCache = pickVoice(synth().getVoices()); } catch { voiceCache = null; }
      return voiceCache;
    }
    function speak(text) {
      const s = synth();
      if (muted || !text || !s || typeof SpeechSynthesisUtterance === 'undefined') return;
      try {
        s.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'ja-JP'; u.rate = 1.0; u.pitch = 1.0; u.volume = 1;
        const v = chosenVoice();
        if (v) u.voice = v;
        s.speak(u);
      } catch { /* 読み上げ不可 */ }
    }
    function audioEl() {
      if (voiceEl || typeof window === 'undefined' || typeof window.Audio !== 'function') return voiceEl;
      try {
        voiceEl = new window.Audio();
        voiceEl.preload = 'auto';
        if (typeof voiceEl.addEventListener === 'function') {
          voiceEl.addEventListener('error', () => {
            // ファイルが無い/壊れている → このキーは以後読み上げに回す
            const k = voiceEl.dataset && voiceEl.dataset.key;
            if (k) voiceMissing.add(k);
            const t = voiceText; voiceText = null;
            speak(t);
          });
        }
      } catch { voiceEl = null; }
      return voiceEl;
    }
    function playFile(url, key, text) {
      const a = audioEl(); if (!a) return false;
      try {
        voiceText = text;
        if (a.dataset) a.dataset.key = key;
        a.src = url;
        try { a.currentTime = 0; } catch { /* 読み込み前 */ }
        const p = a.play();
        if (p && typeof p.then === 'function') {
          p.then(() => { voiceText = null; }, () => { const t = voiceText; voiceText = null; speak(t); });
        }
        return true;
      } catch { voiceText = null; return false; }
    }

    let ctx = null;
    let muted = false;
    let unlocked = false;
    let keepAlive = false;   // 無音ループを回すか(親機は常時、スマホは自分の対戦中だけ)
    let loopEl = null;
    let speechWarm = false;
    const readyCbs = [];
    const isReady = () => !!ctx && ctx.state === 'running';
    const notify = () => { const r = isReady(); for (const f of readyCbs) { try { f(r); } catch { /* 画面側の都合 */ } } };
    const ac = () => {
      try {
        if (!ctx) {
          ctx = new (window.AudioContext || window.webkitAudioContext)();
          if (typeof ctx.addEventListener === 'function') ctx.addEventListener('statechange', notify);
        }
        return ctx;
      } catch { return null; }
    };
    const tryResume = (c) => { let p; try { p = c.resume(); } catch { p = null; } return Promise.resolve(p); };
    /**
     * 鳴らす直前の保険。running ならすぐ鳴らす。違えば resume() を試し、300ms 以内に起きたら鳴らす。
     * 起きなければその音は捨てる(あとでまとめて鳴らない)。resume() はユーザー操作の外では拒まれることがある。
     */
    function ensure(fn) {
      if (muted) return;
      const c = ac(); if (!c) return;
      if (c.state === 'running') { fn(c); return; }
      let late = false;
      const timer = setTimeout(() => { late = true; }, 300);
      tryResume(c).then(() => { clearTimeout(timer); if (!late && c.state === 'running' && !muted) fn(c); notify(); }, () => {});
    }
    function startLoop() {
      if (typeof window === 'undefined' || typeof window.Audio !== 'function') return;
      try {
        if (!loopEl) {
          loopEl = new window.Audio();
          loopEl.loop = true;
          if (typeof loopEl.setAttribute === 'function') loopEl.setAttribute('playsinline', '');
          loopEl.src = SILENT_LOOP;
        }
        if (loopEl.paused !== false) { const p = loopEl.play(); if (p && p.catch) p.catch(() => {}); }
      } catch { /* 再生できなければ次の操作で */ }
    }
    function stopLoop() { if (loopEl) { try { loopEl.pause(); } catch { /* 無視 */ } } }
    /** iOS は最初の読み上げもユーザー操作が要るので、操作の中で無音の発話を 1 回流しておく。 */
    function warmSpeech() {
      if (speechWarm) return;
      const s = synth(); if (!s || typeof SpeechSynthesisUtterance === 'undefined') return;
      speechWarm = true;
      try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; s.speak(u); } catch { /* 読み上げ不可 */ }
    }
    function noise(dur, freq, q, vol) { ensure((c) => noiseAt(c, dur, freq, q, vol)); }
    function noiseAt(c, dur, freq, q, vol) {
      const len = Math.floor(c.sampleRate * dur);
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
      const src = c.createBufferSource(); src.buffer = buf;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
      const g = c.createGain(); g.gain.value = vol;
      src.connect(bp).connect(g).connect(c.destination); src.start();
    }
    function tone(freq, dur, vol, type = 'triangle') { ensure((c) => toneAt(c, freq, dur, vol, type)); }
    function toneAt(c, freq, dur, vol, type) {
      const t = c.currentTime;
      const o = c.createOscillator(); o.type = type; o.frequency.value = freq;
      const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
    }
    function lowNoise(dur, vol) { ensure((c) => lowNoiseAt(c, dur, vol)); }
    function lowNoiseAt(c, dur, vol) {
      const len = Math.floor(c.sampleRate * dur);
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.5);
      const src = c.createBufferSource(); src.buffer = buf;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220;
      const g = c.createGain(); g.gain.value = vol;
      src.connect(lp).connect(g).connect(c.destination); src.start();
    }
    function sweep(from, to, dur, vol) { ensure((c) => sweepAt(c, from, to, dur, vol)); }
    function sweepAt(c, from, to, dur, vol) {
      const t = c.currentTime;
      const o = c.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(from, t); o.frequency.exponentialRampToValueAtTime(to, t + dur);
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
      const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(lp).connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
    }
    return {
      /** iOS Safari 対策: ユーザー操作の中で AudioContext を作って起こす。 */
      unlock() {
        const c = ac();
        if (c) {
          unlocked = true;
          if (c.state !== 'running') tryResume(c).then(notify, () => {});
        }
        // <audio> も同じ操作の中で一度鳴らしておく(iOS は操作外の play() を拒むため)
        const a = audioEl();
        if (a && !a.src) { try { a.src = SILENT_WAV; const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch { /* 無視 */ } }
        if (keepAlive) startLoop();
        warmSpeech();
      },
      /** 効果音を今すぐ鳴らせるか(AudioContext が running)。 */
      get ready() { return isReady(); },
      /** ready が変わったかもしれないときに呼ばれる(statechange と resume の後)。 */
      onReadyChange(cb) { if (typeof cb === 'function') readyCbs.push(cb); },
      /** 無音ループで iOS を「再生中」にするか。true にすると次の操作(と解錠済みなら今)から回り、false で止める。 */
      setKeepAlive(b) { keepAlive = !!b; if (keepAlive) { if (unlocked) startLoop(); } else stopLoop(); },
      get unlocked() { return unlocked; },
      /** 着地: 高い「カッ」+ 低い「ドッ」。 */
      clack(vol = 1) { noise(0.07, 1800 + Math.random() * 900, 1.2, 0.8 * vol); tone(2400 + Math.random() * 600, 0.1, 0.22 * vol); lowNoise(0.09, 0.7 * vol); },
      rattle(ms = 600) { const n = Math.floor(ms / 60); for (let i = 0; i < n; i++) setTimeout(() => { noise(0.03, 2600 + Math.random() * 900, 2, 0.3); }, i * 60 + Math.random() * 20); },
      /** 投げ込みの風切り。 */
      whoosh() { sweep(180, 900, 0.35, 0.25); noise(0.3, 1200, 0.6, 0.25); },
      /** 転がっている間のゴロゴロ。 */
      rumble(ms = 900) { const n = Math.floor(ms / 45); for (let i = 0; i < n; i++) setTimeout(() => lowNoise(0.05, 0.35 * (1 - i / n)), i * 45); },
      /** 強い役の「ドン!」。 */
      boom() { lowNoise(0.5, 1.0); sweep(120, 40, 0.5, 0.5); noise(0.25, 600, 0.5, 0.5); },
      /** リーチの鼓動(レベルが高いほど速く・多く。激アツは上昇音つき)。{ stop() } を返す。 */
      heartbeat(level) {
        const beat = () => { tone(60, 0.25, 0.9, 'sine'); lowNoise(0.08, 0.6); };
        const times = level >= 3 ? [0, 500, 900, 1250, 1550, 1800, 2000, 2150] : level === 2 ? [0, 350, 700, 1050] : [0, 450];
        const timers = times.map((t) => setTimeout(beat, t));
        if (level >= 3) timers.push(setTimeout(() => sweep(200, 1800, 1.2, 0.35), 1600));
        return { stop() { for (const t of timers) clearTimeout(t); } };
      },
      /** ピンチの低い唸り。{ stop() } を返す。 */
      drone() {
        const hum = () => tone(55, 1.2, 0.3, 'sawtooth');
        hum();
        const id = setInterval(hum, 600);
        return { stop() { clearInterval(id); } };
      },
      /** 着地のヒットストップの一撃。 */
      hit() { noise(0.09, 2000, 1.2, 1.2); tone(2600, 0.12, 0.3); lowNoise(0.25, 1.0); },
      /** リーチが外れたときの「ずっこけ」。 */
      sad() { sweep(400, 150, 0.6, 0.3); },
      /**
       * 役名をコールする。voiceFiles[key] があればその音声ファイル(人の声)を再生し、
       * 無ければ端末の読み上げ(いちばん自然な日本語の声を自動で選ぶ)。どちらも無ければ何もしない。
       */
      voice(text, key) {
        if (muted || typeof window === 'undefined') return;
        const url = key && !voiceMissing.has(key) && Object.hasOwn(voiceFiles, key) ? voiceFiles[key] : null;
        if (url && playFile(url, key, text)) return;
        speak(text);
      },
      /** 読み上げに使う声(テスト/設定表示用)。 */
      get voiceName() { const v = chosenVoice(); return v ? v.name : null; },
      chime(kind) {
        const seq = kind === 'gold' ? [880, 1108, 1318, 1760, 2217, 2637] : kind === 'rainbow' ? [659, 784, 988, 1175, 1568] : [523, 659, 784, 1047];
        seq.forEach((f, i) => { setTimeout(() => { tone(f, 0.6, 0.22, 'sine'); tone(f * 2, 0.3, 0.06, 'triangle'); }, i * 85); });
      },
      thud() { tone(110, 0.3, 0.35, 'sine'); noise(0.12, 300, 0.8, 0.35); },
      thunder() { noise(0.7, 140, 0.4, 0.8); tone(55, 0.7, 0.45, 'sawtooth'); },
      roll() { tone(520, 0.12, 0.12, 'square'); setTimeout(() => tone(660, 0.12, 0.12, 'square'), 90); },
      setMuted(b) { muted = !!b; },
      get muted() { return muted; },
    };
  }

  // ---------- 場面 ----------
  function createDiceStage(root, sounds) {
    root.classList.add('stage');
    root.innerHTML = `
      <div class="thrower"><span class="avatar lg" data-char=""></span><div class="bubble"></div><div class="hand"><i class="mini"></i><i class="mini"></i><i class="mini"></i></div></div>
      <div class="scaler"><div class="table">
        <div class="bowl-back"></div>
        <div class="dice-layer"></div>
        <div class="bowl-front"></div>
        <div class="fx-layer"></div>
        <div class="result-stamp" data-hand=""></div>
      </div></div>
      <div class="hint">タップで飛ばす</div>`;
    const el = {
      avatar: root.querySelector('.avatar'), bubble: root.querySelector('.bubble'), hand: root.querySelector('.hand'),
      scaler: root.querySelector('.scaler'), table: root.querySelector('.table'), dice: root.querySelector('.dice-layer'),
      fx: root.querySelector('.fx-layer'), stamp: root.querySelector('.result-stamp'),
    };
    let running = null; // { anims: Animation[], timers: number[], skipped, resolveSkip }

    function fit() {
      const w = root.clientWidth || 480;
      const s = Math.min(1, w / 480);
      el.scaler.style.transform = `scale(${s})`;
      el.scaler.style.height = `${300 * s}px`;
    }
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(root);
    fit();

    function renderPips(face, n) {
      face.innerHTML = '';
      for (const [r, c] of PIPS[n]) {
        const pip = document.createElement('span');
        pip.className = 'pip';
        pip.style.gridArea = `${r} / ${c}`;
        face.appendChild(pip);
      }
    }
    function makeDie() {
      const wrap = document.createElement('div');
      wrap.className = 'die-wrap';
      wrap.innerHTML = '<div class="cube-tilt"><div class="cube"></div></div>';
      const cube = wrap.querySelector('.cube');
      for (let f = 1; f <= 6; f++) {
        const face = document.createElement('div');
        face.className = `face f${f}`;
        renderPips(face, f);
        cube.appendChild(face);
      }
      const shadow = document.createElement('div');
      shadow.className = 'cube-shadow';
      return { wrap, cube, shadow };
    }

    function reset() {
      if (running) { for (const a of running.anims) a.cancel(); for (const t of running.timers) clearTimeout(t); running = null; }
      el.dice.innerHTML = '';
      el.fx.innerHTML = '';
      el.stamp.textContent = '';
      el.stamp.dataset.hand = '';
      el.table.className = 'table';
      el.hand.classList.remove('rattle');
      root.classList.remove('playing', 'reaching');
    }

    function setThrower(t) {
      if (t && t.char && typeof SugorokuArt !== 'undefined' && Object.hasOwn(SugorokuArt.CHAR_ART, t.char)) {
        el.avatar.innerHTML = SugorokuArt.CHAR_ART[t.char]();
        el.avatar.dataset.char = t.char;
        el.avatar.style.setProperty('--c', t.color || '#2b2d5c');
        el.avatar.hidden = false;
      } else {
        el.avatar.hidden = true;
      }
      el.bubble.textContent = t && t.name ? `${t.name} さんが振る!` : '';
    }

    // 待ち。skip() されたら即座に起こす
    const sleep = (ms) => new Promise((r) => {
      const run = running;
      const id = setTimeout(r, ms);
      if (run) { run.timers.push(id); run.wakers.push(r); }
    });
    const pointIn = (rnd, rmin, rmax) => {
      const a = rnd() * Math.PI * 2;
      const r = rmin + rnd() * (rmax - rmin);
      return { x: Math.cos(a) * FLOOR.rx * r, y: Math.sin(a) * FLOOR.ry * r };
    };
    function landingSpots(rnd) {
      const spots = [];
      for (let i = 0; i < 3; i++) {
        let p = pointIn(rnd, 0.15, 0.85);
        for (let k = 0; k < 60; k++) {
          if (spots.every((q) => Math.hypot(q.x - p.x, (q.y - p.y) * 2.0) >= 84)) break;
          p = pointIn(rnd, 0.15, 0.9);
        }
        spots.push(p);
      }
      return spots;
    }

    /** 1つのサイコロの軌道(テーブル座標。器の底中心が原点)。 */
    function pathFor(rnd, i, land, out) {
      const start = { x: -300 + i * 18, y: -250 - i * 10 };
      if (!out) {
        const p1 = pointIn(rnd, 0.5, 0.95);
        const p2 = pointIn(rnd, 0.3, 0.9);
        const p3 = { x: (p2.x + land.x) / 2 + (rnd() - 0.5) * 30, y: (p2.y + land.y) / 2 + (rnd() - 0.5) * 12 };
        return [
          { p: start, h: 0, off: 0 },
          { p: p1, h: 0, off: 0.26 }, { p: mid(p1, p2), h: 95, off: 0.37 },
          { p: p2, h: 0, off: 0.48 }, { p: mid(p2, p3), h: 50, off: 0.58 },
          { p: p3, h: 0, off: 0.68 }, { p: mid(p3, land), h: 22, off: 0.76 },
          { p: land, h: 0, off: 0.86 }, { p: land, h: 6, off: 0.92 }, { p: land, h: 0, off: 1 },
        ];
      }
      // ションベン: 縁で跳ねて外へ飛び出し、机を転がって画面外へ
      const rim = { x: 120 + rnd() * 30, y: -30 };
      return [
        { p: start, h: 0, off: 0 },
        { p: rim, h: 0, off: 0.26 }, { p: { x: 230, y: 40 }, h: 80, off: 0.40 },
        { p: { x: 300, y: 125 }, h: 0, off: 0.55 }, { p: { x: 360, y: 150 }, h: 26, off: 0.66 },
        { p: { x: 420, y: 175 }, h: 0, off: 0.78 }, { p: { x: 520, y: 200 }, h: 0, off: 1 },
      ];
    }
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

    function buildFrames(path, face, rnd, out) {
      const [fx, fy] = FINAL_ROT[face] || [0, 0];
      const wrapF = []; const cubeF = []; const shadowF = [];
      let rx = rnd() * 360; let ry = rnd() * 360;
      const n = path.length;
      path.forEach((k, idx) => {
        const easing = k.h > 0 ? 'ease-in' : 'ease-out';
        wrapF.push({ transform: `translate(${k.p.x}px, ${k.p.y - k.h}px)`, offset: k.off, easing, opacity: out && idx === n - 1 ? 0 : 1 });
        const last = idx >= n - 2 && !out;
        if (!last) { rx += 120 + rnd() * 160; ry += 140 + rnd() * 200; }
        const rot = last ? `rotateX(${fx + 1080}deg) rotateY(${fy + 1440}deg)` : `rotateX(${rx}deg) rotateY(${ry}deg)`;
        cubeF.push({ transform: rot, offset: k.off, easing: 'linear' });
        const s = Math.max(0.35, 1 - k.h / 150);
        shadowF.push({ transform: `translate(${k.p.x}px, ${k.p.y}px) scale(${s})`, opacity: out && idx === n - 1 ? 0 : 0.12 + 0.28 * s, offset: k.off, easing });
      });
      return { wrapF, cubeF, shadowF };
    }

    /** 着地の砂煙。 */
    function fxDust(x, y, rnd, n = 5) {
      for (let i = 0; i < n; i++) {
        const d = document.createElement('i');
        d.className = 'dust';
        el.fx.appendChild(d);
        const a = Math.PI + rnd() * Math.PI; // 上方向へ
        const dist = 14 + rnd() * 26;
        d.style.left = `${240 + x}px`; d.style.top = `${160 + y + 14}px`;
        d.animate([
          { transform: 'translate(-50%,-50%) scale(.4)', opacity: .8 },
          { transform: `translate(calc(-50% + ${Math.cos(a) * dist}px), calc(-50% + ${Math.sin(a) * dist * 0.5 - 6}px)) scale(1.6)`, opacity: 0 },
        ], { duration: 420 + rnd() * 200, easing: 'ease-out', fill: 'forwards' });
      }
    }
    function fxShake(strong) {
      el.table.classList.remove('shake', 'shake2');
      void el.table.offsetWidth; // アニメを再始動
      el.table.classList.add(strong ? 'shake2' : 'shake');
      setTimeout(() => el.table.classList.remove('shake', 'shake2'), 260);
    }

    function fxFlash(kind, ms = 700) {
      const f = document.createElement('div'); f.className = `flash ${kind}`; el.fx.appendChild(f);
      f.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, fill: 'forwards' });
    }
    function fxRing(kind) {
      const r = document.createElement('div'); r.className = `ring ${kind}`; el.fx.appendChild(r);
      r.animate([{ transform: 'scale(.2)', opacity: 1 }, { transform: 'scale(3.2)', opacity: 0 }], { duration: 900, easing: 'ease-out', fill: 'forwards' });
    }
    function fxParticles(rnd, n, colors, star) {
      for (let i = 0; i < n; i++) {
        const p = document.createElement('i');
        p.className = 'particle' + (star ? ' star' : '');
        p.style.background = colors[i % colors.length];
        el.fx.appendChild(p);
        const a = rnd() * Math.PI * 2; const d = 90 + rnd() * 160;
        p.animate([
          { transform: 'translate(0,0) rotate(0deg) scale(1)', opacity: 1 },
          { transform: `translate(${Math.cos(a) * d}px, ${Math.sin(a) * d * 0.7 + 40}px) rotate(${rnd() * 720}deg) scale(.4)`, opacity: 0 },
        ], { duration: 800 + rnd() * 500, easing: 'cubic-bezier(.2,.8,.4,1)', fill: 'forwards' });
      }
    }

    function stampFor(hand, remaining) {
      if (!hand) return { text: remaining > 0 ? `目なし… あと${remaining}投` : '目なし…', key: 'none' };
      switch (hand.type) {
        case 'pinzoro': return { text: 'ピンゾロ!!', key: 'pinzoro' };
        case 'zoro': return { text: `${hand.value}ゾロ!`, key: 'zoro' };
        case 'shigoro': return { text: 'シゴロ!', key: 'shigoro' };
        case 'me': return { text: `${hand.value}の目`, key: 'me' };
        case 'hifumi': return { text: 'ヒフミ…', key: 'hifumi' };
        case 'shonben': return { text: 'ションベン!', key: 'shonben' };
        default: return { text: remaining > 0 ? `目なし… あと${remaining}投` : '目なし…', key: 'none' };
      }
    }

    function showResult(throwObj, opts, dies, rnd, skipped, plan = NO_REACH()) {
      const { text, key } = stampFor(throwObj.shonben ? { type: 'shonben' } : throwObj.hand, opts.remaining ?? 0);
      el.stamp.textContent = text;
      el.stamp.dataset.hand = key;
      const vkey = voiceKeyFor(throwObj.shonben ? { type: 'shonben' } : throwObj.hand);
      setTimeout(() => sounds.voice(VOICE_LINES[vkey], vkey), skipped ? 0 : (key === 'pinzoro' || key === 'zoro' ? 250 : 120));
      if (skipped) return;
      const colors = ['#ffd93d', '#ff4d4d', '#2ec27e', '#3b8cff', '#b56cff', '#fff'];
      switch (key) {
        case 'pinzoro': fxFlash('gold', 1100); fxRing('gold'); fxParticles(rnd, 44, ['#ffd93d', '#ffe978', '#fff', '#ff9f1c'], true); fxShake(true); sounds.boom(); sounds.chime('gold'); break;
        case 'zoro': fxFlash('white', 500); fxRing('rainbow'); fxParticles(rnd, 24, colors, true); fxShake(true); sounds.boom(); sounds.chime('rainbow'); break;
        case 'shigoro': fxFlash('blue', 700); fxRing('blue'); fxParticles(rnd, 20, ['#8ed0ff', '#fff', '#3b8cff'], false); fxShake(false); sounds.chime('blue'); break;
        case 'me': {
          const d = throwObj.dice; const odd = d[0] === d[1] ? 2 : d[0] === d[2] ? 1 : 0;
          if (dies[odd]) dies[odd].cube.classList.add('pulse');
          fxParticles(rnd, 8, ['#fff', '#ffd93d'], false);
          sounds.roll(); break;
        }
        case 'none': sounds.thud(); break;
        case 'hifumi': el.table.classList.add('dark'); fxFlash('white', 120); fxShake(true); sounds.thunder(); break;
        case 'shonben': fxShake(false); sounds.thud(); break;
        default: break;
      }
    }

    /** 投げる。opts: { thrower:{name,char,color}, remaining, reduced }。タップで skip。 */
    // ---- リーチの飾り(カットイン・ランプ・ストライプ・稲妻・スポットライト) ----
    const BOLT = '<svg viewBox="0 0 60 160" xmlns="http://www.w3.org/2000/svg"><path d="M36 0 L6 78 L30 78 L18 160 L56 60 L32 60 Z" fill="#ffe978" stroke="#2b2d5c" stroke-width="5" stroke-linejoin="round"/></svg>';
    function cutinText(plan, level) {
      if (plan.pinch) return level >= 2 ? '大ピンチ!!' : 'ピンチ…';
      const base = level >= 3 ? '激アツ!!!' : level === 2 ? 'スーパーリーチ!!' : 'リーチ!';
      return plan.kind === 'pinzoro' ? `ピンゾロ${base}` : base;
    }
    function fxReach(plan, level) {
      const spot = document.createElement('div'); spot.className = 'spot'; el.fx.appendChild(spot);
      const c = document.createElement('div');
      c.className = `cutin l${level}${plan.pinch ? ' pinch' : ''}`;
      c.textContent = cutinText(plan, level);
      el.fx.appendChild(c);
      if (level >= 2) { const l = document.createElement('div'); l.className = 'lamps'; l.innerHTML = '<i></i><i></i><i></i><i></i>'; el.fx.appendChild(l); }
      if (level >= 3) {
        for (const pos of ['top', 'bottom']) { const st = document.createElement('div'); st.className = `stripes ${pos}`; el.fx.appendChild(st); }
        for (const pos of ['left', 'right']) { const bolt = document.createElement('div'); bolt.className = `bolt ${pos}`; bolt.innerHTML = BOLT; el.fx.appendChild(bolt); }
      }
    }
    function clearReach() {
      for (const n of el.fx.querySelectorAll('.cutin, .lamps, .stripes, .bolt, .spot')) n.remove();
      el.table.classList.remove('reach', 'reach-l1', 'reach-l2', 'reach-l3', 'pinch', 'dark2', 'hit');
      for (const n of el.dice.querySelectorAll('.hold')) n.classList.remove('hold');
      root.classList.remove('reaching');
    }
    function stopAll(run) { for (const st of run.stops) { try { st.stop(); } catch { /* 無視 */ } } run.stops = []; }

    /** 投げる。opts: { thrower:{name,char,color}, remaining, reduced, forceReach }。タップで skip。 */
    async function play(throwObj, opts = {}) {
      reset();
      setThrower(opts.thrower);
      root.classList.add('playing');
      const run = { anims: [], timers: [], wakers: [], stops: [], skipped: false };
      running = run;
      const dice = throwObj && throwObj.dice;
      if (!validDice(dice)) { // 壊れたデータ: 演出せず「?」を少し見せる
        el.stamp.textContent = '?';
        el.stamp.dataset.hand = 'invalid';
        await sleep(800);
        if (run !== running) return;
        root.classList.remove('playing');
        running = null;
        return;
      }
      const rnd = mulberry32(throwObj.seed);
      const reduced = opts.reduced || reducedMotion();
      const outIdx = throwObj.shonben ? Math.floor(rnd() * 3) : -1;
      const spots = landingSpots(rnd);
      // リーチ: 最後に止める1個と強さ(seed から。quick/動きを減らす/ションベンでは無し)
      const plan = outIdx < 0 ? reachPlan(dice, false, throwObj.seed, opts.forceReach) : NO_REACH();
      const level = reduced ? 0 : plan.level;
      const decider = outIdx < 0 ? plan.lastIdx : -1;
      const dies = [];
      for (let i = 0; i < 3; i++) {
        const d = makeDie();
        el.dice.appendChild(d.shadow);
        el.dice.appendChild(d.wrap);
        d.wrap.style.transform = 'translate(-300px, -250px)';
        d.shadow.style.opacity = '0';
        dies.push(d);
      }
      // 構え(手の中でカラカラ)
      if (!reduced) {
        el.hand.classList.add('rattle');
        sounds.rattle(550);
        await sleep(550);
        if (run !== running) return;
        el.hand.classList.remove('rattle');
      }
      // 投げ込み〜跳ねる〜止まる(飛ばされていたら一瞬で終える)
      const quick = reduced || run.skipped;
      const D = quick ? 1 : 1500;
      const finished = [];
      if (!quick) { sounds.whoosh(); run.timers.push(setTimeout(() => sounds.rumble(900), 380)); }
      // 投げる順: 最後の1個(decider)以外を先に(0 / 90ms)、decider は 180ms
      const order = [0, 1, 2].filter((i) => i !== decider).concat(decider >= 0 ? [decider] : []);
      const delayOf = (i) => (quick ? 0 : order.indexOf(i) * 90);
      const HOLD_OFF = 0.58, REL_RATE = 0.6, SLOW_OFF = 0.76, SLOW_RATE = 0.5, LAND_OFF = 0.86;
      const secondLandAt = Math.max(...[0, 1, 2].filter((i) => i !== decider && i !== outIdx).map((i) => delayOf(i) + D * LAND_OFF), 0);
      const bounceFx = (k) => { sounds.clack(1 - k.off * 0.5); fxDust(k.p.x, k.p.y, rnd, k.off < 0.5 ? 8 : 5); fxShake(k.off < 0.5); };
      const later = (fn, ms) => run.timers.push(setTimeout(() => { if (!run.skipped && run === running) fn(); }, ms));
      dies.forEach((d, i) => {
        const out = i === outIdx;
        const path = pathFor(rnd, i, spots[i], out);
        const { wrapF, cubeF, shadowF } = buildFrames(path, dice[i], rnd, out);
        const delay = delayOf(i);
        const o = { duration: D, delay, fill: 'forwards' };
        const anims = [d.wrap.animate(wrapF, o), d.cube.animate(cubeF, o), d.shadow.animate(shadowF, o)];
        run.anims.push(...anims);
        finished.push(anims[0].finished.catch(() => {}));
        if (quick) return;
        if (out) later(() => { d.wrap.classList.add('out'); d.cube.classList.add('out'); el.fx.appendChild(d.wrap); }, delay + D * 0.42);
        const bounces = path.filter((k) => k.h === 0 && k.off > 0 && k.off < 1);
        if (i !== decider) { for (const k of bounces) later(() => bounceFx(k), delay + D * k.off); return; }
        if (level === 0) {
          // 軽いスロー+ズームで止まる
          for (const k of bounces) if (k.off <= SLOW_OFF) later(() => bounceFx(k), delay + D * k.off);
          later(() => {
            for (const a of anims) a.playbackRate = SLOW_RATE;
            el.table.classList.add('zoom');
            sounds.rattle(500);
            for (const k of bounces) if (k.off > SLOW_OFF) later(() => bounceFx(k), (k.off - SLOW_OFF) * D / SLOW_RATE);
          }, delay + D * SLOW_OFF);
          return;
        }
        // リーチ: 空中で止めて溜め、2個目が止まったらカットイン、溜めが明けたら落としてヒットストップ
        for (const k of bounces) if (k.off <= HOLD_OFF) later(() => bounceFx(k), delay + D * k.off);
        const holdPoint = path.find((k) => k.off === HOLD_OFF) || path[Math.floor(path.length / 2)];
        later(() => {
          for (const a of anims) a.pause();
          d.wrap.classList.add('hold'); d.cube.classList.add('hold');
          el.table.classList.add('reach', 'zoom', `reach-l${level}`);
          if (plan.pinch) el.table.classList.add('pinch');
          el.table.style.setProperty('--spot-x', `${240 + holdPoint.p.x}px`);
          el.table.style.setProperty('--spot-y', `${160 + holdPoint.p.y - holdPoint.h}px`);
          root.classList.add('reaching');
        }, delay + D * HOLD_OFF);
        const hold = REACH_HOLD_MS[level] || REACH_HOLD_MS[1];
        later(() => {
          fxReach(plan, level);
          run.stops.push(plan.pinch ? sounds.drone() : sounds.heartbeat(level));
          if (level >= 3) later(() => { el.table.classList.add('dark2'); stopAll(run); }, hold - 400);
          later(() => {
            stopAll(run);
            el.table.classList.remove('dark2');
            d.wrap.classList.remove('hold'); d.cube.classList.remove('hold');
            for (const a of anims) { a.playbackRate = REL_RATE; a.play(); }
            for (const k of bounces) if (k.off > HOLD_OFF) {
              const at = (k.off - HOLD_OFF) * D / REL_RATE;
              if (k.off === LAND_OFF) later(() => {
                for (const a of anims) a.pause(); // ヒットストップ(最後の1個だけ。他は止まっている)
                el.table.classList.add('hit');
                fxFlash('white', 220); fxShake(true); sounds.hit(); fxDust(k.p.x, k.p.y, rnd, 10);
                later(() => { for (const a of anims) a.play(); el.table.classList.remove('hit'); }, 120);
              }, at);
              else later(() => bounceFx(k), at);
            }
          }, hold);
        }, Math.max(secondLandAt, delay + D * HOLD_OFF) + 60);
      });
      await Promise.all(finished);
      if (run !== running) return;
      stopAll(run);
      el.table.classList.remove('zoom');
      clearReach();
      dies.forEach((d, i) => { d.cube.dataset.face = dice[i]; if (i === outIdx) { d.wrap.classList.add('out'); d.cube.classList.add('out'); } });
      showResult(throwObj, opts, dies, rnd, run.skipped || quick, { ...plan, level });
      await sleep(run.skipped || quick ? 250 : 1100);
      if (run === running) { root.classList.remove('playing'); running = null; }
    }

    function skip() {
      if (!running) return;
      try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch { /* なし */ }
      running.skipped = true;
      for (const t of running.timers) clearTimeout(t);
      running.timers = [];
      stopAll(running);
      for (const w of running.wakers) w();
      running.wakers = [];
      el.hand.classList.remove('rattle');
      el.table.classList.remove('zoom');
      clearReach();
      for (const a of running.anims) { a.playbackRate = 1; try { if (a.playState === 'paused') a.play(); a.finish(); } catch { /* 未開始なら無視 */ } }
    }

    /** 「振る」を押してから親機の返事が来るまでの待ち: 手の中でカラカラ。 */
    function showWaiting(thrower) {
      reset();
      setThrower(thrower);
      el.bubble.textContent = `${thrower && thrower.name ? thrower.name + ' さんが' : ''}振っています…`;
      el.hand.classList.add('rattle');
      root.classList.add('playing');
      sounds.rattle(600);
    }

    root.addEventListener('click', skip);
    return { play, skip, reset, showWaiting, el };
  }

  /** 数字を from から to まで動かして見せる(点数のカウントアップ)。 */
  function countUp(el, from, to, ms = 600) {
    const start = performance.now();
    const f = Number(from) || 0;
    const t = Number(to) || 0;
    if (ms <= 0 || f === t) { el.textContent = String(t); return; }
    const step = (now) => {
      const k = Math.min(1, (now - start) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = String(Math.round(f + (t - f) * e));
      if (k < 1) requestAnimationFrame(step);
      else el.textContent = String(t);
    };
    el.textContent = String(f);
    requestAnimationFrame(step);
  }

  return { createSounds, createDiceStage, countUp, mulberry32, pickVoice, voiceKeyFor, VOICE_LINES, reachPlan, REACH_WEIGHTS, REACH_HOLD_MS, FINAL_ROT, PIPS };
})();
if (typeof module !== 'undefined') module.exports = ChinchiroAnim;
