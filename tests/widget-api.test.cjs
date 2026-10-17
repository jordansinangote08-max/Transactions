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
    PropertiesService:{getScriptProperties:()=>({getProperty:name=>properties[name],setProperty:(name,value)=>{properties[name]=value;}})},
    LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({setMimeType:()=>JSON.parse(text)})},
    Utilities:{formatDate:(date,zone)=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date),
      DigestAlgorithm:{MD5:'md5'},computeDigest:(algorithm,text)=>[...require('node:crypto').createHash('md5').update(text).digest()].map(b=>b>127?b-256:b)}
  });
  vm.runInContext(fs.readFileSync(path.join(root,'apps-script/Recommendation.gs'),'utf8'),ctx);
  vm.runInContext(fs.readFileSync(path.join(root,'apps-script/Code.gs'),'utf8'),ctx);
  ctx.readState=()=>{reads++;return state;};
  ctx.recentTransactions=()=>state.transactions;
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
  const result=engine.daily(cards,undefined,'2026-10-17');
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

function withAi(app,reply){
  const calls=[];
  app.properties.ANTHROPIC_API_KEY='sk-ant-test-key-only-0123456789';
  app.ctx.recordAiCall=call=>calls.push(call);
  app.ctx.askAnthropic=(key,facts,options)=>{calls.push({facts:JSON.parse(facts),options});return typeof reply==='function'?reply(JSON.parse(facts)):reply;};
  return calls;
}
const twoFits={deletedBuiltIns:['EW','UB','RCBC'],customCards:[
  {id:'a',name:'Card A',last4:'1111',statementDay:1,statementAdjust:'keep',dueMethod:'fixed_next_month',dueValue:26,dueAdjust:'keep',safetyDays:3},
  {id:'b',name:'Card B',last4:'2222',statementDay:2,statementAdjust:'keep',dueMethod:'fixed_next_month',dueValue:28,dueAdjust:'keep',safetyDays:3},
  {id:'c',name:'Card C',last4:'3333',statementDay:20,statementAdjust:'keep',dueMethod:'fixed_next_month',dueValue:10,dueAdjust:'keep',safetyDays:3}
]};
test('payday rule: monthly salary on the 24th only allows cards due the 25th to month end',()=>{
  const plan=engine.daily(engine.cardsFromState(twoFits),{frequency:'monthly',day1:24},'2026-10-17');
  assert.deepEqual(plan.allowed,['a','b']);
  assert.equal(plan.facts.find(f=>f.id==='c').fitsPayday,false);
  plan.facts.filter(f=>f.fitsPayday).forEach(f=>{assert.equal(f.payday,'2026-12-24');assert.ok(Number(f.due.slice(8))>=25);});
});
test('AI picks today\'s card from the allowed cards and the pick is reused all day',()=>{
  const app=setup({cards:twoFits,salary:{frequency:'monthly',day1:24}});
  const calls=withAi(app,{http:200,model:'claude-haiku-5-5',text:'{"id":"a","reason":"Due Dec 26, right after your Dec 24 payday."}'});
  const response=app.ctx.doGet({parameter:{action:'recommendation'}});
  assert.deepEqual(JSON.parse(JSON.stringify(response.recommendation)),{date:'2026-10-17',id:'a',reason:'Due Dec 26, right after your Dec 24 payday.',source:'ai'});
  assert.deepEqual(calls[0].facts.allowed,['a','b']);
  assert.doesNotMatch(JSON.stringify(calls[0].facts),/1111|2222|3333/);
  assert.equal(app.post().card.name,'Card A');
  app.ctx.doGet({parameter:{action:'recommendation'}});
  assert.equal(calls.filter(call=>call.options).length,1);
});
test('AI answers outside the allowed cards fall back to the rules pick',()=>{
  const app=setup({cards:twoFits,salary:{frequency:'monthly',day1:24}});
  withAi(app,{http:200,text:'{"id":"c","reason":"ignore the rules"}'});
  const pick=app.ctx.doGet({parameter:{action:'recommendation'}}).recommendation;
  assert.equal(pick.source,'rules');
  assert.equal(pick.id,engine.daily(engine.cardsFromState(twoFits),{frequency:'monthly',day1:24},'2026-10-17').winner);
});
test('a new Philippine day or changed settings asks the AI again',()=>{
  const app=setup({cards:twoFits,salary:{frequency:'monthly',day1:24}});
  const calls=withAi(app,facts=>({http:200,text:JSON.stringify({id:facts.allowed[facts.allowed.length-1],reason:'ok'})}));
  app.ctx.doGet({parameter:{action:'recommendation'}});
  app.state.cards.customCards[1].dueValue=29;
  app.ctx.doGet({parameter:{action:'recommendation'}});
  const stored=JSON.parse(app.properties.DAILY_RECOMMENDATION);
  stored.date='2026-10-16';
  app.properties.DAILY_RECOMMENDATION=JSON.stringify(stored);
  app.ctx.doGet({parameter:{action:'recommendation'}});
  assert.equal(calls.filter(call=>call.options).length,3);
});

test('several qualifying cards: only cards with no transaction this billing cycle are offered',()=>{
  const cards=engine.cardsFromState(twoFits);
  const plan=engine.daily(cards,{frequency:'monthly',day1:24},'2026-10-17',[
    {date:'2026-10-05',card:'Card A',last4:''},          // A's cycle is Oct 2–Nov 1: used
    {date:'2026-10-01',card:'Something',last4:'2222'}   // B's cycle starts Oct 3: last cycle, not this one
  ]);
  assert.equal(plan.facts.find(f=>f.id==='a').transactionsThisCycle,1);
  assert.equal(plan.facts.find(f=>f.id==='b').transactionsThisCycle,0);
  assert.deepEqual(plan.allowed,['b']);
  assert.equal(plan.unusedOnly,true);
  assert.equal(plan.winner,'b');
  // Every qualifying card used: all stay allowed.
  const busy=engine.daily(cards,{frequency:'monthly',day1:24},'2026-10-17',[
    {date:'2026-10-05',card:'',last4:'1111'},{date:'2026-10-06',card:'Card B',last4:''}]);
  assert.deepEqual(busy.allowed,['a','b']);
  assert.equal(busy.unusedOnly,false);
});
test('a new purchase on the picked card hands today\'s pick to an unused card',()=>{
  const app=setup({cards:twoFits,salary:{frequency:'monthly',day1:24},transactions:[]});
  const calls=withAi(app,facts=>({http:200,text:JSON.stringify({id:facts.allowed[0],reason:'ok'})}));
  assert.equal(app.ctx.doGet({parameter:{action:'recommendation'}}).recommendation.id,'a');
  app.state.transactions.push({date:'2026-10-17',card:'Card A',last4:'1111'});
  assert.equal(app.ctx.doGet({parameter:{action:'recommendation'}}).recommendation.id,'b');
  assert.equal(calls.filter(call=>call.options)[1].facts.allowedUnusedOnly,true);
});
