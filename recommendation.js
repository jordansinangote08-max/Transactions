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
  return {defaultSalary,logoLibrary,builtInDefaults,cardsFromState,evaluate,parseDate,dateKey,calcCustomCard,salaryDatesBetween,clampSalaryDay};
})();
if(typeof module!=="undefined"&&module.exports) module.exports=CardAdvisorRecommendation;
