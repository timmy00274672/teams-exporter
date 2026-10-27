/* Rendered-DOM readers for the local Teams build. */
(function(root){
// Runs only against the rendered DOM. Never reads application stores or network traffic.
function readMessages() {
  const visible = e => !!e && e.getClientRects().length > 0;
  return [...document.querySelectorAll('[id^="message-body-"]')].filter(visible).map((body, index) => {
    const id = body.getAttribute('data-mid') || body.id.slice('message-body-'.length);
    const byId = prefix => document.getElementById(prefix + id);
    const content = byId('content-') || body.querySelector('[data-message-content]');
    const time = byId('timestamp-');
    const author = byId('author-');
    const links = [...(content || body).querySelectorAll('a[href]')].map(a => ({text: a.innerText || a.getAttribute('aria-label') || '', url: a.href})).filter(a => /^https?:/.test(a.url));
    const attachments = byId('attachments-') || body.querySelector('[data-tid="file-attachment-grid"]');
    if (attachments) {
      for (const a of attachments.querySelectorAll('a[href]')) if (/^https?:/.test(a.href)) links.push({text: a.innerText || a.getAttribute('aria-label') || '', url: a.href});
      const text = attachments.innerText.trim();
      if (text) links.push({text, url: null});
    }
    const images = [...(content || body).querySelectorAll('img')].map(e => e.alt || e.getAttribute('aria-label') || '圖片');
    // A quoted reply is part of the body; preserve the quote text and DOM target, if exposed.
    const quote = content?.querySelector('[data-track-module-name="messageQuotedReply"], [data-tid*="quoted"], [data-reply-to-id], blockquote');
    const parent = body.getAttribute('data-reply-to-id') || quote?.getAttribute('data-reply-to-id') || quote?.getAttribute('data-message-id') || null;
    return {id: id || null, author: author?.innerText?.trim() || null, rawTime: time?.getAttribute('datetime') || time?.getAttribute('aria-label') || time?.textContent || null,
      time: time?.getAttribute('datetime') || null,
      text: [content?.innerText?.trim() || '', ...images.map(x=>'[圖片：'+x+']')].filter(Boolean).join('\n') || body.innerText.trim(),
      images: root.TeamsChatImages ? root.TeamsChatImages.candidates(body).map(root.TeamsChatImages.describe) : [],
      links, parent, quote: quote?.getAttribute('aria-label') || quote?.innerText || null, index,
      truncated: [...body.querySelectorAll('button')].some(b=>visible(b) && /^(see more|read more|show more|顯示更多|查看更多|閱讀更多|展开|展開)$/i.test((b.innerText || b.getAttribute('aria-label') || '').trim()))};
  });
}
function readRail() {
  const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const tree = [...document.querySelectorAll('[role="tree"]')].find(visible);
  if (!tree) return {items: [], folders: [], top: null, bottom: null, loading: true};
  const items = [...tree.querySelectorAll('[role="treeitem"][data-item-type="chat"], [role="treeitem"][data-item-type="muted-chat"]')].filter(visible).map(e => {
    const value = e.getAttribute('data-fui-tree-item-value');
    const title = e.querySelector('[id^="title-chat-list-item_"]');
    const id = title?.id.slice('title-chat-list-item_'.length) || value?.split('|').at(-1);
    const name = title?.innerText?.trim();
    return {key: id, name, value, type:'chat', latest: e.querySelector('time[datetime]')?.getAttribute('datetime') || null};
  }).filter(e=>e.key && e.name);
  const folders = [...tree.querySelectorAll('[role="treeitem"][data-conversation-folder="true"][aria-expanded="false"]')].filter(visible).map(e=>e.getAttribute('data-fui-tree-item-value'));
  return {items, folders, top: tree.scrollTop, bottom: tree.scrollHeight - tree.clientHeight - tree.scrollTop, loading: !!tree.querySelector('[role="progressbar"], [aria-busy="true"]'),
    filtered: [...document.querySelectorAll('[aria-checked="true"], [aria-pressed="true"]')].filter(e=>visible(e) && /^(Unread|Chats|Meeting chats|未讀|聊天|會議聊天|未读|会议聊天)$/i.test((e.getAttribute('aria-label') || e.innerText || '').trim())).map(e=>e.getAttribute('aria-label') || e.innerText),
    moreValues: [...tree.querySelectorAll('[role="treeitem"][data-fui-tree-item-value$="load-next-page"]')].filter(visible).map(e=>e.getAttribute('data-fui-tree-item-value')),
    moreLabels: [...tree.querySelectorAll('button,[role="treeitem"]')].filter(e=>visible(e) && /^(show more|see more|load more|show all|顯示更多|查看更多|載入更多|显示更多|加载更多|See all chats|所有聊天)$/i.test(e.innerText.trim())).map(e=>e.innerText.trim())};
}
function readPane() {
  const visible = e => !!e && e.getClientRects().length > 0;
  const root = document.querySelector('[data-tid="app-layout-area--main"]') || document.body;
  const viewport = [...root.querySelectorAll('[data-tid="message-pane-list-viewport"]')].find(visible);
  const header = document.querySelector('[data-tid="chat-header"]') || document.querySelector('[id^="chat-header-"]');
  const title = document.querySelector('[data-tid="chat-title"]')?.innerText?.trim();
  const busy = [...root.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(visible);
  const text = root.innerText || '';
  const startMarker = /(?:This is the beginning of (?:your |the )?(?:chat|conversation)|This is the start of (?:your |the )?(?:chat|conversation)|這是.*(?:聊天|對話)的開頭|这是.*(?:聊天|对话)的开头)/i.test(text);
  const empty = /(?:No messages (?:yet|here)|There are no messages|Start a conversation|尚無訊息|還沒有訊息|暂无消息|尚無聊天記錄)/i.test(text);
  const replies = [...root.querySelectorAll('button')].filter(e=>visible(e) && /(?:\d+ replies|View thread|Open thread|\d+ 則回覆|查看討論串|\d+ 条回复)/i.test(e.getAttribute('aria-label') || e.innerText || '')).length;
  return {title, headerId: header?.id || null, viewport: !!viewport, top: viewport?.scrollTop ?? null, bottom: viewport ? viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop : null, busy, startMarker, empty, replies};
}

root.TeamsChatDOM={readMessages,readRail,readPane};
})(globalThis);
