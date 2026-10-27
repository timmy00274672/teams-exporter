/* Images already rendered by Teams: read canvas when permitted, otherwise crop a tab screenshot. No media requests. */
(function(root){
'use strict';
const pngBlob=canvas=>new Promise((resolve,reject)=>{try{canvas.toBlob(b=>b?resolve(b):reject(Error('圖片轉換失敗')),'image/png');}catch(e){reject(e);}});
const frame=()=>new Promise(resolve=>{const timer=setTimeout(resolve,500);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();}));});
const unavailable=message=>Object.assign(Error(message),{captureUnavailable:true});
function candidates(body){return [...(body.querySelector('[data-message-content]')||body).querySelectorAll('img')].filter(e=>{
 if(/\/profilepicture(?:v\d+)?(?:\/|\?|$)/i.test(e.currentSrc||e.src||'')||e.closest('[data-tid*="avatar"],[data-tid*="Avatar"],.fui-Avatar'))return false;
 const r=e.getBoundingClientRect();return !e.closest('[itemtype*="Emoji"],[data-tid*="emoji"],.emojione,[data-is-emoji="true"]')&&(r.width>=32&&r.height>=32||e.naturalWidth>=64&&e.naturalHeight>=64);
});}
function describe(e,index){
 const source=e.currentSrc||e.src||'';let identity=e.id||null,identityUncertain=false;
 const digest=text=>{let a=2166136261,b=5381;for(let i=0;i<text.length;i++){a=Math.imul(a^text.charCodeAt(i),16777619);b=Math.imul(b,33)^text.charCodeAt(i);}return (a>>>0).toString(16)+(b>>>0).toString(16);};
 if(!identity&&source.startsWith('blob:')){
  // Blob URLs change on every page load. Fingerprint already-decoded pixels locally.
  try{if(!e.complete||!e.naturalWidth||e.naturalWidth*e.naturalHeight>24000000)throw Error('not ready');const c=document.createElement('canvas');c.width=e.naturalWidth;c.height=e.naturalHeight;c.getContext('2d').drawImage(e,0,0);identity='pixels:'+digest(c.toDataURL('image/png'));}catch{identity='unverified-slot:'+index;identityUncertain=true;}
 }
 identity ||= source.startsWith('data:')?'data-image:'+digest(source):source||String(index);
 return {index,identity,identityUncertain,alt:e.alt||e.getAttribute('aria-label')||'圖片',url:/^(https?:|blob:)/.test(source)?source:null};
}
class MediaStore{
 async db(){if(!this.connection)this.connection=await new Promise((resolve,reject)=>{const request=indexedDB.open('teams-chat-downloader-local-media-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('images');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});return this.connection;}
 async transaction(mode,action){const db=await this.db();return new Promise((resolve,reject)=>{const tx=db.transaction('images',mode),request=action(tx.objectStore('images'));tx.oncomplete=()=>resolve(request.result??null);tx.onerror=()=>reject(tx.error||Error('圖片儲存失敗'));tx.onabort=()=>reject(tx.error||Error('圖片儲存中斷'));});}
 async put(job,file,blob){await this.transaction('readwrite',s=>s.put(blob,job+':'+file));}
 async get(job,file){return this.transaction('readonly',s=>s.get(job+':'+file));}
}
async function filename(chat,message,index){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(chat+'\0'+message));const prefix=[...new Uint8Array(bytes)].slice(0,10).map(x=>x.toString(16).padStart(2,'0')).join('');return `images/${prefix}_${index+1}.png`;}
function cropRect(e){
 let r=e.getBoundingClientRect(),left=0,top=0,right=innerWidth,bottom=innerHeight;
 for(let p=e.parentElement;p;p=p.parentElement){const css=getComputedStyle(p),b=p.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(css.overflowX)){left=Math.max(left,b.left);right=Math.min(right,b.right);}if(/auto|scroll|hidden|clip/.test(css.overflowY)){top=Math.max(top,b.top);bottom=Math.min(bottom,b.bottom);}}
 if(r.width<1||r.height<1||r.left<left-1||r.top<top-1||r.right>right+1||r.bottom>bottom+1)throw Error('圖片未完整顯示，已保留來源連結');
 for(const [x,y]of [[r.left+2,r.top+2],[r.right-2,r.top+2],[r.left+2,r.bottom-2],[r.right-2,r.bottom-2],[(r.left+r.right)/2,(r.top+r.bottom)/2]]){const hit=document.elementFromPoint(x,y);if(!hit||!(hit===e||hit.contains(e)))throw Error('圖片被其他面板遮住，已保留連結');}
 return {x:Math.max(0,r.left),y:Math.max(0,r.top),width:r.width,height:r.height,viewWidth:innerWidth,viewHeight:innerHeight};
}
async function capture(e,provider,check=()=>{}){
 check();if(!e.isConnected)throw Error('圖片已離開頁面，請續抓重試');
 if(!e.complete||!e.naturalWidth){await Promise.race([new Promise(resolve=>{e.addEventListener('load',resolve,{once:true});e.addEventListener('error',resolve,{once:true});}),new Promise(r=>setTimeout(r,2500))]);}
 check();if(!e.complete||!e.naturalWidth)throw Error('圖片尚未載入，已保留連結');
 if(e.naturalWidth*e.naturalHeight<=24000000){try{const canvas=document.createElement('canvas');canvas.width=e.naturalWidth;canvas.height=e.naturalHeight;canvas.getContext('2d').drawImage(e,0,0);return {blob:await pngBlob(canvas),method:'rendered-canvas'};}catch{/* Cross-origin pixels require a user-authorized tab capture. */}}
 if(!provider?.capture)throw unavailable('圖片擷取未啟用，請先啟用再續抓');
 const scrollers=[];for(let p=e.parentElement;p;p=p.parentElement)if(p.scrollHeight>p.clientHeight||p.scrollWidth>p.clientWidth)scrollers.push([p,p.scrollTop,p.scrollLeft]);
 const originalStyle=e.getAttribute('style'),originalWindow=[scrollX,scrollY];
 try{
  e.style.setProperty('max-width',Math.floor(innerWidth*.65)+'px','important');e.style.setProperty('max-height',Math.floor(innerHeight*.45)+'px','important');e.style.setProperty('width','auto','important');e.style.setProperty('height','auto','important');e.style.setProperty('object-fit','contain','important');
  e.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});await frame();await new Promise(r=>setTimeout(r,150));check();if(!e.isConnected)throw Error('捲動時圖片被回收，請續抓重試');
  const blob=await provider.capture(()=>{check();return cropRect(e);});check();return {blob,method:'tab-screenshot'};
 }finally{if(originalStyle===null)e.removeAttribute('style');else e.setAttribute('style',originalStyle);for(const [p,top,left]of scrollers){p.scrollTop=top;p.scrollLeft=left;}window.scrollTo(...originalWindow);await frame();}
}
class TabCapture{
 constructor({hide=()=>()=>{},onState=()=>{}}={}){Object.assign(this,{hide,onState});this.stream=null;this.video=null;this.marker=null;}
 get ready(){return !!this.stream?.getVideoTracks().some(t=>t.readyState==='live');}
 async enable(){
  this.stop();if(!navigator.mediaDevices?.getDisplayMedia||!root.CropTarget?.fromElement)throw Error('此 Chrome 不支援分頁圖片擷取，請改用擴充套件');
  // Called only by a direct click on the enable button: Chrome presents its own tab picker.
  const stream=await navigator.mediaDevices.getDisplayMedia({video:{displaySurface:'browser',frameRate:10},audio:false,preferCurrentTab:true,selfBrowserSurface:'include'});
  try{const track=stream.getVideoTracks()[0];if(track.getSettings().displaySurface!=='browser'||!track.cropTo)throw Error('請只選目前的 Teams 瀏覽器分頁，不要選整個螢幕或視窗');
   // A CropTarget from this document must belong to the captured tab. A different tab rejects.
   this.marker=document.createElement('div');this.marker.setAttribute('aria-hidden','true');this.marker.style.cssText='position:fixed;inset:0;pointer-events:none;background:transparent;z-index:-2147483647';document.documentElement.append(this.marker);const target=await CropTarget.fromElement(this.marker);await track.cropTo(target);
   this.stream=stream;this.video=document.createElement('video');this.video.muted=true;this.video.playsInline=true;this.video.srcObject=stream;await this.video.play();track.addEventListener('ended',()=>this.stop(),{once:true});this.onState(true);
  }catch(e){for(const t of stream.getTracks())t.stop();this.stream=null;this.video=null;this.marker?.remove();this.marker=null;throw e;}
 }
 stop(){this.marker?.remove();this.marker=null;const stream=this.stream;this.stream=null;for(const t of stream?.getTracks()||[])t.stop();if(this.video){this.video.pause();this.video.srcObject=null;this.video=null;}this.onState(false);}
 async capture(rectangle){
  if(!this.ready)throw unavailable('此圖片受網頁限制，請按「啟用圖片擷取」、選擇此 Teams 分頁後續抓；文字進度已保存');
  const restore=this.hide();
  try{await frame();const video=this.video;if(!video)throw unavailable('圖片擷取已停止');
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(unavailable('沒有收到新的分頁畫面，請重新啟用圖片擷取')),5000);video.requestVideoFrameCallback(()=>{clearTimeout(timer);resolve();});});
   const r=rectangle(),sx=video.videoWidth/r.viewWidth,sy=video.videoHeight/r.viewHeight;if(!sx||!sy)throw unavailable('分頁影像尚未就緒');
   const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(r.width*sx));canvas.height=Math.max(1,Math.round(r.height*sy));canvas.getContext('2d').drawImage(video,r.x*sx,r.y*sy,r.width*sx,r.height*sy,0,0,canvas.width,canvas.height);return pngBlob(canvas);
  }finally{restore();}
 }
}
function blobFromDataURL(data){const raw=atob(data.split(',')[1]),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);return new Blob([bytes],{type:'image/png'});}
function extensionCapture(){return {ready:true,async capture(rectangle){const r=await chrome.runtime.sendMessage({action:'capture-image',rect:rectangle()});if(!r?.ok)throw unavailable(r?.error||'無法擷取圖片，請保持 Teams 分頁在前景並重新點擴充套件');return blobFromDataURL(r.dataURL);}};}
root.TeamsChatImages={MediaStore,TabCapture,candidates,describe,filename,capture,extensionCapture,blobFromDataURL};
})(globalThis);
