'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const hash=s=>crypto.createHash('sha256').update(String(s)).digest('hex').slice(0,24);
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
async function atomic(file,value){await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(tmp,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value,null,2)+'\n',{mode:0o600});await fs.rename(tmp,file);}
// Never write through a hard link: cache updates and output replacement use rename.
async function linkImage(source,destination,{link=fs.link,copy=fs.copyFile}={}){
 const original=await fs.lstat(source);if(!original.isFile())throw Error('圖片來源不是一般檔案');
 await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});
 const existing=await fs.lstat(destination).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 if(existing?.isFile()&&existing.dev===original.dev&&existing.ino===original.ino)return 'existing';
 const tmp=destination+'.'+crypto.randomUUID()+'.tmp';let method='hardlink';
 try{
  try{await link(source,tmp);}catch(e){if(!['EXDEV','ENOTSUP','EOPNOTSUPP','ENOSYS'].includes(e.code))throw e;await copy(source,tmp,require('node:fs').constants.COPYFILE_EXCL);method='copy';}
  await fs.rename(tmp,destination);return method;
 }finally{await fs.unlink(tmp).catch(()=>{});}
}
async function read(file,fallback){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT'&&fallback!==undefined)return fallback;throw e;}}
async function lock(dir){
 await fs.mkdir(dir,{recursive:true,mode:0o700});const file=path.join(dir,'.export.lock');
 for(let i=0;i<2;i++){
  let handle;try{handle=await fs.open(file,'wx',0o600);}catch(e){if(e.code!=='EEXIST')throw e;const raw=await fs.readFile(file,'utf8');const pid=Number(raw.trim());if(!Number.isInteger(pid)||pid<=0||alive(pid))throw Error('另一個掃描程序正在執行，或工作鎖尚未寫完');await fs.unlink(file);continue;}
  await handle.writeFile(String(process.pid));return async()=>{await handle.close();if(await fs.readFile(file,'utf8').catch(()=>null)===String(process.pid))await fs.unlink(file);};
 }throw Error('無法取得掃描鎖');
}
const inRange=(m,r)=>m.timestamp===null||(m.timestamp>=r.from&&m.timestamp<r.to);
function union(ranges){const out=[];for(const r of ranges.filter(r=>r.from<r.to).sort((a,b)=>a.from-b.from)){const last=out.at(-1);if(last&&r.from<=last.to)last.to=Math.max(last.to,r.to);else out.push({from:r.from,to:r.to});}return out;}
function subtract(range,covered){let ranges=[range];for(const c of union(covered)){ranges=ranges.flatMap(r=>c.to<=r.from||c.from>=r.to?[r]:[{from:r.from,to:Math.min(r.to,c.from)},{from:Math.max(r.from,c.to),to:r.to}].filter(x=>x.from<x.to));}return ranges;}
function planRanges(previous,range,incremental){
 if(!incremental||!previous)return [{from:range.from,to:range.to}];
 const coverage=union([...(previous.coverage||[]),...(previous.screenedRanges||[]).map(x=>x.range)]),latest=Math.max(...coverage.map(r=>r.to),-Infinity);
 const fresh={from:Number.isFinite(latest)?Math.max(Math.min(...coverage.map(r=>r.from)),latest-86400000):range.from,to:range.to};
 const gaps=(previous.requests||[]).flatMap(r=>subtract({from:r.from,to:Math.min(r.to,range.to)},coverage));
 // Retry missing images in their original time window, even outside the daily overlap.
 const media=(previous.messages||[]).filter(m=>(m.timestamp===null||m.timestamp<range.to&&(previous.requests||[]).some(r=>inRange(m,r)))&&(m.images||[]).some(i=>i.status!=='saved')).map(m=>m.timestamp===null?fresh:{from:m.timestamp,to:m.timestamp+1});
 return union([fresh,...gaps,...media]);
}
function planConversation(previous,c,range,incremental,{fullScan=false,only=false}={}){
 const ranges=planRanges(previous,range,incremental);
 const tasks=c.tasks?.length?structuredClone(c.tasks):ranges.map(range=>({range,status:'pending',coverageComplete:false}));
 const latest=typeof c.latest==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(c.latest)?Date.parse(c.latest):NaN;
 const unfinished=t=>!['complete','screened'].includes(t.status);
 const attempted=!!(c.error||c.cursor||c.status==='failed'||c.tasks?.some(t=>unfinished(t)&&(t.status!=='pending'||t.cursor)));
 const hasMissing=(previous?.messages||[]).some(m=>(m.images||[]).some(i=>i.status!=='saved'));
 const legacyGap=previous&&previous.repairRequired===undefined&&previous.messages?.length&&(previous.requests||[]).some(r=>subtract(r,previous.coverage||[]).length);
 const repairs=attempted||previous?.repairRequired||legacyGap||hasMissing;
 const evidence=[];
 for(const task of tasks){
  if(task.status==='complete')continue;
  if(task.status==='screened')task.status='pending';
  if(!fullScan&&!only&&!repairs&&Number.isFinite(latest)&&latest<task.range.from){task.status='screened';task.coverageComplete=false;task.screening={latest:c.latest,observedAt:c.observedAt||Date.now(),source:'rail-time'};evidence.push({range:task.range,...task.screening});}
 }
 return {ranges,tasks,screenedRanges:evidence,skip:tasks.length>0&&tasks.every(t=>['complete','screened'].includes(t.status)),reason:evidence.length?'latest-before-start':null};
}
function applyPacket(job,packet){
 if(packet?.kind!=='delta-v1')return packet;
 const byKey=new Map((job?.conversations||[]).map(c=>[c.key,c]));
 for(const update of packet.conversations){const old=byKey.get(update.meta.key)||{messages:[]},messages=new Map(old.messages.map(m=>[m.key,m]));for(const m of update.upserts||[])messages.set(m.key,m);byKey.set(update.meta.key,{...old,...update.meta,messages:[...messages.values()]});}
 return {...job,...packet.header,conversations:packet.order.map(key=>{const c=byKey.get(key);if(!c)throw Error('進度封包缺少聊天');return c;})};
}
function digest(m){return hash(JSON.stringify([m.sender,m.timestamp,m.rawTime,m.text,m.parent,m.quote,m.attachments,(m.images||[]).map(i=>[i.index,i.identity,i.alt])]));}
function diff(conversations,baseline,jobId){const changes=[];for(const c of conversations){const old=new Map((baseline[c.key]?.messages||[]).filter(m=>m.id).map(m=>[m.id,m]));for(const m of c.messages){if(m.seenInRun!==jobId||!(c.tasks||[{range:{from:-Infinity,to:Infinity}}]).some(t=>inRange(m,t.range)))continue;const before=m.id?old.get(m.id):null;const types=[];if(!m.id)types.push('uncertain');else if(!before)types.push('added');else if(digest(before)!==digest(m))types.push('updated');if((m.images||[]).some(i=>i.identityUncertain)&&!types.includes('uncertain'))types.push('uncertain');if(before&&(m.images||[]).some(i=>i.status==='saved'&&!(before.images||[]).some(b=>b.identity===i.identity&&b.index===i.index&&b.status==='saved')))types.push('images-saved');if(types.length)changes.push({conversationKey:c.key,conversationName:c.name,types,message:m});}}return changes;}
class Repository{
 constructor(root){this.root=path.resolve(root);this.libraries=new Map();this.serialized=new Map();this.io={writes:0,bytesWritten:0,mediaChecks:0};}
 async write(file,value){const encoded=JSON.stringify(value,null,2)+'\n';if(this.serialized.get(file)===encoded)return;await atomic(file,encoded);this.serialized.set(file,encoded);this.io.writes++;this.io.bytesWritten+=Buffer.byteLength(encoded);}
 jobDir(id){if(!/^[a-zA-Z0-9_-]+$/.test(id||''))throw Error('無效工作編號');return path.join(this.root,'jobs',id);}
 async job(id){const dir=this.jobDir(id),state=await read(path.join(dir,'state.json'));if(state.storage!=='split-v1')return state;const conversations=[];for(const c of state.conversations){if(c.file!==hash(c.key)+'.json')throw Error('無效聊天進度路徑');const file=path.join(dir,'conversations',c.file),value=await read(file);this.serialized.set(file,JSON.stringify(value,null,2)+'\n');conversations.push(value);}delete state.storage;return {...state,conversations};}
 async save(job,{changedKeys=null}={}){
  const dir=this.jobDir(job.id),stateFile=path.join(dir,'state.json');
  const migratedNow=!this.migratedJobs?.has(job.id);
  if(migratedNow){const old=await read(stateFile,null);if(old&&old.storage!=='split-v1')await this.write(path.join(dir,'legacy-state.json'),old);this.migratedJobs||=new Set();this.migratedJobs.add(job.id);}
  const changed=changedKeys&&!migratedNow?new Set(changedKeys):null;
  for(const c of job.conversations)if(!changed||changed.has(c.key))await this.write(path.join(dir,'conversations',hash(c.key)+'.json'),c);
  const manifest={...job,storage:'split-v1',conversations:job.conversations.map(c=>({key:c.key,file:hash(c.key)+'.json'}))};
  await this.write(stateFile,manifest);await this.write(path.join(dir,'progress.json'),summary(job));await this.write(path.join(this.root,'latest.json'),{id:job.id});
 }
 async progress(id){const header=await read(path.join(this.jobDir(id),'state.json')),progress=await read(path.join(this.jobDir(id),'progress.json'),null);return progress&&progress.updated===header.updated&&progress.status===header.status&&progress.pid===header.pid?progress:summary(await this.job(id));}
 async latest(){return (await read(path.join(this.root,'latest.json'),{})).id;}
 async library(account){
  if(this.libraries.has(account))return this.libraries.get(account);
  const index=await read(path.join(this.root,'accounts',hash(account)+'.json'),{version:1,account,conversations:{}});
  if(index.version===2){const loaded={};for(const [key,ref]of Object.entries(index.conversations)){if(ref.file!==hash(key)+'.json')throw Error('無效帳號聊天路徑');const file=path.join(this.root,'accounts',hash(account),ref.file);loaded[key]=await read(file);this.serialized.set(file,JSON.stringify(loaded[key],null,2)+'\n');}index.conversations=loaded;}
  if(index.version===1&&Object.keys(index.conversations).length){
   const records=[];
   for(const entry of await fs.readdir(path.join(this.root,'jobs'),{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){
    if(!entry.isDirectory())continue;const state=await read(path.join(this.root,'jobs',entry.name,'state.json'),null);if(state?.account!==account)continue;
    records.push({state,id:entry.name});
   }
   records.sort((a,b)=>(a.state.updated||a.state.created||0)-(b.state.updated||b.state.created||0));
   for(const r of records){const state=r.state.storage==='split-v1'?await this.job(r.id):r.state;for(const c of state.conversations||[]){const prior=index.conversations[c.key];if(!prior)continue;prior.repairRequired=!!c.error||c.status==='failed'||c.tasks?.some(t=>['running','partial'].includes(t.status))||false;}}
  }
  this.libraries.set(account,index);return index;
 }
 async verifyMedia(library){for(const c of Object.values(library.conversations))for(const m of c.messages)for(const i of m.images||[])if(i.status==='saved'&&!(await this.hasImage(i.file))){i.status='failed';i.error='本機圖片快取遺失';}return library;}
 async baseline(job,library){const file=path.join(this.jobDir(job.id),'baseline.json');return read(file).catch(async e=>{if(e.code!=='ENOENT')throw e;await atomic(file,library.conversations);return structuredClone(library.conversations);});}
 async ingest(job,{changedKeys=null}={}){
  const lib=await this.library(job.account),changed=changedKeys?new Set(changedKeys):null,accountFile=path.join(this.root,'accounts',hash(job.account)+'.json');
  if(lib.version!==2){const old=await read(accountFile,null);if(old)await this.write(accountFile+'.legacy.json',old);for(const c of Object.values(lib.conversations))await this.write(path.join(this.root,'accounts',hash(job.account),hash(c.key)+'.json'),c);lib.version=2;}
  for(const c of job.conversations){
   if(changed&&!changed.has(c.key)||job.options?.only&&c.name!==job.options.only)continue;
   const old=lib.conversations[c.key]||{messages:[],coverage:[],requests:[],screenedRanges:[]};const map=new Map(old.messages.map(m=>[m.key,m]));
   for(const m of c.messages)if(m.seenInRun===job.id&&(c.tasks||[{range:job.range}]).some(t=>inRange(m,t.range)))map.set(m.key,m);
   const tasks=c.tasks||[],screened=tasks.filter(t=>t.status==='screened').map(t=>({range:t.range,...t.screening}));
   const repaired=tasks.length>0&&tasks.every(t=>['complete','screened'].includes(t.status));
   const repairRequired=repaired?false:(old.repairRequired||!!c.error||tasks.some(t=>['running','partial'].includes(t.status)));
   const next={...old,key:c.key,name:c.name,messages:[...map.values()],repairRequired,coverage:union([...(old.coverage||[]),...tasks.filter(t=>t.coverageComplete).map(t=>t.range)]),requests:union([...(old.requests||[]),...(c.tasks||[{range:job.range}]).map(t=>t.range)]),screenedRanges:[...(old.screenedRanges||[]),...screened]};
   // Bound repeated list evidence while retaining distinct inspected ranges.
   next.screenedRanges=[...new Map(next.screenedRanges.map(x=>[x.range.from+':'+x.range.to,x])).values()];
   lib.conversations[c.key]=next;await this.write(path.join(this.root,'accounts',hash(job.account),hash(c.key)+'.json'),next);
  }
  await this.write(accountFile,{version:2,account:job.account,conversations:Object.fromEntries(Object.keys(lib.conversations).map(key=>[key,{file:hash(key)+'.json'}]))});return lib;
 }
 async hasImage(file){this.io.mediaChecks++;try{return (await fs.stat(this.image(file))).isFile();}catch(e){if(e.code==='ENOENT')return false;throw e;}}
 image(file){if(!/^images\/[a-f0-9]{20}_\d+\.png$/.test(file))throw Error('無效圖片檔名');return path.join(this.root,file);}
 async putImage(file,bytes){const existing=await this.getImage(file);if(existing?.equals(bytes))return;await atomic(this.image(file),bytes);}
 async exportImage(file,directory){try{return await linkImage(this.image(file),path.join(directory,file));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async getImage(file){try{return await fs.readFile(this.image(file));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async render(job,baseline,formatText){
  const changes=diff(job.conversations,baseline,job.id),dir=this.jobDir(job.id);const byChat=new Map();
  for(const change of changes){if(!byChat.has(change.conversationKey))byChat.set(change.conversationKey,{key:change.conversationKey,name:change.conversationName,status:'partial',warnings:[],messages:[]});byChat.get(change.conversationKey).messages.push({...change.message,changeTypes:change.types});}
  const view={...job,mode:'changes',conversations:[...byChat.values()]},mediaErrors=[];
  for(const c of view.conversations)for(const m of c.messages)for(const image of m.images||[]){if(image.status!=='saved'||!image.file)continue;const method=await this.exportImage(image.file,dir);if(!method){image.status='failed';image.error='本機圖片快取遺失，請續抓補存';mediaErrors.push({file:image.file,error:image.error});}}
  const report=summary(job);report.mediaErrors=mediaErrors;if(mediaErrors.length)report.status='partial';report.changes={total:changes.length,added:changes.filter(c=>c.types.includes('added')).length,updated:changes.filter(c=>c.types.includes('updated')).length,imagesSaved:changes.filter(c=>c.types.includes('images-saved')).length,uncertain:changes.filter(c=>c.types.includes('uncertain')).length};
  await atomic(path.join(dir,'changes.txt'),changes.length?formatText(view):'本次沒有新增或更新內容。\n');await atomic(path.join(dir,'changes.json'),{jobId:job.id,range:job.range,changes});await atomic(path.join(dir,'report.json'),report);return report;
 }
}
function summary(job){return {id:job.id,status:job.status,stage:job.stage,account:job.account,range:job.range,metrics:job.metrics||{},statistics:{listed:job.conversations?.length||0,skipped:(job.conversations||[]).filter(c=>c.status==='skipped-out-of-range').length,opened:(job.conversations||[]).filter(c=>c.opened).length,completed:(job.conversations||[]).filter(c=>c.status==='complete').length,failed:(job.conversations||[]).filter(c=>c.status==='failed').length,repairPending:(job.conversations||[]).filter(c=>c.status==='failed'||c.tasks?.some(t=>['running','partial'].includes(t.status))).length,pending:(job.conversations||[]).filter(c=>['pending','running'].includes(c.status)).length},pid:job.pid,error:job.error||null,updated:job.updated,warnings:job.warnings||[],conversations:(job.conversations||[]).map(c=>({key:c.key,name:c.name,status:c.status,screening:c.screening||null,count:c.messages.filter(m=>(c.tasks||[]).some(t=>inRange(m,t.range))).length,images:c.messages.reduce((n,m)=>n+(m.images||[]).filter(i=>i.status==='saved').length,0),coverage:(c.tasks||[]).map(t=>({range:t.range,complete:!!t.coverageComplete,status:t.status,method:t.status==='screened'?'list-screened':t.coverageComplete?'dom':'unconfirmed',screening:t.screening||null})),warnings:c.warnings,error:c.error||null})),note:'含依清單時間篩選的項目；list-screened 與實際 DOM 覆蓋分開列出。完整檢查可用 --full-scan；不保證更早編輯、刪除或獨立討論串變動。'};}
module.exports={Repository,linkImage,atomic,read,lock,alive,union,subtract,planRanges,planConversation,applyPacket,diff,digest,inRange,summary,hash};
