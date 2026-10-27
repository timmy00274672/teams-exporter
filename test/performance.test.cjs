const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{chromium}=require('playwright');
const {Repository,planConversation,applyPacket,planRanges}=require('../cli/store.cjs');
const {runBrowser}=require('../cli/browser.cjs');
const {parse}=require('../cli/teams-dump.cjs');
const root=path.resolve(__dirname,'..');
const range={from:Date.parse('2026-10-26T00:00Z'),to:Date.parse('2026-10-27T00:00Z')};

test('清單時間篩選保留邊界、未知時間、失敗、較早缺口與缺圖例外',()=>{
 assert.equal(parse([]).adaptive,true);assert.equal(parse(['--delay','900']).adaptive,false);assert.equal(parse(['--full-scan']).fullScan,true);
 const old={key:'x',latest:'2026-10-25T00:00:00Z',status:'pending',tasks:null};
 assert.equal(planConversation(null,old,range,false).skip,true);
 for(const latest of ['2026-10-26T00:00:00Z','2026-10-28T00:00:00Z',null,'invalid','2026-10-25 00:00'])assert.equal(planConversation(null,{...old,latest},range,false).skip,false);
 assert.equal(planConversation(null,{...old,status:'failed',error:'載入失敗'},range,false).skip,false);
 assert.equal(planConversation(null,{...old,tasks:[{range,status:'running'}]},range,false).skip,false);
 assert.equal(planConversation({messages:[{images:[{status:'failed'}]}]},old,range,false).skip,false);
 assert.equal(planConversation(null,old,range,false,{fullScan:true}).skip,false);assert.equal(planConversation(null,old,range,false,{only:true}).skip,false);
 const prior={messages:[],coverage:[],requests:[{from:range.from-5*86400000,to:range.from}],repairRequired:false};assert.equal(planConversation(prior,old,range,true).skip,false);
 const screened={messages:[],coverage:[],requests:[range],screenedRanges:[{range}]};assert.deepEqual(planRanges(screened,{from:range.to,to:range.to+86400000},true),[{from:range.from,to:range.to+86400000}]);
});

test('分檔進度只重寫改變聊天，舊格式可讀且保留原快照',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'teams-split-'));try{
  const repo=new Repository(dir),job={version:2,id:'old',account:'test@example.com',status:'interrupted',range,conversations:Array.from({length:5},(_,i)=>({key:'c'+i,name:'c'+i,status:'pending',messages:[],warnings:[]}))};
  await fs.mkdir(repo.jobDir(job.id),{recursive:true});await fs.writeFile(path.join(repo.jobDir(job.id),'state.json'),JSON.stringify(job));await repo.save(job);const restored=await new Repository(dir).job(job.id);assert.equal(restored.conversations.length,5);assert.equal(JSON.parse(await fs.readFile(path.join(repo.jobDir(job.id),'legacy-state.json'))).conversations.length,5);
  const before=repo.io.writes;job.conversations[2].messages.push({key:'m1',id:'m1',timestamp:range.from,seenInRun:'old',images:[]});await repo.save(job,{changedKeys:['c2']});assert.ok(repo.io.writes-before>=1&&repo.io.writes-before<=3);assert.equal((await new Repository(dir).job(job.id)).conversations[2].messages.length,1);
  await repo.ingest(job);const fresh=new Repository(dir);const lib=await fresh.library(job.account);assert.equal(lib.conversations.c2.messages.length,1);assert.equal(lib.version,2);
  const packet={kind:'delta-v1',header:{id:'old',status:'running'},order:['c2'],conversations:[{meta:{key:'c2',name:'changed'},upserts:[{key:'m1',text:'更新'}]}]};const applied=applyPacket(job,packet);assert.equal(applied.conversations[0].messages.length,1);assert.equal(applied.conversations[0].messages[0].text,'更新');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

function fixture(n=167){
 const items=Array.from({length:n},(_,i)=>{const recent=(i*71)%167<37;return `<div role="treeitem" data-item-type="${i%3?'chat':'muted-chat'}" data-fui-tree-item-value="chat|c${i}" data-key="c${i}"><span id="title-chat-list-item_c${i}">聊天${i}</span><time datetime="${recent?'2026-10-26T12:00:00Z':'2026-10-25T12:00:00Z'}"></time></div>`;}).join('');
 return `<style>[role=tree]{height:220px;overflow:auto}[data-tid=message-pane-list-viewport]{height:240px;overflow:auto}</style><button data-tid="me-control-avatar-trigger" aria-label="test@example.com"></button><div role="tree">${items}</div><div id="chat-header-c0"><h2 data-tid="chat-title">聊天0</h2></div><div data-tid="app-layout-area--main"><div data-tid="message-pane-list-viewport"></div></div><script>window.opened=[];document.querySelector('[role=tree]').onclick=e=>{const row=e.target.closest('[data-key]');if(!row)return;const key=row.dataset.key;opened.push(key);document.querySelector('[id^=chat-header-]').id='chat-header-'+key;document.querySelector('[data-tid=chat-title]').textContent=row.innerText;document.querySelector('[data-tid=message-pane-list-viewport]').innerHTML='<span id="author-'+key+'">作者</span><time id="timestamp-'+key+'" datetime="2026-10-25T00:00:00Z"></time><div id="message-body-'+key+'"><div id="content-'+key+'">邊界</div></div>';};</script>`;
}

test('167 個交錯排序聊天只開 37 個；delta 封包及分檔仍可復原',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),dir=await fs.mkdtemp(path.join(os.tmpdir(),'teams-filter-'));try{
  const page=await browser.newPage(),repo=new Repository(dir);await page.route('https://teams.cloud.microsoft/**',r=>r.fulfill({body:fixture(),contentType:'text/html'}));await page.goto('https://teams.cloud.microsoft/');
  await page.evaluate(()=>{const tree=document.querySelector('[role=tree]'),rows=[...tree.children].map(e=>e.outerHTML);let top=0;const render=()=>{tree.innerHTML=rows.slice(Math.floor(top/40),Math.floor(top/40)+10).join('');};Object.defineProperties(tree,{scrollHeight:{get:()=>rows.length*40},clientHeight:{get:()=>400},scrollTop:{get:()=>top,set:v=>{top=Math.max(0,Math.min(v,rows.length*40-400));render();}}});render();});
  for(const name of ['images.js','dom.js','shared-utils.js','export-formats.js'])await page.evaluate(await fs.readFile(path.join(root,name),'utf8'));
  let job;let received=0;
  await page.exposeBinding('teamsLocalSave',async(_s,packet)=>{received+=Buffer.byteLength(JSON.stringify(packet));const changedKeys=packet.conversations.map(x=>x.meta.key);job=applyPacket(job,packet);await repo.save(job,{changedKeys});await repo.ingest(job,{changedKeys});return {stop:false};});
  await page.exposeBinding('teamsLocalPlan',async(_s,{key,conversation,range,incremental})=>{const prior=(await repo.library('test@example.com')).conversations[key],plan=planConversation(prior,conversation,range,incremental);return {plan,messages:[],ranges:plan.ranges};});
  const result=await page.evaluate(async({code,options,host})=>(0,eval)('('+code+')')(options,null,null,host),{code:runBrowser.toString(),options:{from:new Date(range.from).toISOString(),to:new Date(range.to).toISOString(),delay:1,maxSteps:1000,loginTimeout:1000,deltaTransport:true},host:{id:'filter',created:Date.now()}});
  assert.equal(result.conversations.length,167);assert.equal(result.conversations.filter(c=>c.status==='skipped-out-of-range').length,130);assert.equal((await page.evaluate(()=>opened)).length,37);assert.equal(result.status,'complete');assert.equal((await new Repository(dir).job('filter')).conversations.length,167);assert.ok(received>0);assert.equal(result.metrics.browser.navigationResets,0);
 }finally{await browser.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('動態等待會等 busy 結束並穩定，而非提早讀取',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});try{
  const page=await browser.newPage();await page.setContent(fixture(1));for(const name of ['images.js','dom.js','shared-utils.js'])await page.evaluate(await fs.readFile(path.join(root,name),'utf8'));
  const elapsed=await page.evaluate(async()=>{const pane=document.querySelector('[data-tid=message-pane-list-viewport]');pane.setAttribute('aria-busy','true');setTimeout(()=>pane.removeAttribute('aria-busy'),650);const s=new TeamsChatUtils.Scanner({adaptive:true}),start=Date.now();await s.wait();return Date.now()-start;});assert.ok(elapsed>=900);assert.ok(elapsed<3000);
 }finally{await browser.close();}
});


test('清單排除與真正覆蓋分開保存，既有失敗不能被時間篩選清除',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'teams-screened-'));try{
  const repo=new Repository(dir),job={version:2,id:'screen',account:'test@example.com',status:'running',range,conversations:[{key:'x',name:'x',status:'skipped-out-of-range',messages:[],tasks:[{range,status:'screened',coverageComplete:false,screening:{latest:'2026-10-25T00:00:00Z',observedAt:1,source:'rail-time'}}]}]};
  await repo.save(job);await repo.ingest(job);const c=(await new Repository(dir).library(job.account)).conversations.x;assert.equal(c.coverage.length,0);assert.equal(c.screenedRanges.length,1);assert.equal(c.repairRequired,false);const progress=await repo.progress(job.id);assert.equal(progress.statistics.skipped,1);assert.equal(progress.conversations[0].coverage[0].method,'list-screened');
  job.conversations[0].status='failed';job.conversations[0].error='載入失敗';job.conversations[0].tasks=[{range,status:'partial',coverageComplete:false}];await repo.save(job);await repo.ingest(job);const failed=(await repo.library(job.account)).conversations.x;assert.equal(failed.repairRequired,true);assert.equal(planConversation(failed,{key:'x',latest:'2026-10-25T00:00:00Z'},range,false).skip,false);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('影片自己的載入指示不阻止文字掃描，清單本身 busy 仍須等待',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});try{
  const page=await browser.newPage();await page.setContent(fixture(1));await page.locator('[data-tid=message-pane-list-viewport]').evaluate(e=>{e.innerHTML='<div id="message-body-video"><div role="progressbar" aria-label="Video loading">影片載入中</div></div>';});await page.evaluate(await fs.readFile(path.join(root,'dom.js'),'utf8'));
  assert.equal(await page.evaluate(()=>TeamsChatDOM.readPane().busy),false);await page.locator('[role=progressbar]').evaluate(e=>e.setAttribute('aria-label','Loading message'));assert.equal(await page.evaluate(()=>TeamsChatDOM.readPane().busy),true);await page.locator('[data-tid=message-pane-list-viewport]').evaluate(e=>e.setAttribute('aria-busy','true'));assert.equal(await page.evaluate(()=>TeamsChatDOM.readPane().busy),true);
 }finally{await browser.close();}
});

test('訊息捲動後有最短穩定等待，晚到的長訊息不在300ms就讀取',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});try{
  const page=await browser.newPage();await page.setContent(fixture(1));for(const name of ['dom.js','shared-utils.js'])await page.evaluate(await fs.readFile(path.join(root,name),'utf8'));
  const result=await page.evaluate(async()=>{const pane=document.querySelector('[data-tid=message-pane-list-viewport]');pane.innerHTML='<div id="message-body-delayed">等待內容</div>';setTimeout(()=>pane.querySelector('div').textContent='完整長訊息',500);const s=new TeamsChatUtils.Scanner({adaptive:true});s.waitSurface='messages';const start=Date.now();await s.wait();return {elapsed:Date.now()-start,text:pane.textContent};});assert.ok(result.elapsed>=650);assert.equal(result.text,'完整長訊息');
 }finally{await browser.close();}
});
