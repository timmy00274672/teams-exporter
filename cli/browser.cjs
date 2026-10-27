/* Runs inside the Teams page; only rendered DOM is inspected. */
async function runBrowser(options,saved,library,host){
 const u=globalThis.TeamsChatUtils,images=globalThis.TeamsChatImages;
 const provider={async capture(rectangle){const r=await globalThis.teamsLocalScreenshot(rectangle());return images.blobFromDataURL('data:image/png;base64,'+r);}};
 const mediaStore={async put(_job,file,blob){const bytes=new Uint8Array(await blob.arrayBuffer());let data='';for(let i=0;i<bytes.length;i+=8192)data+=String.fromCharCode(...bytes.subarray(i,i+8192));await globalThis.teamsLocalImage({op:'put',file,data:btoa(data)});},async get(_job,file){const data=await globalThis.teamsLocalImage({op:'get',file});return data?images.blobFromDataURL('data:image/png;base64,'+data):null;}};
 const scanner=new u.Scanner({delay:options.delay,maxSteps:options.maxSteps,loginTimeout:options.loginTimeout,captureProvider:provider,mediaStore,save:async job=>{const result=await globalThis.teamsLocalSave(job);if(result.stop)scanner.stop();}});
 globalThis.teamsLocalScanner=scanner;
 // Task planning is calculated by the host from durable coverage, not from rail timestamps.
 const originalNew=scanner.newConversation.bind(scanner);
 scanner.newConversation=c=>({...originalNew(c),messages:[],tasks:null});
 const originalScan=scanner.scan.bind(scanner);
 scanner.scan=async c=>{
  if(!c.tasks){const plan=await globalThis.teamsLocalPlan({key:c.key,range:scanner.job.range,incremental:options.command==='update'});c.tasks=plan.ranges.map(range=>({range,status:'pending',coverageComplete:false}));c.messages=plan.messages;}
  let warnings=[],allCovered=true;
  for(const task of c.tasks){
   scanner.check();if(task.status==='complete'){warnings.push(...(task.warnings||[]));continue;}
   c.scanRange=task.range;c.cursor=task.cursor||null;c.traversal={};c.warnings=[];
   task.status='running';await scanner.persist();
   try{
    await originalScan(c);
    task.traversal=structuredClone(c.traversal);task.coverageComplete=!!c.traversal.upper&&['crossed-range-start','explicit-start','explicit-empty'].includes(c.traversal.lower);
    const missing=c.messages.some(m=>(m.timestamp===null||m.timestamp>=task.range.from&&m.timestamp<task.range.to)&&(m.images||[]).some(i=>i.status!=='saved'));
    task.status=task.coverageComplete&&!missing?'complete':'partial';task.warnings=[...c.warnings];task.cursor=null;
   }finally{if(task.status==='running')task.cursor=c.cursor;await scanner.persist();}
   warnings.push(...c.warnings);allCovered=allCovered&&task.coverageComplete;
  }
  c.warnings=[...new Set(warnings)];c.status=allCovered&&c.tasks.every(t=>t.status==='complete')&&!c.warnings.length?'complete':'partial';delete c.scanRange;
 };
 // Every persisted up-scroll checkpoint retains a stable DOM anchor for positioning on resume.
 const persist=scanner.persist.bind(scanner);
 scanner.persist=async()=>{if(scanner.job)for(const c of scanner.job.conversations||[]){const task=c.tasks?.find(t=>t.status==='running');if(task&&c.cursor)task.cursor=c.cursor;}return persist();};
  if(options.only){const discover=scanner.discover.bind(scanner);scanner.discover=async()=>{await discover();const matched=scanner.job.conversations.filter(c=>c.name===options.only);if(matched.length!==1)throw Error('--only 必須唯一對應聊天名稱');scanner.job.conversations=matched;scanner.job.discovery={status:'partial',warning:'僅掃描指定聊天'};};}
 await u.identify();
 if(saved){
  // A completed task with missing local image bytes must be rescanned for repair.
  for(const c of saved.conversations)for(const m of c.messages)for(const image of m.images||[]){if(image.status==='saved'&&!(await mediaStore.get(saved.id,image.file))){image.status='failed';image.error='本機圖片快取遺失';for(const t of c.tasks||[])if(m.timestamp===null||m.timestamp>=t.range.from&&m.timestamp<t.range.to){t.status='pending';t.cursor=null;}c.status='pending';}}
  await scanner.resume(saved);
 }else{
  const {a,mode,scope,initial,range}=u.prepare({...options,scope:'all',mode:'range'});
  scanner.job={version:2,id:host.id,created:host.created,account:a,range,scope,mode,captureImages:true,status:'running',stage:'準備中',discovery:{status:'pending'},warnings:['僅掃描可透過網頁列舉的聊天；所有頻道排除。'],conversations:initial.map(c=>scanner.newConversation(c))};
  await scanner.execute();
 }
 return scanner.job;
}
module.exports={runBrowser};
