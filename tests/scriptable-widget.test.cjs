const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../scriptable/recommended-card.js'),'utf8');
const card={name:'Actual Saved Card',logo:'unionbank.svg',last4:'0042'};
async function run({family='small',response={ok:true,card},offline=false,cached,configured=true,imageOffline=false}={}){
  const files=new Map(), requests=[],texts=[],images=[];
  const settings={site:'https://example.test/Transactions/',endpoint:'https://script.google.com/macros/s/deployment/exec',token:'secret-test-token-only-'.repeat(3)};
  if(cached!==undefined)files.set('/library/card-advisor-Recommended_Card/recommendation.json',JSON.stringify({card:cached}));
  let widget;
  class Stack{
    addStack(){return new Stack();} addSpacer(){} layoutHorizontally(){} layoutVertically(){} centerAlignContent(){} setPadding(){}
    addImage(image){images.push(image);return {applyFittingContentMode(){}};}
    addText(value){texts.push(value);return {centerAlignText(){}};}
  }
  class Widget extends Stack{}
  const fileManager={libraryDirectory:()=>'/library',joinPath:(a,b)=>a+'/'+b,fileExists:p=>files.has(p),createDirectory:p=>files.set(p,'directory'),remove:p=>{for(const k of files.keys())if(k.startsWith(p))files.delete(k);},readString:p=>{if(!files.has(p))throw Error();return files.get(p);},writeString:(p,v)=>files.set(p,v),readImage:p=>files.get(p),writeImage:(p,v)=>files.set(p,v)};
  class Request{
    constructor(url){this.url=url;requests.push(this);this.response={statusCode:200};}
    async loadJSON(){if(offline)throw Error('Offline');return response;}
    async loadImage(){if(imageOffline)throw Error('Offline');return 'actual-logo-image';}
  }
  class Color{static dynamic(a,b){return {light:a,dark:b};}constructor(hex){this.hex=hex;}}
  const ctx=vm.createContext({Date,JSON,console,Request,Color,Size:class{constructor(w,h){this.width=w;this.height=h;}},Font:{semiboldSystemFont:()=>'',mediumSystemFont:()=>''},ListWidget:Widget,
    FileManager:{local:()=>fileManager},Keychain:{get:()=>{if(!configured)throw Error();return JSON.stringify(settings);}},Script:{name:()=> 'Recommended Card',setWidget:w=>widget=w,complete(){}},config:{runsInWidget:true,widgetFamily:family}});
  await vm.runInContext('(async()=>{'+source+'})()',ctx);
  return {files,requests,texts,images,settings,widget};
}
for(const family of ['small','medium','large'])test(`${family} renders only actual name and masked ending, logo and relevant app link`,async()=>{
  const r=await run({family});
  assert.deepEqual(r.texts,[card.name,'•••• 0042']);
  assert.equal(r.images.length,1);
  assert.equal(r.widget.url,'https://example.test/Transactions/#overview');
  const wait=r.widget.refreshAfterDate.getTime()-Date.now();
  assert.ok(wait>0&&wait<=5*60*1000+1000);
  assert.equal(r.requests[0].method,'POST');
  assert.equal(r.requests[0].url,r.settings.endpoint);
  assert.ok(!r.requests[0].url.includes(r.settings.token));
  assert.equal(new URLSearchParams(r.requests[0].body).get('widgetToken'),r.settings.token);
  assert.equal(r.requests[1].url,'https://example.test/Transactions/widget-logos/unionbank.png');
  const saved=[...r.files.values()].find(v=>typeof v==='string'&&v.startsWith('{'));
  assert.ok(!saved.includes(r.settings.token));
});
test('temporary offline failure reuses last successful recommendation',async()=>{
  const r=await run({offline:true,cached:card});assert.deepEqual(r.texts,[card.name,'•••• 0042']);
});
test('authoritative null removes old recommendation and replaces cache',async()=>{
  const r=await run({response:{ok:true,card:null},cached:card});
  assert.deepEqual(r.texts,['No Recommended Card']);
  assert.equal(JSON.parse([...r.files.entries()].find(([k])=>k.endsWith('.json'))[1]).card,null);
});
test('revoked token purges private cached data',async()=>{
  const r=await run({response:{ok:false,code:401},cached:card});
  assert.deepEqual(r.texts,['No Recommended Card']);
  assert.ok(![...r.files.keys()].some(k=>k.endsWith('.json')));
});
test('no setup or no cached result never invents a card',async()=>{
  const a=await run({configured:false}); assert.deepEqual(a.texts,['No Recommended Card']);assert.equal(a.requests.length,0);
  const b=await run({offline:true}); assert.deepEqual(b.texts,['No Recommended Card']);
});
test('invalid full card number is not displayed or cached',async()=>{
  const r=await run({response:{ok:true,card:{...card,last4:'4111111111111111'}}});
  assert.deepEqual(r.texts,['No Recommended Card']);
});
test('missing logo never creates a fake logo; name and actual ending still render',async()=>{
  const r=await run({imageOffline:true}); assert.equal(r.images.length,0);assert.deepEqual(r.texts,[card.name,'•••• 0042']);
});
test('unknown last4 is omitted rather than made up',async()=>{
  const r=await run({response:{ok:true,card:{...card,last4:''}}});assert.deepEqual(r.texts,[card.name]);
});
test('rejects full numbers hidden in a display name too',async()=>{
  const r=await run({response:{ok:true,card:{...card,name:'Card 4111-1111-1111-1111'}}});
  assert.deepEqual(r.texts,['No Recommended Card']);
});
