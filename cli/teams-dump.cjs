#!/usr/bin/env node
'use strict';
const path=require('node:path'),fs=require('node:fs/promises'),{parseArgs}=require('node:util'),crypto=require('node:crypto'),{spawn}=require('node:child_process'),vm=require('node:vm');
const {Repository,atomic,read,alive,summary}=require('./store.cjs');
const HELP=`Teams 本機匯出（略過頻道；專用 Chrome；無 Teams API）
teams-dump [--from "2026-10-26 09:00" --to "2026-10-27 09:00"]
teams-dump update [--to <時間>]
teams-dump resume <工作編號> （或 --resume <工作編號>）
teams-dump status [工作編號]
teams-dump stop <工作編號>
teams-dump export [--account <email>] [--out <目錄>]
teams-dump --login
--background  背景執行，立即回傳工作編號
--json        機器可讀 JSON 輸出
--data <目錄> 本機資料根目錄（預設 repo/.local/cli）
--profile <目錄> 專用 Chrome 設定檔，勿使用日常 Chrome 設定檔
--only <名稱> 僅掃描唯一同名聊天（用於驗證）
--delay <毫秒> 預設 900，最低 200
--max-steps <次數> 預設 2000
--login-timeout <秒> 預設 600
時間預設台北，包含開始、不含結束。可能將聊天標為已讀。
退出碼：0 完成或已接受；2 部分完成；1 失敗；130 中斷。
`;
function parse(args){
 const {values:v,positionals:p}=parseArgs({args,allowPositionals:true,options:{from:{type:'string'},to:{type:'string'},resume:{type:'string'},data:{type:'string'},out:{type:'string'},profile:{type:'string'},only:{type:'string'},account:{type:'string'},background:{type:'boolean'},json:{type:'boolean'},help:{type:'boolean'},login:{type:'boolean'},worker:{type:'string'},delay:{type:'string'},'max-steps':{type:'string'},'login-timeout':{type:'string'}}});
 const command=v.worker?'worker':v.login?'login':v.resume?'resume':p[0]||'scan',id=v.worker||v.resume||p[1];
 if(!['scan','update','resume','status','stop','export','login','worker'].includes(command)||p.length>2)throw Error('未知指令；請用 --help');
 if(['resume','stop'].includes(command)&&!id)throw Error('請提供工作編號');
 if(v.resume&&p.length)throw Error('--resume 不可搭配其他指令');
 if(['resume','status','stop','worker','export'].includes(command)&&(v.from||v.to||v.only))throw Error('此指令不可另設時段或聊天');
 if(command==='update'&&v.from)throw Error('update 起點由已保存進度決定，不接受 --from');
 if(p.length===2&&!['resume','status','stop'].includes(command))throw Error('不接受多餘參數');
 const positive=(x,d,min)=>{const n=x===undefined?d:Number(x);if(!Number.isInteger(n)||n<min)throw Error('等待時間／次數無效');return n;};
 return {...v,command,id,delay:positive(v.delay,900,200),maxSteps:positive(v['max-steps'],2000,1),loginTimeout:positive(v['login-timeout'],600,1)*1000};
}
async function range(options){const source=await fs.readFile(path.join(__dirname,'../shared-utils.js'),'utf8');const ctx=vm.createContext({TeamsChatDOM:{},Date});vm.runInContext(source,ctx);return JSON.parse(JSON.stringify(ctx.TeamsChatUtils.makeRange(options)));}
function output(value,json){process.stdout.write(json?JSON.stringify(value)+'\n':JSON.stringify(value,null,2)+'\n');}
async function main(args=process.argv.slice(2)){
 process.umask(0o077);const opt=parse(args);if(opt.help){process.stdout.write(HELP);return 0;}
 const repo=new Repository(opt.data||process.env.TEAMS_DUMP_DATA||path.join(__dirname,'../.local/cli'));
 if(['status','stop'].includes(opt.command)){
  const id=opt.id||await repo.latest();if(!id){output({status:'empty',message:'尚無工作'},opt.json);return 0;}const job=await repo.job(id);
  const worker=await read(path.join(repo.jobDir(id),'worker.json'),{});const pid=job.pid||worker.pid;const live=pid&&alive(pid)&&['queued','running','waiting-login'].includes(job.status);if(!live&&['queued','running','waiting-login'].includes(job.status)){job.status='interrupted';job.error='程序已結束，可用 resume 續抓';}
  if(opt.command==='stop'){await atomic(path.join(repo.jobDir(id),'control.json'),{stop:true});output({id,status:live?'stop-requested':job.status},opt.json);return 0;}
  const report=await read(path.join(repo.jobDir(id),'report.json'),null);output({...summary(job),running:!!live,paths:{directory:repo.jobDir(id),changes:path.join(repo.jobDir(id),'changes.txt'),report:path.join(repo.jobDir(id),'report.json')},changes:report?.changes},opt.json);return 0;
 }
 if(opt.command==='export'){
  const last=await repo.latest(),account=opt.account||(last?(await repo.job(last)).account:null);if(!account)throw Error('請提供 --account 或先完成一次掃描');
  const lib=await repo.library(account),out=path.resolve(opt.out||path.join(repo.root,'full',new Date().toISOString().replace(/[:.]/g,'-')));await fs.mkdir(out,{recursive:true,mode:0o700});if((await fs.readdir(out)).length)throw Error('匯出目錄必須為空');
  const conversations=Object.values(lib.conversations).map(c=>({...c,status:'partial',warnings:[],messages:structuredClone(c.messages)}));
  for(const c of conversations)for(const m of c.messages)for(const image of m.images||[]){if(image.status==='saved'){const bytes=await repo.getImage(image.file);if(bytes)await atomic(path.join(out,image.file),bytes);else{image.status='failed';image.error='本機圖片快取遺失';}}}
  const job={status:'partial',mode:'history',account,range:{from:0,to:Date.now()},warnings:['累積內容並非全部歷史的完整備份'],discovery:{status:'partial'},conversations};await atomic(path.join(out,'all.txt'),require('./text.cjs').format(job));await atomic(path.join(out,'all.json'),job);output({directory:out,messages:conversations.reduce((n,c)=>n+c.messages.length,0)},opt.json);return 0;
 }
 if(opt.command==='worker'){const j=await repo.job(opt.id);const result=await require('./runner.cjs').run(repo,opt.id,j.options);return exitCode(result);}
 let job;
 if(opt.command==='resume'){
  job=await repo.job(opt.id);const worker=await read(path.join(repo.jobDir(job.id),'worker.json'),{});if((job.pid&&alive(job.pid))||(worker.pid&&alive(worker.pid)))throw Error('此工作仍在執行');await fs.rm(path.join(repo.jobDir(job.id),'control.json'),{force:true});
 }else{
  const r=await range(opt);job={version:1,id:crypto.randomUUID(),created:Date.now(),status:'queued',stage:'等待啟動',range:r,account:null,conversations:[],warnings:[],options:{...opt,from:new Date(r.from).toISOString(),to:new Date(r.to).toISOString()}};
  // Reuse the original dedicated profile when present; never open everyday Chrome credentials.
  if(!job.options.profile){const legacy=path.resolve(__dirname,'../../teams-exporter/.local/chrome-profile');try{await fs.access(legacy);job.options.profile=legacy;}catch{}}
  if(job.options.profile)job.options.profile=path.resolve(job.options.profile);
  await repo.save(job);
 }
 if(opt.background){const log=await fs.open(path.join(repo.jobDir(job.id),'worker.log'),'a',0o600);const child=spawn(process.execPath,[__filename,'--worker',job.id,'--data',repo.root],{detached:true,stdio:['ignore',log.fd,log.fd]});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();await atomic(path.join(repo.jobDir(job.id),'worker.json'),{pid:child.pid});await log.close();output({id:job.id,status:'queued',pid:child.pid,directory:repo.jobDir(job.id)},opt.json);return 0;}
 const result=await require('./runner.cjs').run(repo,job.id,job.options);output({...summary(result),directory:repo.jobDir(job.id)},opt.json);return exitCode(result);
}
function exitCode(job){return job.status==='complete'?0:job.status==='interrupted'?130:job.status==='failed'?1:2;}
if(require.main===module)main().then(code=>{process.exitCode=code;}).catch(e=>{output({status:'error',error:e.message},process.argv.includes('--json'));process.exitCode=1;});
module.exports={main,parse,range};
