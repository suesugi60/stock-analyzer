// 「音を試す」の判定(測定結果 → 利用者に見せる文)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soundVerdict } from '../public/draw-sound.mjs';

const base = { supported: true, state: 'running', peak: 0.4, sampleRate: 48000, session: 'playback', loop: 'なし', error: '' };

test('音を試す: 出口に信号が出ていれば「アプリは音を出しています」。聞こえないときに確かめる順番を示す', () => {
  const v = soundVerdict(base);
  assert.equal(v.kind, 'ok');
  assert.ok(v.title.includes('アプリは音を出しています'));
  for (const word of ['音量', '消音', '出力先', 'サイトのミュートを解除']) assert.ok(v.body.includes(word), word);
  assert.equal(v.body.split('\n').length, 5, '説明 1 行 + 確かめること 4 つ');
});

test('音を試す: iPhone では、消音(マナーモード)とアプリ内ブラウザのことを伝える', () => {
  const v = soundVerdict(base, { ios: true });
  assert.equal(v.kind, 'ok');
  assert.ok(v.body.includes('マナーモード'));
  assert.ok(v.body.includes('Safari で開き直す'));
  assert.ok(!v.body.includes('タブを右クリック'));
});

test('音を試す: 出口が動いていなければ「ブラウザが音を止めています」', () => {
  for (const state of ['suspended', 'interrupted', 'closed', 'none']) {
    const v = soundVerdict({ ...base, state, peak: 0 });
    assert.equal(v.kind, 'blocked', state);
    assert.ok(v.title.includes('ブラウザが音を止めています'));
    assert.ok(v.body.includes('開き直して'));
  }
});

test('音を試す: 出口は動いているのに信号が無ければ、アプリ側の問題として伝える', () => {
  for (const peak of [0, 0.001, NaN, undefined]) {
    const v = soundVerdict({ ...base, peak });
    assert.equal(v.kind, 'silent', String(peak));
    assert.ok(v.body.includes('写真'));
  }
});

test('音を試す: 音を出す機能が無いブラウザ・壊れた入力でも落ちない', () => {
  assert.equal(soundVerdict({ ...base, supported: false }).kind, 'unsupported');
  assert.equal(soundVerdict(null).kind, 'unsupported');
  assert.equal(soundVerdict(undefined).kind, 'unsupported');
});
