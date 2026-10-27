const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const {Repository,atomic,lock,planRanges,diff,subtract}=require('../cli/store.cjs');
const {parse,range}=require('../cli/teams-dump.cjs');
const exec=promisify(execFile),root=path.resolve(__dirname,'..');
const day=86400000;
const message=(id,time,text='相同內容')=>({id,key:'id:'+id,timestamp:time,sender:'作者',text,attachments:[],images:[],seenInRun:'run'});

test('增量以每個聊天的成功區段回讀一天，補較早缺口及失敗圖片',()=>{
 const prior={coverage:[{from:0,to:5*day}],requests:[{from:0,to:7*day}],messages:[{timestamp:day,images:[{status:'failed'}]}]};
 assert.deepEqual(planRanges(prior,{from:8*day,to:9*day},true),[{from:day,to:day+1},{from:4*day,to:9*day}]);
 assert.deepEqual(planRanges(null,{from:8*day,to:9*day},true),[{from:8*day,to:9*day}]);
 assert.deepEqual(subtract({from:0,to:9},[{from:2,to:3},{from:5,to:8}]),[{from:0,to:2},{from:3,to:5},{from:8,to:9}]);
});

test('新增、同字不同 ID、更新、補圖、未知識別與無變動各自判讀',()=>{
 const old=message('a',100),now={...old,images:[{index:0,identity:'x',status:'saved',file:'images/123.png'}]};
 const baseline={chat:{messages:[{...old,images:[{index:0,identity:'x',status:'failed'}]},message('b',101)]}};
 const c={key:'chat',name:'聊天',tasks:[{range:{from:100,to:200}}],messages:[now,{...message('b',101),text:'已編輯'},message('c',102),{...message(null,null),key:'uncertain:1'},message('end',200)]};
 const result=diff([c],baseline,'run');assert.equal(result.length,4);assert.deepEqual(result[0].types,['images-saved']);assert.deepEqual(result[1].types,['updated']);assert.deepEqual(result[2].types,['added']);assert.deepEqual(result[3].types,['uncertain']);
 assert.equal(diff([{...c,messages:[old]}],{chat:{messages:[old]}},'run').length,0);
});

test('原子存檔、累積去重、失敗不推進覆蓋、結果及圖片可搬移',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'teams-cli-'));try{
  const repo=new Repository(temp),m=message('a',100);m.images=[{identity:'img',index:0,status:'saved',file:'images/0123456789abcdef0123_1.png'}];await repo.putImage(m.images[0].file,Buffer.from('png-test'));
  const job={id:'run',account:'a@example.com',status:'partial',stage:'test',mode:'range',range:{from:100,to:200},discovery:{status:'complete'},warnings:[],conversations:[{key:'c',name:'聊天',status:'partial',warnings:[],messages:[m],tasks:[{range:{from:100,to:200},status:'partial',coverageComplete:false}]}]};
  await repo.save(job);const base=await repo.baseline(job,await repo.library(job.account));await repo.ingest(job);assert.equal((await repo.library(job.account)).conversations.c.coverage.length,0);
  job.conversations[0].tasks[0].coverageComplete=true;await repo.ingest(job);await repo.ingest(job);const lib=await repo.library(job.account);assert.equal(lib.conversations.c.messages.length,1);assert.deepEqual(lib.conversations.c.coverage,[{from:100,to:200}]);
  await repo.render(job,base,require('../cli/text.cjs').format);const text=await fs.readFile(path.join(repo.jobDir('run'),'changes.txt'),'utf8');assert.match(text,/images\/0123/);assert.doesNotMatch(text,/本次匯出目前聊天全部歷史/);assert.equal((await fs.readFile(path.join(repo.jobDir('run'),m.images[0].file))).toString(),'png-test');
  await assert.rejects(()=>repo.putImage('../escape',Buffer.from('x')),/圖片檔名/);
  const release=await lock(temp);try{await assert.rejects(()=>lock(temp),/另一個/);}finally{await release();}
  await fs.writeFile(path.join(temp,'.export.lock'),'2147483646');const staleRelease=await lock(temp);await staleRelease();
  const mode=(await fs.stat(path.join(repo.jobDir('run'),'state.json'))).mode&0o777;assert.equal(mode,0o600);
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});

test('CLI 日期、JSON 狀態、程序死亡、停止與保留固定時段',async()=>{
 assert.equal((await range({from:'2026-10-26 09:00',to:'2026-10-27 09:00'})).to,Date.parse('2026-10-27T01:00Z'));assert.throws(()=>parse(['resume','abc','--from','2026-10-26 09:00']));
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'teams-cli-'));try{
  const repo=new Repository(temp);await repo.save({id:'stale',status:'running',pid:2147483646,range:{from:1,to:2},conversations:[],warnings:[]});
  const result=JSON.parse((await exec(process.execPath,[path.join(root,'cli/teams-dump.cjs'),'status','--data',temp,'--json'])).stdout);assert.equal(result.status,'interrupted');assert.equal(result.running,false);
  await exec(process.execPath,[path.join(root,'cli/teams-dump.cjs'),'stop','stale','--data',temp,'--json']);assert.equal(JSON.parse(await fs.readFile(path.join(repo.jobDir('stale'),'control.json'))).stop,true);
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});

const {chromium}=require('playwright'),{runBrowser}=require('../cli/browser.cjs');
const chat='fixture';
const domMessage=(id,time,text)=>`<div><span id="author-${id}">作者</span><time id="timestamp-${id}" datetime="${time}"></time><div id="message-body-${id}"><div id="content-${id}">${text}</div></div></div>`;
const shell=messages=>`<style>[role=tree]{height:100px;overflow:auto}[data-tid=message-pane-list-viewport]{height:200px;overflow:auto}[id^=message-body]{min-height:100px}</style><button data-tid="me-control-avatar-trigger" aria-label="fixture@example.com"></button><div role="tree"><div role="treeitem" data-item-type="chat" data-fui-tree-item-value="chat|fixture"><span id="title-chat-list-item_fixture">測試</span></div></div><div id="chat-header-fixture"><h2 data-tid="chat-title">測試</h2></div><div data-tid="app-layout-area--main"><div data-tid="message-pane-list-viewport">${messages}</div></div>`;

test('指令共用引擎連續更新不重複、保留變更，圖片快取遺失可補抓',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'teams-cli-browser-')),browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage(),repo=new Repository(temp);await page.route('https://teams.cloud.microsoft/**',r=>r.fulfill({body:'<html></html>',contentType:'text/html'}));await page.goto('https://teams.cloud.microsoft/');
  let active,base,imageWrites=0;
  await page.exposeBinding('teamsLocalSave',async(_s,j)=>{active=j;await repo.save(j);await repo.ingest(j);return {stop:false};});
  await page.exposeBinding('teamsLocalPlan',async(_s,{key,range,incremental})=>{const prior=(await repo.library('fixture@example.com')).conversations[key];const ranges=planRanges(prior,range,incremental);return {ranges,messages:structuredClone(prior?.messages||[])};});
  await page.exposeBinding('teamsLocalImage',async(_s,{op,file,data})=>{if(op==='put'){imageWrites++;await repo.putImage(file,Buffer.from(data,'base64'));return true;}return (await repo.getImage(file))?.toString('base64')||null;});
  await page.exposeBinding('teamsLocalScreenshot',async()=>{throw Error('不應需要畫面擷取');});
  const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=80;c.height=80;c.getContext('2d').fillRect(0,0,80,80);return c.toDataURL();});
  async function perform(id,html,saved=null){
   await page.setContent(shell(domMessage('old','2026-10-24T00:00Z','邊界')+html+domMessage('future','2026-10-29T00:00Z',`不在範圍<img width=80 height=80 src="${png}">`)));await page.locator('img').evaluateAll(async elements=>{for(const e of elements){await e.decode();const c=document.createElement('canvas');c.width=e.naturalWidth;c.height=e.naturalHeight;c.getContext('2d').drawImage(e,0,0);e.src=URL.createObjectURL(await new Promise(r=>c.toBlob(r)));await e.decode();}});for(const f of ['images.js','dom.js','shared-utils.js','export-formats.js'])await page.evaluate(await fs.readFile(path.join(root,f),'utf8'));
   base=await repo.baseline({id},await repo.library('fixture@example.com'));
   const result=await page.evaluate(async({code,options,saved,host})=>(0,eval)('('+code+')')(options,saved,null,host),{code:runBrowser.toString(),options:{command:'update',from:'2026-10-25T00:00:00Z',to:'2026-10-28T00:00:00Z',delay:5,maxSteps:50,loginTimeout:1000},saved,host:{id,created:Date.now()}});
   return {job:result,changes:diff(result.conversations,base,id)};
  }
  const html=domMessage('a','2026-10-27T00:00Z',`中文<br>多行<img width="80" height="80" src="${png}">`);
  const first=await perform('first',html);assert.equal(first.job.status,'complete');assert.equal(first.changes.length,1);assert.equal(first.changes[0].message.images[0].status,'saved');assert.equal(imageWrites,1);assert.equal((await repo.library('fixture@example.com')).conversations.fixture.messages.length,1);
  const second=await perform('second',html+domMessage('b','2026-10-27T01:00Z','中文'));assert.equal(second.changes.length,1);assert.equal(second.changes[0].message.id,'b');assert.equal(imageWrites,1);
  const third=await perform('third',html+domMessage('b','2026-10-27T01:00Z','編輯後'));assert.deepEqual(third.changes[0].types,['updated']);
  const fourth=await perform('fourth',html+domMessage('b','2026-10-27T01:00Z','編輯後'));assert.equal(fourth.changes.length,0);
  const file=first.changes[0].message.images[0].file;await fs.unlink(repo.image(file));const fifth=await perform('fifth',html,fourth.job);assert.ok(await repo.getImage(file));assert.equal(fifth.job.conversations[0].tasks[0].coverageComplete,true);
 }finally{await browser.close();await fs.rm(temp,{recursive:true,force:true});}
});

test('主機工作流程可停止、固定時段續抓，並回報登入等待與帳號不符',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'teams-runner-')),browser=await chromium.launch({channel:'chrome',headless:true});
 const {run}=require('../cli/runner.cjs');
 try{
  const repo=new Repository(temp);const opts={deltaTransport:true,adaptive:false,command:'update',from:'2026-10-26T00:00:00Z',to:'2026-10-28T00:00:00Z',delay:200,maxSteps:20,loginTimeout:1000,profile:path.join(temp,'profile')};
  const makeJob=id=>({version:1,id,created:Date.now(),status:'queued',range:{from:Date.parse(opts.from),to:Date.parse(opts.to)},account:null,conversations:[],options:opts,warnings:[]});
  const launch=async()=>{const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.route('https://teams.cloud.microsoft/**',r=>r.fulfill({body:shell(domMessage('old','2026-10-25T00:00Z','界線')+domMessage('a','2026-10-27T00:00Z','訊息')),contentType:'text/html'}));return context;};
  await repo.save(makeJob('stop-test'));const promise=run(repo,'stop-test',opts,{launch,lockDirectory:path.join(temp,'worker-lock')});
  // Let the scanner persist a real checkpoint, then request a graceful stop.
  for(let i=0;i<100;i++){const j=await repo.job('stop-test');if(j.version===2&&j.conversations.some(c=>c.messages.length)){await atomic(path.join(repo.jobDir(j.id),'control.json'),{stop:true});break;}await new Promise(r=>setTimeout(r,50));}
  const stopped=await promise;assert.equal(stopped.status,'interrupted');assert.equal(stopped.options.from,opts.from);
  await fs.rm(path.join(repo.jobDir(stopped.id),'control.json'),{force:true});const resumed=await run(repo,stopped.id,stopped.options,{launch,lockDirectory:path.join(temp,'worker-lock')});assert.equal(resumed.status,'complete');assert.deepEqual(resumed.range,stopped.range);assert.equal(resumed.conversations[0].messages.filter(m=>m.id==='a').length,1);
  const report=JSON.parse(await fs.readFile(path.join(repo.jobDir(resumed.id),'report.json'),'utf8'));assert.equal(report.changes.added,1);
  const wrong=structuredClone(resumed);wrong.id='wrong-account';wrong.account='other@example.com';await repo.save(wrong);const rejected=await run(repo,wrong.id,opts,{launch,lockDirectory:path.join(temp,'worker-lock')});assert.equal(rejected.status,'failed');assert.match(rejected.error,/帳號/);
  const waiting=makeJob('waiting');await repo.save(waiting);const noLogin=async()=>{const ctx=await browser.newContext();await ctx.route('https://teams.cloud.microsoft/**',r=>r.fulfill({body:'<html>登入</html>'}));return ctx;};const expired=await run(repo,waiting.id,{...opts,loginTimeout:50},{launch:noLogin,lockDirectory:path.join(temp,'worker-lock')});assert.equal(expired.status,'failed');assert.match(expired.error,/登入逾時/);
 }finally{await browser.close();await fs.rm(temp,{recursive:true,force:true});}
});
