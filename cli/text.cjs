const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const context=vm.createContext({Intl,Date,console});vm.runInContext(fs.readFileSync(path.join(__dirname,'../export-formats.js'),'utf8'),context);
module.exports={format:job=>context.TeamsChatFormats.format(job,'txt')};
