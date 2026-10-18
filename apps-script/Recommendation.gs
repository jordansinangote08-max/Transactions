// GENERATED from recommendation.js. Do not edit; run python3 scripts/sync-widget-assets.py.
/* Shared recommendation engine. Browser source of truth; Apps Script copy is generated
 * with python3 scripts/sync-widget-assets.py. No network or UI dependencies.
 * Calendar dates use UTC internally to avoid device/server timezone and DST drift.
 */
var CardAdvisorRecommendation = (() => {
  const defaultSalary = {frequency:"monthly",day1:24,dayA:15,dayB:30,weekday:5};
  function calendarDate(year,month,day) { return new Date(Date.UTC(year,month,day)); }
  function parseDate(key) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error("Invalid date");
    const [y,m,d]=key.split("-").map(Number);
    const date=calendarDate(y,m-1,d);
    if(dateKey(date)!==key) throw new Error("Invalid date");
    return date;
  }
  function dateKey(date) { return date.toISOString().slice(0,10); }
const logoLibrary = [
      {name:"BDO",src:"bdo.svg"},
      {name:"BPI",src:"bpi.svg"},
      {name:"China Bank",src:"chinabank.png"},
      {name:"EastWest",src:"eastwest.png"},
      {name:"Landbank",src:"landbank.png"},
      {name:"MariBank",src:"maribank.png"},
      {name:"Metrobank",src:"metrobank.svg"},
      {name:"PNB",src:"pnb.svg"},
      {name:"RCBC",src:"rcbc.png"},
      {name:"Security Bank",src:"security-bank.svg"},
      {name:"UnionBank",src:"unionbank.svg"},
      {name:"Apple Pay",src:"apple-pay.svg"},
      {name:"PayPal",src:"paypal.svg"},
      {name:"Wise",src:"wise.svg"}
    ];
function easterSunday(year){
      const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4;
      const f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30;
      const i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451);
      const month=Math.floor((h+l-7*m+114)/31);
      const day=((h+l-7*m+114)%31)+1;
      return calendarDate(year,month-1,day);
    }

function lastMondayOfAugust(year){
      const d=calendarDate(year,7,31);
      while(d.getUTCDay()!==1)d.setUTCDate(d.getUTCDate()-1);
      return d;
    }

function philippineHolidayKeys(year){
      const fixed=["01-01","04-09","05-01","06-12","08-21","11-01","11-30","12-08","12-24","12-25","12-30","12-31"];
      const keys=new Set(fixed.map(md=>`${year}-${md}`));
      keys.add(dateKey(lastMondayOfAugust(year)));
      const easter=easterSunday(year);
      [-3,-2,-1].forEach(offset=>{const d=new Date(easter);d.setUTCDate(d.getUTCDate()+offset);keys.add(dateKey(d));});
      const proclaimed={
        2026:["2026-02-17","2026-03-20","2026-05-27","2026-11-02"]
      };
      (proclaimed[year]||[]).forEach(key=>keys.add(key));
      return keys;
    }

function isPhilippineHoliday(date){
      return philippineHolidayKeys(date.getUTCFullYear()).has(dateKey(date));
    }

function isBusinessDay(date){
      const day=date.getUTCDay();
      return day!==0&&day!==6&&!isPhilippineHoliday(date);
    }

function moveToPreviousBusinessDay(date){
      const d=new Date(date);
      while(!isBusinessDay(d))d.setUTCDate(d.getUTCDate()-1);
      return d;
    }

function moveToNextBusinessDay(date){
      const d=new Date(date);
      while(!isBusinessDay(d))d.setUTCDate(d.getUTCDate()+1);
      return d;
    }

function addBusinessDays(date,count){
      const d=new Date(date);
      let remaining=Math.max(0,Number(count)||0);
      while(remaining>0){
        d.setUTCDate(d.getUTCDate()+1);
        if(isBusinessDay(d)) remaining--;
      }
      return d;
    }

function statementForDay(transactionDate,dayOfMonth,adjuster=null){
      let raw=calendarDate(transactionDate.getUTCFullYear(),transactionDate.getUTCMonth(),dayOfMonth);
      let statement=adjuster?adjuster(raw):raw;
      if(transactionDate>statement){
        raw=calendarDate(transactionDate.getUTCFullYear(),transactionDate.getUTCMonth()+1,dayOfMonth);
        statement=adjuster?adjuster(raw):raw;
      }
      return statement;
    }

function daysUntil(due,from){
      return Math.ceil((due-from)/86400000);
    }

function clampSalaryDay(value){
      return Math.min(31,Math.max(1,Number(value)||1));
    }

function dateForMonthDay(year,month,day){
      const lastDay=calendarDate(year,month+1,0).getUTCDate();
      return calendarDate(year,month,Math.min(day,lastDay));
    }

function salaryDatesBetween(fromDate,toDate,salarySettings){
      const dates=[];
      if(!(fromDate instanceof Date)||!(toDate instanceof Date)||toDate<=fromDate) return dates;

      if(salarySettings.frequency==="weekly"){
        const target=Number(salarySettings.weekday);
        const cursor=new Date(fromDate);
        cursor.setUTCDate(cursor.getUTCDate()+1);
        while(cursor<toDate){
          if(cursor.getUTCDay()===target) dates.push(new Date(cursor));
          cursor.setUTCDate(cursor.getUTCDate()+1);
        }
        return dates;
      }

      const monthCursor=calendarDate(fromDate.getUTCFullYear(),fromDate.getUTCMonth(),1);
      const endMonth=calendarDate(toDate.getUTCFullYear(),toDate.getUTCMonth(),1);
      while(monthCursor<=endMonth){
        const year=monthCursor.getUTCFullYear();
        const month=monthCursor.getUTCMonth();
        const days=salarySettings.frequency==="twice"
          ? [salarySettings.dayA,salarySettings.dayB]
          : [salarySettings.day1];
        [...new Set(days.map(clampSalaryDay))].forEach(day=>{
          const candidate=dateForMonthDay(year,month,day);
          if(candidate>fromDate&&candidate<toDate) dates.push(candidate);
        });
        monthCursor.setUTCMonth(monthCursor.getUTCMonth()+1);
      }
      return dates.sort((a,b)=>a-b);
    }

function adjustBusinessDate(date,rule){
      if(rule==="previous") return moveToPreviousBusinessDay(date);
      if(rule==="next") return moveToNextBusinessDay(date);
      return new Date(date);
    }

function calcCustomCard(card,date){
      const statement=statementForDay(
        date,
        Number(card.statementDay),
        original=>adjustBusinessDate(original,card.statementAdjust)
      );
      let originalDue;
      if(card.dueMethod==="fixed_next_month"){
        const targetMonth=calendarDate(statement.getUTCFullYear(),statement.getUTCMonth()+1,1);
        const lastDay=calendarDate(targetMonth.getUTCFullYear(),targetMonth.getUTCMonth()+1,0).getUTCDate();
        originalDue=calendarDate(targetMonth.getUTCFullYear(),targetMonth.getUTCMonth(),Math.min(lastDay,Number(card.dueValue)));
      }else if(card.dueMethod==="business_days"){
        originalDue=addBusinessDays(statement,Number(card.dueValue));
      }else{
        originalDue=new Date(statement);
        originalDue.setUTCDate(originalDue.getUTCDate()+Number(card.dueValue));
      }
      return {statement,due:adjustBusinessDate(originalDue,card.dueAdjust)};
    }

function builtInDefaults(){
      return [
        {id:"EW",name:"EastWest",last4:"3002",logo:"eastwest.png",statementDay:21,statementAdjust:"keep",dueMethod:"fixed_next_month",dueValue:15,dueAdjust:"previous",safetyDays:7},
        {id:"UB",name:"UnionBank",last4:"6023",logo:"unionbank.svg",statementDay:10,statementAdjust:"previous",dueMethod:"calendar_days",dueValue:17,dueAdjust:"next",safetyDays:7},
        {id:"RCBC",name:"RCBC",last4:"4069",logo:"rcbc.png",statementDay:3,statementAdjust:"keep",dueMethod:"calendar_days",dueValue:25,dueAdjust:"next",safetyDays:7}
      ];
    }
  function cardsFromState(state) {
    const saved=state||{};
    const deleted=new Set(saved.deletedBuiltIns||[]);
    return [
      ...builtInDefaults().filter(card=>!deleted.has(card.id)).map(card=>({...card,...(saved.builtInOverrides?.[card.id]||{}),id:card.id,builtIn:true})),
      ...(saved.customCards||[]).map(card=>({...card,builtIn:false}))
    ];
  }
  function evaluate(cards,salary,key) {
    const date=parseDate(key);
    const settings={...defaultSalary,...salary};
    const details=Object.fromEntries(cards.map(card=>{
      if(!Number.isInteger(Number(card.statementDay))||Number(card.statementDay)<1||Number(card.statementDay)>31||
         !Number.isFinite(Number(card.dueValue))||Number(card.dueValue)<0||Number(card.dueValue)>366||
         !Number.isFinite(Number(card.safetyDays??7))) throw new Error("Invalid card rules");
      const result=calcCustomCard(card,date);
      const salaryDates=salaryDatesBetween(date,result.due,settings);
      const daysToStatement=daysUntil(result.statement,date);
      const nearStatement=daysToStatement>=0&&daysToStatement<=Number(card.safetyDays??7);
      return [card.id,{card,...result,days:daysUntil(result.due,date),daysToStatement,nearStatement,salaryDates,salarySafe:salaryDates.length>0}];
    }));
    const eligible=cards.map(card=>card.id).filter(id=>details[id].salarySafe&&!details[id].nearStatement);
    const winner=eligible.length?eligible.reduce((best,id)=>details[id].days>details[best].days?id:best):null;
    return {winner,details};
  }
  // The statement before `statement`: today's purchase belongs to the cycle
  // (previous statement, statement]. Found with the card's own rules, so holiday
  // and month-end adjustments match the engine exactly.
  function previousStatement(card,date,statement){
    const probe=new Date(date);
    for(let i=0;i<62;i++){
      probe.setUTCDate(probe.getUTCDate()-1);
      const earlier=calcCustomCard(card,probe).statement;
      if(earlier<statement) return earlier;
    }
    return null;
  }
  function cardEndings(card){
    return [card.last4].concat(Array.isArray(card.last4s)?card.last4s:[])
      .map(value=>String(value??"").trim()).filter(value=>/^\d{4}$/.test(value));
  }
  // A sheet row belongs to a card by its last 4, or by the card's name.
  function isCardTransaction(card,transaction){
    const last4=String(transaction.last4||"").trim();
    if(last4&&cardEndings(card).includes(last4)) return true;
    const name=value=>String(value||"").trim().toLowerCase();
    return !!name(card.name)&&name(card.name)===name(transaction.card);
  }
  const UTILIZATION_LIMIT=20;
  const MONTHS=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  function shortDate(date){ return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`; }
  function peso(value){
    const fixed=(Math.round(Number(value)*100)/100).toFixed(2).replace(/\.00$/,"");
    const [whole,cents]=fixed.split(".");
    return "₱"+whole.replace(/\B(?=(\d{3})+(?!\d))/g,",")+(cents?"."+cents:"");
  }
  function addDays(date,days){ const d=new Date(date); d.setUTCDate(d.getUTCDate()+days); return d; }
  function centsOf(rows){ return Math.round(rows.reduce((sum,row)=>sum+(Number(row.amount)||0),0)*100); }
  function rowsBetween(card,transactions,after,through){
    return transactions.filter(transaction=>{
      const day=String(transaction.date||"");
      return (!after||day>dateKey(after))&&day<=dateKey(through)&&isCardTransaction(card,transaction);
    });
  }
  /*
   * Today's Recommended Card, in strict priority order. A lower step only breaks
   * a tie left by the steps above it; it never overrides them.
   *   Step 1  due date after the upcoming salary date (and the statement is not
   *           about to close). A card already at or over the 20% utilization
   *           limit is set aside while a qualifying card under it remains.
   *   Step 2  lowest spend in the card's own current billing cycle (₱0 first).
   *   Step 3  latest payment due date.
   *   Step 4  lowest credit utilization (outstanding ÷ credit limit).
   *   Final   the card that has gone longest without being recommended, then
   *           the card listed first.
   * No card qualifies → the closest alternative (latest due date), flagged.
   * transactions: [{date:"yyyy-mm-dd",card,last4,amount}], or undefined when
   * unknown (Steps 2 and 4 then can't use spend). options.lastRecommended:
   * {cardId:"yyyy-mm-dd"}, the last day before today each card was picked.
   * Outstanding = this cycle's spend plus the last statement's, while that
   * statement's due date hasn't passed (payments aren't in the sheet).
   */
  function daily(cards,salary,key,transactions,options) {
    const settings={...defaultSalary,...salary};
    const evaluation=evaluate(cards,settings,key);
    const today=parseDate(key);
    const known=Array.isArray(transactions);
    const lastRecommended=(options&&options.lastRecommended)||{};
    const nextPayday=salaryDatesBetween(addDays(today,-1),addDays(today,400),settings)[0]||null;
    const facts=cards.map((card,order)=>{
      const item=evaluation.details[card.id];
      const cycleStart=previousStatement(card,today,item.statement);
      let spendCents=null,outstandingCents=null;
      if(known){
        spendCents=centsOf(rowsBetween(card,transactions,cycleStart,today));
        outstandingCents=spendCents;
        if(cycleStart){
          const lastDue=calcCustomCard(card,cycleStart).due;
          if(lastDue>=today) outstandingCents+=centsOf(rowsBetween(card,transactions,previousStatement(card,cycleStart,cycleStart),cycleStart));
        }
      }
      const limit=Number(card.creditLimit)>0?Number(card.creditLimit):null;
      return {
        id:card.id,name:String(card.name||card.id),order,
        statement:dateKey(item.statement),due:dateKey(item.due),dueDate:item.due,
        daysToStatement:item.daysToStatement,daysToDue:item.days,nearStatement:item.nearStatement,
        dueAfterPayday:!!nextPayday&&item.due>nextPayday,
        cycleStart:cycleStart?dateKey(addDays(cycleStart,1)):null,cycleStartDate:cycleStart?addDays(cycleStart,1):null,statementDate:item.statement,
        spendCents,spendThisCycle:spendCents==null?null:spendCents/100,
        outstanding:outstandingCents==null?null:outstandingCents/100,
        creditLimit:limit,
        utilization:outstandingCents!=null&&limit?Math.round(outstandingCents/limit*10)/10:null,
        lastRecommended:lastRecommended[card.id]||null
      };
    });
    const byId=Object.fromEntries(facts.map(fact=>[fact.id,fact]));
    const steps=[];
    const narrow=(ids,keep,step)=>{
      const kept=ids.filter(keep);
      steps.push({step,before:ids,after:kept});
      return kept;
    };

    let remaining=facts.filter(fact=>fact.dueAfterPayday&&!fact.nearStatement).map(fact=>fact.id);
    steps.push({step:1,before:facts.map(fact=>fact.id),after:remaining});
    let status="qualified";
    if(!remaining.length){
      // Closest alternative: the latest due date, preferring cards not about to close.
      const pool=facts.filter(fact=>!fact.nearStatement).length?facts.filter(fact=>!fact.nearStatement):facts;
      const alternative=pool.reduce((best,fact)=>!best||fact.dueDate>best.dueDate?fact:best,null);
      status=alternative?"alternative":"none";
      remaining=alternative?[alternative.id]:[];
    }else{
      if(remaining.some(id=>byId[id].utilization!=null&&byId[id].utilization<UTILIZATION_LIMIT))
        remaining=narrow(remaining,id=>byId[id].utilization==null||byId[id].utilization<UTILIZATION_LIMIT,"limit");
      if(remaining.length>1&&known){
        const lowest=Math.min(...remaining.map(id=>byId[id].spendCents));
        remaining=narrow(remaining,id=>byId[id].spendCents===lowest,2);
      }
      if(remaining.length>1){
        const latest=Math.max(...remaining.map(id=>byId[id].dueDate.getTime()));
        remaining=narrow(remaining,id=>byId[id].dueDate.getTime()===latest,3);
      }
      if(remaining.length>1&&remaining.some(id=>byId[id].utilization!=null)){
        const lowest=Math.min(...remaining.map(id=>byId[id].utilization??Infinity));
        remaining=narrow(remaining,id=>(byId[id].utilization??Infinity)===lowest,4);
      }
      if(remaining.length>1){
        const oldest=remaining.reduce((best,id)=>(byId[id].lastRecommended||"")<(byId[best].lastRecommended||"")?id:best);
        remaining=narrow(remaining,id=>id===oldest,"final");
      }
    }
    const winner=remaining[0]||null;
    return {
      date:key,winner,status,nextPayday:nextPayday?dateKey(nextPayday):null,steps,
      reasons:winner?explain(byId[winner],status,steps,nextPayday,known):[],
      facts:facts.map(({dueDate,cycleStartDate,statementDate,spendCents,order,...fact})=>fact),
      details:evaluation.details
    };
  }
  function explain(fact,status,steps,nextPayday,known){
    const used=step=>steps.some(item=>item.step===step&&item.before.length>1);
    const payday=nextPayday?shortDate(nextPayday):"your next payday";
    const reasons=[];
    if(status==="alternative"){
      reasons.push(`⚠️ No card's due date is after your ${payday} payday.`);
      reasons.push(`Closest alternative: due ${shortDate(fact.dueDate)}, the latest due date.`);
    }else{
      reasons.push(`✅ Due ${shortDate(fact.dueDate)}, after your ${payday} payday.`);
      if(known){
        const cycle=fact.cycleStartDate?`${shortDate(fact.cycleStartDate)}–${shortDate(fact.statementDate)}`:"this cycle";
        reasons.push(fact.spendCents===0
          ? `✅ No transactions yet this billing cycle (${cycle}).`
          : `✅ ${used(2)?"Lowest":"Only"} spend this billing cycle: ${peso(fact.spendCents/100)} (${cycle}).`);
      }
      if(used(3)) reasons.push("✅ Latest payment due date among the tied cards.");
      if(used("final")) reasons.push("✅ Tied on every rule; it has gone longest without being recommended.");
    }
    if(fact.utilization!=null){
      reasons.push(fact.utilization<UTILIZATION_LIMIT
        ? `✅ Credit utilization ${fact.utilization}%, below your ${UTILIZATION_LIMIT}% limit${used(4)?" and the lowest":""}.`
        : `⚠️ Credit utilization ${fact.utilization}%, at or above your ${UTILIZATION_LIMIT}% limit.`);
    }else if(fact.creditLimit==null){
      reasons.push("Add a credit limit to this card to track utilization.");
    }
    return reasons;
  }
  return {defaultSalary,logoLibrary,builtInDefaults,cardsFromState,evaluate,daily,shortDate,UTILIZATION_LIMIT,parseDate,dateKey,calcCustomCard,salaryDatesBetween,clampSalaryDay};
})();
if(typeof module!=="undefined"&&module.exports) module.exports=CardAdvisorRecommendation;
