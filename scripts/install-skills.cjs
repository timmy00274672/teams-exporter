#!/usr/bin/env node
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
async function main(){const source=path.resolve(__dirname,'../skills/teams-dump'),destination=path.join(os.homedir(),'.agents/skills/teams-dump');await fs.mkdir(path.dirname(destination),{recursive:true});try{const existing=await fs.realpath(destination);if(existing!==source)throw Error('已有不同的 teams-dump Skill；保留原檔，請先確認');}catch(e){if(e.code!=='ENOENT')throw e;await fs.symlink(source,destination,'dir');}console.log('Codex / OpenCode 共用 Skill：'+destination+' -> '+source);}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
