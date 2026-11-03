#!/usr/bin/env node
/*
 雅叙園東京 KANADE LOUNGE / KANADE TERRACE の「お席のみのご予約」を TableCheck で自動入力して送信する。

 使い方:
   node reserve/tablecheck_reserve.js --date 11/20 --time 19:00 --adults 2
       [--children 0] [--babies 0] [--shop terrace|lounge]   既定は terrace
       [--dry-run]            フォームを埋めるだけで送信しない(初回確認用)
       [--stop-at-confirm]    確定画面まで進んで止まる(最終ボタンは押さない)
       [--request "ご要望"] [--purpose デート] [--visits 初来店] [--marketing]
       [--sei 姓 --mei 名 --sei-kana せい --mei-kana めい --phone 090xxxxxxxx --email a@b.c]
       [--allergy なし] [--hilton 会員ではない] [--out 出力フォルダ]

 予約者情報は環境変数でも渡せる:
   TC_SEI TC_MEI TC_SEI_KANA TC_MEI_KANA TC_PHONE TC_EMAIL (任意: TC_ALLERGY TC_HILTON)

 終了コード: 0 成功(dry-run / stop-at-confirm 完了を含む)
            2 満席・その日時では席のみプランを選べない
            3 確定画面で最終ボタンを特定できず止まった(スクリーンショットを確認)
            1 その他のエラー
 画面の画像とログは --out (既定: reserve/out/<日時>/) に保存する。
*/
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { parseDate, parseTime, chooseSeatOnlyPlan, resolveProfile, parseArgs, DEFAULT_SHOP } = require('./lib');

const SHOPS = {
  lounge: { slug: 'gajoentokyo-kanadelounge', label: 'KANADE LOUNGE / 雅叙園東京' },
  terrace: { slug: 'gajoentokyo-kanadeterrace', label: 'KANADE TERRACE / 雅叙園東京' },
};
const FINAL_BUTTON_RE = /予約を確定|確定する|この内容で予約|予約する|予約を完了|予約を申し込む|申し込む|送信する/;
const NOT_FINAL_RE = /戻る|修正|キャンセル|変更|ログイン|登録する/;

function jstToday() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}
function stamp() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(/[-: ]/g, '').slice(0, 14);
}

class Fail extends Error { constructor(code, msg, extra) { super(msg); this.code = code; this.extra = extra || {}; } }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const shopKey = (args.shop || DEFAULT_SHOP).toString();
  const shop = SHOPS[shopKey];
  if (!shop) throw new Fail(1, `--shop は terrace か lounge: ${shopKey}`);
  if (!args.date || !args.time || !args.adults) throw new Fail(1, '--date --time --adults は必須です');
  const today = jstToday();
  const date = parseDate(args.date, today);
  const time = parseTime(args.time);
  const adults = String(args.adults);
  const children = String(args.children || '0');
  const babies = String(args.babies || '0');
  for (const [k, v] of [['adults', adults], ['children', children], ['babies', babies]]) {
    if (!/^\d$/.test(v) || (k === 'adults' && v === '0')) throw new Fail(1, `--${k} は ${k === 'adults' ? '1' : '0'}〜9 の数字: ${v}`);
  }
  const profile = resolveProfile(args, process.env);
  const mode = args['dry-run'] ? 'dry-run' : args['stop-at-confirm'] ? 'stop-at-confirm' : 'submit';
  const out = args.out ? path.resolve(String(args.out)) : path.join(__dirname, 'out', stamp());
  fs.mkdirSync(out, { recursive: true });
  const logFile = path.join(out, 'run.log');
  const log = (m) => { const line = `[${new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' })}] ${m}`; console.log(line); fs.appendFileSync(logFile, line + '\n'); };
  const summary = { shop: shop.label, date, time, adults, children, babies, mode, out };
  log(`予約内容: ${shop.label} ${date} ${time} 大人${adults} 子供${children} 幼児${babies} (モード: ${mode})`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 1600 } });
  const page = await ctx.newPage();
  page.on('dialog', d => { log(`ダイアログ: ${d.message()}`); d.accept(); });
  page.on('response', async r => {
    const u = r.url();
    if (/tablecheck\.com\/ja\/(shops\/[^/]+\/(sheets|available|reserve\/create)|reservations)/.test(u)) {
      let body = ''; try { body = (await r.text()).slice(0, 600); } catch (e) { body = '(読めず)'; }
      fs.appendFileSync(logFile, `  RESP ${r.status()} ${u.replace(/authenticity_token=[^&]*&?/, '')}\n    ${body.replace(/\n/g, ' ')}\n`);
    }
  });
  const shot = async (name) => { const p = path.join(out, name); await page.screenshot({ path: p, fullPage: true }); return p; };

  try {
    // 1. ページを開く
    const url = `https://www.tablecheck.com/ja/shops/${shop.slug}/reserve`;
    log(`1/8 予約ページを開く: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
    const heading = await page.evaluate(() => document.body.innerText.match(/.+を予約する/)?.[0] || '');
    if (!heading.includes(shop.label.split(' /')[0])) throw new Fail(1, `店名を確認できません: "${heading}"`);
    log(`   店名: ${heading}`);

    // 2. お知らせ同意・人数
    log('2/8 お知らせに同意し人数を設定');
    await page.check('#reservation_confirm_shop_note');
    await page.selectOption('#reservation_num_people_adult', adults);
    if (children !== '0') await page.selectOption('#reservation_num_people_child', children);
    if (babies !== '0') await page.selectOption('#reservation_num_people_baby', babies);

    // 3. 日付(Mobiscroll の API で設定 → 時間枠が読み込まれる)
    log(`3/8 日付を設定: ${date}`);
    const [y, m, d] = date.split('-').map(Number);
    await Promise.all([
      page.waitForResponse(r => r.url().includes('/sheets'), { timeout: 30000 }),
      page.evaluate(([y, m, d]) => jQuery('#reservation_start_date').mobiscroll('setVal', new Date(y, m - 1, d), true, true), [y, m, d]),
    ]);
    await page.waitForTimeout(500);
    const dateVal = await page.$eval('#reservation_start_date', e => e.value);
    if (dateVal !== date) throw new Fail(2, `この日付は選べません(受付範囲外の可能性): 入力=${date} 画面=${dateVal || '(空)'}`);

    // 4. 時間
    const slots = await page.$$eval('#reservation_start_at_epoch option', os => os.filter(o => o.value).map(o => ({ value: o.value, label: o.textContent.trim() })));
    log(`4/8 空き時間枠: ${slots.length ? slots.map(s => s.label).join(' ') : '(なし)'}`);
    if (!slots.length) throw new Fail(2, `${date} は空き時間枠がありません(満席か受付対象外)`, { slots: [] });
    const slot = slots.find(s => s.label === time);
    if (!slot) throw new Fail(2, `${date} ${time} は選べません。選べる時間: ${slots.map(s => s.label).join(' ')}`, { slots: slots.map(s => s.label) });
    await Promise.all([
      page.waitForResponse(r => /\/available\?/.test(r.url()), { timeout: 30000 }),
      page.selectOption('#reservation_start_at_epoch', slot.value),
    ]);
    await page.waitForTimeout(500);

    // 5. 席のみプランを選ぶ
    const plans = await page.$$eval('.menu-item', ms => ms.map(m => {
      const dt = m.querySelector('.menu-item-data');
      return { id: dt?.dataset.id, name: (dt?.dataset.name || '').trim(), visible: getComputedStyle(m).display !== 'none' && !m.classList.contains('hide') };
    }));
    const choice = chooseSeatOnlyPlan(plans);
    log(`5/8 表示中のプラン: ${plans.filter(p => p.visible).map(p => p.name).join(' / ')}`);
    if (!choice) throw new Fail(2, `${date} ${time} では「お席のみ」プランを選べません`, { plans: plans.filter(p => p.visible).map(p => p.name) });
    summary.plan = choice.plan.name;
    summary.coverCharge = choice.coverCharge;
    log(`   選択: ${choice.plan.name}${choice.coverCharge ? ' ※窓側確約プランはカバーチャージがかかります' : ''}`);
    const availResp = page.waitForResponse(r => /\/available\?/.test(r.url()) && r.url().includes('menu_item_id'), { timeout: 30000 });
    await page.click(`.menu-item:has(.menu-item-data[data-id="${choice.plan.id}"]) label.menu-item-order-btn`);
    const avail = await (await availResp).json().catch(() => ({}));
    if (avail.status && avail.status !== 'success') throw new Fail(2, `この日時・人数ではプランを確保できません: ${JSON.stringify(avail)}`);
    await page.waitForFunction(() => { const b = document.querySelector('#new_reservation .reservation-only input[type=submit]'); return b && !b.disabled; }, null, { timeout: 15000 })
      .catch(async () => { await shot('error_form.png'); throw new Fail(1, '日時・人数・プランを選んでも送信ボタンが有効になりません(error_form.png を確認)'); });

    // 6. お店からの質問
    log('6/8 お店からの質問に回答');
    const questions = await page.$$eval('[name^="reservation[enquete_drafts_attributes]"]', els => els
      .filter(e => e.tagName === 'TEXTAREA' || e.type === 'checkbox')
      .map(e => ({ id: e.id, kind: e.tagName === 'TEXTAREA' ? 'text' : 'checkbox', q: (e.closest('.form-group') || e.parentElement).textContent.replace(/\s+/g, ' ').trim().slice(0, 80) })));
    summary.answers = [];
    for (const q of questions) {
      if (q.kind === 'checkbox') { await page.check(`#${q.id}`); summary.answers.push({ q: q.q, a: '(同意にチェック)' }); continue; }
      const a = /アレルギー/.test(q.q) ? profile.allergy : /ヒルトン|オナーズ/.test(q.q) ? profile.hilton : 'なし';
      await page.fill(`#${q.id}`, a);
      summary.answers.push({ q: q.q, a });
    }
    summary.answers.forEach(x => log(`   Q: ${x.q.slice(0, 40)}… → A: ${x.a}`));

    // 7. 予約者情報・その他
    log('7/8 予約者情報を入力');
    await page.fill('#reservation_customer_last_name', profile['sei-kana']);
    await page.fill('#reservation_customer_first_name', profile['mei-kana']);
    await page.fill('#reservation_customer_kanji_last_name', profile.sei);
    await page.fill('#reservation_customer_kanji_first_name', profile.mei);
    await page.fill('#reservation_customer_phone', profile.phone);
    await page.fill('#reservation_customer_email', profile.email);
    if (args.purpose) await page.selectOption('#reservation_objective', { label: String(args.purpose) });
    if (args.visits) await page.selectOption('#reservation_visit_history', { label: String(args.visits) });
    if (args.request) await page.fill('#reservation_customer_request', String(args.request));
    await page.uncheck('#create_account').catch(() => {});
    if (args.marketing) await page.check('#reservation_customer_allow_marketing'); else await page.uncheck('#reservation_customer_allow_marketing');
    await page.check('#reservation_confirm_shop_note2');
    summary.customer = { name: `${profile.sei} ${profile.mei} (${profile['sei-kana']} ${profile['mei-kana']})`, phone: profile.phone, email: profile.email, request: args.request || '', purpose: args.purpose || '', visits: args.visits || '' };
    const formShot = await shot('01_form_filled.png');
    const submitBtn = await page.$('#new_reservation .reservation-only input[type=submit]');
    const submitLabel = await submitBtn.evaluate(e => e.value);
    if (await submitBtn.evaluate(e => e.disabled)) throw new Fail(1, `送信ボタン「${submitLabel}」が無効のままです(${formShot} を確認)`);
    log(`   入力完了。送信ボタン「${submitLabel}」が有効 → ${formShot}`);
    if (mode === 'dry-run') { summary.status = 'dry-run'; return summary; }

    // 8. 送信 → 確定画面 → 最終ボタン
    log(`8/8 「${submitLabel}」を押して確定画面へ`);
    const beforeUrl = page.url();
    await Promise.all([
      page.waitForResponse(r => r.url().includes('/reserve/create'), { timeout: 60000 }),
      submitBtn.click(),
    ]);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForURL(u => u.toString() !== beforeUrl, { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    const confirmShot = await shot('02_confirm_page.png');
    const errors = await page.$$eval('.has-error, .help-block, .alert-danger:not(.reserve-alert-message), .error-message', es => es.map(e => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean));
    const buttons = await page.$$eval('input[type=submit], button, a.btn', es => es.filter(e => e.offsetParent !== null).map(e => (e.value || e.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean));
    log(`   URL: ${page.url()}`);
    log(`   画面上のボタン: ${buttons.join(' | ')}`);
    if (page.url() === beforeUrl && errors.length) throw new Fail(1, `入力エラー: ${errors.join(' / ')} (${confirmShot})`, { errors });
    const finals = buttons.filter(b => FINAL_BUTTON_RE.test(b) && !NOT_FINAL_RE.test(b));
    summary.confirmPage = { url: page.url(), buttons, screenshot: confirmShot, text: (await page.evaluate(() => document.body.innerText)).replace(/\n{2,}/g, '\n').slice(0, 2500) };
    if (mode === 'stop-at-confirm') { summary.status = 'confirm-page'; summary.finalButtonCandidates = finals; return summary; }
    if (finals.length !== 1) throw new Fail(3, `確定画面の最終ボタンを特定できません(候補: ${finals.join(' | ') || 'なし'})。${confirmShot} を確認してください`, { buttons });
    log(`   最終ボタン「${finals[0]}」を押す`);
    const finalBtn = page.locator(`input[type=submit][value="${finals[0]}"], button:has-text("${finals[0]}"), a.btn:has-text("${finals[0]}")`).first();
    const confirmUrl = page.url();
    await finalBtn.click();
    await page.waitForURL(u => u.toString() !== confirmUrl, { timeout: 30000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    const doneShot = await shot('03_result.png');
    const doneText = (await page.evaluate(() => document.body.innerText)).replace(/\n{2,}/g, '\n');
    summary.result = { url: page.url(), screenshot: doneShot, text: doneText.slice(0, 2500) };
    summary.reservationNumber = doneText.match(/予約番号[^\dA-Z]*([A-Z0-9-]{4,})/)?.[1] || null;
    summary.status = /受け付け|受付|承り|完了|確定|ありがとう/.test(doneText) ? 'submitted' : 'unknown';
    log(`   結果: ${summary.status}${summary.reservationNumber ? ' 予約番号 ' + summary.reservationNumber : ''} → ${doneShot}`);
    return summary;
  } catch (e) {
    if (!(e instanceof Fail)) { await shot('error.png').catch(() => {}); }
    throw e;
  } finally {
    await browser.close();
  }
}

main().then(summary => {
  console.log('RESULT ' + JSON.stringify(summary));
  process.exit(0);
}).catch(e => {
  const code = e instanceof Fail ? e.code : 1;
  console.log('RESULT ' + JSON.stringify({ status: code === 2 ? 'unavailable' : code === 3 ? 'needs-manual-confirm' : 'error', message: e.message, ...(e.extra || {}) }));
  if (!(e instanceof Fail)) console.error(e.stack);
  process.exit(code);
});
