/* Local DOM-only scanner. No fetch/XHR, tokens, application stores or remote selectors. */
(function(root){
'use strict';
const {readMessages,readRail,readPane}=root.TeamsChatDOM;
const validHost=host=>['teams.microsoft.com','teams.cloud.microsoft','teams.live.com'].includes(host);
const knownTime=value=> typeof value==='string' && /(Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
function parseDate(value){
 const local=/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/.exec(value||'');
 const input=local?`${local[1]}T${local[2]}:${local[3]||'00'}+08:00`:value;
 if(!knownTime(input))throw Error('請輸入有效日期時間；未帶時區時使用台北時間');
 const t=Date.parse(input);
 if(local && new Date(t+28800000).toISOString().slice(0,19)!==`${local[1]}T${local[2]}:${local[3]||'00'}`)throw Error('日期時間無效');
 if(!local){const d=new Date(value.slice(0,10)+'T00:00:00Z');if(d.toISOString().slice(0,10)!==value.slice(0,10))throw Error('日期無效');}
 return t;
}
function makeRange(input={},now=Date.now()){
 const to=input.to?parseDate(input.to):now;
 const from=input.from?parseDate(input.from):to-86400000;
 if(from>=to)throw Error('開始時間必須早於結束時間');
 return {from,to,timezone:'Asia/Taipei'};
}
function current(){
 const pane=readPane();
 if(!pane.headerId)throw Error('請先開啟一個 Teams 聊天；此版本略過頻道');
 return {key:pane.headerId.slice('chat-header-'.length),name:pane.title||'未命名聊天',type:'chat'};
}
let verifiedProfile=null;
const emailFrom=text=>text?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase()||null;
function profile(){const trigger=document.querySelector('[data-tid="me-control-avatar-trigger"]');const avatar=document.querySelector('[data-tid="me-control-avatar"]');return {trigger,fingerprint:(avatar?.getAttribute('aria-label')||'')+'|'+(trigger?.innerText||'')};}
function account(){
 const p=profile();if(!p.trigger||!p.trigger.getClientRects().length)return null;
 const dialog=document.querySelector('[data-tid="me-control-menu-dialog"]');
 const email=emailFrom(p.trigger.getAttribute('aria-label'))||(dialog?.getClientRects().length?emailFrom(dialog.innerText):null);
 if(email){verifiedProfile={...p,email};return email;}
 return verifiedProfile?.trigger===p.trigger&&verifiedProfile.fingerprint===p.fingerprint?verifiedProfile.email:null;
}
async function identify(){
 const p=profile();if(!p.trigger)throw Error('請先登入 Teams 並等待聊天介面載入');
 const direct=emailFrom(p.trigger.getAttribute('aria-label'));if(direct){verifiedProfile={...p,email:direct};return direct;}
 const alreadyOpen=!!document.querySelector('[data-tid="me-control-menu-dialog"]')?.getClientRects().length;
 if(!alreadyOpen)p.trigger.click();
 try{for(let i=0;i<25;i++){const dialog=document.querySelector('[data-tid="me-control-menu-dialog"]');const email=dialog?.getClientRects().length?emailFrom(dialog.innerText):null;if(email){verifiedProfile={...profile(),email};return email;}await new Promise(r=>setTimeout(r,200));}throw Error('無法從帳號面板確認登入帳號');}
 finally{if(!alreadyOpen&&document.querySelector('[data-tid="me-control-menu-dialog"]')?.getClientRects().length)p.trigger.click();}
}
function matches(c,query){return [...document.querySelectorAll(query)].filter(e=>e.getClientRects().length);}
function tree(){return matches(null,'[role="tree"]')[0];}
function item(value){return [...document.querySelectorAll('[role="treeitem"]')].find(e=>e.getAttribute('data-fui-tree-item-value')===value);}
function expand(value){const e=item(value);if(!e)throw Error('清單資料夾已變更');e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',code:'ArrowRight',bubbles:true}));}
function buttonText(e){return (e.getAttribute('aria-label')||e.innerText||'').trim();}
const stopped=()=>Object.assign(Error('已停止，可續抓'),{stopped:true});
function prepare(input={}){
 if(!validHost(location.hostname))throw Error('此網頁不是支援的 Teams 網址');
  const a=account();if(!a)throw Error('請先登入 Teams 並等待聊天介面載入');
  if(!['current','all'].includes(input.scope||'all')||!['range','visible','history'].includes(input.mode||'range'))throw Error('不支援的掃描範圍');
  const mode=input.mode||'range',scope=mode==='range'?(input.scope||'all'):'current';
  const initial=scope==='current'?[current()]:[];
 return {a,mode,scope,initial,range:makeRange(input)};
}
class Scanner{
 constructor({save=async()=>{},delay=900,maxSteps=2000,onUpdate=()=>{},loginTimeout=600000,captureProvider=null,mediaStore=null}={}){Object.assign(this,{save,delay,maxSteps,onUpdate,loginTimeout,captureProvider});this.mediaStore=mediaStore||(root.TeamsChatImages?new root.TeamsChatImages.MediaStore():null);this.job=null;this.running=false;this.cancelled=false;this.sequence=0;}
 check(){if(this.cancelled)throw stopped();}
 async wait(){this.check();await new Promise(r=>setTimeout(r,this.delay));this.check();}
 summary(){if(!this.job)return null;const j=this.job;return {id:j.id,status:j.status,stage:j.stage,range:j.range,scope:j.scope,mode:j.mode,account:j.account,conversations:j.conversations.map(c=>({key:c.key,name:c.name,status:c.status,count:this.selected(c).length,warnings:c.warnings,error:c.error})),count:j.conversations.reduce((n,c)=>n+this.selected(c).length,0),captureImages:j.captureImages,imageCount:j.conversations.reduce((n,c)=>n+this.selected(c).reduce((sum,m)=>sum+(m.images||[]).filter(i=>i.status==='saved').length,0),0),warnings:j.warnings,error:j.error,updated:j.updated};}
 async persist(){if(!this.job)return;this.job.updated=Date.now();this.onUpdate(this.summary());await this.save(this.job);}
 selected(c){const range=c.scanRange||this.job.range;return c.messages.filter(m=>m.timestamp===null || this.job.mode==='history'||(m.timestamp>=range.from&&m.timestamp<range.to));}
 async auth(){
  const end=Date.now()+this.loginTimeout;
  while(Date.now()<end){this.check();let a=account();if(!a&&profile().trigger){try{a=await identify();}catch{}}if(a){if(a!==this.job.account)throw Error('登入帳號與此匯出不同，已停止');if(this.job.status==='waiting-login'){this.job.status='running';await this.persist();}return;}
   if(this.job.status!=='waiting-login'){this.job.status='waiting-login';await this.persist();}await this.wait();
  }throw Error('等待登入逾時，進度已保留');
 }
 async start(input={}){
  if(this.running)throw Error('已有掃描正在執行');
  this.running=true;this.cancelled=false;
  let prepared;try{await identify();this.check();prepared=prepare(input);if(input.captureImages&&!this.captureProvider)throw Error('請先啟用圖片擷取，並選擇此 Teams 分頁');}catch(e){this.running=false;throw e;}
  const {a,mode,scope,initial,range}=prepared;
  const conversations=initial.map(c=>this.newConversation(c));
  this.job={version:2,id:crypto.randomUUID(),created:Date.now(),account:a,range,scope,mode,captureImages:!!input.captureImages,status:'running',stage:'準備中',discovery:{status:'pending'},warnings:['僅掃描網頁可列舉的聊天；隱藏／封存內容可能不在清單中。','所有頻道依需求排除。'],conversations};
  await this.execute();return this.job;
 }
 newConversation(c){return {...c,status:'pending',messages:[],warnings:[],traversal:{},attempts:0};}
 async resume(job,options={}){
  if(this.running)throw Error('已有掃描正在執行');
  if(!job||job.version!==2)throw Error('沒有可續抓的工作');
  this.running=true;this.cancelled=false;
  try{await identify();this.check();if(account()!==job.account)throw Error('目前登入帳號與進度不同');if((job.captureImages||options.captureImages)&&!this.captureProvider)throw Error('原工作需要圖片擷取，請啟用並選擇此 Teams 分頁後續抓');}catch(e){this.running=false;throw e;}
  this.job=structuredClone(job);this.sequence=this.job.conversations.reduce((max,c)=>c.messages.reduce((n,m)=>m.id?n:Math.max(n,Number(m.key.split(':').at(-1))||0),max),this.sequence);if(options.captureImages&&!this.job.captureImages){this.job.captureImages=true;for(const c of this.job.conversations)if(c.status==='complete')c.status='pending';}await this.execute();return this.job;
 }
 stop(){this.cancelled=true;}
 async rail(){
  const buttons=matches(null,'[data-tid="app-bar-wrapper"] button');
  const chat=buttons.find(e=>/^(Chat|聊天)$/i.test(buttonText(e)));
  if(chat)chat.click();
  for(let i=0;i<40&&!tree();i++)await this.wait();
  if(!tree())throw Error('找不到聊天清單，可能尚未載入或 Teams 已改版');
  const filters=matches(null,'[role="toolbar"] [role="checkbox"][aria-checked="true"], [role="toolbar"] [aria-pressed="true"]');
  for(const f of filters)if(/^(Unread|Chats|Meeting chats|未讀|聊天|會議聊天|未读|会议聊天)$/i.test(buttonText(f))){f.click();await this.wait();}
  const search=matches(null,'input').find(e=>/^(Filter by name|依名稱篩選|按名称筛选)$/i.test(e.getAttribute('placeholder')||''));
  if(search?.value)throw Error('請先清除聊天清單的名稱篩選再掃描');
  tree().scrollTop=0;await this.wait();
 }
 async discover(){
  await this.rail();let previous='',stable=0;const expanded=new Set();
  for(let n=0;n<this.maxSteps;n++){
   await this.auth();const r=readRail();if(r.filtered?.length)throw Error('清單仍有啟用中的篩選');
   for(const c of r.items)if(!this.job.conversations.some(x=>x.key===c.key))this.job.conversations.push(this.newConversation(c));
   this.job.stage=`列舉聊天：${this.job.conversations.length} 個`;await this.persist();
   const folder=r.folders.find(v=>!expanded.has(v));
   if(folder){expanded.add(folder);expand(folder);await this.wait();if(item(folder)?.getAttribute('aria-expanded')==='false')throw Error('無法展開聊天資料夾');continue;}
   if(r.moreValues?.length){const e=item(r.moreValues[0]);e.scrollIntoView({block:'nearest'});e.click();await this.wait();continue;}
   if(r.moreLabels?.length){const e=matches(null,'[role="tree"] button,[role="tree"] [role="treeitem"]').find(e=>e.innerText.trim()===r.moreLabels[0]);if(!e)throw Error('無法展開更多聊天');e.click();await this.wait();continue;}
   const signature=JSON.stringify([r.items.map(x=>x.key),r.top,r.bottom]);
   stable=!r.loading&&r.bottom!==null&&r.bottom<=2&&signature===previous?stable+1:0;
   if(stable>=4){this.job.discovery={status:this.job.conversations.length?'complete':'partial',boundary:'observed-stable-bottom'};return;}
   previous=signature;tree().scrollTop+=tree().clientHeight*.7;await this.wait();
  }this.job.discovery={status:'partial',warning:'列舉達到捲動上限，可能有未發現聊天'};
 }
 async open(c){
  await this.rail();let previous='',stable=0;
  for(let n=0;n<this.maxSteps;n++){
   await this.auth();const r=readRail(),found=r.items.find(x=>x.key===c.key);
   if(found){item(found.value).click();for(let i=0;i<40;i++){await this.wait();const p=readPane();if(p.headerId==='chat-header-'+c.key&&p.viewport)return;}throw Error('聊天訊息未載入');}
   if(r.folders[0]){expand(r.folders[0]);await this.wait();continue;}
   if(r.moreValues?.length){const e=item(r.moreValues[0]);e.scrollIntoView({block:'nearest'});e.click();await this.wait();continue;}
   const signature=JSON.stringify([r.items.map(x=>x.key),r.top,r.bottom]);stable=r.bottom<=2&&signature===previous?stable+1:0;if(stable>=4)break;
   previous=signature;tree().scrollTop+=tree().clientHeight*.7;await this.wait();
  }throw Error('此聊天已不在可讀取清單中');
 }
 async capture(c){
  await this.auth();
  if(readPane().headerId!=='chat-header-'+c.key)throw Error('聊天已切換；停止以免混入其他聊天');
  for(let i=0;i<50;i++){
   const more=matches(null,'[id^="message-body-"] button').find(e=>/^(see more|read more|show more|顯示更多|查看更多|閱讀更多|展开|展開)$/i.test(buttonText(e)));
   if(!more)break;more.click();await this.wait();
  }
  const raw=readMessages(),pane=readPane();
  if(pane.replies)c.warnings.push('此聊天含獨立討論串，尚未展開，結果部分完成');
  for(const m of raw){
   const time=knownTime(m.time)?Date.parse(m.time):null;
   const identity=m.id?'id:'+m.id:'uncertain:'+this.job.id+':'+(++this.sequence);
   const converted={seenInRun:this.job.id,id:m.id,key:identity,sender:m.author||'作者不明',authorMissing:!m.author,timestamp:time,rawTime:m.rawTime,text:m.text,attachments:m.links||[],parent:m.parent,quote:m.quote,uncertainIdentity:!m.id};
   const old=c.messages.find(x=>x.key===identity);
   converted.images=(m.images||[]).map(image=>{const prior=old?.images?.find(x=>!image.identityUncertain&&x.index===image.index&&x.identity===image.identity);return prior?{...prior,...image}:{...image,status:'link-only'};});
   if(old)Object.assign(old,converted);else c.messages.push(converted);
   if(m.truncated)c.warnings.push('部分訊息未展開全文');
   if(!m.id)c.warnings.push('部分訊息沒有穩定識別值，保留可能重複的紀錄');
  }
  if(this.job.captureImages)await this.captureImages(c,raw);
  c.warnings=[...new Set(c.warnings)];await this.persist();return {raw:readMessages(),pane:readPane()};
 }
 async captureImages(c,raw){
  if(!root.TeamsChatImages||!this.mediaStore)throw Error('圖片模組尚未載入，請更新後重新整理');
  for(const item of raw){
   const m=item.id?c.messages.find(x=>x.id===item.id):c.messages.find(x=>x.text===item.text&&x.sender===(item.author||'作者不明'));
   if(!m||!this.selected(c).includes(m))continue;
   const body=document.getElementById('message-body-'+item.id);if(!body)continue;
   const elements=root.TeamsChatImages.candidates(body);
   for(const image of m.images||[]){
    this.check();if(image.status==='saved')continue;
    const e=elements[image.index];if(!e)continue;const r=e.getBoundingClientRect(),view=this.viewport().getBoundingClientRect();if(r.bottom<=view.top||r.top>=view.bottom)continue;
    this.job.stage=`保存圖片：${c.name} / ${m.id||'未識別訊息'} / ${image.index+1}`;
    const check=()=>{this.check();if(readPane().headerId!=='chat-header-'+c.key)throw Error('聊天已切換；停止以免混入其他聊天');};
    try{check();const {blob,method}=await root.TeamsChatImages.capture(e,this.captureProvider,check);check();const file=await root.TeamsChatImages.filename(c.key,m.key,image.index);await this.mediaStore.put(this.job.id,file,blob);Object.assign(image,root.TeamsChatImages.describe(e,image.index),{file,status:'saved',method,bytes:blob.size,error:null});}
    catch(error){Object.assign(image,{status:'failed',error:error.message});if(error.stopped||error.captureUnavailable||/已切換/.test(error.message))throw error;}
    await this.persist();
   }
  }
 }
 viewport(){const e=matches(null,'[data-tid="message-pane-list-viewport"]')[0];if(!e)throw Error('找不到聊天捲動區');return e;}
 async scan(c){
  if(this.job.mode==='visible'){
   const {pane}=await this.capture(c);c.status='partial';c.warnings.push('只讀取目前已載入畫面，未掃描全部歷史');c.traversal={snapshot:true};return;
  }
  const range=c.scanRange||this.job.range;
  const checkpoint=c.cursor;
  let previous='',stable=0,bottom=false,lower=false;
  // Reposition without reprocessing an already persisted upper segment.
  if(checkpoint?.phase==='up'&&checkpoint.anchorId&&checkpoint.upperConfirmed){
   this.job.stage='續抓定位：'+c.name;await this.persist();
   let sig='',unchanged=0;
   for(let i=0;i<this.maxSteps;i++){
    await this.auth();if(readPane().headerId!=='chat-header-'+c.key)throw Error('聊天已切換');
    const raw=readMessages(),pane=readPane();
    if(!pane.busy&&raw.some(m=>m.id===checkpoint.anchorId)){bottom=true;c.traversal.upper='checkpoint-confirmed-bottom';c.traversal.resume='anchor-found';break;}
    const next=JSON.stringify([raw.map(m=>m.id||m.text),pane.top]);unchanged=!pane.busy&&next===sig?unchanged+1:0;if(unchanged>=4)break;sig=next;
    this.viewport().scrollTop-=this.viewport().clientHeight*.65;await this.wait();
   }
   if(!bottom)c.traversal.resume='anchor-unavailable-rescan';
  }
  for(let i=0;i<this.maxSteps;i++){
   if(bottom)break;
   const {raw,pane}=await this.capture(c);const signature=JSON.stringify([raw.map(m=>m.id||m.text),pane.bottom]);
   stable=!pane.busy&&pane.bottom!==null&&pane.bottom<=2&&signature===previous?stable+1:0;
   if(stable>=3){bottom=true;c.traversal.upper='observed-stable-bottom';break;}
   previous=signature;this.viewport().scrollTop=this.viewport().scrollHeight;await this.wait();
  }
  previous='';stable=0;
  for(let i=0;i<this.maxSteps;i++){
   const {raw,pane}=await this.capture(c),dated=raw.filter(m=>knownTime(m.time));
   const ordered=dated.every((m,i)=>!i||Date.parse(dated[i-1].time)<=Date.parse(m.time));
   // System events and grouped messages may lack datetime. Keep them as unknown,
   // but do not let them prevent the dated, ordered timeline reaching its boundary.
   if(this.job.mode==='range'&&!pane.busy&&ordered&&dated.some(m=>Date.parse(m.time)<range.from)){lower=true;c.traversal.lower='crossed-range-start';break;}
   if(!pane.busy&&(pane.startMarker||pane.empty)){lower=true;c.traversal.lower=pane.empty?'explicit-empty':'explicit-start';break;}
   const signature=JSON.stringify([raw.map(m=>m.id||m.text),pane.top]);stable=!pane.busy&&pane.top!==null&&pane.top<=2&&signature===previous?stable+1:0;
   if(stable>=4){c.traversal.lower='observed-stable-top';c.warnings.push('頂部已穩定，但沒有明確歷史起始標記，無法確認更早內容完整載入');break;}
   if(bottom&&!pane.busy&&ordered&&dated.length){const anchor=dated.find(m=>m.id);if(anchor){c.cursor={phase:'up',anchorId:anchor.id,anchorTime:anchor.time,upperConfirmed:true};await this.persist();}}
   previous=signature;this.viewport().scrollTop-=this.viewport().clientHeight*.65;await this.wait();
  }
  if(this.job.captureImages&&this.selected(c).some(m=>(m.images||[]).some(image=>image.status!=='saved')))c.warnings.push('部分圖片未保存，TXT 已保留連結與原因；可啟用圖片擷取後續抓');
  if(!bottom)c.warnings.push('未確認最新訊息的底部邊界');
  if(!lower&&!c.traversal.lower)c.warnings.push('尚未覆蓋開始時間，達到捲動上限');
  if(c.messages.some(m=>m.timestamp===null))c.warnings.push('部分紀錄缺少完整時間，未判定是否在範圍內');
  if(c.messages.some(m=>m.authorMissing))c.warnings.push('部分紀錄缺少作者');
  c.warnings=[...new Set(c.warnings)];c.status=bottom&&lower&&!c.warnings.length?'complete':'partial';
 }
 async execute(){
  this.running=true;this.cancelled=false;this.job.status='running';this.job.error=null;
  try{
   await this.persist();
   if(this.job.scope==='all')await this.discover();else this.job.discovery={status:'complete',scope:'current'};
   for(let i=0;i<this.job.conversations.length;i++){
    this.check();const c=this.job.conversations[i];if(c.status==='complete')continue;
    this.job.stage=`${i+1}/${this.job.conversations.length}：${c.name}`;
    c.status='running';c.error=null;c.warnings=[];await this.persist();
    for(let attempt=0;attempt<3;attempt++){
     c.attempts++;
     try{
      if(this.job.scope==='all')await this.open(c);else if(current().key!==c.key)throw Error('請回到原本的聊天再續抓');
      await this.scan(c);c.error=null;break;
     }catch(e){c.status='failed';c.error=e.message;await this.persist();if(e.stopped||e.captureUnavailable||/帳號|已切換|原本的聊天/.test(e.message))throw e;if(attempt<2)await this.wait();}
    }await this.persist();
   }
   this.job.status=this.job.discovery.status==='complete'&&this.job.conversations.length&&this.job.conversations.every(c=>c.status==='complete')?'complete':'partial';this.job.stage='掃描結束';await this.persist();
  }catch(e){this.job.status=e.stopped?'interrupted':'failed';this.job.error=e.message;try{await this.persist();}catch{};}
  finally{this.running=false;this.onUpdate(this.summary());}
 }
}
root.TeamsChatUtils={Scanner,parseDate,makeRange,validHost,current,account,identify,prepare};
})(globalThis);
