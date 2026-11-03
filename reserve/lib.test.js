// node --test reserve/lib.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDate, parseTime, chooseSeatOnlyPlan, resolveProfile, parseArgs } = require('./lib');

const TODAY = '2026-11-03';

test('parseDate: ISO passes through', () => {
  assert.equal(parseDate('2026-11-20', TODAY), '2026-11-20');
});
test('parseDate: M/D picks the next occurrence', () => {
  assert.equal(parseDate('11/20', TODAY), '2026-11-20');
  assert.equal(parseDate('1/6', TODAY), '2027-01-06');
  assert.equal(parseDate('11/3', TODAY), '2026-11-03');
});
test('parseDate: Japanese forms', () => {
  assert.equal(parseDate('11月20日', TODAY), '2026-11-20');
  assert.equal(parseDate('2026年11月20日', TODAY), '2026-11-20');
  assert.equal(parseDate('2026/11/20', TODAY), '2026-11-20');
});
test('parseDate: rejects garbage and past ISO dates', () => {
  assert.throws(() => parseDate('tomorrow', TODAY));
  assert.throws(() => parseDate('2026-11-02', TODAY));
});

test('parseTime: normalises to HH:MM', () => {
  assert.equal(parseTime('19:00'), '19:00');
  assert.equal(parseTime('9:00'), '09:00');
  assert.equal(parseTime('19時'), '19:00');
  assert.equal(parseTime('19時半'), '19:30');
  assert.equal(parseTime('19時15分'), '19:15');
  assert.equal(parseTime('1900'), '19:00');
});
test('parseTime: rejects garbage', () => {
  assert.throws(() => parseTime('evening'));
  assert.throws(() => parseTime('25:00'));
});

test('chooseSeatOnlyPlan: prefers the plain seat-only plan', () => {
  const plans = [
    { name: 'お席のみのご予約', visible: true },
    { name: '抹茶あんみつセット', visible: true },
    { name: '【窓側確約】お席のみのご予約', visible: true },
  ];
  assert.deepEqual(chooseSeatOnlyPlan(plans), { plan: plans[0], coverCharge: false });
});
test('chooseSeatOnlyPlan: accepts a dated seat-only variant', () => {
  const plans = [
    { name: 'お席のみのご予約', visible: false },
    { name: '1/6～ お席のみのご予約', visible: true },
  ];
  assert.equal(chooseSeatOnlyPlan(plans).plan, plans[1]);
});
test('chooseSeatOnlyPlan: falls back to window-guaranteed plan and flags it', () => {
  const plans = [
    { name: 'お席のみのご予約', visible: false },
    { name: '【窓側確約】お席のみのご予約', visible: true },
  ];
  assert.deepEqual(chooseSeatOnlyPlan(plans), { plan: plans[1], coverCharge: true });
});
test('chooseSeatOnlyPlan: returns null when nothing fits', () => {
  assert.equal(chooseSeatOnlyPlan([{ name: '季節のパフェ', visible: true }]), null);
});

test('resolveProfile: CLI beats env, env fills gaps, defaults for questions', () => {
  const env = { TC_SEI: '環境', TC_MEI: '太郎', TC_SEI_KANA: 'かんきょう', TC_MEI_KANA: 'たろう', TC_PHONE: '09000000000', TC_EMAIL: 'env@example.com' };
  const p = resolveProfile({ sei: '引数' }, env);
  assert.equal(p.sei, '引数');
  assert.equal(p.mei, '太郎');
  assert.equal(p.email, 'env@example.com');
  assert.equal(p.allergy, 'なし');
  assert.equal(p.hilton, '会員ではない');
});
test('resolveProfile: reports every missing required field at once', () => {
  assert.throws(() => resolveProfile({}, {}), /sei.*mei.*sei-kana.*mei-kana.*phone.*email/s);
});

test('parseArgs: flags, booleans and numbers', () => {
  const a = parseArgs(['--date', '11/20', '--time', '19:00', '--adults', '2', '--dry-run', '--shop', 'terrace']);
  assert.equal(a.date, '11/20');
  assert.equal(a.adults, '2');
  assert.equal(a['dry-run'], true);
  assert.equal(a.shop, 'terrace');
});
