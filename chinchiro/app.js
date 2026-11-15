// ===== 表示層: 役割の判定、親機・リスナー・表示専用の画面 =====
(() => {
  'use strict';
  const L = ChinchiroLogic;
  const params = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);

  const sounds = ChinchiroAnim.createSounds();
  const stage = ChinchiroAnim.createDiceStage($('stage'), sounds);

  // ---------- デモ(演出の確認用): ?demo=1&dice=4,5,6&seed=7[&shonben=1][&remaining=2][&skip=1] ----------
  if (params.get('demo') === '1') {
    $('stage-overlay').hidden = false;
    const dice = (params.get('dice') || '1,2,3').split(',').map((x) => (x === '' ? NaN : Number(x)));
    const seed = Number(params.get('seed') || 1);
    const shonben = params.get('shonben') === '1';
    const remaining = Number(params.get('remaining') ?? 2);
    let hand = null;
    try { hand = shonben ? { ...L.SHONBEN } : L.evaluate(dice); } catch { hand = null; }
    if (!hand && !shonben && remaining === 0) hand = { ...L.NONE };
    stage.play({ dice, seed, shonben, hand }, { thrower: { name: 'デモ', char: 'momotaro', color: '#ff4d4d' }, remaining });
    if (params.get('skip') === '1') stage.skip();
    return;
  }
})();
