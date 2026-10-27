const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {Repository,linkImage}=require('../cli/store.cjs');
const {dedupe}=require('../scripts/dedupe-images.cjs');
const file='images/0123456789abcdef0123_1.png';

test('工作與完整匯出共享 inode，快取更新不修改舊工作，刪快取仍可讀附件',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'teams-links-'));try{
  const repo=new Repository(dir);await repo.putImage(file,Buffer.from('old-image'));
  const first=repo.jobDir('one'),second=repo.jobDir('two');assert.equal(await repo.exportImage(file,first),'hardlink');assert.equal(await repo.exportImage(file,second),'hardlink');
  const cache=await fs.stat(repo.image(file)),one=await fs.stat(path.join(first,file)),two=await fs.stat(path.join(second,file));assert.equal(cache.ino,one.ino);assert.equal(one.ino,two.ino);assert.equal(cache.nlink,3);
  assert.equal(await repo.exportImage(file,first),'existing');await repo.putImage(file,Buffer.from('old-image'));assert.equal((await fs.stat(repo.image(file))).ino,cache.ino);
  await repo.putImage(file,Buffer.from('new-image'));assert.equal((await fs.readFile(path.join(first,file))).toString(),'old-image');assert.notEqual((await fs.stat(repo.image(file))).ino,one.ino);
  const full=path.join(dir,'full','export');assert.equal(await repo.exportImage(file,full),'hardlink');assert.equal((await fs.stat(path.join(full,file))).ino,(await fs.stat(repo.image(file))).ino);
  await fs.unlink(repo.image(file));assert.equal((await fs.readFile(path.join(full,file))).toString(),'new-image');assert.equal(await repo.exportImage(file,repo.jobDir('missing')),null);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('跨磁碟退回原子複製，其他錯誤保留既有輸出且不殘留暫存檔',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'teams-links-'));try{
  const src=path.join(dir,'source.png'),dest=path.join(dir,'out','image.png');await fs.writeFile(src,'pixels');
  const mode=await linkImage(src,dest,{link:async()=>{throw Object.assign(Error('cross-device'),{code:'EXDEV'});}});assert.equal(mode,'copy');assert.equal((await fs.readFile(dest)).toString(),'pixels');assert.notEqual((await fs.stat(src)).ino,(await fs.stat(dest)).ino);
  await assert.rejects(()=>linkImage(src,dest,{link:async()=>{throw Object.assign(Error('denied'),{code:'EACCES'});}}),/denied/);assert.equal((await fs.readFile(dest)).toString(),'pixels');assert.deepEqual(await fs.readdir(path.dirname(dest)),['image.png']);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('舊圖片僅合併內容相同的副本，可預覽，且排除登入設定檔與符號連結',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'teams-dedupe-'));try{
  const a=path.join(dir,'.local/cli',file),b=path.join(dir,'.local/cli-validation/jobs/old',file),different=path.join(dir,'.local/cli-validation-final',file),profile=path.join(dir,'.local/cli/chrome-profile',file);
  for(const [f,bytes]of [[a,'same'],[b,'same'],[different,'different'],[profile,'same']]){await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,bytes);}
  const before=await fs.stat(b),profileBefore=await fs.stat(profile);const preview=await dedupe(dir);assert.equal(preview.replacements,1);assert.equal((await fs.stat(b)).ino,before.ino);
  await dedupe(dir,{apply:true});assert.equal((await fs.stat(a)).ino,(await fs.stat(b)).ino);assert.notEqual((await fs.stat(a)).ino,(await fs.stat(different)).ino);assert.equal((await fs.stat(profile)).ino,profileBefore.ino);assert.equal((await dedupe(dir,{apply:true})).replacements,0);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
