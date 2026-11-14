// 抽選の音(主催者画面だけで使う)。音声ファイルは使わず、その場で合成する。
// ブラウザは、画面を押すなどの操作のあとでないと音を出せない。
// スイッチを入れたとき・「ランダムに引く」を押したときに unlock() を呼んでおく。

export function createDrawSound() {
  let ctx = null;
  let bus = null; // 1回の演出ぶんの出口。stop() でまとめて止める。

  function ensure() {
    if (!ctx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;
      try { ctx = new AudioContextClass(); } catch { return null; }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => { /* 操作の前は鳴らせない */ });
    return ctx;
  }

  function output() {
    if (!bus) {
      bus = ctx.createGain();
      bus.gain.value = 0.6;
      bus.connect(ctx.destination);
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

  function safely(fn) {
    if (!ensure()) return;
    try { fn(); } catch { /* 音が出せなくても、演出は続ける */ }
  }

  return {
    unlock() { ensure(); },

    // 玉がガラガラ鳴る音。だんだん大きく、細かくなる。
    roll(ms) {
      safely(() => {
        const total = ms / 1000;
        let t = 0;
        while (t < total) {
          const progress = t / total;
          const filter = ctx.createBiquadFilter();
          filter.type = 'bandpass';
          filter.frequency.value = 900 + Math.random() * 1900;
          filter.Q.value = 5;
          blip(noise(0.05), { at: ctx.currentTime + t, decay: 0.035, level: 0.18 + 0.4 * progress, filter });
          t += 0.075 - 0.04 * progress + Math.random() * 0.02;
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
        blip(osc, { at, decay: 0.22, level: 0.5 });
      });
    },

    // 番号が出たときの音(明るい和音とシンバル)
    reveal() {
      safely(() => {
        const at = ctx.currentTime;
        for (const [freq, delay] of [[1046.5, 0], [1318.5, 0.05], [1568, 0.1], [2093, 0.15]]) {
          const osc = ctx.createOscillator();
          osc.type = 'triangle';
          osc.frequency.value = freq;
          blip(osc, { at: at + delay, decay: 0.8, level: 0.28 });
        }
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 5200;
        blip(noise(0.5), { at, decay: 0.4, level: 0.22, filter });
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
