const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),sources=['images.js','dom.js','shared-utils.js','export-formats.js','archive.js'];
const key='19:fixture@thread.v2',other='19:second@thread.v2';
const msg=(id,t,text='相同內容')=>`<div><span id="author-${id}">測試作者</span><time id="timestamp-${id}" datetime="${t}"></time><div id="message-body-${id}" data-mid="${id}"><div id="content-${id}">${text}</div></div></div>`;
const row=(key,name,muted=false)=>`<div tabindex="0" role="treeitem" data-item-type="${muted?'muted-chat':'chat'}" data-fui-tree-item-value="chat|${key}"><span id="title-chat-list-item_${key}">${name}</span></div>`;
const shell=messages=>`<style>[role=tree]{height:120px;overflow:auto}[data-tid=message-pane-list-viewport]{height:200px;overflow:auto}[id^=message-body-]{min-height:80px}</style><button data-tid="me-control-avatar-trigger" aria-label="Your profile for fixture@example.com"></button><div data-tid="app-bar-wrapper"><button aria-label="Chat">Chat</button></div><div role="tree">${row(key,'測試群組')}${row(other,'靜音會議',true)}</div><div id="chat-header-${key}"><h2 data-tid="chat-title">測試群組</h2></div><div data-tid="app-layout-area--main"><div data-tid="message-pane-list-viewport">${messages}</div></div>`;
async function setup(){const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();await page.route('https://teams.cloud.microsoft/**',r=>r.fulfill({body:'<html></html>',contentType:'text/html'}));await page.goto('https://teams.cloud.microsoft/');return {browser,page};}
async function inject(page){for(const file of sources)await page.addScriptTag({path:path.join(root,file)});}

test('網域、日期、邊界與未知時間輸出',async()=>{
 const {browser,page}=await setup();try{
  await page.setContent(shell(''));await inject(page);
  const result=await page.evaluate(()=>{const u=TeamsChatUtils;let invalid=false;try{u.makeRange({from:'2026-02-30T09:00',to:'2026-10-27T09:00'});}catch{invalid=true;}return {host:u.validHost(location.hostname),bad:u.validHost('teams.cloud.microsoft.attacker.com'),from:u.parseDate('2026-10-27T09:00'),range:u.makeRange({},Date.parse('2026-10-27T01:00:00Z')),invalid};});
  assert.equal(result.host,true);assert.equal(result.bad,false);assert.equal(result.from,Date.parse('2026-10-27T01:00Z'));assert.equal(result.range.to-result.range.from,86400000);assert.equal(result.invalid,true);
  const result2=await page.evaluate(()=>{const j={status:'partial',range:{from:100,to:200},mode:'range',warnings:[],discovery:{status:'partial'},conversations:[{name:'測試',status:'partial',warnings:[],messages:[{key:'1',timestamp:100,sender:'A',text:'<script>alert(1)</script>',attachments:[]},{key:'2',timestamp:200,sender:'B',text:'不包含結束',attachments:[]},{key:'3',timestamp:null,sender:'?',text:'不明日期',rawTime:null,attachments:[]}]}]};return {data:TeamsChatFormats.exportObject(j),txt:TeamsChatFormats.format(j,'txt'),json:TeamsChatFormats.format(j,'json'),html:TeamsChatFormats.format(j,'html'),csv:TeamsChatFormats.format(j,'csv')};});
  assert.equal(result2.data.messageCount,2);assert.match(result2.txt,/時間不明/);assert.doesNotMatch(result2.txt,/不包含結束/);assert.match(result2.html,/&lt;script&gt;/);assert.equal(JSON.parse(result2.json).conversations[0].messages[1].timestamp,null);assert.match(result2.csv,/Time/);
 }finally{await browser.close();}
});

test('逐頁累積、DOM 回收、穩定 ID 去重與固定範圍續抓',async()=>{
 const {browser,page}=await setup();try{
  const all=Array.from({length:30},(_,i)=>msg(String(i+1),new Date(Date.parse('2026-10-25T00:00Z')+i*3600000).toISOString(),i%2?'相同內容':'多行<br>訊息'));
  await page.setContent(shell(all.slice(20).join('')));await inject(page);
  await page.evaluate(all=>{const view=document.querySelector('[data-tid="message-pane-list-viewport"]');let start=20,loading=false;view.scrollTop=view.scrollHeight;view.addEventListener('scroll',()=>{if(view.scrollTop>2||!start||loading)return;loading=true;view.setAttribute('aria-busy','true');setTimeout(()=>{start=Math.max(0,start-5);view.innerHTML=all.slice(start,start+10).join('');view.scrollTop=350;view.removeAttribute('aria-busy');loading=false;},25);});},all);
  const r=await page.evaluate(async()=>{window.scanner=new TeamsChatUtils.Scanner({delay:20,maxSteps:100});const job=await scanner.start({scope:'current',from:'2026-10-25T15:00:00Z',to:'2026-10-26T06:00:00Z'});const saved=structuredClone(job);const first=TeamsChatFormats.exportObject(job);await scanner.resume(saved);return {first,second:TeamsChatFormats.exportObject(scanner.job)};});
  assert.equal(r.first.status,'complete');assert.equal(r.first.messageCount,15);assert.equal(r.second.messageCount,15);assert.deepEqual(r.first.range,r.second.range);assert.equal(new Set(r.second.conversations[0].messages.map(m=>m.id)).size,15);
 }finally{await browser.close();}
});

test('批次清單包含靜音與載入更多；單一聊天失敗不中止其他聊天',async()=>{
 const {browser,page}=await setup();try{
  await page.setContent(shell(msg('1','2026-10-25T00:00Z')+msg('2','2026-10-27T00:00Z')));await inject(page);
  await page.evaluate(()=>{
   const tree=document.querySelector('[role="tree"]'),more=document.createElement('div');more.setAttribute('role','treeitem');more.setAttribute('data-fui-tree-item-value','recent-load-next-page');more.textContent='2';more.onclick=()=>{more.remove();const e=document.createElement('div');e.setAttribute('role','treeitem');e.setAttribute('data-item-type','chat');e.setAttribute('data-fui-tree-item-value','chat|third');e.innerHTML='<span id="title-chat-list-item_third">壞掉的聊天</span>';tree.append(e);};tree.append(more);
   for(const e of tree.querySelectorAll('[data-item-type]'))e.addEventListener('click',()=>{document.querySelector('[id^="chat-header-"]').id='chat-header-'+e.getAttribute('data-fui-tree-item-value').split('|')[1];});
  });
  const r=await page.evaluate(async()=>{const scanner=new TeamsChatUtils.Scanner({delay:5,maxSteps:30});const original=scanner.open.bind(scanner);scanner.open=async c=>{if(c.key==='third')throw Error('模擬載入失敗');return original(c);};return scanner.start({scope:'all',from:'2026-10-26T00:00:00Z',to:'2026-10-28T00:00:00Z'});});
  assert.equal(r.conversations.length,3);assert.equal(r.conversations[1].name,'靜音會議');assert.equal(r.conversations[2].status,'failed');assert.equal(r.conversations[2].attempts,3);assert.equal(r.conversations[0].status,'complete');assert.equal(r.status,'partial');
 }finally{await browser.close();}
});

test('停止、帳號切換與存檔失敗都保留可辨識的狀態',async()=>{
 const {browser,page}=await setup();try{
  await page.setContent(shell(msg('1','','時間不明')));await inject(page);
  const r=await page.evaluate(async()=>{const scanner=new TeamsChatUtils.Scanner({delay:10,maxSteps:50});const promise=scanner.start({scope:'current'});setTimeout(()=>scanner.stop(),30);const job=await promise;const stopped=job.status;document.querySelector('[data-tid="me-control-avatar-trigger"]').setAttribute('aria-label','Your profile for other@example.com');let error;try{await scanner.resume(job);}catch(e){error=e.message;}return {stopped,error};});assert.equal(r.stopped,'interrupted');assert.match(r.error,/帳號/);
  const failed=await page.evaluate(async()=>{const scanner=new TeamsChatUtils.Scanner({delay:1,save:()=>{throw Error('儲存空間已滿');}});await scanner.start({scope:'current'});return {status:scanner.job.status,error:scanner.job.error};});assert.equal(failed.status,'failed');assert.match(failed.error,/儲存空間/);
 }finally{await browser.close();}
});

test('個人頭像沒有 email 時可從帳號面板確認，續抓再次核對帳號',async()=>{
 const {browser,page}=await setup();try{
  await page.setContent(shell(msg('1','2026-10-27T00:00:00Z')));await inject(page);
  await page.evaluate(()=>{const trigger=document.querySelector('[data-tid="me-control-avatar-trigger"]');trigger.setAttribute('aria-label','Your profile, status Available');window.currentEmail='fixture@example.com';trigger.onclick=()=>{const old=document.querySelector('[data-tid="me-control-menu-dialog"]');if(old){old.remove();return;}const e=document.createElement('div');e.setAttribute('data-tid','me-control-menu-dialog');e.textContent='測試使用者 '+currentEmail;document.body.append(e);};});
  const result=await page.evaluate(async()=>{const s=new TeamsChatUtils.Scanner({delay:1});const j=await s.start({scope:'current',mode:'visible'});const email=j.account;window.currentEmail='other@example.com';let error;try{await s.resume(j);}catch(e){error=e.message;}return {email,error,open:!!document.querySelector('[data-tid="me-control-menu-dialog"]')};});
  assert.equal(result.email,'fixture@example.com');assert.match(result.error,/帳號/);assert.equal(result.open,false);
 }finally{await browser.close();}
});

test('指定時段混有無時間紀錄仍在跨過開始時間後停止，不掃到更舊歷史',async()=>{
 const {browser,page}=await setup();try{
  const all=Array.from({length:30},(_,i)=>msg(String(i+1),new Date(Date.parse('2026-10-25T00:00Z')+i*3600000).toISOString()));
  await page.setContent(shell(all.slice(20).join('')+msg('event','','沒有 datetime 的系統紀錄')));await inject(page);
  await page.evaluate(all=>{
   const view=document.querySelector('[data-tid="message-pane-list-viewport"]');window.oldestLoaded=20;let loading=false;view.scrollTop=view.scrollHeight;
   view.addEventListener('scroll',()=>{if(view.scrollTop>2||!window.oldestLoaded||loading)return;loading=true;view.setAttribute('aria-busy','true');setTimeout(()=>{window.oldestLoaded=Math.max(0,window.oldestLoaded-5);view.innerHTML=all.slice(window.oldestLoaded,window.oldestLoaded+10).join('')+'<div id="message-body-event"><div id="content-event">沒有 datetime 的系統紀錄</div></div>';view.scrollTop=350;view.removeAttribute('aria-busy');loading=false;},10);});
  },all);
  const r=await page.evaluate(async()=>{const s=new TeamsChatUtils.Scanner({delay:20,maxSteps:100});const j=await s.start({scope:'current',from:'2026-10-25T15:00:00Z',to:'2026-10-26T06:00:00Z'});return {job:j,data:TeamsChatFormats.exportObject(j),oldestLoaded};});
  assert.equal(r.oldestLoaded,10);assert.equal(r.job.conversations[0].traversal.lower,'crossed-range-start');
  assert.equal(r.data.conversations[0].messages.filter(m=>m.timestamp!==null).length,15);
  assert.equal(r.data.conversations[0].messages.filter(m=>m.timestamp===null).length,1);
  assert.equal(r.job.status,'partial');assert.ok(r.job.conversations[0].warnings.some(w=>w.includes('缺少完整時間')));
 }finally{await browser.close();}
});

test('沒有可確認的時間或時間亂序時，不誤判跨過開始時間',async()=>{
 const {browser,page}=await setup();try{
  for(const messages of [msg('event','','時間不明'),msg('new','2026-10-27T00:00Z')+msg('old','2026-10-20T00:00Z')]){
   await page.setContent(shell(messages));await inject(page);
   const j=await page.evaluate(()=>new TeamsChatUtils.Scanner({delay:1,maxSteps:15}).start({scope:'current',from:'2026-10-26T00:00:00Z',to:'2026-10-28T00:00:00Z'}));
   assert.equal(j.status,'partial');assert.notEqual(j.conversations[0].traversal.lower,'crossed-range-start');
  }
 }finally{await browser.close();}
});

test('中斷後從已保存的訊息錨點接續，不再重新處理最新區段',async()=>{
 const {browser,page}=await setup();try{
  const all=Array.from({length:30},(_,i)=>msg(String(i+1),new Date(Date.parse('2026-10-25T00:00Z')+i*3600000).toISOString()));
  await page.setContent(shell(all.slice(20).join('')));await inject(page);
  await page.evaluate(all=>{const view=document.querySelector('[data-tid="message-pane-list-viewport"]');let start=20,loading=false;view.scrollTop=view.scrollHeight;view.addEventListener('scroll',()=>{if(view.scrollTop>2||!start||loading)return;loading=true;view.setAttribute('aria-busy','true');setTimeout(()=>{start=Math.max(0,start-5);view.innerHTML=all.slice(start,start+10).join('');view.scrollTop=350;view.removeAttribute('aria-busy');loading=false;},10);});},all);
  const r=await page.evaluate(async()=>{
   const s=new TeamsChatUtils.Scanner({delay:20,maxSteps:100,save:async j=>{if(j.conversations[0]?.cursor?.anchorId==='16')s.stop();}});
   const first=await s.start({scope:'current',from:'2026-10-25T12:00:00Z',to:'2026-10-26T06:00:00Z'});const saved=structuredClone(first);s.save=async()=>{};
   const captures=[];const capture=s.capture.bind(s);s.capture=async c=>{const result=await capture(c);captures.push(result.raw[0]?.id);return result;};
   const second=await s.resume(saved);return {firstStatus:saved.status,anchor:saved.conversations[0].cursor.anchorId,second,captures};
  });
  assert.equal(r.firstStatus,'interrupted');assert.equal(r.anchor,'16');assert.equal(r.captures[0],'16');assert.equal(r.second.conversations[0].traversal.upper,'checkpoint-confirmed-bottom');assert.equal(r.second.status,'complete');assert.equal(new Set(r.second.conversations[0].messages.map(m=>m.key)).size,r.second.conversations[0].messages.length);
 }finally{await browser.close();}
});

test('TXT 明確區分發送者、引用與本機圖片檔，缺圖不暗示存在檔案',async()=>{
 const {browser,page}=await setup();try{
  await page.setContent(shell(''));await inject(page);
  const text=await page.evaluate(()=>TeamsChatFormats.format({status:'partial',mode:'changes',range:{from:0,to:1000},warnings:[],discovery:{status:'complete'},conversations:[{key:'c',name:'測試群組',status:'partial',warnings:[],messages:[{id:'1',key:'id:1',timestamp:1,sender:'現在的發送者',text:'引用者\n先前內容\n我補上圖\n[圖片：影像]',bodyText:'我補上圖',bodySeparated:true,quotedText:'引用者\n先前內容',quote:'引用者\n先前內容',images:[{index:0,alt:'影像',context:'body',status:'saved',file:'images/fixture_1.png',url:'blob:https://teams.cloud.microsoft/session'}]},{id:'2',key:'id:2',timestamp:2,sender:'另一人',text:'只有圖片\n[圖片：圖片]',images:[]},{id:'3',key:'id:3',timestamp:3,sender:'第三人',text:'下載失敗',images:[{alt:'圖',status:'failed',file:'images/not-saved.png',error:'擷取失敗'}]}]}]},'txt'));
  assert.match(text,/發送者：現在的發送者/);assert.match(text,/\[引用原文開始\]\n引用者\n先前內容\n\[引用原文結束\]/);assert.match(text,/\[本文開始\]\n我補上圖\n\[本文結束\]/);
  assert.match(text,/\[本機圖片附件 1 開始\]\n所屬訊息 ID：1/);assert.match(text,/圖片檔案：images\/fixture_1.png/);assert.match(text,/以本 TXT 所在資料夾為基準開啟/);assert.match(text,/暫時來源網址（離開原分頁後可能失效）/);
  assert.match(text,/頁面圖片提示（未對應到本機檔案）：圖片/);assert.match(text,/沒有可讀取的本機圖片檔/);assert.doesNotMatch(text,/圖片檔案：images\/not-saved/);
  assert.equal((text.match(/\[訊息開始\]/g)||[]).length,3);assert.equal((text.match(/\[訊息結束\]/g)||[]).length,3);
 }finally{await browser.close();}
});

test('DOM 引用與正文分開保留，引用頭像不當作聊天圖片',async()=>{
 const {browser,page}=await setup();try{
  await page.setContent(shell(msg('1','2026-10-27T00:00Z','<blockquote data-tid="quoted-message">Ryan<br>10/27/2026 11:18 AM<br>DCG Development<img src="https://teams.cloud.microsoft/api/users/profilepicturev2/person" width="64" height="64"></blockquote><p>我也看到這頁</p><img id="real-image" src="data:image/png;base64,AA" width="80" height="60" alt="截圖">')));await inject(page);
  const m=await page.evaluate(()=>TeamsChatDOM.readMessages()[0]);assert.equal(m.bodySeparated,true);assert.match(m.quotedText,/Ryan/);assert.equal(m.bodyText,'我也看到這頁');assert.equal(m.images.length,1);assert.equal(m.images[0].context,'body');
 }finally{await browser.close();}
});
