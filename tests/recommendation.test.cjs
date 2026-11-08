const {test}=require('node:test');
const assert=require('node:assert/strict');
const engine=require('../recommendation.js');
const baseline=require('./fixtures/recommendation-baseline.json');
for(const scenario of baseline.scenarios) test(`matches original calendar, holidays, safety and winner (${scenario.salary.frequency}; ${scenario.expected.length} dates)`,()=>{
  for(const item of scenario.expected){
    const result=engine.evaluate(scenario.cards,scenario.salary,item.date);
    assert.equal(result.winner,item.winner,item.date);
    for(const detail of item.details){
      assert.equal(engine.dateKey(result.details[detail.id].due),detail.due,item.date);
      assert.equal(engine.dateKey(result.details[detail.id].statement),detail.statement,item.date);
    }
  }
});
test('fixed day of the same month: due later that month, else the next; weekend rules still apply',()=>{
  const card={id:'r',statementDay:3,statementAdjust:'keep',dueMethod:'fixed_same_month',dueValue:28,dueAdjust:'next',safetyDays:7};
  const due=(rules,day)=>engine.dateKey(engine.calcCustomCard(rules,engine.parseDate(day)).due);
  assert.equal(due(card,'2026-11-08'),'2026-12-28');                 // statement Dec 3 → Dec 28
  assert.equal(due(card,'2027-01-25'),'2027-03-01');                 // Feb 28 2027 is a Sunday
  assert.equal(due({...card,dueValue:2},'2026-11-08'),'2027-01-04'); // before the statement → next month
  assert.equal(due({...card,dueValue:31,dueAdjust:'keep'},'2027-01-25'),'2027-02-28');  // short month
  assert.ok(engine.evaluate([card],{frequency:'monthly',day1:24},'2026-11-08').details.r);
});
