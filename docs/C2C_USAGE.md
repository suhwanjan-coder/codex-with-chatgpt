# C2C 使用說明

## 入口

在本專案任務中說 `C2C`，並指出要處理的程式或問題即可。
同一核准批次直接執行；新資料只合併確認一次範圍，不另外發明使用口令。

## 會發生什麼

- 操作者（Codex）擁有全部步驟：定義任務、挑選最小 snapshot、執行、修改、測試、驗證與清理。
- ChatGPT 只讀取經核准的固定 snapshot 提供建議；它不讀 live repository，也沒有寫入或執行權。
- local workflow 支援明確分類的 `public` 或經審閱的 `non-sensitive` 內容；`synthetic` 舊證據保留作歷史參考。
- 未分類內容不外送。已實測十個真實任務，涵蓋程式理解、缺陷審查與歷史改動審查。

## 核准邊界

- 真實 permit 必須綁定 exact snapshot 的 `reviewedSnapshotDigest`，並取得目的地綁定的批准。
- 每批只對 exact scope 取得一次 action-time 合併批准；範圍、內容、目的地、model 或限制改變就要重新批准。
- 已消耗或到期的 snapshot 不重用；只有事先批准的範圍才可做一次有紀錄的重試。
- 不全域安裝 skill，不默默修改全域設定，不把 C2C 變成永久 connector。

## 資料禁止

不得使用病人資料、院內機密、憑證、未知來源或未分類敏感資料；public provenance
也不等於沒有秘密。資料分類與逐項 inspect 是操作者責任。

## 目前進度與完成證明

完成必須有直接 evidence：實際 findings、擷取 findings 後立即停止遠端、Codex 的
本機修正與相關測試、清理回執及未觀察項目。十案已核對讀取範圍、token 歸零、
公開端點關閉及暫時外掛移除；失敗啟動與基準重試紀錄保留。

實用性 7/10；補量測十案共 30 次資料工具呼叫。
十組答案 Ordinary 通過 10/10、C2C 8/10，完整流程中位耗時 3.75／7.19 分鐘。
本批未量到淨額度收益，也未確認顧問入口的額度歸屬；不能用耗時比較判定省不省額度。
若把工作轉交給獨立額度入口，能轉移 Codex 工作量，但仍須扣除交接與驗證成本。
ChatGPT Work 與 Codex 共用額度，不能只因在 ChatGPT 網頁操作就宣稱節省。
來源：[官方額度規則](https://learn.chatgpt.com/docs/pricing)（2026-08-31 核對）。
原生 file-symlink 測試受 Windows 權限限制，沒有完整原生驗證。
詳見[真實使用報告](C2C_REAL_ACCEPTANCE.md)。撤權不會刪除 ChatGPT 已收到的內容。

目前定位：明確需要 ChatGPT 讀受控程式碼、取得可追溯第二意見時使用。
你說「C2C，檢查這個專案的登入流程」，Codex 就執行整套作業；只在新的資料／目的地範圍核准一次。
簡單修改仍用 Ordinary Codex；重大架構／風險判斷才用 AI Council。

詳見[完整操作指南](HARDENED_REVIEW.md)與[本專案 C2C Skill](../skill/SKILL.md)。

換電腦請讀[跨機接手說明](C2C_CROSS_MACHINE.md)；程式放各機本機，Git 同步版本，雲端同步交接文件。
