/* Small ZIP writer (stored entries, UTF-8 names, CRC32). No network or third-party runtime. */
(function(root){
'use strict';
const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const crc=bytes=>{let c=0xffffffff;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
function header(size){const bytes=new Uint8Array(size),view=new DataView(bytes.buffer);return {bytes,u16:(p,n)=>view.setUint16(p,n,true),u32:(p,n)=>view.setUint32(p,n,true)};}
async function zip(entries){
 const chunks=[],central=[];let offset=0,centralSize=0;
 if(entries.length>65535)throw Error('檔案數超過 ZIP 上限，請縮小匯出時間範圍');
 for(const {name,data}of entries){if(!name||name.startsWith('/')||name.split('/').includes('..'))throw Error('無效 ZIP 檔名');
  const filename=new TextEncoder().encode(name),bytes=data instanceof Blob?new Uint8Array(await data.arrayBuffer()):new TextEncoder().encode(String(data));if(filename.length>65535||bytes.length>0xffffffff||offset+bytes.length+filename.length+30>0xffffffff)throw Error('ZIP 超過 4GB，請縮小時間範圍');
  const checksum=crc(bytes),local=header(30);local.u32(0,0x04034b50);local.u16(4,20);local.u16(6,0x800);local.u16(12,33);local.u32(14,checksum);local.u32(18,bytes.length);local.u32(22,bytes.length);local.u16(26,filename.length);
  chunks.push(local.bytes,filename,bytes);
  const dir=header(46);dir.u32(0,0x02014b50);dir.u16(4,20);dir.u16(6,20);dir.u16(8,0x800);dir.u16(14,33);dir.u32(16,checksum);dir.u32(20,bytes.length);dir.u32(24,bytes.length);dir.u16(28,filename.length);dir.u32(42,offset);central.push(dir.bytes,filename);centralSize+=46+filename.length;offset+=30+filename.length+bytes.length;
 }
 const end=header(22);end.u32(0,0x06054b50);end.u16(8,entries.length);end.u16(10,entries.length);end.u32(12,centralSize);end.u32(16,offset);return new Blob([...chunks,...central,end.bytes],{type:'application/zip'});
}
async function build(job,store){
 const j=structuredClone(root.TeamsChatFormats.exportObject(job)),entries=[],seen=new Set();let saved=0,missing=0;
 if(!j.captureImages)j.warnings.push('此工作未啟用圖片保存；ZIP 只包含文字與原有連結。若需圖片，請啟用圖片擷取後按續抓或重新掃描。');
 for(const c of j.conversations)for(const m of c.messages)for(const image of m.images||[]){
  if(image.status==='saved'&&image.file&&!seen.has(image.file)){
   const blob=await store.get(j.id,image.file);if(blob){entries.push({name:image.file,data:blob});seen.add(image.file);saved++;}
   else{image.status='missing';image.error='本機圖片快取已不存在，需啟用圖片後重新掃描';missing++;c.status='partial';}
  }else if(image.status!=='saved'&&j.captureImages)missing++;
 }
 j.imageReport={saved,missing};if(missing){j.status='partial';j.warnings.push(`${missing} 張圖片未保存，請查看各訊息的圖片連結與原因。`);}
 entries.unshift({name:'chat.txt',data:root.TeamsChatFormats.format(j,'txt')},{name:'report.json',data:JSON.stringify(j,null,2)});
 return zip(entries);
}
root.TeamsChatArchive={zip,build};
})(globalThis);
