const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const sourceFiles=['images.js','dom.js','shared-utils.js','export-formats.js','archive.js'];
const key='19:image@thread.v2';
const svg='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="50"><rect width="80" height="50" fill="red"/></svg>');
const shell=()=>`<style>[data-tid=message-pane-list-viewport]{height:250px;overflow:auto}</style><button data-tid="me-control-avatar-trigger" aria-label="fixture@example.com"></button><div id="chat-header-${key}"><h2 data-tid="chat-title">圖片測試</h2></div><div data-tid="app-layout-area--main"><div data-tid="message-pane-list-viewport"><span id="author-1">小明</span><time id="timestamp-1" datetime="2026-10-27T00:00:00Z"></time><div id="message-body-1" data-mid="1"><div id="content-1" data-message-content><p>附圖說明</p><img id="image-1" src="${svg}" width="80" height="50" alt="測試圖片"><span data-tid="emoji"><img src="${svg}" width="20" height="20" alt="表情符號"></span></div></div></div></div>`;
async function setup(){const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage();await page.route('https://teams.cloud.microsoft/**',r=>r.fulfill({body:'<html></html>',contentType:'text/html'}));await page.goto('https://teams.cloud.microsoft/');await page.setContent(shell());for(const f of sourceFiles)await page.addScriptTag({path:path.join(root,f)});await page.locator('#image-1').evaluate(e=>e.decode());return {browser,page};}
function entries(buffer){const result={};let p=0;while(buffer.readUInt32LE(p)===0x04034b50){const length=buffer.readUInt32LE(p+18),nameLength=buffer.readUInt16LE(p+26),extra=buffer.readUInt16LE(p+28),name=buffer.subarray(p+30,p+30+nameLength).toString('utf8'),start=p+30+nameLength+extra;result[name]=buffer.subarray(start,start+length);p=start+length;}assert.equal(buffer.readUInt32LE(p),0x02014b50);assert.equal(buffer.readUInt32LE(buffer.length-22),0x06054b50);return result;}

test('圖片獨立 PNG、TXT 檔名、ZIP 對應；續抓不重複；表情符號排除',async()=>{
 const {browser,page}=await setup();try{
  const r=await page.evaluate(async()=>{const store=new TeamsChatImages.MediaStore(),scanner=new TeamsChatUtils.Scanner({delay:1,mediaStore:store,captureProvider:new TeamsChatImages.TabCapture()});const job=await scanner.start({scope:'current',mode:'visible',from:'2026-10-26T00:00:00Z',to:'2026-10-28T00:00:00Z',captureImages:true});await scanner.resume(job);const zip=await TeamsChatArchive.build(scanner.job,store),bytes=new Uint8Array(await zip.arrayBuffer());return {job:scanner.job,zip:Array.from(bytes),text:TeamsChatFormats.format(scanner.job,'txt')};});
  assert.equal(r.job.conversations[0].messages.length,1);const images=r.job.conversations[0].messages[0].images;assert.equal(images.length,1);assert.equal(images[0].status,'saved');assert.equal(images[0].method,'rendered-canvas');assert.match(r.text,new RegExp(images[0].file.replaceAll('.','\\.')));
  const zip=Buffer.from(r.zip),files=entries(zip);assert.deepEqual(Object.keys(files).sort(),['chat.txt','report.json',images[0].file].sort());assert.equal(files[images[0].file].subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.match(files['chat.txt'].toString(),/圖片檔案：images\//);assert.equal(JSON.parse(files['report.json']).imageReport.saved,1);
  const file=path.join(require('node:os').tmpdir(),'teams-image-test-'+process.pid+'.zip');fs.writeFileSync(file,zip);try{const check=require('node:child_process').spawnSync('python3',['-c','import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None',file]);assert.equal(check.status,0,check.stderr.toString());}finally{fs.unlinkSync(file);}
 }finally{await browser.close();}
});

test('圖片快取遺失會保留連結並標記部分完成，不產生假的檔案',async()=>{
 const {browser,page}=await setup();try{
  const r=await page.evaluate(async()=>{const job={id:'missing',captureImages:true,status:'complete',mode:'range',range:{from:0,to:9999999999999},warnings:[],discovery:{status:'complete'},conversations:[{status:'complete',name:'圖片',warnings:[],messages:[{key:'1',timestamp:1,sender:'A',text:'圖',images:[{status:'saved',file:'images/lost.png',url:'https://example.com/image'}]}]}]};return Array.from(new Uint8Array(await (await TeamsChatArchive.build(job,{get:async()=>null})).arrayBuffer()));});
  const files=entries(Buffer.from(r)),report=JSON.parse(files['report.json']);assert.equal(report.status,'partial');assert.equal(report.imageReport.missing,1);assert.match(files['chat.txt'].toString(),/https:\/\/example.com\/image/);assert.doesNotMatch(files['chat.txt'].toString(),/圖片檔案：images\/lost/);assert.equal(files['images/lost.png'],undefined);
 }finally{await browser.close();}
});

test('跨來源圖片退回畫面裁切，樣式與捲動位置恢復；尺寸和檔名可重現',async()=>{
 const {browser,page}=await setup();try{
  const imageBytes=await page.locator('#image-1').screenshot();await page.route('https://foreign.example/image.png',r=>r.fulfill({body:imageBytes,contentType:'image/png'}));await page.locator('#image-1').evaluate(e=>{e.setAttribute('style','border: 0px;');e.src='https://foreign.example/image.png';});await page.locator('#image-1').evaluate(e=>e.decode());
  const r=await page.evaluate(async()=>{const e=document.getElementById('image-1'),before=e.getAttribute('style'),positions=[...document.querySelectorAll('[data-tid="message-pane-list-viewport"]')].map(x=>x.scrollTop);let calls=0;const result=await TeamsChatImages.capture(e,{capture:async rect=>{calls++;const r=rect();if(r.width<1)throw Error('無效範圍');const canvas=document.createElement('canvas');canvas.width=Math.round(r.width);canvas.height=Math.round(r.height);return new Promise(resolve=>canvas.toBlob(resolve));}});return {method:result.method,calls,style:e.getAttribute('style'),before,positions,after:[...document.querySelectorAll('[data-tid="message-pane-list-viewport"]')].map(x=>x.scrollTop),file:await TeamsChatImages.filename('a','b',0),file2:await TeamsChatImages.filename('a','b',0)};});
  assert.equal(r.method,'tab-screenshot');assert.equal(r.calls,1);assert.equal(r.style,r.before);assert.deepEqual(r.after,r.positions);assert.equal(r.file,r.file2);
 }finally{await browser.close();}
});

test('圖片未啟用、分享中止與錯誤分頁選擇都不會默默當成成功',async()=>{
 const {browser,page}=await setup();try{
  const r=await page.evaluate(async()=>{const scanner=new TeamsChatUtils.Scanner({delay:1});let error;try{await scanner.start({scope:'current',captureImages:true});}catch(e){error=e.message;}const capture=new TeamsChatImages.TabCapture();let stopped;try{await capture.capture(()=>({}));}catch(e){stopped=e.captureUnavailable;}let trackStopped=false;const stream={getVideoTracks:()=>[{getSettings:()=>({displaySurface:'window'})}],getTracks:()=>[{stop:()=>trackStopped=true}]};Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getDisplayMedia:async()=>stream}});globalThis.CropTarget={fromElement:async()=>({})};let wrong;try{await capture.enable();}catch(e){wrong=e.message;}return {error,stopped,wrong,trackStopped};});
  assert.match(r.error,/啟用圖片/);assert.equal(r.stopped,true);assert.match(r.wrong,/分頁/);assert.equal(r.trackStopped,true);
 }finally{await browser.close();}
});

test('單檔分頁擷取接收新影格並裁切；錯誤分頁的 cropTo 拒絕後清除分享',async()=>{
 const {browser,page}=await setup();try{
  const r=await page.evaluate(async()=>{
   const source=document.createElement('canvas');source.width=320;source.height=240;const ctx=source.getContext('2d');ctx.fillStyle='lime';ctx.fillRect(0,0,320,240);const stream=source.captureStream(10),track=stream.getVideoTracks()[0];Object.defineProperty(track,'getSettings',{value:()=>({displaySurface:'browser'})});track.cropTo=async()=>{};
   Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getDisplayMedia:async()=>stream}});globalThis.CropTarget={fromElement:async e=>({element:e})};
   let hide=0,restore=0;const session=new TeamsChatImages.TabCapture({hide:()=>{hide++;return ()=>restore++;}}),timer=setInterval(()=>ctx.fillRect(0,0,320,240),30);
   try{await session.enable();const blob=await session.capture(()=>({x:20,y:20,width:80,height:50,viewWidth:320,viewHeight:240}));const bitmap=await createImageBitmap(blob),out=new OffscreenCanvas(bitmap.width,bitmap.height);out.getContext('2d').drawImage(bitmap,0,0);const pixel=Array.from(out.getContext('2d').getImageData(0,0,1,1).data);session.stop();
    let stopped=false;const badTrack={getSettings:()=>({displaySurface:'browser'}),cropTo:async()=>{throw Error('wrong-tab');},stop:()=>stopped=true};navigator.mediaDevices.getDisplayMedia=async()=>({getVideoTracks:()=>[badTrack],getTracks:()=>[badTrack]});let wrong;try{await session.enable();}catch(e){wrong=e.message;}return {width:bitmap.width,height:bitmap.height,pixel,hide,restore,wrong,stopped,ready:session.ready,marker:!!session.marker};
   }finally{clearInterval(timer);session.stop();}
  });assert.equal(r.width,80);assert.equal(r.height,50);assert.deepEqual(r.pixel,[0,255,0,255]);assert.equal(r.hide,1);assert.equal(r.restore,1);assert.equal(r.wrong,'wrong-tab');assert.equal(r.stopped,true);assert.equal(r.ready,false);assert.equal(r.marker,false);
 }finally{await browser.close();}
});

test('已解碼的預載圖片即使在可視區外仍保存，避免時段停止前漏圖',async()=>{
 const {browser,page}=await setup();try{
  await page.locator('#image-1').evaluate(e=>e.style.marginTop='800px');await page.locator('[data-tid=message-pane-list-viewport]').evaluate(e=>e.scrollTop=0);
  const r=await page.evaluate(async()=>{const s=new TeamsChatUtils.Scanner({delay:1,captureProvider:new TeamsChatImages.TabCapture()});const j=await s.start({scope:'current',mode:'visible',from:'2026-10-26T00:00:00Z',to:'2026-10-28T00:00:00Z',captureImages:true});return {image:j.conversations[0].messages[0].images[0],top:document.querySelector('[data-tid=message-pane-list-viewport]').scrollTop};});assert.equal(r.image.status,'saved');assert.equal(r.image.method,'rendered-canvas');assert.equal(r.top,0);
 }finally{await browser.close();}
});
