const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname,'..');
const engine = require('../recommendation.js');
const token = 'widget-test-token-only-'.repeat(3);
function setup(state = {cards:{customCards:[],builtInOverrides:{},deletedBuiltIns:[]}}) {
  let reads = 0;
  const properties = {WIDGET_READ_TOKEN:token};
  const ctx = vm.createContext({
    console, Date:class extends Date { constructor(...args){super(...(args.length?args:['2026-10-16T16:30:00Z']));} },
    PropertiesService:{getScriptProperties:()=>({getProperty:name=>properties[name]})},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({setMimeType:()=>JSON.parse(text)})},
    Utilities:{formatDate:(date,zone)=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date)}
  });
  vm.runInContext(fs.readFileSync(path.join(root,'apps-script/Recommendation.gs'),'utf8'),ctx);
  vm.runInContext(fs.readFileSync(path.join(root,'apps-script/Code.gs'),'utf8'),ctx);
  ctx.readState=()=>{reads++;return state;};
  const post=(extra={})=>ctx.doPost({parameter:{action:'widget',widgetToken:token,...extra}});
  return {ctx,state,properties,post,reads:()=>reads};
}
test('deployed engine is generated from exactly the browser source',()=>{
  assert.equal(fs.readFileSync(path.join(root,'apps-script/Recommendation.gs'),'utf8'),
    '// GENERATED from recommendation.js. Do not edit; run python3 scripts/sync-widget-assets.py.\n'+fs.readFileSync(path.join(root,'recommendation.js'),'utf8'));
});
test('rejects absent/wrong/oversized tokens before accessing private state',()=>{
  const app=setup();
  for(const bad of ['', 'wrong', token+'x','x'.repeat(513)]) assert.equal(app.post({widgetToken:bad}).code,401);
  delete app.properties.WIDGET_READ_TOKEN;
  assert.equal(app.post().code,401);
  app.properties.WIDGET_READ_TOKEN='short';
  assert.equal(app.post({widgetToken:'short'}).code,401);
  assert.equal(app.reads(),0);
});
test('returns only the actual winner projection, using Manila today across UTC midnight',()=>{
  const app=setup();
  const cards=engine.cardsFromState(app.state.cards);
  const result=engine.evaluate(cards,undefined,'2026-10-17');
  assert.ok(result.winner);
  const expected=result.details[result.winner].card;
  const response=app.post();
  assert.deepEqual(JSON.parse(JSON.stringify(response)),{ok:true,card:{name:expected.name,logo:expected.logo,last4:expected.last4}});
});
test('reflects saved changes on next request, uses actual leading-zero ending, and exposes no financial metadata',()=>{
  const app=setup({cards:{deletedBuiltIns:['EW','UB','RCBC'],customCards:[{
    id:'mine',name:'My Saved Card',logo:'unionbank.svg',last4:'0001',last4s:['0001','5678'],
    statementDay:1,statementAdjust:'keep',dueMethod:'calendar_days',dueValue:28,dueAdjust:'next',safetyDays:0,
    creditLimit:123456789,completeNumber:'1234567890123456'
  }]}});
  const response=app.post();
  assert.equal(response.card.last4,'0001');
  assert.deepEqual(Object.keys(response.card).sort(),['last4','logo','name']);
  assert.doesNotMatch(JSON.stringify(response),/123456789|completeNumber|creditLimit|5678/);
  app.state.cards.customCards[0].name='Renamed card';
  app.state.cards.customCards[0].last4='0042';
  assert.equal(app.post().card.name,'Renamed card');
  assert.equal(app.post().card.last4,'0042');
  app.state.cards.customCards=[];
  assert.equal(app.post().card,null);
});
test('no cloud state or no eligible card returns null rather than fabricated defaults',()=>{
  assert.equal(setup({}).post().card,null);
  const app=setup({cards:{deletedBuiltIns:['EW','UB','RCBC'],customCards:[]}});
  assert.equal(app.post().card,null);
});
test('refuses arbitrary logo URLs and full numbers in last4',()=>{
  const app=setup();
  app.state.cards.builtInOverrides={EW:{logo:'https://evil.test/image',last4:'4111111111111111'},UB:{logo:'../../private',last4:'4111111111111111'},RCBC:{logo:'data:bad',last4:'4111111111111111'}};
  assert.equal(app.post().card.logo,'');
  assert.equal(app.post().card.last4,'');
});
test('fails closed on corrupt stored rules without exposing details',()=>{
  const app=setup();
  app.state.cards.builtInOverrides={EW:{dueValue:Infinity}};
  assert.deepEqual(JSON.parse(JSON.stringify(app.post())),{ok:false,code:503,error:'Recommendation temporarily unavailable.'});
});
test('GET does not expose the widget response',()=>{
  const app=setup();
  assert.equal(app.ctx.doGet({parameter:{action:'widget'}}).ok,false);
  assert.equal(app.reads(),0);
});
test('stable ties preserve existing card order; all unsafe cards yield no winner',()=>{
  const base={statementDay:1,statementAdjust:'keep',dueMethod:'calendar_days',dueValue:28,dueAdjust:'keep',safetyDays:0};
  const cards=[{...base,id:'first'},{...base,id:'second'}];
  assert.equal(engine.evaluate(cards,undefined,'2026-10-17').winner,'first');
  cards.forEach(card=>card.safetyDays=366);
  assert.equal(engine.evaluate(cards,undefined,'2026-10-17').winner,null);
});
test('rejects a full card number mistakenly embedded in a card name',()=>{
  const app=setup();
  app.state.cards.builtInOverrides=Object.fromEntries(['EW','UB','RCBC'].map(id=>[id,{name:'Card 4111 1111 1111 1111'}]));
  const result=app.post(); assert.equal(result.code,503);assert.doesNotMatch(JSON.stringify(result),/4111/);
});
test('read-only state access does not initialize or mutate an absent Settings sheet',()=>{
  const app=setup();
  app.ctx.SpreadsheetApp={getActiveSpreadsheet:()=>({getSheetByName:()=>null,insertSheet:()=>{throw Error('Should not write');}})};
  // Restore the actual readState function instead of the fixture override.
  vm.runInContext(fs.readFileSync(path.join(root,'apps-script/Code.gs'),'utf8').slice(
    fs.readFileSync(path.join(root,'apps-script/Code.gs'),'utf8').indexOf('function readState('),
    fs.readFileSync(path.join(root,'apps-script/Code.gs'),'utf8').indexOf('function saveState(')
  ),app.ctx);
  assert.equal(app.post().card,null);
});
