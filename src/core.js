import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';

export const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 20);
export function parseDate(value) {
  if (typeof value !== 'string') throw new Error('日期必須為文字');
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value);
  if (local) {
    const [, y, mo, d, h = '00', mi = '00', s = '00'] = local;
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`;
    const date = new Date(iso);
    if (!Number.isFinite(+date) || new Date(+date + 8 * 3600000).toISOString().slice(0, 19) !== `${y}-${mo}-${d}T${h}:${mi}:${s}`)
      throw new Error(`無效日期：${value}`);
    return date.toISOString();
  }
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error(`日期格式錯誤：${value}；請用 YYYY-MM-DD HH:mm 或含時區的 ISO 日期`);
  // Validate the calendar portion separately; Date.parse normalizes invalid days.
  parseDate(value.slice(0, 10));
  return new Date(value).toISOString();
}
export function dateRange(from, to, now = new Date()) {
  const end = to ? parseDate(to) : now.toISOString();
  const start = from ? parseDate(from) : new Date(Date.parse(end) - 86400000).toISOString();
  if (Date.parse(start) >= Date.parse(end)) throw new Error('開始時間必須早於結束時間');
  return { from: start, to: end, timezone: 'Asia/Taipei' };
}
export const inRange = (time, range) => Number.isFinite(Date.parse(time)) && Date.parse(time) >= Date.parse(range.from) && Date.parse(time) < Date.parse(range.to);
export const taipei = value => value ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) + ' +08:00' : '時間無法判定';
export async function atomicJSON(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(file + '.tmp', file);
}
export async function acquireLock(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, '.export.lock');
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let pid;
    try { pid = Number(await readFile(file, 'utf8')); } catch {}
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); throw new Error('此工作目錄正在匯出中'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
    } else throw new Error('工作鎖無法判讀；確認沒有工具執行後，刪除 .export.lock');
    await unlink(file);
    return acquireLock(directory);
  }
  await handle.writeFile(String(process.pid));
  return async () => { await handle.close(); await unlink(file).catch(() => {}); };
}
export class Store {
  constructor(dir, state) { this.dir = dir; this.state = state; }
  static async create(dir, range) {
    const state = { version: 1, created: new Date().toISOString(), range, account: null, status: 'running', discovery: { status: 'pending', warnings: [] }, conversations: {}, warnings: [] };
    const store = new Store(dir, state); await store.save(); return store;
  }
  static async load(dir) {
    const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
    if (state.version !== 1) throw new Error('不支援的進度格式');
    dateRange(state.range.from, state.range.to);
    return new Store(dir, state);
  }
  async save() { await atomicJSON(path.join(this.dir, 'state.json'), this.state); }
  addConversation(item) {
    return this.state.conversations[item.key] ??= { ...item, status: 'pending', attempts: 0, messages: [], warnings: [], traversal: {} };
  }
  addMessage(conversation, input, scope) {
    const message = { ...input, scope };
    const existing = conversation.messages;
    if (message.id) {
      message.key = 'id:' + scope + ':' + message.id;
      const found = existing.find(m => m.key === message.key);
      if (found) { Object.assign(found, message); return false; }
    } else {
      // Only deduplicate an exact viewport occurrence within this execution.
      // Across retries a missing ID cannot establish identity: retain both.
      message.uncertainIdentity = true;
      message.key = 'uncertain:' + hash(JSON.stringify([scope, message.author, message.time, message.text, message.links])) + ':' + (message.observation || hash(Math.random()));
      if (existing.some(m => m.key === message.key)) return false;
      if (!conversation.warnings.includes('部分訊息沒有穩定識別值；保留可能的重複訊息')) conversation.warnings.push('部分訊息沒有穩定識別值；保留可能的重複訊息');
    }
    existing.push(message); return true;
  }
  async render() {
    await mkdir(path.join(this.dir, 'conversations'), { recursive: true, mode: 0o700 });
    const combined = [`Teams 文字匯出`, `${taipei(this.state.range.from)} ≤ 訊息時間 < ${taipei(this.state.range.to)}`, ''];
    const report = [];
    let total = 0, unknown = 0;
    for (const c of Object.values(this.state.conversations)) {
      const selected = c.messages.filter(m => inRange(m.time, this.state.range) || !m.time);
      total += selected.filter(m => m.time).length;
      unknown += selected.filter(m => !m.time).length;
      selected.sort((a,b) => (a.time || '').localeCompare(b.time || '') || a.key.localeCompare(b.key));
      const lines = [`=== ${c.name} ===`, `狀態：${c.status}`, `來源：${c.url || '無直接連結'}`, ''];
      for (const m of selected) {
        lines.push(`[${taipei(m.time)}] ${m.author || '作者無法判定'}${m.parent ? ` （回覆 ${m.parent}）` : ''}`, m.text);
        if (m.quote && !m.parent) lines.push('引用／回覆原文：' + m.quote);
        if (m.rawTime && !m.time) lines.push('原始時間：' + m.rawTime);
        if (m.uncertainIdentity) lines.push('[識別不確定：可能與其他紀錄重複]');
        if (!m.time) lines.push('[日期無法解析：未確認是否在匯出範圍內]');
        for (const l of m.links || []) lines.push(`連結／附件：${l.text || ''} ${l.url || ''}`.trim());
        lines.push('');
      }
      const filename = c.name.replace(/[\/\\\x00-\x1f:*?"<>|]/g, '_').slice(0, 70) + '-' + hash(c.key) + '.txt';
      await writeFile(path.join(this.dir, 'conversations', filename), lines.join('\n'), { mode: 0o600 });
      combined.push(...lines);
      report.push({ key: c.key, name: c.name, status: c.status, messagesInRange: selected.filter(m => m.time).length, unknownTime: selected.filter(m => !m.time).length, warnings: c.warnings, traversal: c.traversal, error: c.error });
    }
    const complete = this.state.status === 'finished' && this.state.discovery.status === 'complete' && report.length > 0 && report.every(c => c.status === 'complete' && !c.unknownTime);
    const output = { status: complete ? 'scan-complete' : 'partial', range: this.state.range, account: this.state.account, discovery: this.state.discovery, totalMessagesInRange: total, unknownTimeMessages: unknown, conversations: report, warnings: this.state.warnings, note: '僅反映網頁掃描結果，不代表伺服器端備份完整性。' };
    await atomicJSON(path.join(this.dir, 'report.json'), output);
    await writeFile(path.join(this.dir, 'all.txt'), combined.join('\n'), { mode: 0o600 });
    await writeFile(path.join(this.dir, 'report.txt'), [`匯出狀態：${output.status}`, `訊息：${total}；時間不明：${unknown}`, `列舉狀態：${this.state.discovery.status}`, ...(this.state.discovery.excluded || []), this.state.discovery.caveat || '', ...this.state.discovery.warnings, ...this.state.warnings, ...report.map(c => `${c.status}\t${c.name}\t${c.messagesInRange} 則\t${c.error || ''}\t${c.warnings.join('；')}`), output.note].join('\n'), { mode: 0o600 });
    return output;
  }
}
