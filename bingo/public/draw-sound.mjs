// 抽選の音(主催者画面だけで使う)。音声ファイルは使わず、その場で合成する。
//
// 「音が出ない」を作らないための決まり:
// - ブラウザは、画面を押すなどの操作のあとでないと音を出せない。操作のたびに unlock() を呼ぶ。
// - 音の出口(AudioContext)は、電話・別のアプリ・画面を閉じたあとなどにブラウザが止めることがある。
//   鳴らす直前に必ず状態を確かめ、止まっていれば起こし、閉じられていれば作り直す。
// - それでも出せないときは黙って失敗しない。ready() が false になり、onChange() で画面に知らせる。

const WAIT_MS = 1500; // 出口が起きるのを待つ時間。これを過ぎた音は捨てる(あとでまとめて鳴らさない)
const HEARD = 0.02;   // 「音を試す」で、これ以上の大きさの信号が出口に出ていれば「アプリは音を出している」とみなす

function isIOS() {
  try {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  } catch { return false; }
}

/**
 * 「音を試す」の測定結果(measure() の戻り値)から、利用者に見せる判定を作る。
 * アプリが音を出しているのに聞こえないのか、ブラウザが音を止めているのか、アプリが音を作れていないのかを切り分ける。
 * @returns {{ kind: 'ok'|'blocked'|'silent'|'unsupported', title: string, body: string }}
 */
export function soundVerdict(d, { ios = false } = {}) {
  if (!d || !d.supported) {
    return { kind: 'unsupported', title: '⚠️ このブラウザは音を出せません', body: 'Safari か Chrome で開き直してください。' };
  }
  if (d.state !== 'running') {
    return {
      kind: 'blocked',
      title: '⚠️ ブラウザが音を止めています',
      body: 'ページを開き直して、もう一度「音を試す」を押してください。\nそれでも同じなら、通話・録音・配信など、ほかのアプリがこの端末の音を使っていないか確かめてください。\n直らないときは、この画面を写真に撮って送ってください。',
    };
  }
  if (!(d.peak >= HEARD)) {
    return { kind: 'silent', title: '⚠️ アプリが音を作れていません', body: 'アプリ側の問題です。この画面を写真に撮って送ってください。' };
  }
  const steps = ios
    ? ['本体の音量を上げる(横の音量ボタン)', '消音(マナーモード)を切る', 'イヤホン・Bluetooth など、音の出力先を確かめる', 'LINE などのアプリの中で開いているときは、Safari で開き直す']
    : [
      '本体の音量を上げる',
      '消音(マナーモード・ミュート)を切る',
      'イヤホン・Bluetooth・配信ソフトなど、音の出力先を確かめる',
      'パソコンは、ブラウザのタブを右クリックして「サイトのミュートを解除」があれば押す。Windows は「音量ミキサー」でブラウザが消音になっていないかも見る',
    ];
  return {
    kind: 'ok',
    title: '✅ アプリは音を出しています',
    body: `いま確認の音が鳴りました。聞こえなかったときは、原因はこの端末の設定です。上から順に確かめてください。\n${steps.map((t, i) => `${'①②③④'[i]} ${t}`).join('\n')}`,
  };
}

export function createDrawSound() {
  let ctx = null;
  let out = null;  // 全体の出口(音が割れないように抑える)
  let bus = null;  // 1回の演出ぶんの出口。stop() でまとめて止める。
  let primed = false; // いまの出口で、操作のうちに一度鳴らしたか
  let loop = null; // iPhone / iPad 用の、無音を流し続ける <audio>
  let meter = null; // 出口に出ている音の大きさを測る(「音を試す」の結果表示用)
  let lastError = ''; // 出口を作れなかったときの理由
  let generation = 0; // stop() のたびに進める。待たせていた音を、止めたあとに鳴らさないため
  const listeners = [];

  function notify() {
    for (const fn of listeners) { try { fn(); } catch { /* 画面側の都合 */ } }
  }

  function create() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    // iPhone では、この種の音は消音(マナーモード)だと鳴らない。「再生」の扱いにすると鳴る。
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* 対応していない端末 */ }
    let made = null;
    try { made = new AudioContextClass(); } catch (e) { lastError = String((e && e.message) || e); return null; }
    ctx = made;
    out = ctx.createDynamicsCompressor();
    out.threshold.value = -8;
    out.knee.value = 6;
    out.ratio.value = 12;
    out.attack.value = 0.002;
    out.release.value = 0.15;
    out.connect(ctx.destination);
    try { meter = ctx.createAnalyser(); meter.fftSize = 2048; out.connect(meter); } catch { meter = null; }
    bus = null;
    primed = false;
    try { ctx.addEventListener('statechange', notify); } catch { ctx.onstatechange = notify; }
    return ctx;
  }

  // 音の出口を用意して返す。閉じられていたら作り直し、止まっていたら起こす。用意できなければ null。
  function ensure() {
    if (ctx && ctx.state === 'closed') { ctx = null; out = null; bus = null; meter = null; }
    if (!ctx && !create()) return null;
    if (ctx.state !== 'running') {
      try {
        const p = ctx.resume();
        if (p && typeof p.then === 'function') p.then(notify, () => { /* 操作の前は起こせない */ });
      } catch { /* 起こせない */ }
    }
    return ctx;
  }

  // まだ一度も画面を押していないページは、ブラウザが音を出させない。
  function neverTouched() {
    try { return !!navigator.userActivation && !navigator.userActivation.hasBeenActive; } catch { return false; }
  }

  // iPhone / iPad は、無音の音声(<audio>)を流し続けている間、消音(マナーモード)でもこの種の音が鳴る。
  // audioSession を「再生」にするだけで足りるはずの版でも、念のため両方やる(アプリ内ブラウザなど、効かない場面があるため)。
  function startLoop() {
    if (!isIOS() || typeof window.Audio !== 'function') return;
    try {
      if (!loop) {
        loop = new window.Audio('/silent.wav');
        loop.loop = true;
        loop.setAttribute('playsinline', '');
      }
      if (loop.paused) {
        const p = loop.play();
        if (p && typeof p.catch === 'function') p.catch(() => { /* 次の操作でやり直す */ });
      }
    } catch { /* 流せなくても、ほかの音は鳴らす */ }
  }

  function output() {
    if (!bus) {
      bus = ctx.createGain();
      bus.gain.value = 0.9;
      bus.connect(out);
    }
    return bus;
  }

  function noise(seconds) {
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    return source;
  }

  // 短く減衰する音を1つ鳴らす
  function blip(source, { at, attack = 0.004, decay, level, filter = null }) {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(level, at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    if (filter) { source.connect(filter); filter.connect(gain); } else source.connect(gain);
    gain.connect(output());
    source.start(at);
    source.stop(at + attack + decay + 0.05);
  }

  function tone(freq, { at, decay, level, type = 'triangle' }) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    blip(osc, { at, decay, level });
  }

  // fn を鳴らす。出口が止まっていたら起きるのを待ってから鳴らす。起きなければ捨てて、画面に知らせる。
  function play(fn) {
    if (!ctx && neverTouched()) { notify(); return; } // 押したときに unlock() が出口を作る
    const c = ensure();
    if (!c) { notify(); return; }
    const mine = generation;
    const run = () => {
      if (c !== ctx || mine !== generation) return;
      try { fn(); } catch { /* 音が出せなくても、画面は動かし続ける */ }
    };
    if (c.state === 'running') { run(); return; }
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { c.removeEventListener('statechange', check); } catch { /* 古いブラウザ */ }
      if (ok) run();
      notify();
    };
    const check = () => { if (c.state === 'running') settle(true); else if (c.state === 'closed') settle(false); };
    const timer = setTimeout(() => settle(c.state === 'running'), WAIT_MS);
    try { c.addEventListener('statechange', check); } catch { /* 古いブラウザは、時間切れのときに確かめる */ }
    check();
  }

  return {
    // 操作(押す・キーを打つ)のうちに呼ぶ。以後、操作なしでも音を出せるようになる。何度呼んでもよい。
    unlock() {
      const c = ensure();
      if (!c) { notify(); return; }
      startLoop();
      if (primed && c.state === 'running') return;
      try {
        const source = c.createBufferSource();
        source.buffer = c.createBuffer(1, 1, c.sampleRate); // 無音を一瞬だけ
        source.connect(c.destination);
        source.start();
        primed = true;
      } catch { /* 次の操作でやり直す */ }
      notify();
    },

    // 画面に戻ってきたときなどに呼ぶ。出口があって止まっていれば起こす(新しくは作らない)。
    wake() {
      if (ctx) ensure();
      notify();
    },

    // いますぐ音を出せるか
    ready() {
      return !!ctx && ctx.state === 'running';
    },

    // 「音を試す」用。出口が起きるのを待ち(最長 WAIT_MS)、起きてから ms の間、出口に出ている音の大きさを測って返す。
    measure(ms = 900) {
      const read = (buf, bytes) => {
        if (!meter || !ctx || ctx.state !== 'running') return 0;
        let peak = 0;
        try {
          if (typeof meter.getFloatTimeDomainData === 'function') {
            meter.getFloatTimeDomainData(buf);
            for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
          } else {
            meter.getByteTimeDomainData(bytes);
            for (let i = 0; i < bytes.length; i++) peak = Math.max(peak, Math.abs(bytes[i] - 128) / 128);
          }
        } catch { /* 測れない端末 */ }
        return peak;
      };
      return new Promise((resolve) => {
        const buf = new Float32Array(2048);
        const bytes = new Uint8Array(2048);
        const startedAt = Date.now();
        let runningSince = null;
        let peak = 0;
        const timer = setInterval(() => {
          const now = Date.now();
          if (ctx && ctx.state === 'running') {
            if (runningSince === null) runningSince = now;
            peak = Math.max(peak, read(buf, bytes));
          }
          const done = runningSince !== null ? now - runningSince >= ms : now - startedAt >= WAIT_MS + 300;
          if (!done) return;
          clearInterval(timer);
          let session = '';
          try { session = navigator.audioSession ? String(navigator.audioSession.type) : 'なし'; } catch { session = '不明'; }
          resolve({
            supported: !!(window.AudioContext || window.webkitAudioContext),
            state: ctx ? ctx.state : 'none',
            peak,
            sampleRate: ctx ? ctx.sampleRate : 0,
            session,
            loop: !loop ? 'なし' : loop.paused ? '停止' : '再生中',
            error: lastError,
          });
        }, 20);
      });
    },

    // ready() が変わったかもしれないときに呼ばれる
    onChange(fn) {
      if (typeof fn === 'function') listeners.push(fn);
    },

    // スイッチを入れたとき・「音を試す」を押したときの、確認の音
    confirm() {
      play(() => {
        const at = ctx.currentTime;
        tone(1318.5, { at, decay: 0.22, level: 0.5 });
        tone(1760, { at: at + 0.12, decay: 0.35, level: 0.5 });
      });
    },

    // 玉がガラガラ鳴る音。だんだん大きく、細かくなる。
    roll(ms) {
      play(() => {
        const total = ms / 1000;
        let t = 0;
        while (t < total) {
          const progress = t / total;
          const filter = ctx.createBiquadFilter();
          filter.type = 'bandpass';
          filter.frequency.value = 700 + Math.random() * 1900;
          filter.Q.value = 1.4;
          blip(noise(0.06), { at: ctx.currentTime + t, decay: 0.045, level: 0.55 + 0.4 * progress, filter });
          t += 0.07 - 0.035 * progress + Math.random() * 0.02;
        }
      });
    },

    // 玉がコロンと出る音
    drop() {
      play(() => {
        const at = ctx.currentTime;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(760, at);
        osc.frequency.exponentialRampToValueAtTime(240, at + 0.2);
        blip(osc, { at, decay: 0.22, level: 0.7 });
      });
    },

    // 番号が出たときの音(明るい和音とシンバル)
    reveal() {
      play(() => {
        const at = ctx.currentTime;
        for (const [freq, delay] of [[1046.5, 0], [1318.5, 0.05], [1568, 0.1], [2093, 0.15]]) {
          tone(freq, { at: at + delay, decay: 0.8, level: 0.4 });
        }
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 5200;
        blip(noise(0.5), { at, decay: 0.4, level: 0.3, filter });
      });
    },

    // 飛ばしたとき・打ち切ったときに、鳴っている音を止める(待たせている音も鳴らさない)
    stop() {
      generation += 1;
      if (!ctx || !bus) return;
      const old = bus;
      bus = null;
      try {
        old.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
        setTimeout(() => { try { old.disconnect(); } catch { /* すでに外れている */ } }, 1500);
      } catch { /* 止められなくても害はない */ }
    },
  };
}
