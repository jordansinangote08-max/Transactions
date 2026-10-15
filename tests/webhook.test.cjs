const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8');

// In-memory Apps Script services: no network, credentials or real spreadsheet.
function setup() {
  class Sheet {
    constructor(rows = []) { this.rows = rows; }
    appendRow(row) { this.rows.push([...row]); }
    getLastRow() { return this.rows.length; }
    getLastColumn() { return Math.max(0, ...this.rows.map(r => r.length)); }
    setFrozenRows() {}
    getDataRange() { return { getValues: () => this.rows.map(r => [...r]) }; }
    getRange(row, col, height = 1, width = 1) {
      return {
        getValues: () => Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, j) => this.rows[row - 1 + i]?.[col - 1 + j] ?? '')),
        setValues: values => values.forEach((r, i) => r.forEach((v, j) => { (this.rows[row - 1 + i] ||= [])[col - 1 + j] = v; })),
        setValue: value => { (this.rows[row - 1] ||= [])[col - 1] = value; },
        setNumberFormat() {}
      };
    }
  }
  const sheets = {
    Transactions: new Sheet([['Timestamp', 'Date', 'Amount', 'Card', 'Note', 'Last4']]),
    Cards: new Sheet([['ID', 'Bank', 'Last4', 'Name', 'Source', 'Created'], ['EW', 'EastWest', '3002, 0123', 'EastWest', 'app', new Date()]])
  };
  const book = { getSheetByName: n => sheets[n], insertSheet: n => (sheets[n] = new Sheet()) };
  const props = { WEBHOOK_SECRET: 'test-webhook-secret', ANTHROPIC_API_KEY: 'test-only-provider-key-not-real' };
  let calls = 0, answer = 'Y', http = 200;
  const ctx = vm.createContext({
    Date, console: { warn() {}, error() {}, log() {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => book },
    PropertiesService: { getScriptProperties: () => ({ getProperty: n => props[n] || '' }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'Asia/Manila' },
    Utilities: { formatDate: d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => JSON.parse(text) }) },
    UrlFetchApp: { fetch: (url, options) => {
      calls++;
      assert.match(url, /api.anthropic.com|openrouter.ai/);
      const payload = JSON.parse(options.payload);
      assert.match(payload.system || payload.messages[0].content, /completed card purchase/);
      return { getResponseCode: () => http, getContentText: () => JSON.stringify(url.includes('anthropic.com')
        ? { model: 'test-model', content: [{ type: 'text', text: answer }], usage: { input_tokens: 10, output_tokens: 1 } }
        : { model: 'test-model', choices: [{ message: { content: answer } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }) };
    } }
  });
  vm.runInContext(source, ctx);
  function post(body, { form = false, token = 'test-webhook-secret', action } = {}) {
    const parameter = { token, ...(action ? { action } : {}), ...(form ? body : {}) };
    return ctx.doPost({ parameter, postData: { type: form ? 'application/x-www-form-urlencoded' : 'application/json', contents: form ? '' : JSON.stringify(body) } });
  }
  return { ctx, sheets, props, post, calls: () => calls, answer: (text, status = 200) => { answer = text; http = status; } };
}
const purchase = 'EastWest: Your card ending 0123 was charged PHP 10.00 at Shop. Purchase completed.';
const body = (raw = purchase, extra = {}) => ({ raw, amount: '10', last4: '0123', note: 'Shop', ...extra });

test('approval followed by completed charge writes exactly one PHP 10 row', () => {
  const app = setup();
  assert.equal(app.post(body('EastWest: Confirm your PHP 10.00 transaction on card 0123. Tap Yes to approve.', { note: 'Approval' })).status, 'ignored');
  assert.equal(app.calls(), 0);
  assert.equal(app.post(body()).status, 'logged');
  assert.equal(app.post(body()).status, 'duplicate');
  assert.equal(app.calls(), 1);
  assert.equal(app.sheets.Transactions.rows.length, 2);
  assert.equal(app.sheets.Transactions.rows[1][2], 10);
  assert.equal(app.sheets.Transactions.rows[1][5], '0123');
});

for (const raw of [
  'Confirm your PHP 10 purchase on card 0123',
  'EastWest: Approve the PHP 10 transaction on card 0123',
  'Card 0123: Please authorize your PHP 10 purchase',
  'Card 0123: Confirmation required for PHP 10 at Shop',
  'Did you make a PHP 10 transaction on card 0123?',
  'EastWest: Was this you? PHP 10 at Shop, card 0123',
  'Card 0123: Do you recognize PHP 10 at Shop?',
  'OTP 765432 for PHP 10 at Shop using card 0123',
  'Your PHP 10 payment on card 0123 is pending',
  'Your PHP 10 purchase on card 0123 was declined',
  'Your PHP 10 payment on card 0123 failed',
  'Card 0123: PHP 10 refunded',
  'Card 0123: PHP 10 reversal',
  'Card 0123: cash in PHP 10 successful',
  'PHP 10 added funds to card 0123',
  'Card 0123: top-up of PHP 10 completed',
  'Card 0123: fund transfer PHP 10 successful',
  'Card 0123: PHP 10 transferred to another account',
  'Card 0123: received PHP 10',
  'Card 0123: Earn PHP 10 cashback promo',
  'Card 0123: PHP 10 rewards advertisement'
]) test(`ignores non-purchase without paying AI: ${raw}`, () => {
  const app = setup();
  assert.equal(app.post(body(raw)).status, 'ignored');
  assert.equal(app.calls(), 0);
  assert.equal(app.sheets.Transactions.rows.length, 1);
});

test('a completed-charge confirmation is eligible for AI validation', () => {
  const app = setup();
  assert.equal(app.post(body('EastWest: Transaction confirmed. Your card 0123 was charged PHP 10 at Shop.')).status, 'logged');
});

test('requires full notification, never infers a charge from merchant note alone', () => {
  const app = setup();
  assert.equal(app.post({ amount: '10', last4: '0123', note: 'Shop' }).code, 400);
  assert.equal(app.post(body('x'.repeat(2001))).code, 400);
  assert.equal(app.calls(), 0);
});

test('accepts text alias and form posts; token/action cannot bypass classification', () => {
  const app = setup();
  assert.equal(app.post(body('Confirm your PHP 10 transaction on card 0123'), { form: true, action: 'anything' }).status, 'ignored');
  const input = body(); input.text = input.raw; delete input.raw;
  assert.equal(app.post(input, { form: true }).status, 'logged');
});

test('missing or wrong credentials never writes', () => {
  const app = setup();
  for (const token of ['', 'wrong']) assert.equal(app.post(body(), { token }).code, 401);
  assert.equal(app.calls(), 0);
});

for (const [answer, http, code] of [['N', 200, 200], ['Yes', 200, 503], ['Y - approved', 200, 503], ['', 200, 503], ['Y', 429, 503], ['Y', 500, 503]]) {
  test(`AI fails closed for ${JSON.stringify(answer)} / HTTP ${http}`, () => {
    const app = setup(); app.answer(answer, http);
    assert.equal(app.post(body()).code, code);
    assert.equal(app.sheets.Transactions.rows.length, 1);
  });
}

test('no AI key returns unverified, with no transaction written', () => {
  const app = setup(); delete app.props.ANTHROPIC_API_KEY;
  assert.equal(app.post(body()).code, 503);
  assert.equal(app.sheets.Transactions.rows.length, 1);
});

test('OpenRouter also enforces completed-purchase classification', () => {
  const app = setup(); delete app.props.ANTHROPIC_API_KEY; app.props.OPENROUTER_API_KEY = 'test-only-openrouter-key-not-real';
  assert.equal(app.post(body()).status, 'logged');
  assert.equal(app.calls(), 1);
});

test('normalizes merchant punctuation for duplicates, preserves unrelated same-price purchases', () => {
  const app = setup();
  assert.equal(app.post(body(purchase, { note: 'Shop, Inc.' })).status, 'logged');
  assert.equal(app.post(body(purchase, { note: ' SHOP INC ' })).status, 'duplicate');
  assert.equal(app.post(body(purchase.replace('Shop', 'Other'), { note: 'Other' })).status, 'logged');
  assert.equal(app.sheets.Transactions.rows.length, 3);
});

test('matches aliases and explicit endings, never amounts or ambiguous cards', () => {
  const { ctx } = setup();
  const cards = ctx.readCards();
  assert.equal(ctx.findSavedCard(cards, '0123', '').id, 'EW');
  assert.equal(ctx.findSavedCard(cards, '', 'Visa 3002 was charged PHP 10').id, 'EW');
  assert.equal(ctx.findSavedCard(cards, '', 'Purchase PHP 3,002.00'), null);
  assert.equal(ctx.findSavedCard(cards, '9999', 'EastWest card 3002'), null);
  assert.equal(ctx.findSavedCard([...cards, { id: 'other', last4: '0123', name: 'Other' }], '0123', ''), null);
});

test('sync round-trips multiple endings and alias removal; one Cards row per card', () => {
  const app = setup();
  const sync = endings => app.ctx.syncCards({ payload: JSON.stringify([{ id: 'EW', name: 'EastWest', bank: 'EastWest', last4: '3002', last4s: endings }]) });
  assert.equal(sync(['3002', '0123', '5678']).ok, true);
  assert.deepEqual(Array.from(app.ctx.readCards()[0].last4s), ['3002', '0123', '5678']);
  assert.equal(app.sheets.Cards.rows.length, 2);
  assert.equal(sync(['3002', '5678']).ok, true);
  assert.equal(app.ctx.findSavedCard(app.ctx.readCards(), '0123', 'EastWest'), null);
  assert.equal(app.ctx.findSavedCard(app.ctx.readCards(), '5678', '').id, 'EW');
});

test('new cards and legacy numeric sheet endings retain primary/aliases and leading zeros', () => {
  const app = setup();
  assert.equal(app.ctx.syncCards({ payload: JSON.stringify([{ id: 'new', name: 'Test', last4: '0001', last4s: ['0001', '0042'] }]) }).ok, true);
  const card = app.ctx.readCards().find(c => c.id === 'new');
  assert.deepEqual(Array.from(card.last4s), ['0001', '0042']);
  app.sheets.Cards.rows[1][2] = 123;
  assert.equal(app.ctx.readCards()[0].last4, '0123');
});


test('completed charges remain eligible when a fraud-reporting footer mentions authorization', () => {
  const app = setup();
  assert.equal(app.post(body(purchase + ' If you did not authorize this transaction, call the bank.')).status, 'logged');
});
