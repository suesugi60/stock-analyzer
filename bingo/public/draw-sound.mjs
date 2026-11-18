// 抽選の音(主催者画面だけで使う)。音声ファイルは使わず、その場で合成する。
// ブラウザは、画面を押すなどの操作のあとでないと音を出せない。
// スイッチを入れたとき・画面をさわったときに unlock() を呼んでおく。

export function createDrawSound() {
  let ctx = null;
  let out = null; // 全体の出口(音が割れないように抑える)
  let bus = null; // 1回の演出ぶんの出口。stop() でまとめて止める。

  function ensure() {
    if (!ctx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;
      // iPhone では、この種の音は消音(マナーモード)だと鳴らない。「再生」の扱いにすると鳴る。
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* 対応していない端末 */ }
      try { ctx = new AudioContextClass(); } catch { return null; }
      out = ctx.createDynamicsCompressor();
      out.threshold.value = -8;
      out.knee.value = 6;
      out.ratio.value = 12;
      out.attack.value = 0.002;
      out.release.value = 0.15;
      out.connect(ctx.destination);
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => { /* 操作の前は鳴らせない */ });
    return ctx;
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

  function safely(fn) {
    if (!ensure()) return;
    try { fn(); } catch { /* 音が出せなくても、画面は動かし続ける */ }
  }

  return {
    // 操作のうちに呼ぶ。以後、操作なしでも音を出せるようになる。
    unlock() {
      safely(() => {
        const source = ctx.createBufferSource();
        source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate); // 無音を一瞬だけ
        source.connect(ctx.destination);
        source.start();
      });
    },

    // スイッチを入れたとき・「音を試す」を押したときの、確認の音
    confirm() {
      safely(() => {
        const at = ctx.currentTime;
        tone(1318.5, { at, decay: 0.22, level: 0.5 });
        tone(1760, { at: at + 0.12, decay: 0.35, level: 0.5 });
      });
    },

    // 玉がガラガラ鳴る音。だんだん大きく、細かくなる。
    roll(ms) {
      safely(() => {
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
      safely(() => {
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
      safely(() => {
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

    // 飛ばしたとき・打ち切ったときに、鳴っている音を止める
    stop() {
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
