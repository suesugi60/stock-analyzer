import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../anim.js');
const v = (name, lang, extra = {}) => ({ name, lang, voiceURI: name, localService: true, ...extra });

test('pickVoice: 日本語の声から、拡張(premium/enhanced)→ 知られた自然な声 → その他 の順で選ぶ', () => {
  const voices = [v('Alex', 'en-US'), v('Kyoko', 'ja-JP'), v('Kyoko', 'ja-JP', { voiceURI: 'com.apple.voice.premium.ja-JP.Kyoko' }), v('Otoya', 'ja-JP')];
  assert.equal(A.pickVoice(voices).voiceURI, 'com.apple.voice.premium.ja-JP.Kyoko');
  assert.equal(A.pickVoice([v('Alex', 'en-US'), v('Otoya', 'ja-JP'), v('Google 日本語', 'ja-JP')]).name, 'Google 日本語');
  assert.equal(A.pickVoice([v('Microsoft Ayumi', 'ja-JP'), v('Microsoft Nanami Online (Natural)', 'ja-JP')]).name, 'Microsoft Nanami Online (Natural)');
  assert.equal(A.pickVoice([v('Alex', 'en-US'), v('Otoya', 'ja-JP')]).name, 'Otoya');
  assert.equal(A.pickVoice([v('Alex', 'en-US')]), null);
  assert.equal(A.pickVoice([]), null);
});

test('VOICE_KEYS: 役ごとの音声ファイル名と文言が揃っている', () => {
  const keys = Object.keys(A.VOICE_LINES);
  for (const k of ['pinzoro', 'zoro2', 'zoro6', 'shigoro', 'me1', 'me6', 'none', 'hifumi', 'shonben']) assert.ok(keys.includes(k), k);
  assert.equal(A.VOICE_LINES.pinzoro, 'ピンゾロ！');
  assert.equal(A.VOICE_LINES.me5, '5の目');
  assert.equal(A.voiceKeyFor({ type: 'zoro', value: 4 }), 'zoro4');
  assert.equal(A.voiceKeyFor({ type: 'me', value: 1 }), 'me1');
  assert.equal(A.voiceKeyFor({ type: 'shonben' }), 'shonben');
  assert.equal(A.voiceKeyFor(null), 'none');
});
