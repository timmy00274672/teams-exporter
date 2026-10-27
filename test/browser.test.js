import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readMessages,readRail,readPane} from '../src/dom.js';
import {TeamsUI} from '../src/adapter.js';
import {Store,dateRange} from '../src/core.js';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';

const key='19:fixture@thread.v2';
const msg=(id,time,text,extra='')=>`<div><span id="author-${id}">測試作者</span><time id="timestamp-${id}" datetime="${time}"></time><div id="message-body-${id}" data-mid="${id}"><div id="content-${id}">${text}</div>${extra}</div></div>`;
const shell=(messages,extra='')=>`<style>[data-tid="message-pane-list-viewport"]{height:200px;overflow:auto} [role="tree"]{height:100px;overflow:auto} [id^="message-body-"]{min-height:90px} </style>
<button data-tid="me-control-avatar-trigger" aria-label="Your profile for fixture@example.com"></button><div data-tid="app-bar-wrapper"><button aria-label="Chat">Chat</button></div>
<div role="tree" data-tid="simple-collab-dnd-rail"><div role="treeitem" data-item-type="chat" data-fui-tree-item-value="chat|${key}"><span id="title-chat-list-item_${key}">測試聊天</span></div><div role="treeitem" data-item-type="muted-chat" data-fui-tree-item-value="chat|muted"><span id="title-chat-list-item_muted">靜音會議</span></div></div>
<div id="chat-header-${key}"><h2 data-tid="chat-title">測試聊天</h2></div><div data-tid="app-layout-area--main"><div data-tid="message-pane-list-viewport">${messages}</div>${extra}</div>`;

test('真實瀏覽器 DOM：文字、圖片標記、附件、引用與靜音聊天',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(shell(msg('101','2026-10-27T01:00:00Z','<p>第一行</p><p>第二行</p><a href="https://example.com/file">檔案.xlsx</a><img alt="圖表"><div data-track-module-name="messageQuotedReply" aria-label="Begin quote, 前文">前文</div>')));
  const [m]=await page.evaluate(readMessages);
  assert.equal(m.id,'101');assert.equal(m.author,'測試作者');assert.equal(m.time,'2026-10-27T01:00:00Z');
  assert.match(m.text,/第一行\n/);assert.match(m.text,/第二行/);assert.match(m.text,/圖片：圖表/);assert.equal(m.links[0].url,'https://example.com/file');assert.match(m.quote,/前文/);
  const rail=await page.evaluate(readRail);assert.equal(rail.items.length,2);assert.equal(rail.items[1].name,'靜音會議');
  assert.equal((await page.evaluate(readPane)).headerId,'chat-header-'+key);
 }finally{await browser.close();}
});

test('長聊天捲動、範圍邊界、保存續抓及局部失敗',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const dir=await mkdtemp(path.join(os.tmpdir(),'teams-browser-'));
 try{
  const page=await browser.newPage();
  // Fulfilled locally: these tests make no request to Teams.
  await page.route('https://teams.microsoft.com/**',r=>r.fulfill({body:'<html></html>',contentType:'text/html'}));
  await page.goto('https://teams.microsoft.com/v2/');
  const messages=Array.from({length:22},(_,i)=>msg(String(i+1),new Date(Date.parse('2026-10-26T00:00:00Z')+i*3600000).toISOString(),i%2?'相同內容':'多行<br>訊息')).join('');
  await page.setContent(shell(messages));
  const range=dateRange('2026-10-26 18:00','2026-10-27 05:00');
  const store=await Store.create(dir,range),c=store.addConversation({key,name:'測試聊天'});
  const ui=new TeamsUI(page,{delay:5,maxSteps:50,loginTimeout:100});
  const discovery=await ui.discover(async()=>{});assert.equal(discovery.status,'complete');assert.equal(discovery.count,2);
  const result=await ui.scan(c,range,async batch=>{batch.forEach(m=>store.addMessage(c,m,'chat'));await store.save();},'fixture@example.com');
  assert.equal(result.status,'complete');assert.equal(result.traversal.lower,'crossed-range-start');
  c.status=result.status;store.state.discovery=discovery;store.state.status='finished';await store.save();
  let report=await store.render();assert.equal(report.totalMessagesInRange,11);assert.equal(report.status,'scan-complete');
  const restored=await Store.load(dir);assert.equal(restored.state.conversations[key].messages.length,c.messages.length);
  await ui.scan(c,range,async batch=>batch.forEach(m=>store.addMessage(c,m,'chat')),'fixture@example.com');
  report=await store.render();assert.equal(report.totalMessagesInRange,11);
  await assert.rejects(ui.ensureAccount('other@example.com'),/帳號/);
  const stopped=new TeamsUI(page,{stop:()=>true});await assert.rejects(stopped.ready(),/中斷/);
  await page.locator('[data-tid="message-pane-list-viewport"]').evaluate(e=>e.scrollTop=0);
  await page.setContent(shell(msg('no-date','','未知時間')));
  const unknown=store.addConversation({key,name:'測試聊天'});
  const partial=await ui.scan(unknown,range,async batch=>batch.forEach(m=>store.addMessage(unknown,m,'chat')),'fixture@example.com');
  assert.equal(partial.status,'partial');assert.match(partial.warnings.join(','),/時間/);
 }finally{await browser.close();await rm(dir,{recursive:true,force:true});}
});

test('虛擬清單載入更多與收合資料夾',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();await page.route('https://teams.microsoft.com/**',r=>r.fulfill({body:'<html></html>',contentType:'text/html'}));await page.goto('https://teams.microsoft.com/v2/');
  await page.setContent(shell(''));
  await page.evaluate(()=>{
   const tree=document.querySelector('[role="tree"]');
   const more=document.createElement('div');more.setAttribute('role','treeitem');more.setAttribute('data-fui-tree-item-value','recent-load-next-page');more.setAttribute('aria-label','See more 2 Badged chats');more.textContent='2';
   more.onclick=()=>{more.remove();const e=document.createElement('div');e.setAttribute('role','treeitem');e.setAttribute('data-item-type','chat');e.setAttribute('data-fui-tree-item-value','chat|third');e.innerHTML='<span id="title-chat-list-item_third">更多聊天</span>';tree.append(e);};tree.append(more);
  });
  const ui=new TeamsUI(page,{delay:5,maxSteps:40,loginTimeout:100});const seen=[];
  const result=await ui.discover(async c=>{if(!seen.includes(c.key))seen.push(c.key);});
  assert.equal(result.status,'complete');assert.equal(result.count,3);assert.ok(seen.includes('third'));
 }finally{await browser.close();}
});

test('捲動載入並回收 DOM 時，先前擷取的訊息仍保存',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});const dir=await mkdtemp(path.join(os.tmpdir(),'teams-virtual-'));
 try{
  const page=await browser.newPage();await page.route('https://teams.microsoft.com/**',r=>r.fulfill({body:'<html></html>',contentType:'text/html'}));await page.goto('https://teams.microsoft.com/v2/');
  const all=Array.from({length:30},(_,i)=>msg(String(i+1),new Date(Date.parse('2026-10-25T00:00:00Z')+i*3600000).toISOString(),'虛擬訊息 '+i));
  await page.setContent(shell(all.slice(20).join('')));
  await page.evaluate(all=>{
   const view=document.querySelector('[data-tid="message-pane-list-viewport"]');let start=20,loading=false;
   view.scrollTop=view.scrollHeight;
   view.addEventListener('scroll',()=>{
    if(view.scrollTop>2 || start===0 || loading)return;
    loading=true;view.setAttribute('aria-busy','true');
    setTimeout(()=>{start=Math.max(0,start-5);view.innerHTML=all.slice(start,start+10).join('');view.scrollTop=350;view.removeAttribute('aria-busy');loading=false;},30);
   });
  },all);
  const range=dateRange('2026-10-25T15:00:00Z','2026-10-26T06:00:00Z');
  const store=await Store.create(dir,range),c=store.addConversation({key,name:'測試聊天'});
  const ui=new TeamsUI(page,{delay:20,maxSteps:80,loginTimeout:100});
  const result=await ui.scan(c,range,async batch=>{batch.forEach(m=>store.addMessage(c,m,'chat'));await store.save();},'fixture@example.com');
  assert.equal(result.status,'complete');
  const report=await store.render();assert.equal(report.totalMessagesInRange,15);
  assert.ok(c.messages.some(m=>m.id==='30'));assert.ok(c.messages.some(m=>m.id==='16'));
 }finally{await browser.close();await rm(dir,{recursive:true,force:true});}
});

test('登入等待可恢復；沒有完成登入時保留失敗狀態',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();await page.route('https://teams.cloud.microsoft/**',r=>r.fulfill({body:'<html></html>',contentType:'text/html'}));await page.goto('https://teams.cloud.microsoft/');
  const ui=new TeamsUI(page,{delay:5,loginTimeout:2000,log:()=>{}});
  const waiting=ui.ready();
  await page.evaluate(()=>setTimeout(()=>{const e=document.createElement('button');e.setAttribute('data-tid','me-control-avatar-trigger');e.setAttribute('aria-label','Your profile for fixture@example.com');document.body.append(e);},25));
  await waiting;assert.equal(await ui.ensureAccount('fixture@example.com'),'fixture@example.com');
  await page.locator('[data-tid="me-control-avatar-trigger"]').evaluate(e=>e.remove());
  const expired=new TeamsUI(page,{loginTimeout:1,log:()=>{}});await assert.rejects(expired.ready(),/登入逾時/);
 }finally{await browser.close();}
});
