#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, chmod, writeFile, readdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { Store, dateRange, acquireLock, taipei, hash } from './core.js';
import { TeamsUI } from './adapter.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELP = `Teams 聊天純文字匯出（略過所有頻道）

teams-dump                         最近 24 小時
teams-dump --from "2026-10-26 09:00" --to "2026-10-27 09:00"
teams-dump --resume <工作目錄>     原時間範圍續抓
teams-dump --login                 先登入專用 Chrome 並結束
teams-dump --only "聊天名稱"       只驗證一個精確名稱的聊天
teams-dump --inspect               儲存目前頁面結構供本機除錯

--out <新目錄>      匯出位置；預設工具下 exports/<時間>
--max-steps <次數>  每階段最多捲動次數（預設 2000；超過會標為部分完成）
--delay <毫秒>      每步等待時間（預設 900，至少 200）
--login-timeout <秒> 等待手動登入（預設 600）
--help             顯示說明

日期未帶時區時使用 Asia/Taipei，範圍包含開始、不含結束。
瀏覽器可能將聊天標為已讀。工具不直接呼叫 Teams／Graph API。
退出碼：0 掃描完成，2 部分完成，1 執行錯誤，130 使用者中斷。
`;

export function options(args) {
  const {values,positionals}=parseArgs({args,allowPositionals:true,options:{from:{type:'string'},to:{type:'string'},resume:{type:'string'},out:{type:'string'},only:{type:'string'},login:{type:'boolean'},inspect:{type:'boolean'},help:{type:'boolean',short:'h'},'max-steps':{type:'string'},delay:{type:'string'},'login-timeout':{type:'string'}}});
  if (positionals.length) throw new Error('不接受位置參數；請用 --help 查看格式');
  if (values.resume && (values.from || values.to || values.out || values.only)) throw new Error('--resume 不可搭配 --from、--to、--out 或 --only；續抓沿用原工作設定');
  if (values.login && (values.resume || values.from || values.to || values.only || values.inspect)) throw new Error('--login 不可搭配匯出／檢查選項');
  const positive=(v,d,min=1)=>{const n=v===undefined?d:Number(v);if(!Number.isInteger(n)||n<min)throw new Error('次數／等待時間必須為有效正整數');return n;};
  return {...values,maxSteps:positive(values['max-steps'],2000),delay:positive(values.delay,900,200),loginTimeout:positive(values['login-timeout'],600)*1000};
}
export async function main(args=process.argv.slice(2)) {
  process.umask(0o077);
  const opt=options(args);
  if(opt.help){console.log(HELP);return 0;}
  const range=opt.resume?null:dateRange(opt.from,opt.to);
  const local=path.join(root,'.local');
  const profile=path.join(local,'chrome-profile');
  await mkdir(profile,{recursive:true,mode:0o700});await chmod(local,0o700);await chmod(profile,0o700);
  const unlockProfile=await acquireLock(local);
  let context,store,unlockOutput,stopping=false;
  const stop=()=>{if(stopping){process.exitCode=130;context?.close().catch(()=>{});}stopping=true;console.log('正在保存進度，請稍候…');};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  try {
    if (!opt.login) {
      const stamp=new Date().toISOString().replace(/[:.]/g,'-');
      const dir=path.resolve(opt.resume || opt.out || path.join(root,'exports',stamp));
      if(!opt.resume) {
        try {const files=await readdir(dir);if(files.length)throw new Error('輸出目錄非空；請使用 --resume 或另選新目錄');}
        catch(e){if(e.code!=='ENOENT')throw e;}
      }
      unlockOutput=await acquireLock(dir);
      store=opt.resume?await Store.load(dir):await Store.create(dir,range);
      if(opt.only)store.state.only=opt.only;
      store.state.scope='chats-only';
      store.state.status='running';await store.save();
      console.log(`輸出：${dir}\n範圍：${taipei(store.state.range.from)} ～ ${taipei(store.state.range.to)}（不含結束）\n頻道：依要求略過`);
    }
    context=await chromium.launchPersistentContext(profile,{channel:'chrome',headless:false,timezoneId:'Asia/Taipei',viewport:{width:1440,height:1000},acceptDownloads:false});
    const page=context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto('https://teams.microsoft.com/v2/',{waitUntil:'domcontentloaded',timeout:60000});
    const ui=new TeamsUI(page,{...opt,stop:()=>stopping});
    const account=await ui.ensureAccount(store?.state.account);
    if(opt.login){console.log(`已登入 ${account}；登入狀態已保存。`);return 0;}
    store.state.account=account;await store.save();
    if(opt.inspect) {
      const dir=path.join(store.dir,'diagnostics');await mkdir(dir,{recursive:true,mode:0o700});
      await writeFile(path.join(dir,'page.aria.txt'),await page.locator('body').ariaSnapshot(),{mode:0o600});
      await writeFile(path.join(dir,'page.html'),await page.content(),{mode:0o600});
      await page.screenshot({path:path.join(dir,'page.png')});
      store.state.warnings.push('僅執行介面檢查，未匯出全部聊天。');await store.save();await store.render();
      console.log(`本機診斷：${dir}（可能含私人聊天內容，請勿直接分享）`);return 2;
    }
    console.log('正在列舉聊天（含靜音與會議聊天）…');
    store.state.discovery={status:'running',warnings:[]};await store.save();
    store.state.discovery=await ui.discover(async item=>{store.addConversation(item);await store.save();});
    if(store.state.only) {
      const matches=Object.values(store.state.conversations).filter(c=>c.name===store.state.only);
      if(matches.length!==1)throw new Error(`--only 必須唯一對應聊天名稱，目前符合 ${matches.length} 個`);
      store.state.discovery.status='partial';store.state.discovery.warnings.push('本次只匯出 --only 指定的聊天');
    }
    await store.save();
    const conversations=Object.values(store.state.conversations);
    for (let i=0;i<conversations.length;i++) {
      const c=conversations[i];
      if(store.state.only && c.name!==store.state.only){c.status='excluded';continue;}
      if(c.status==='complete')continue;
      ui.checkStop();
      console.log(`[${i+1}/${conversations.length}] ${c.name}`);
      c.status='running';c.error=null;await store.save();
      for(let attempt=0;attempt<3;attempt++) {
        c.attempts++;await store.save();
        try {
          const result=await ui.scan(c,store.state.range,async messages=>{
            for(const m of messages)store.addMessage(c,m,'chat');
            await store.save();
          },account);
          c.status=result.status;c.warnings=[...new Set([...c.warnings,...result.warnings])];c.traversal=result.traversal;c.error=null;break;
        }catch(e){
          c.status='failed';c.error=e.message;await store.save();
          if(stopping || page.isClosed() || /帳號/.test(e.message))throw e;
          console.log(`  讀取失敗（${attempt+1}/3），保存進度後重試。`);
          if(attempt<2)await page.waitForTimeout(1500);
        }
      }
      await store.save();await store.render();
    }
    store.state.status='finished';await store.save();
    const report=await store.render();console.log(`完成：${report.totalMessagesInRange} 則，狀態 ${report.status}\n${path.join(store.dir,'all.txt')}\n請查看 report.txt 的未完成項目。`);
    return report.status==='scan-complete'?0:2;
  }catch(e){
    if(store){store.state.status=stopping?'interrupted':'failed';store.state.warnings.push(e.message);await store.save();await store.render();console.error(`進度已保存：${store.dir}`);}
    throw e;
  }finally{
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    await context?.close().catch(()=>{});await unlockOutput?.();await unlockProfile();
  }
}
if(process.argv[1] && realpathSync(process.argv[1])===fileURLToPath(import.meta.url))main().then(code=>{process.exitCode=code;}).catch(e=>{console.error(e.message);process.exitCode=/中斷/.test(e.message)?130:1;});
