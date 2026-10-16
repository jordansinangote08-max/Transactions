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
