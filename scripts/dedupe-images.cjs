#!/usr/bin/env node
'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {lock,linkImage}=require('../cli/store.cjs');
const imageName=/^[a-f0-9]{20}_\d+\.png$/;
async function collect(directory){const out=[];for(const e of await fs.readdir(directory,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){const full=path.join(directory,e.name);if(e.isDirectory())out.push(...await collect(full));else if(e.isFile()&&imageName.test(e.name))out.push(full);}return out;}
async function dedupe(repoRoot,{apply=false}={}){
 const local=path.join(repoRoot,'.local'),release=await lock(path.join(local,'run-lock'));
 try{
  const roots=(await fs.readdir(local,{withFileTypes:true})).filter(e=>e.isDirectory()&&/^cli(?:-|$)/.test(e.name)).sort((a,b)=>(a.name==='cli'?-1:b.name==='cli'?1:a.name.localeCompare(b.name)));
  const files=[];
  for(const r of roots){const base=path.join(local,r.name);for(const sub of ['images','jobs','full'])files.push(...await collect(path.join(base,sub)));}
  files.push(...await collect(path.join(repoRoot,'exports')));
  const groups=new Map(),result={apply,files:files.length,alreadyLinked:0,replacements:0,crossDeviceSkipped:0};
  for(const file of files){const stat=await fs.lstat(file);if(!stat.isFile())continue;const sha=crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');const key=stat.dev+':'+sha;const source=groups.get(key);
   if(!source){groups.set(key,{file,ino:stat.ino});continue;}
   if(source.ino===stat.ino){result.alreadyLinked++;continue;}
   if(apply){const method=await linkImage(source.file,file);if(method==='copy'){result.crossDeviceSkipped++;continue;}}
   result.replacements++;
  }
  return result;
 }finally{await release();}
}
if(require.main===module){const args=process.argv.slice(2);if(args.some(a=>a!=='--apply')){console.error('用法：node scripts/dedupe-images.cjs [--apply]（預設僅檢查）');process.exitCode=1;}else dedupe(path.resolve(__dirname,'..'),{apply:args.includes('--apply')}).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1;});}
module.exports={dedupe};
