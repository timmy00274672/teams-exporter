'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {chromium}=require('playwright');
const {read,lock,planRanges,inRange,alive}=require('./store.cjs');
const {runBrowser}=require('./browser.cjs');
const root=path.resolve(__dirname,'..');
const sources=['images.js','dom.js','shared-utils.js','export-formats.js'];
async function run(repo,id,options,{launch=(profile,settings)=>chromium.launchPersistentContext(profile,settings),lockDirectory=path.join(root,'.local/run-lock')}={}){
 let job=await repo.job(id),release;try{release=await lock(lockDirectory);}catch(e){if(job.pid&&alive(job.pid))throw e;job.status='failed';job.error=e.message;job.pid=null;await repo.save(job);await repo.render(job,{},require('./text.cjs').format);return job;}
 const originalOptions=job.options,originalCreated=job.created;let releaseProfile,context,timer,baseline;
 let stopping=false,saveChain=Promise.resolve();
 const stop=()=>{stopping=true;};process.on('SIGINT',stop);process.on('SIGTERM',stop);
 const save=async state=>{
  job={...state,options:originalOptions,pid:process.pid,created:originalCreated};
  await repo.save(job);if(job.account){if(!baseline)baseline=await repo.baseline(job,await repo.library(job.account));await repo.ingest(job);}return {stop:stopping};
 };
 const format=require('./text.cjs').format;
 try{
  const profile=path.resolve(options.profile||path.join(repo.root,'chrome-profile'));await fs.mkdir(profile,{recursive:true,mode:0o700});
  releaseProfile=await lock(path.dirname(profile));
  job.pid=process.pid;job.status='waiting-login';job.stage='開啟專用瀏覽器，等待登入';await repo.save(job);
  context=await launch(profile,{channel:'chrome',headless:false,timezoneId:'Asia/Taipei',viewport:{width:1440,height:1000},acceptDownloads:false});
  const page=context.pages()[0]||await context.newPage();
  const trusted=source=>{if(source&&source.frame!==page.mainFrame())return false;const u=new URL(page.url());return u.protocol==='https:'&&['teams.microsoft.com','teams.cloud.microsoft','teams.live.com'].includes(u.hostname);};
  await page.exposeBinding('teamsLocalSave',async(_source,state)=>{if(!trusted(_source))throw Error('非 Teams 頁面');saveChain=saveChain.then(()=>save(state));return saveChain;});
  await page.exposeBinding('teamsLocalPlan',async(_source,{key,range,incremental})=>{
   if(!trusted(_source))throw Error('非 Teams 頁面');const lib=await repo.verifyMedia(await repo.library(job.account)),prior=lib.conversations[key];const ranges=planRanges(prior,range,incremental);
   const messages=structuredClone((prior?.messages||[]).filter(m=>ranges.some(r=>inRange(m,r))));
   for(const m of messages)for(const i of m.images||[])if(i.status==='saved'&&!(await repo.getImage(i.file))){i.status='failed';i.error='本機圖片快取遺失';}
   return {ranges,messages};
  });
  await page.exposeBinding('teamsLocalImage',async(_source,{op,file,data})=>{if(!trusted(_source))throw Error('非 Teams 頁面');if(op==='put'){if(typeof data!=='string'||data.length>150000000)throw Error('圖片過大');await repo.putImage(file,Buffer.from(data,'base64'));return true;}if(op!=='get')throw Error('無效圖片操作');return (await repo.getImage(file))?.toString('base64')||null;});
  await page.exposeBinding('teamsLocalScreenshot',async(_source,r)=>{
   if(!trusted(_source))throw Error('非 Teams 頁面');const size=page.viewportSize();if(!r||![r.x,r.y,r.width,r.height].every(Number.isFinite)||r.width<=0||r.height<=0||r.x<0||r.y<0||r.x+r.width>size.width+1||r.y+r.height>size.height+1)throw Error('圖片裁切區域無效');
   const bytes=await page.screenshot({type:'png',clip:{x:r.x,y:r.y,width:r.width,height:r.height}});if(!trusted(_source))throw Error('擷取期間分頁已離開 Teams');return bytes.toString('base64');
  });
  timer=setInterval(async()=>{try{if(await read(path.join(repo.jobDir(id),'control.json'),{}).then(x=>x.stop))stopping=true;if(stopping)await page.evaluate(()=>globalThis.teamsLocalScanner?.stop());}catch{}},500);
  await page.goto('https://teams.cloud.microsoft/',{waitUntil:'domcontentloaded',timeout:60000});
  let lastNavigationError=null,deadline=Date.now()+options.loginTimeout;
  while(true){
   if(stopping){job.status='interrupted';job.stage='已停止，進度已保存';break;}
   try{
    if(!trusted())throw Error('等待 Teams 登入');
    for(const source of sources)await page.evaluate(await fs.readFile(path.join(root,source),'utf8'));
    const identity=await page.evaluate(async()=>{try{return await TeamsChatUtils.identify();}catch{return null;}});
    if(!identity)throw Error('等待 Teams 登入');
    if(job.account&&job.account!==identity)throw Error('登入帳號與工作不同');
    job.account=identity;baseline=await repo.baseline(job,await repo.verifyMedia(await repo.library(identity)));
    if(options.login){job.status='complete';job.stage='登入狀態已保存';await repo.save(job);break;}
    const saved=job.version===2?structuredClone(job):null;
    job=await page.evaluate(async({code,options,saved,host})=>{const run=(0,eval)('('+code+')');return run(options,saved,null,host);},{code:runBrowser.toString(),options,saved,host:{id,created:job.created}});
    await save(job);break;
   }catch(e){
    if(/帳號/.test(e.message))throw e;
    if(page.isClosed())throw Error('專用瀏覽器已關閉；進度保留，可續抓');
    if(!/等待 Teams 登入|Execution context was destroyed|Cannot find context|navigation|frame was detached/i.test(e.message))throw e;
    lastNavigationError=e;if(job.status!=='waiting-login')deadline=Date.now()+options.loginTimeout;job.status='waiting-login';job.stage='請在專用視窗登入 Teams';await repo.save(job);
    if(Date.now()>deadline)throw Error('等待登入逾時，進度已保存：'+lastNavigationError.message);
    await new Promise(r=>setTimeout(r,1000));
   }
  }
 }catch(e){job.status=stopping?'interrupted':'failed';job.error=e.message;}
 finally{
  clearInterval(timer);await saveChain.catch(()=>{});
  try{job.pid=null;job.updated=Date.now();job.options=originalOptions;await repo.save(job);
   if(job.account){baseline||=await repo.baseline(job,await repo.library(job.account));await repo.ingest(job);}
   const report=await repo.render(job,baseline||{},format);if(report.status!==job.status){job.status=report.status;await repo.save(job);}
  }catch(e){job.status='failed';job.error='保存輸出失敗：'+e.message;await repo.save(job).catch(()=>{});}
  finally{await context?.close().catch(()=>{});await releaseProfile?.();await release();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
 }
 return job;
}
module.exports={run};
