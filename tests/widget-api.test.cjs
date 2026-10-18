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
const salary={frequency:'monthly',day1:24};
const card=(id,name,last4,statementDay,dueValue,extra={})=>({id,name,last4,statementDay,statementAdjust:'keep',dueMethod:'calendar_days',dueValue,dueAdjust:'keep',safetyDays:0,creditLimit:10000,...extra});
// Today Oct 17, upcoming salary Oct 24. Statements on the 18th (cycle Sep 19–Oct 18).
const fourCards={deletedBuiltIns:['EW','UB','RCBC'],customCards:[
  card('c1','Card 1','1111',18,4),   // due Oct 22: before payday
  card('c2','Card 2','2222',18,7),    // due Oct 25
  card('c3','Card 3','3333',18,14),     // due Nov 1
  card('c4','Card 4','4444',18,18)      // due Nov 5
]};
const plan=(transactions,options,state=fourCards,day='2026-10-17')=>engine.daily(engine.cardsFromState(state),salary,day,transactions,options);
const tx=(last4,amount,date='2026-10-10')=>({date,card:'',last4,amount});

test('Step 1: only cards due after the upcoming salary date qualify',()=>{
  const result=plan([]);
  assert.equal(result.nextPayday,'2026-10-24');
  assert.deepEqual(result.facts.map(f=>[f.due,f.dueAfterPayday]),[['2026-10-22',false],['2026-10-25',true],['2026-11-01',true],['2026-11-05',true]]);
  assert.deepEqual(result.steps[0].after,['c2','c3','c4']);
});
test('Step 2 beats Step 3: the lowest spend wins even with an earlier due date',()=>{
  const result=plan([tx('2222',200),tx('3333',50),tx('4444',60)]);
  assert.equal(result.winner,'c3');
  assert.match(result.reasons[1],/Lowest spend this billing cycle: ₱50/);
});
test('Steps 2→3: tied lowest spend goes to the latest due date (spec example)',()=>{
  const result=plan([tx('1111',500),tx('2222',200),tx('3333',50),tx('4444',50)]);
  assert.equal(result.winner,'c4');
  assert.deepEqual(result.reasons.slice(0,3),['✅ Due Nov 5, after your Oct 24 payday.','✅ Lowest spend this billing cycle: ₱50 (Sep 19–Oct 18).','✅ Latest payment due date among the tied cards.']);
});
test('only the current billing cycle counts toward spend',()=>{
  const result=plan([tx('4444',900,'2026-09-15'),tx('3333',10)]);
  assert.equal(result.facts.find(f=>f.id==='c4').spendThisCycle,0);
  assert.equal(result.winner,'c4');
  assert.match(result.reasons[1],/No transactions yet this billing cycle \(Sep 19–Oct 18\)/);
});
test('Step 4: same spend and due date → lowest utilization; final tie → longest since recommended',()=>{
  const twins={deletedBuiltIns:['EW','UB','RCBC'],customCards:[card('a','A','1111',18,18,{creditLimit:1000}),card('b','B','2222',18,18,{creditLimit:2000})]};
  const prior=[tx('1111',150,'2026-09-10'),tx('2222',100,'2026-09-10')]; // last cycle, due Oct 6 → paid, not outstanding
  assert.equal(plan(prior,{},twins).facts[0].outstanding,0);
  const util=plan([tx('1111',100),tx('2222',100)],{},twins);   // 10% vs 5%
  assert.equal(util.winner,'b');
  assert.ok(util.steps.some(step=>step.step===4));
  const even={...twins,customCards:twins.customCards.map(c=>({...c,creditLimit:1000}))};
  assert.equal(plan([],{lastRecommended:{a:'2026-10-16',b:'2026-10-10'}},even).winner,'b');
  assert.equal(plan([],{lastRecommended:{a:'2026-10-16'}},even).winner,'b');   // never recommended = oldest
});
test('20% utilization protection: a card at the limit is set aside while another qualifies',()=>{
  const result=plan([tx('4444',2500),tx('3333',100),tx('2222',100)]);   // c4 at 25%
  assert.equal(result.winner,'c3');
  assert.deepEqual(result.steps.find(step=>step.step==='limit').after,['c2','c3']);
});
test('no qualifying card: shows the closest alternative, flagged, instead of bypassing silently',()=>{
  const early={deletedBuiltIns:['EW','UB','RCBC'],customCards:[card('x','X','1111',18,2),card('y','Y','2222',18,4)]};
  const result=plan([],{},early);
  assert.equal(result.status,'alternative');
  assert.equal(result.winner,'y');
  assert.match(result.reasons[0],/No card's due date is after your Oct 24 payday/);
});
test('your cards today: MariCard (₱0 this cycle, due Dec 7)',()=>{
  const mine={deletedBuiltIns:[],builtInOverrides:{RCBC:{name:'RCBC Flex',creditLimit:70000},UB:{last4s:['9624'],creditLimit:33000}},customCards:[
    {id:'mari',name:'MariCard Credit',last4:'2475',statementDay:15,statementAdjust:'keep',dueMethod:'calendar_days',dueValue:22,dueAdjust:'keep',safetyDays:7,creditLimit:90000}]};
  const result=plan([tx('6023',2000,'2026-10-12'),tx('9624',770,'2026-10-15'),tx('4069',498,'2026-10-08'),tx('2475',5000,'2026-10-14')],{},mine,'2026-10-18');
  assert.deepEqual(result.facts.map(f=>f.due),['2026-11-13','2026-11-27','2026-12-01','2026-12-07']);
  assert.equal(result.winner,'mari');
  assert.equal(result.facts.find(f=>f.id==='UB').utilization,8.4);
  assert.equal(result.facts.find(f=>f.id==='mari').outstanding,5000);   // last statement not yet due
});
test('the AI cross-checks: its note shows only when it reaches the same card, and it never changes the pick',()=>{
  const app=setup({cards:fourCards,salary,transactions:[tx('2222',200),tx('3333',50),tx('4444',50)]});
  const calls=withAi(app,{http:200,model:'claude-haiku-5-5',text:'{"id":"c4","note":"Keep this purchase under PHP 1,950 to stay below 20%."}'});
  const pick=app.ctx.doGet({parameter:{action:'recommendation'}}).recommendation;
  assert.equal(pick.id,'c4');
  assert.equal(pick.note,'Keep this purchase under PHP 1,950 to stay below 20%.');
  assert.equal(pick.status,'qualified');
  assert.ok(pick.updatedAt&&pick.nextEvaluation);
  assert.doesNotMatch(JSON.stringify(calls[0].facts),/1111|2222|3333|4444/);
  assert.equal(app.post().card.name,'Card 4');
  app.ctx.doGet({parameter:{action:'recommendation'}});
  assert.equal(calls.filter(call=>call.options).length,1);   // reused all day

  const other=setup({cards:fourCards,salary,transactions:[tx('2222',200),tx('3333',50),tx('4444',50)]});
  const log=withAi(other,{http:200,text:'{"id":"c2","note":"use card 2"}'});
  const kept=other.ctx.doGet({parameter:{action:'recommendation'}}).recommendation;
  assert.equal(kept.id,'c4');
  assert.equal(kept.note,'');
  assert.match(log.find(call=>call.result).result,/disagreed/);
});
test('recalculates on a new transaction, a new day, or changed cards; tie-breaker ignores today',()=>{
  const app=setup({cards:fourCards,salary,transactions:[]});
  const calls=withAi(app,facts=>({http:200,text:'{"id":"x","note":""}'}));
  assert.equal(app.ctx.doGet({parameter:{action:'recommendation'}}).recommendation.id,'c4');
  app.state.transactions.push(tx('4444',30,'2026-10-17'));
  assert.equal(app.ctx.doGet({parameter:{action:'recommendation'}}).recommendation.id,'c3');
  assert.deepEqual(JSON.parse(app.properties.RECOMMENDATION_HISTORY),{c4:['2026-10-17'],c3:['2026-10-17']});
  const stored=JSON.parse(app.properties.DAILY_RECOMMENDATION);
  stored.date='2026-10-16';
  app.properties.DAILY_RECOMMENDATION=JSON.stringify(stored);
  app.ctx.doGet({parameter:{action:'recommendation'}});
  assert.equal(calls.filter(call=>call.options).length,3);
});
test('without an AI key the pick and reasons still show',()=>{
  const app=setup({cards:fourCards,salary,transactions:[]});
  const pick=app.ctx.doGet({parameter:{action:'recommendation'}}).recommendation;
  assert.equal(pick.id,'c4');
  assert.equal(pick.source,'rules');
  assert.equal(pick.reasons[1],'✅ No transactions yet this billing cycle (Sep 19–Oct 18).');
});
