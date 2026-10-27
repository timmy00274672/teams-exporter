# Teams Exporter

讓本機 AI 呼叫的 Teams 命令列匯出工具。使用 Playwright 操作專用 Chrome，不需安裝外掛，不呼叫 Graph 或 Teams 內部 API。支援一對一、群組與會議聊天，略過全部頻道。

## 安裝

這版先支援 macOS、Node.js 20 以上及已安裝的 Google Chrome。

```sh
cd ~/workspace/teams-exporter
npm install
npm link
npm run skills:install
```

程式、測試、使用說明與 `skills/teams-dump/SKILL.md` 都在這個 repo。Skill 安裝器只建立 `~/.agents/skills/teams-dump` 的連結，不複製另一份；Codex 與 OpenCode 都可從該位置探索 Skill。依據 [Codex 官方文件](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills) 與 [OpenCode 官方文件](https://opencode.ai/docs/skills)。必要時重新啟動 AI 客戶端。

首次執行會開啟專用 Chrome，請在其中登入。舊版 CLI 的獨立設定檔 `.local/chrome-profile` 存在時會沿用；否則使用 `.local/cli/chrome-profile`。不會讀取日常 Chrome 的登入資料。

## AI 日常使用

```sh
teams-dump update --background --json
teams-dump status <工作編號> --json
teams-dump stop <工作編號> --json
teams-dump resume <工作編號> --background --json
```

背景掃描立即回傳工作編號，不需保持終端機開啟。AI 先查 `status`，完成後讀回傳的 `paths.report` 與 `paths.changes`。回報 `waiting-login` 時，在專用視窗重新登入；逾時則保存進度並失敗，可用 `resume` 接續。工作仍在跑時不需另外續抓。

`stop` 是停止請求；查到 `interrupted` 才是已保存並停止。同一安裝一次只能掃描一個工作，其他 AI 請先追蹤正在執行的工作。不要在專用視窗手動切換聊天。

```sh
teams-dump
teams-dump --from "2026-10-26 09:00" --to "2026-10-27 09:00" --background --json
teams-dump --login
teams-dump export --json
teams-dump --help
```

首次預設最近 24 小時；未帶時區採台北時間，包含開始、不含結束，結束時間固定為啟動當下。`export` 另行產生完整累積文字、JSON 與引用圖片，預設不會將整份歷史交給 AI。

## 進度、增量與輸出

- 每批訊息、圖片與進度採本機原子寫入，聊天分檔保存；頁面只傳變動訊息，狀態查詢讀取小型摘要。`resume` 使用同一工作編號及原時間範圍，跳過已完成聊天和任務。
- 已確認掃完最新區段後，保存穩定訊息 ID 作為向前掃描的錨點。續抓先捲動定位，略過已處理區段；錨點被刪除或無法定位時，回到一般掃描並重用已存資料。仍可能需要捲動，不保證瞬間跳回。
- `update` 依各聊天的成功覆蓋區段續接到本次結束時間，回讀最多 24 小時的既有區段以比對；過去尚未完成的缺口和失敗圖片另外補抓。新出現的聊天先掃本次最近 24 小時。
- 聊天 ID＋訊息 ID 去重，同 ID 的文字、作者、時間、連結或圖片描述改變列為更新。無穩定 ID 的項目保守保留，標示識別不確定，不將同字的不同訊息合併。
- TXT 每則訊息有獨立起訖標記及明確的聊天、發送者、時間、訊息 ID。圖片使用「本機圖片附件」區塊，寫明所屬訊息、相對檔案路徑、保存狀態與讀取方式；替代文字不是圖片摘要。可由 DOM 確認的引用會分區，無法拆分的轉傳保留原文並註記，不猜測原作者。
- 每個工作的差異以開始前的資料為基準；同一工作中斷續抓後，結果仍涵蓋該工作的全部新增／更新，不會只剩最後一段。

預設本機資料位於 `.local/cli/`，可用 `--data` 或 `TEAMS_DUMP_DATA` 指定。工作編號及帳號資料分開保存；首次登入使用的帳號會鎖定該工作，續抓時核對。跨次更新依實際登入帳號分開累積。

```text
.local/cli/
  accounts/                  帳號索引及各聊天累積快照、覆蓋與清單篩選證據
  images/                    共用 PNG 快取（工作附件以 hard link 共用）
  jobs/<工作編號>/
    state.json               原始範圍及聊天快照索引
    conversations/           每個聊天的可續抓快照
    progress.json            狀態查詢用的小型摘要
    baseline.json            本次開始前的比對基準
    changes.txt              本次新增／更新，含圖片檔名與連結
    changes.json             added / updated / images-saved / uncertain
    report.json              掃描狀態、各聊天覆蓋與缺漏
    images/                  本次變動引用的圖片，可整包搬移；同磁碟使用 hard link
```

沒有變動時，文字明確記錄「本次沒有新增或更新內容」。訊息或圖片快取遺失時會補抓；保存失敗保留頁面可取得的連結與原因。圖片以頁面已載入的像素存成 PNG；跨來源限制時裁切專用分頁，不下載媒體 API、不做 OCR。截圖不保證原始解析度，動畫保留當下影格。文件附件只保留名稱及連結。

`report.json` 的每個聊天分開列出掃描覆蓋、文字／時間／作者警告及圖片缺漏。`partial` 仍有可用結果，不能當成完整成功。`--only "精確名稱"` 可測單一聊天，但整體報告會標為部分範圍。

退出碼：0 完成或背景請求已接受；2 部分完成；1 執行錯誤；130 中斷。使用 JSON 時，正常輸出只含 JSON；背景除錯資訊留在工作的 `worker.log`。

## 限制與相容性

- 操作 Teams 可能將聊天標為已讀。只涵蓋網頁可列舉與讀取的內容，不等同伺服器備份。
- 增量不保證發現回讀時段之前的編輯、刪除或獨立討論串變動；獨立討論串會註記部分完成。先前已存的訊息不因頁面沒顯示就當成刪除。
- 畫面沒有完整時間的紀錄保留並註記。它們不會阻止其他有序、可確認日期的訊息觸發時段停止條件。
- `--max-steps` 預設每階段 2000 次；到上限仍未確認邊界會回報部分完成。預設依頁面載入與穩定狀態等待（側欄至少 300ms、訊息區至少 650ms，側欄與訊息區分開判斷，影片自己的載入指示不阻止文字掃描），明確指定 `--delay` 時使用固定等待（最低 200ms）。
- 舊版 CLI（`src/` 引擎）的匯出進度與 Tampermonkey／外掛進度不自動遷移。舊輸出及專用登入設定檔保留，舊原始碼可從 Git 歷史取得。
- 登入設定檔、本機訊息、圖片與測試匯出均受 `.gitignore` 排除。

DOM 讀取及圖片處理借鑑 [TeamsChatDownloader](https://github.com/rahulmasal/TeamsChatDownloader) 的[本機 DOM 改版](https://github.com/timmy00274672/TeamsChatDownloader/tree/8508fe8)（基準 `8508fe8`），保留 MIT 授權。此 repo 的命令列入口共用同一掃描引擎，不需 Chrome 外掛。

## 圖片硬碟空間

工作結果與完整匯出的圖片優先使用 hard link，與快取共用同一份檔案資料，保留原本的 `images/` 路徑；跨磁碟或檔案系統不支援時退回複製。圖片更新使用原子替換，保留舊工作看到的舊版本；刪除其中一個連結也不會讓其餘路徑失效。相同檔名但內容不同的版本不會合併。

舊副本可用 `node scripts/dedupe-images.cjs` 預覽，再加 `--apply` 合併。範圍限此 repo 的 `.local/cli*` 圖片快取、工作／完整匯出附件及 `exports/`，依 SHA-256 比對內容，只在同一磁碟合併，不掃描 Chrome 登入設定檔。此操作與掃描共用工作鎖。

## 清單時間篩選與效能

開啟聊天前先讀取清單的完整最新時間，並依該聊天的增量／補抓範圍規劃任務。時間早於任務開始、且沒有已開始的中斷／失敗或圖片待補抓時，標示 `skipped-out-of-range`，不打開聊天。資料夾、置頂及時間回跳逐項處理，仍列舉完整清單。時間不明、恰好等於開始、或晚於結束都需讀取；晚於結束的聊天仍可能含有範圍內訊息。

`teams-dump --full-scan` 可強制開啟聊天，`--only` 也會略過時間篩選。清單篩選僅依最新活動時間，不保證發現未反映在該時間上的舊內容編輯或刪除。

`status --json`／`report.json` 的 `statistics` 列出 listed、skipped、opened、completed、failed、repairPending、pending。每項任務的 `method` 分別為 list-screened、dom 或 unconfirmed；清單篩選的時間範圍、來源與觀察時間另行保存，不冒充實際讀取訊息的覆蓋。

`metrics.browser` 記錄清單、導航、訊息、圖片、等待耗時及重定位次數；`metrics.host` 記錄總執行時間、保存耗時、接收資料量、進度／索引寫入量與圖片存在性檢查數。各階段包含其內部等待、存檔等時間，不能直接相加當作總耗時。

既有 0.2.x 進度會自動轉成分檔格式，轉換時保留 legacy-state.json；舊帳號資料另保留 .legacy.json。原工作時間及比對基準不變。續抓只對尚未打開的項目新增篩選，已開始、失敗或待補圖的任務保留處理。
