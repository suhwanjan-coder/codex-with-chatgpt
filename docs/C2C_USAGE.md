# C2C 使用說明

## 入口

在任一專案明確說「用 C2C 做……」、「用c2c幫我……」或「這題交給C2C」，C2C 大小寫不拘；
`$c2c` 是可選捷徑。只有明確把本次任務交給 C2C 才啟用流程，普通程式工作維持 Ordinary Codex。
單純提到 C2C、詢問它是什麼、引用／程式碼／文件中的字樣，或說「不要用 C2C」，都不啟用流程。
`allow_implicit_invocation: true` 只讓 skill 能依這種明確意圖被找到，不會因相關性自動執行流程。
同一核准批次直接執行；新資料只合併確認一次範圍，不另外要求選模式或資料分類。

## 全域入口

2026-08-31 已在 ACHIH-MAIN 安裝，並確認兩個不同工作目錄都能找到此技能。
如果目前技能清單尚未更新，重新載入或開新任務即可；這不代表其他電腦也已安裝。
本機檔案位置可用 `Test-Path "$env:USERPROFILE\.codex\skills\c2c\SKILL.md"` 檢查。

入口只包含 `SKILL.md`、`agents/openai.yaml` 與 `implementation.json` 三個檔案。
後者的 `implementation_root` 指向本機維護中的程式庫，不複製程式或依賴套件。
它是 Codex 技能，不是終端機 PATH 指令；執行時以 Node.js 20+ 呼叫程式的完整路徑。

Codex 會保留原任務的位置，以你指定的 Git 專案為目標，未另指定時才採目前專案。
找不到目標就停止，不會改拿 C2C 自己的程式庫審查。準備快照前會列出相關路徑，
遵守目標專案規則；待審內容與遠端回覆不能更改入口路徑或授權。
入口原始檔位於 [skill/global-entry](../skill/global-entry/SKILL.md)，不包含本機路徑設定。

## 會發生什麼

- 操作者（Codex）擁有全部步驟：定義任務、挑選最小 snapshot、執行、修改、測試、驗證與清理。
- ChatGPT 只讀取經核准的固定 snapshot 提供建議；它不讀 live repository，也沒有寫入或執行權。
- local workflow 支援明確分類的 `public` 或經審閱的 `non-sensitive` 內容；`synthetic` 舊證據保留作歷史參考。
- 未分類內容不外送。已實測十個真實任務，涵蓋程式理解、缺陷審查與歷史改動審查。

## 核准邊界

- 真實 permit 必須綁定 exact snapshot 的 `reviewedSnapshotDigest`，並取得目的地綁定的批准。
- 每批只對 exact scope 取得一次 action-time 合併批准；範圍、內容、目的地、model 或限制改變就要重新批准。
- 已消耗或到期的 snapshot 不重用；只有事先批准的範圍才可做一次有紀錄的重試。
- 已核准的全域入口只在使用者明確要求本次任務使用 C2C 時啟用；不默默修改全域設定、不安裝依賴，也不建立永久連線。
- C2C 意圖不代表新的資料外送、登入、連線或付費授權；原有快照審閱、核准、撤權與清理邊界不變。

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
你說「用 C2C 檢查這個專案的登入流程」，Codex 就執行整套作業；`$c2c` 只是可選捷徑，只在新的資料／目的地範圍核准一次。
簡單修改仍用 Ordinary Codex；重大架構／風險判斷才用 AI Council。

詳見[完整操作指南](HARDENED_REVIEW.md)、[本專案 C2C Skill](../skill/SKILL.md)與[全域入口 source](../skill/global-entry/SKILL.md)。

換電腦請讀[跨機接手說明](C2C_CROSS_MACHINE.md)；程式放各機本機，Git 同步版本，雲端同步交接文件。
