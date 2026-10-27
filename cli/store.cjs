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
 const coverage=previous.coverage||[],latest=Math.max(...coverage.map(r=>r.to),-Infinity);
 const fresh={from:Number.isFinite(latest)?Math.max(Math.min(...coverage.map(r=>r.from)),latest-86400000):range.from,to:range.to};
 const gaps=(previous.requests||[]).flatMap(r=>subtract({from:r.from,to:Math.min(r.to,range.to)},coverage));
 // Retry missing images in their original time window, even outside the daily overlap.
 const media=(previous.messages||[]).filter(m=>(m.timestamp===null||m.timestamp<range.to&&(previous.requests||[]).some(r=>inRange(m,r)))&&(m.images||[]).some(i=>i.status!=='saved')).map(m=>m.timestamp===null?fresh:{from:m.timestamp,to:m.timestamp+1});
 return union([fresh,...gaps,...media]);
}
function digest(m){return hash(JSON.stringify([m.sender,m.timestamp,m.rawTime,m.text,m.parent,m.quote,m.attachments,(m.images||[]).map(i=>[i.index,i.identity,i.alt])]));}
function diff(conversations,baseline,jobId){const changes=[];for(const c of conversations){const old=new Map((baseline[c.key]?.messages||[]).filter(m=>m.id).map(m=>[m.id,m]));for(const m of c.messages){if(m.seenInRun!==jobId||!(c.tasks||[{range:{from:-Infinity,to:Infinity}}]).some(t=>inRange(m,t.range)))continue;const before=m.id?old.get(m.id):null;const types=[];if(!m.id)types.push('uncertain');else if(!before)types.push('added');else if(digest(before)!==digest(m))types.push('updated');if((m.images||[]).some(i=>i.identityUncertain)&&!types.includes('uncertain'))types.push('uncertain');if(before&&(m.images||[]).some(i=>i.status==='saved'&&!(before.images||[]).some(b=>b.identity===i.identity&&b.index===i.index&&b.status==='saved')))types.push('images-saved');if(types.length)changes.push({conversationKey:c.key,conversationName:c.name,types,message:m});}}return changes;}
class Repository{
 constructor(root){this.root=path.resolve(root);}
 jobDir(id){if(!/^[a-zA-Z0-9_-]+$/.test(id||''))throw Error('無效工作編號');return path.join(this.root,'jobs',id);}
 async job(id){return read(path.join(this.jobDir(id),'state.json'));}
 async save(job){await atomic(path.join(this.jobDir(job.id),'state.json'),job);await atomic(path.join(this.root,'latest.json'),{id:job.id});}
 async latest(){return (await read(path.join(this.root,'latest.json'),{})).id;}
 async library(account){return read(path.join(this.root,'accounts',hash(account)+'.json'),{version:1,account,conversations:{}});}
 async verifyMedia(library){for(const c of Object.values(library.conversations))for(const m of c.messages)for(const i of m.images||[])if(i.status==='saved'&&!(await this.getImage(i.file))){i.status='failed';i.error='本機圖片快取遺失';}return library;}
 async baseline(job,library){const file=path.join(this.jobDir(job.id),'baseline.json');return read(file).catch(async e=>{if(e.code!=='ENOENT')throw e;await atomic(file,library.conversations);return structuredClone(library.conversations);});}
 async ingest(job){const lib=await this.library(job.account);for(const c of job.conversations){if(job.options?.only&&c.name!==job.options.only)continue;const old=lib.conversations[c.key]||{messages:[],coverage:[],requests:[]};const map=new Map(old.messages.map(m=>[m.key,m]));for(const m of c.messages)if(m.seenInRun===job.id&&(c.tasks||[{range:job.range}]).some(t=>inRange(m,t.range)))map.set(m.key,m);lib.conversations[c.key]={...old,key:c.key,name:c.name,messages:[...map.values()],coverage:union([...(old.coverage||[]),...(c.tasks||[]).filter(t=>t.coverageComplete).map(t=>t.range)]),requests:union([...(old.requests||[]),...(c.tasks||[{range:job.range}]).map(t=>t.range)])};}await atomic(path.join(this.root,'accounts',hash(job.account)+'.json'),lib);return lib;}
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
function summary(job){return {id:job.id,status:job.status,stage:job.stage,account:job.account,range:job.range,pid:job.pid,error:job.error||null,updated:job.updated,warnings:job.warnings||[],conversations:(job.conversations||[]).map(c=>({key:c.key,name:c.name,status:c.status,count:c.messages.filter(m=>(c.tasks||[]).some(t=>inRange(m,t.range))).length,images:c.messages.reduce((n,m)=>n+(m.images||[]).filter(i=>i.status==='saved').length,0),coverage:(c.tasks||[]).map(t=>({range:t.range,complete:!!t.coverageComplete,status:t.status})),warnings:c.warnings,error:c.error||null})),note:'僅反映實際網頁掃描；不保證更早編輯、刪除或獨立討論串變動。'};}
module.exports={Repository,linkImage,atomic,read,lock,alive,union,subtract,planRanges,diff,digest,inRange,summary,hash};
