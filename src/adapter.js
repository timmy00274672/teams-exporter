import { randomUUID } from 'node:crypto';
import { readMessages, readRail, readPane } from './dom.js';

const attribute = value => JSON.stringify(value);
export class TeamsUI {
  constructor(page, {maxSteps=2000, delay=900, loginTimeout=600000, stop=()=>false, log=console.log}={}) {
    Object.assign(this, {page, maxSteps, delay, loginTimeout, stop, log});
    this.session = randomUUID();
    this.observations = new Map();
  }
  checkStop() { if (this.stop()) throw new Error('使用者已中斷；可用 --resume 續抓'); }
  async settle() { this.checkStop(); await this.page.waitForTimeout(this.delay); }
  async account() {
    const label = await this.page.locator('[data-tid="me-control-avatar-trigger"]').getAttribute('aria-label').catch(()=>null);
    return label?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || null;
  }
  async ready() {
    const end = Date.now() + this.loginTimeout;
    let announced = false;
    while (Date.now() < end) {
      this.checkStop();
      if (this.page.isClosed()) throw new Error('瀏覽器視窗已關閉，進度已保留');
      const host = new URL(this.page.url()).hostname;
      if (/^(?:teams\.microsoft\.com|teams\.cloud\.microsoft)$/.test(host) && await this.page.locator('[data-tid="me-control-avatar-trigger"]').isVisible().catch(()=>false)) return;
      if (!announced) { this.log('正在載入 Teams；若專用 Chrome 出現登入畫面，請完成登入，工具會自動繼續。'); announced = true; }
      await this.page.waitForTimeout(1000);
    }
    throw new Error('等待登入逾時；下次執行 --resume 可繼續');
  }
  async ensureAccount(expected) {
    await this.ready();
    const current = await this.account();
    if (!current) throw new Error('無法從頁面確認登入帳號，停止以免混入其他帳號資料');
    if (expected && current !== expected) throw new Error(`登入帳號與此工作不同（預期 ${expected}）`);
    return current;
  }
  async chatRail() {
    await this.ready();
    // The company uses separate Chat and Teams rails. Also works with the combined Chat rail.
    const button = this.page.locator('[data-tid="app-bar-wrapper"] button[aria-label="Chat"], [data-tid="app-bar-wrapper"] button[aria-label="聊天"]');
    if (await button.count()) await button.first().click();
    else await this.page.getByRole('button', {name:/^(Chat|聊天)$/}).first().click();
    await this.page.locator('[role="tree"]:visible').first().waitFor({timeout:30000});
    // Remove active list filters, never touch a message composer.
    for (let n=0;n<8;n++) {
      const filter = this.page.locator('[role="toolbar"]').getByRole('checkbox', {checked:true});
      if (!await filter.count()) break;
      const f = filter.first();
      if (!/^(Unread|Chats|Meeting chats|未讀|聊天|會議聊天|未读|会议聊天)$/i.test(await f.getAttribute('aria-label') || await f.innerText())) break;
      await f.click(); await this.settle();
    }
  }
  railItem(value) { return this.page.locator(`[role="treeitem"][data-fui-tree-item-value=${attribute(value)}]`).first(); }
  async scrollRail(position) {
    await this.page.locator('[role="tree"]:visible').first().evaluate((e,p)=> {e.scrollTop=p === 'top' ? 0 : e.scrollTop + e.clientHeight * 0.7;},position);
    await this.settle();
  }
  async discover(onItem) {
    await this.chatRail(); await this.scrollRail('top');
    const found = new Map(), expanded = new Set();
    let stable=0, previous='', finished=false;
    const warnings=[];
    for (let step=0;step<this.maxSteps;step++) {
      this.checkStop(); await this.ready();
      const rail = await this.page.evaluate(readRail);
      if (rail.filtered?.length) throw new Error(`聊天清單仍有篩選：${rail.filtered.join(', ')}`);
      for (const item of rail.items) { found.set(item.key,item); await onItem(item); }
      const folder = rail.folders.find(v=>v && !expanded.has(v));
      if (folder) {
        expanded.add(folder);
        await this.railItem(folder).press('ArrowRight'); await this.settle();
        continue;
      }
      // Only click list-specific, exact labels; never broad "more" buttons.
      if (rail.moreValues?.length) {
        await this.railItem(rail.moreValues[0]).click(); await this.settle(); continue;
      }
      if (rail.moreLabels?.length) {
        const more = this.page.locator('[role="tree"]:visible').getByText(rail.moreLabels[0],{exact:true});
        if (await more.count() === 1) { await more.click(); await this.settle(); continue; }
        warnings.push('清單的載入更多按鈕無法唯一識別'); break;
      }
      const signature = JSON.stringify([rail.items.map(x=>x.key),rail.top,rail.bottom]);
      stable = !rail.loading && rail.bottom !== null && rail.bottom <= 2 && signature === previous ? stable+1 : 0;
      if (stable>=4) { finished=true; break; }
      previous=signature; await this.scrollRail('down');
    }
    if (!finished) warnings.push('聊天清單遍歷未達穩定底部，可能有未列舉項目');
    if (!found.size) warnings.push('未列舉到聊天，無法確認此版本的清單結構');
    // Teams offers no server-side proof here; report the observed UI boundary explicitly.
    return {status:finished && found.size ? 'complete' : 'partial', method:'rendered-chat-rail', boundary:'observed-stable-bottom', count:found.size, warnings, excluded:['所有團隊頻道訊息（依使用者要求略過）'], caveat:'清單內未顯示的隱藏／封存聊天可能不在列舉結果中；此為網頁可見清單掃描。'};
  }
  async openConversation(c) {
    await this.chatRail(); await this.scrollRail('top');
    let stale=0,previous='';
    for (let i=0;i<this.maxSteps;i++) {
      const rail = await this.page.evaluate(readRail);
      const item = rail.items.find(x=>x.key===c.key);
      if (item) {
        await this.railItem(item.value).click();
        // The chat header contains the stable ID; do not scrape stale messages from the previous chat.
        await this.page.waitForFunction(key=>[...document.querySelectorAll('[id^="chat-header-"]')].some(e=>e.id==='chat-header-'+key),c.key,{timeout:30000});
        await this.page.locator('[data-tid="message-pane-list-viewport"]:visible').first().waitFor({timeout:30000});
        await this.settle();
        return;
      }
      if (rail.moreValues?.length) {await this.railItem(rail.moreValues[0]).click(); await this.settle(); continue;}
      const folder = rail.folders[0];
      if (folder) { await this.railItem(folder).press('ArrowRight'); await this.settle(); continue; }
      const signature=JSON.stringify([rail.items.map(x=>x.key),rail.top,rail.bottom]);
      stale = signature===previous && rail.bottom<=2 ? stale+1 : 0;
      if (stale>=4) break;
      previous=signature; await this.scrollRail('down');
    }
    throw new Error('聊天不在目前可讀取的清單中，可能已隱藏、移除或介面改版');
  }
  async movePane(direction) {
    await this.page.locator('[data-tid="message-pane-list-viewport"]:visible').first().evaluate((e,d)=>{e.scrollTop = d==='bottom' ? e.scrollHeight : e.scrollTop-e.clientHeight*0.65;},direction);
    await this.settle();
  }
  async expandText() {
    const messages = this.page.locator('[id^="message-body-"]:visible');
    const buttons = messages.getByRole('button',{name:/^(see more|read more|show more|顯示更多|查看更多|閱讀更多|展开|展開)$/i});
    for (let i=0;i<50 && await buttons.count();i++) {
      const button = buttons.first();
      if (!await button.isVisible()) break;
      await button.click(); await this.settle();
    }
  }
  normalize(m,c,pass) {
    // Only trust absolute DOM datetime. Localized relative text must never be guessed.
    if (!m.time || !Number.isFinite(Date.parse(m.time)) || !/(Z|[+-]\d\d:\d\d)$/.test(m.time)) m.time=null;
    else m.time=new Date(m.time).toISOString();
    if (!m.id) {
      const signature=JSON.stringify([c.key,m.author,m.time,m.text,m.links,m.index]);
      let observed=this.observations.get(signature);
      if (!observed) { observed=this.session+':'+pass+':'+this.observations.size; this.observations.set(signature,observed); }
      m.observation=observed;
    }
    return m;
  }
  async scan(c,range,onMessages,expected) {
    await this.ensureAccount(expected); await this.openConversation(c);
    const warnings = [], traversal={lower:null,upper:null};
    // First seek current bottom, preserving each viewport in case a large jump loads messages.
    let previous='', stable=0, reachedBottom=false;
    const capture = async pass => {
      await this.ensureAccount(expected); await this.expandText();
      const pane = await this.page.evaluate(readPane);
      if (pane.headerId !== 'chat-header-'+c.key) throw new Error('目前顯示的聊天與目標不同，已停止讀取');
      const messages=(await this.page.evaluate(readMessages)).map(m=>this.normalize(m,c,pass));
      await onMessages(messages);
      if (pane.replies) warnings.push('此聊天有獨立討論串回覆，第一版未展開；結果不完整');
      if (messages.some(m=>m.truncated)) warnings.push('部分訊息未成功展開全文');
      return {pane,messages};
    };
    for (let i=0;i<this.maxSteps;i++) {
      const {pane,messages}=await capture('bottom');
      const signature=JSON.stringify([messages.map(m=>m.id || m.text),pane.bottom]);
      stable=!pane.busy && pane.bottom!==null && pane.bottom<=2 && signature===previous ? stable+1 : 0;
      if (stable>=3) {reachedBottom=true; traversal.upper='observed-stable-bottom'; break;}
      previous=signature; await this.movePane('bottom');
    }
    if (!reachedBottom) warnings.push('未確認聊天最新訊息的底部邊界');
    previous='';stable=0;
    let reachedStart=false;
    for (let i=0;i<this.maxSteps;i++) {
      const {pane,messages}=await capture('up');
      const dated=messages.filter(m=>m.time);
      // Chat list is chronological; crossing the lower bound is sufficient only without independent threads.
      const ordered=dated.every((m,j)=>j===0 || Date.parse(dated[j-1].time)<=Date.parse(m.time));
      if (!pane.busy && messages.length>0 && messages.every(m=>m.time) && ordered && dated.some(m=>Date.parse(m.time)<Date.parse(range.from))) {
        reachedStart=true;traversal.lower='crossed-range-start';break;
      }
      if (!pane.busy && (pane.startMarker || pane.empty)) {reachedStart=true;traversal.lower=pane.empty?'explicit-empty':'explicit-start';break;}
      const signature=JSON.stringify([messages.map(m=>m.id || m.text),pane.top]);
      stable=!pane.busy && pane.top!==null && pane.top<=2 && signature===previous ? stable+1 : 0;
      if (stable>=4) {traversal.lower='observed-stable-top';warnings.push('已達穩定頂部，但頁面未提供明確起始標記，無法確認更早歷史已完整載入');break;}
      previous=signature;await this.movePane('up');
    }
    if (!reachedStart && !traversal.lower) warnings.push('達到捲動上限，尚未覆蓋開始時間');
    if (c.messages.some(m=>!m.author)) warnings.push('部分訊息無法確認作者');
    if (c.messages.some(m=>!m.time)) warnings.push('部分訊息缺少可解析的完整時間，請參考原始紀錄');
    return {status:reachedBottom && reachedStart && !warnings.length?'complete':'partial',warnings:[...new Set(warnings)],traversal};
  }
}
