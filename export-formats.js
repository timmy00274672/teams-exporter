/* Shared by the popup and standalone userscript. */
(function(root){
'use strict';
const time=value=>value===null?'時間不明':new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value))+' +08:00';
function exportObject(job){
 const conversations=job.conversations.map(c=>({...c,messages:c.messages.filter(m=>m.timestamp===null||['history','changes'].includes(job.mode)||(m.timestamp>=job.range.from&&m.timestamp<job.range.to)).sort((a,b)=>(a.timestamp??Infinity)-(b.timestamp??Infinity)||a.key.localeCompare(b.key))}));
 return {...job,note:'僅反映已載入網頁的掃描結果；時間不明訊息未確認是否在指定範圍內。',conversations,messageCount:conversations.reduce((n,c)=>n+c.messages.length,0)};
}
function legacyBody(m){
 let body=m.text||'',match;const hints=[];
 // Older captures appended these placeholders; they never represented file paths.
 while((match=/(?:^|\n)\[圖片：([^\]\n]*)\]\s*$/.exec(body))){hints.unshift(match[1]);body=body.slice(0,match.index).trimEnd();}
 return {body,hints};
}
function text(job){
 const j=exportObject(job),lines=['Teams 聊天匯出',`狀態：${j.status}`,`範圍：${time(j.range.from)} ≤ 訊息時間 < ${time(j.range.to)}`,`模式：${j.mode}；${j.messageCount} 則（含時間不明紀錄）`,j.note,...j.warnings,j.discovery.warning||'',j.error||'',
 '圖片讀取規則：「圖片檔案」指本機實際檔案，路徑相對於本 TXT 所在資料夾；請以圖片工具開啟檔案後再解讀。替代文字不是圖片內容摘要。',
 '訊息區塊內的圖片均屬於該訊息；引用或轉傳中的姓名、日期不代表本則訊息的發送者。',''];
 if(j.mode==='changes')lines.push('本次只列出新增、更新、補存圖片及識別不確定的內容；可能包含較早缺口。','');
 if(j.mode==='history')lines.push('本次匯出目前聊天全部可讀取歷史，不套用時間範圍。','');
 for(const c of j.conversations){
  lines.push(`=== ${c.name} ===`,`狀態：${c.status}`,...c.warnings,c.error||'','');
  for(const m of c.messages){
   const legacy=legacyBody(m),images=m.images||[],forwarded=(m.attachments||[]).some(a=>/[?&]isForwardDeeplink=true(?:&|$)/i.test(a.url||''));
   const separated=m.bodyText!==undefined&&m.bodySeparated!==false&&!(forwarded&&!m.quote);
   lines.push('[訊息開始]',`聊天：${c.name}`,`訊息 ID：${m.id||m.key||'不明'}`,`發送者：${m.sender}`,`時間：${time(m.timestamp)}`);
   if(m.changeTypes?.length)lines.push('變動種類：'+m.changeTypes.join(', '));
   if(m.parent)lines.push('回覆目標訊息 ID：'+m.parent);
   if(m.quote)lines.push('[引用原文開始]',m.quotedText||m.quote,'[引用原文結束]');
   const bodyLabel=!separated&&(m.quote||forwarded)?'訊息原文（含尚未拆分的引用／轉傳）':'本文';
   lines.push(`[${bodyLabel}開始]`,(separated?m.bodyText:legacy.body)||'（無文字本文）',`[${bodyLabel}結束]`);
   if(m.timestamp===null)lines.push('[時間不明：未判定是否位於範圍內] 原始時間：'+(m.rawTime||'頁面未提供'));
   if(m.uncertainIdentity)lines.push('[識別不確定，可能重複]');
   for(const [i,image]of images.entries()){
    lines.push(`[本機圖片附件 ${i+1} 開始]`,'所屬訊息 ID：'+(m.id||m.key||'不明'),'圖片位置：'+({quote:'引用原文',body:'本文'}[image.context]||'原訊息內；引用／轉傳位置未確認'));
    if(image.status==='saved'&&image.file)lines.push('狀態：已保存為獨立圖片檔','圖片檔案：'+image.file,'讀取方式：以本 TXT 所在資料夾為基準開啟上述檔案');
    else lines.push('狀態：沒有可讀取的本機圖片檔','圖片未保存：'+(image.error||'尚未擷取'));
    lines.push('頁面替代文字（不是圖片解讀）：'+(image.alt||'未提供'));
    if(image.url)lines.push((image.url.startsWith('blob:')?'暫時來源網址（離開原分頁後可能失效）：':'圖片來源連結：')+image.url);
    lines.push(`[本機圖片附件 ${i+1} 結束]`);
   }
   for(const hint of legacy.hints)if(!images.some(i=>i.alt===hint))lines.push('頁面圖片提示（未對應到本機檔案）：'+hint);
   for(const a of m.attachments||[])lines.push('連結／附件：'+(a.text||'')+' '+(a.url||''));
   lines.push('[訊息結束]','');
  }
 }return lines.join('\n');
}
function csv(job){
 const quote=s=>'"'+String(s??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';
 const rows=[['Chat','Time (Asia/Taipei)','Sender','Text','Attachments','Reply','Status']];
 for(const c of exportObject(job).conversations)for(const m of c.messages)rows.push([c.name,time(m.timestamp),m.sender,m.text,(m.attachments||[]).map(a=>(a.text||'')+' '+(a.url||'')).join('\n'),m.parent||m.quote||'',c.status]);
 return '\ufeff'+rows.map(r=>r.map(quote).join(',')).join('\r\n');
}
function html(job){const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');return '<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>Teams 聊天匯出</title><style>body{font:15px system-ui;max-width:1000px;margin:30px auto;padding:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}</style><pre>'+esc(text(job))+'</pre></html>';}
function format(job,type){if(!job)throw Error('尚無匯出資料');switch(type){case 'json':return JSON.stringify(exportObject(job),null,2);case 'csv':return csv(job);case 'html':return html(job);default:return text(job);}}
root.TeamsChatFormats={format,exportObject,time};
})(globalThis);
