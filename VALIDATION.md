# 驗證紀錄

2026-10-27，以使用者登入的 Teams 網頁驗證。未呼叫 Teams／Graph API，未安裝下列第三方擴充套件。

## 實際匯出

| 項目 | 結果 |
| --- | --- |
| 網頁擷取欄位 | 觀察到的 26 則群組訊息皆有作者、完整 datetime 與穩定 ID；含 2 則有連結訊息、1 則引文回覆 |
| 清單列舉 | 跨載入更多後列舉到 164 個聊天，稍後執行時為 165 個；含靜音與會議聊天 |
| 群組聊天 | `exports/live-validation/`：最近 24 小時 117 則，聊天本身完整覆蓋時間範圍 |
| 一對一聊天 | `exports/live-direct-chat/`：最近 24 小時 8 則，聊天本身完整覆蓋時間範圍 |
| 會議聊天 | `exports/live-meeting-chat/`：3 則確定在時間內，另有 74 則歷史紀錄缺少可解析的時間／作者；保留並標示範圍不明，聊天為 partial |

三次皆以 `--only` 驗證，沒有執行全部聊天匯出，因此整次報告皆為 `partial`。會議聊天的未知時間項目顯示，結果不可當作完整備份；工具沒有把訊息 ID 或目前時間當作訊息時間猜填。

## 自動測試

執行 `npm test`，以本機模擬頁面及已安裝 Chrome 驗證：

- 台北時區、跨日、最近 24 小時、日期合法性與包含開始／不含結束。
- 穩定識別值去重、編輯訊息、同文字的不同訊息及身分不確定時保留。
- 進度保存與重載、固定時間範圍、工作鎖、完成／失敗狀態及未知時間報告。
- 多行文字、圖片描述、附件連結、引文、靜音聊天與載入更多。
- 長對話捲動、DOM 回收後仍保留先前訊息、登入等待及登入逾時。

測試不使用真實登入資料或公司訊息。

## 現有工具評估

讀取 GitHub main 分支的 README 及相關程式，未執行第三方程式。

### rahulmasal/TeamsChatDownloader

[專案](https://github.com/rahulmasal/TeamsChatDownloader)

擴充套件與 Tampermonkey 版本是 DOM 擷取，Graph CLI 是另外的版本。TXT 輸出及自動捲動可以參考，但無法直接滿足本次需求：

- [manifest.json](https://github.com/rahulmasal/TeamsChatDownloader/blob/main/manifest.json) 與 userscript 的 match 網域只有 teams.microsoft.com、teams.live.com；不含實際帳號使用的 teams.cloud.microsoft。
- [content.js](https://github.com/rahulmasal/TeamsChatDownloader/blob/main/content.js) 只對目前開啟的聊天掃描；沒有自動列舉所有聊天與本次需要的日期範圍／續抓介面。
- [shared-utils.js](https://github.com/rahulmasal/TeamsChatDownloader/blob/main/shared-utils.js) 在捲動完成後才擷取一次；就虛擬捲動回收 DOM 的行為而言，有漏掉已卸載訊息的風險。時間解析失敗會用 Date.now()，不適合直接做可靠的日期篩選。
- shared-utils 與 userscript 會向 raw.githubusercontent.com 讀取 selectors.json；這不是上傳聊天，但也不是完全離線執行。

結論：可當 DOM 實作參考，需要修改網域、逐頁累積、時間處理與批次聊天功能；不建議原封不動取代本工具。

### gediz/teams-web-chat-exporter

[README](https://github.com/gediz/teams-web-chat-exporter/blob/main/README.md)

支援多聊天、日期範圍與 TXT 等格式；README 明列以既有登入狀態使用 Teams Chat Service API。只有單聊天 API 不可用時才回退 DOM，批次多聊天不提供 DOM fallback。因此若限制是不能使用任何 Teams API，不能直接採用；若限制只是無法申請 Graph 權限，則值得評估。

### gildas-lormeau/single-file-export-chat

[專案](https://github.com/gildas-lormeau/single-file-export-chat)

作者已在 README 明列擴充套件失效，倉庫於 2023-07-11 封存，不採用。
