import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {dateRange,parseDate,inRange,Store,acquireLock} from '../src/core.js';
import {options} from '../src/cli.js';

test('台北時間、跨日與固定 24 小時範圍',()=>{
  assert.equal(parseDate('2026-10-27 09:00'),'2026-10-27T01:00:00.000Z');
  assert.equal(parseDate('2026-10-27'),'2026-10-26T16:00:00.000Z');
  const r=dateRange(undefined,undefined,new Date('2026-10-27T03:45:00Z'));
  assert.equal(r.from,'2026-10-26T03:45:00.000Z');
  assert.equal(r.to,'2026-10-27T03:45:00.000Z');
  assert.equal(inRange(r.from,r),true);assert.equal(inRange(r.to,r),false);
  assert.equal(inRange(null,r),false);
  assert.throws(()=>parseDate('2026-02-30 12:00'));
  assert.throws(()=>parseDate('2026-10-27 24:00'));
  assert.throws(()=>parseDate('2026-02-30T12:00:00Z'));
  assert.throws(()=>dateRange('2026-10-28','2026-10-27'));
});
test('續抓不允許更換範圍／目標，拒絕錯誤參數',()=>{
  assert.throws(()=>options(['--resume','x','--from','2026-10-27']));
  assert.throws(()=>options(['--resume','x','--only','群組']));
  assert.throws(()=>options(['--max-steps','NaN']));
  assert.throws(()=>options(['--delay','0']));
  assert.throws(()=>options(['--unknown']));
  assert.equal(options([]).maxSteps,2000);
});
test('識別值去重、同文字不同訊息保留、不確定身分保留',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'teams-core-'));
  try{
    const store=await Store.create(dir,dateRange('2026-10-26','2026-10-28'));
    const c=store.addConversation({key:'chat:1',name:'測試/群組'});
    const m={id:'1',time:'2026-10-27T01:00:00.000Z',author:'小明',text:'第一行\n第二行',links:[]};
    assert.equal(store.addMessage(c,m,'chat'),true);
    assert.equal(store.addMessage(c,{...m,text:'編輯後'},'chat'),false);
    assert.equal(store.addMessage(c,{...m,id:'2'},'chat'),true);
    assert.equal(store.addMessage(c,{...m,id:null,observation:'one'},'chat'),true);
    assert.equal(store.addMessage(c,{...m,id:null,observation:'one'},'chat'),false);
    assert.equal(store.addMessage(c,{...m,id:null,observation:'two'},'chat'),true);
    store.addMessage(c,{...m,id:'outside',time:'2026-10-25T00:00:00Z'},'chat');
    store.addMessage(c,{...m,id:'unknown',time:null,rawTime:'Today'},'chat');
    await store.save();const loaded=await Store.load(dir);
    assert.deepEqual(loaded.state.range,store.state.range);
    assert.equal(loaded.state.conversations['chat:1'].messages.length,6);
    const report=await loaded.render();assert.equal(report.status,'partial');
    assert.equal(report.totalMessagesInRange,4);assert.equal(report.unknownTimeMessages,1);
    const text=await readFile(path.join(dir,'all.txt'),'utf8');
    assert.match(text,/第一行\n第二行/);assert.match(text,/時間無法判定/);assert.match(text,/編輯後/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('完成、失敗與未完成工作不混淆',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'teams-report-'));
  try{
    const s=await Store.create(dir,dateRange());const a=s.addConversation({key:'a',name:'A'});
    s.state.discovery={status:'complete',warnings:[]};a.status='complete';s.state.status='finished';
    assert.equal((await s.render()).status,'scan-complete');
    const b=s.addConversation({key:'b',name:'B'});b.status='failed';b.error='載入失敗';
    assert.equal((await s.render()).status,'partial');
    b.status='complete';s.state.discovery.status='partial';
    assert.equal((await s.render()).status,'partial');
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('工作鎖阻止同時匯出同一工作',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'teams-lock-'));
  try{const unlock=await acquireLock(dir);await assert.rejects(acquireLock(dir),/正在匯出/);await unlock();const again=await acquireLock(dir);await again();}
  finally{await rm(dir,{recursive:true,force:true});}
});
