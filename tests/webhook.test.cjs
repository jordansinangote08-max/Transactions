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

test('priority 1: explicit card digits against every saved ending; other numbers never count', () => {
  const { ctx } = setup();
  const cards = [
    { id: 'UB', name: 'UnionBank', last4: '6023', last4s: ['6023', '9624'] },
    { id: 'MARI', name: 'MariCard Credit', last4: '2475', last4s: ['2475'] },
    { id: 'RCBC', name: 'RCBC Flex', last4: '4069', last4s: ['4069'] }
  ];
  const find = (raw, last4 = '', title = '') => { const card = ctx.findSavedCard(cards, last4, raw, title); return card && card.id; };
  for (const raw of [
    'Your card ending in 9624 was charged PHP 120.00',
    'UnionBank card ****9624: PHP 120.00 at Jollibee',
    'Card no. 9624 purchase PHP 120',
    'Visa 9624 has been charged P 71.00',
    'Mastercard xxxx-9624 used for PHP 99',
    'Card number ending 6023 charged PHP 5'
  ]) assert.equal(find(raw), 'UB', raw);
  assert.equal(find('PHP 120 at Shop', '9624'), 'UB');
  assert.equal(find('Ref 4069: PHP 120 at Shop'), null);                // not tied to a card number
  assert.equal(find('Purchase PHP 4,069.00 at Shop'), null);            // an amount
  assert.equal(find('Card ending 1111 PHP 10. RCBC Flex'), null);       // unsaved card: no name fallback
  assert.equal(find('Card ending 2475 PHP 10', '9624'), null);          // two different saved cards
  assert.equal(find('Card ending 9624 PHP 10', '9624'), 'UB');
});

test('priority 2: exact full card name only when no card digits, including the Wallet title', () => {
  const { ctx } = setup();
  const cards = [
    { id: 'MARI', name: 'MariCard Credit', last4: '2475', last4s: ['2475'] },
    { id: 'BPI', name: 'BPI', last4: '1000', last4s: ['1000'] },
    { id: 'BPIG', name: 'BPI Gold', last4: '2000', last4s: ['2000'] }
  ];
  const find = (raw, title = '') => { const card = ctx.findSavedCard(cards, '', raw, title); return card && card.id; };
  assert.equal(find('A Mari Card credit transaction of PHP 69.00 at TikTok was completed.'), 'MARI');
  assert.equal(find('PHP 69.00 at TikTok Shop', 'MariCard Credit'), 'MARI');   // Apple Wallet
  assert.equal(find('A MariCard transaction of PHP 69.00'), null);              // not the same name
  assert.equal(find('BPI Gold purchase PHP 10'), 'BPIG');
});

test('the webhook passes the Wallet title to card matching', () => {
  const app = setup();
  const result = app.post({ raw: 'PHP 10.00 at Shop. Purchase completed.', amount: '10', last4: '', note: 'Shop', app: 'EastWest' });
  assert.equal(result.card, app.ctx.readCards().find(card => card.name === 'EastWest').name);
});

test('a leftover Cards row with the same name never ties with or beats the real card', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  for (const name of ['Maricard Credit', 'Maricard']) {
    const app = setup();
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Recommendation.gs'), 'utf8'), app.ctx);
    app.sheets.Cards.rows.push(['mari', 'MariBank', '2475', name, 'app', new Date()]);
    app.sheets.Cards.rows.push(['shortcut-old', 'MariBank', '', 'MariCard Credit', 'shortcut', new Date()]);
    app.ctx.readState = () => ({ cards: { deletedBuiltIns: [], customCards: [{ id: 'mari', name, last4: '2475', statementDay: 15, dueMethod: 'calendar_days', dueValue: 22 }] } });
    const raw = 'MariBank A MariCard Credit transaction of PHP 1.00 at GADC KARUHATAN SOK was completed. If unauthorized, please chat with us live on the app.';
    const result = app.post({ raw, amount: '1.00', last4: '', note: 'GADC KARUHATAN SOK', app: 'MariBank' });
    // Before: "Maricard Credit" tied with the old row (ignored); "Maricard" lost to it.
    assert.equal(result.status, 'logged', name);
    assert.equal(result.card, name);
    assert.equal(app.sheets.Transactions.rows.at(-1)[3], name);
  }
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
