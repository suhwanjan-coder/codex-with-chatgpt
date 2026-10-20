# Hardened C2C 操作指南

## 定位與適用範圍

- C2C 是目前任務的單一路徑：Codex 擁有整體計畫與任務拆解；ChatGPT 僅讀取經核准的固定 snapshot 提供建議；Codex 負責修改、測試、驗證與清理。使用者以自然語言明確要求本次任務使用 C2C 即可啟用；`$c2c` 是可選捷徑，不另分口令或要求選模式。
- AI Council 只處理重大取捨；它不接管 C2C 的計畫、執行或驗證。
- 目標是讓為 Achi 客製的 C2C 在安全邊界內比 upstream 更實用：主動找出壞掉路徑與值得做的改善，並以實證保留改善。新需求必須併入整體設計，不能以臨時 patch 疊加。
- Ordinary Codex 使用本機工具不代表模型本身純本機；snapshot 分類限制仍完整適用。
- 現行 local C2C workflow 支援明確分類的 `public` 與經審閱的 `non-sensitive`；`synthetic` 僅保留為 legacy 證據。未分類 snapshot 只能 local-only。
- C2C 的現行入口是使用者明確的自然語言意圖（或 `$c2c` 捷徑）；操作者（Codex）擁有全部步驟，從任務定義、snapshot、執行、修改、測試到驗證與清理。詳見[使用說明](C2C_USAGE.md)。
- 真實 external permit 需 exact snapshot 的 `reviewedSnapshotDigest` 與 destination-bound approval；每批只對 exact scope 取得一次 gate。snapshot 消耗後必須建立 fresh snapshot/permit；retry 僅限事前批准的 bounded scope。
- 本專案的 skill 名稱是 `c2c`；`skill/agents/openai.yaml` 的 `allow_implicit_invocation` 為 `true`，只允許 skill 依明確自然語言意圖被發現，不會因相關性自動啟動。[全域入口 source](../skill/global-entry/SKILL.md) 仍只負責跨專案路由；普通 coding 不會隱式啟動 C2C。
- 已完成十組 Live ChatGPT real-repository 配對比較，個人按需實用性 7/10；Ordinary 10/10、C2C 8/10，中位耗時 1.92 倍，淨額度效益與顧問入口額度歸屬未知。詳見[真實使用報告](C2C_REAL_ACCEPTANCE.md)，不宣稱安全認證。
- 只准明確標記為 `public` 或 `non-sensitive` 的內容進入此 local workflow；病人資料、院內機密、憑證、歸屬不明、未知來源或未分類敏感資料一律禁止。
- 檔名 denylist 與 credential scanner 不是非敏感證明；必須逐一 inspect 每個 before/after，任何不確定即停止。

### 整體品質標準

所有「已完成」「更好」或分數都必須有直接 evidence。每輪要保留實際發現、修正、測試、cleanup、人工介入與未觀察項目；不足者明列為未完成或 `NOT SCORED`。fixture、listener、mock 或 local test 不得被說成真實 ChatGPT review、G7 pass、外部授權或 upstream 優勢。

## 基線與不可做的事

- 上游固定基線：`b1481c0`。普通 workflow 不可自動 update、pull、stash、改 Codex config 或未核准的全域設定，也不可自行建立外部 connector/tunnel；外部 transport 僅在明確核准的批次內由 `review run` 執行，synthetic pilot 為獨立歷史路徑。
- package manager 已 pin 為 `11.19.0`，SDK 為 `1.30.0`。offline-cache install 的 trust-lockfile 只停用線上 metadata check，不是新鮮 supply-chain audit。
- 全域入口只在使用者明確要求本次任務使用 C2C 時路由；不要使用或匯入舊 `setup`、`start`、`doctor`、`update`、`sandbox-allow` helpers。所有 legacy tools 不屬於此流程，且在 action 前拒絕。
- snapshot 在 prepare 時固定 Git HEAD 與目前安全文字，保存 before/after；MCP 後續不重讀 live repository。

## 目前狀態

- 【目前】公開固定版本 `b1481c0b` 的六檔、十組補量測已實際外部讀取並清理；30 次資料工具呼叫未超範圍。原批次 27 次另存，不混算。
- 【已驗】個人按需實用性 7/10，十組完整端到端耗時與返工比較已核對；淨額度效益未知。使用[最新報告](C2C_REAL_ACCEPTANCE.md)，不混用下方歷史數據。
- 【歷史區隔】以下 260-test、synthetic 9/10 與既有 remote synthetic run 均保留為歷史 evidence，不得轉述為本階段 real-repository acceptance。
- 【歷史證據】2026/08/30 22:57 的 `.tooling/g7/run-hrnoPh/` 為未通過 run：28 個測試檔、252 項通過、0 項失敗、2 項 file symlink skipped，嚴格 G7 exit 1；此失敗保留，不以後續結果覆寫。
- 【已驗】使用者於 23:12 對合併 scope 明確核准。最終 `.tooling/g7/run-aKkz8M/gate.json` 為 `passed: true`；23:39 完成 typecheck、build 與 Vitest：28 個測試檔、260 項通過、0 失敗、0 skipped、59.97 秒。
- 【已驗】Windows 原生整合證據涵蓋 PS5.1 entry/default parent/shared hash、native long path、8.3 alias、module inheritance 與 SID type；normal-user `ValidateOnly` preflight 在 UAC 前執行，實際 temporary standard account 拒絕 5/5、正向控制 2/2，cleanup 已完成。根 help 只列可用 review/help，legacy 指令仍在 action 前拒絕。
- 【已驗】prepare/run 都在同一 normal Windows user 下進行，未設定全域 Git `safe.directory`；建立 temporary plugin 後以 fresh ChatGPT page 的 `@C2C` 啟動。已核准的 normal batch 不重複提問。
- `scripts/prepare-c2c-pilot.mjs` 產生單一 synthetic repository，含 3 個已知 regression case 與 6 個精確 review files；三個 baseline 均 exit 0，注入缺陷後均 exit 1。
- 【歷史證據】首次真實 C2C `trial-yqNyrz` 已 OAuth connected，但在 prompt 前 2 分鐘 idle 到期；cleanup 為 `CLOSED`、token 0、plugin removed。此失敗保留。
- 【已驗】第二次 `trial-lMTpbx` 以同一 6 個 synthetic files、`gpt-5.6-sol` High，在未變更的 15 分鐘 TTL 內完成 5 分鐘 idle；ChatGPT 實際完成 13 個資料呼叫（1 info、6 diff、6 read），只讀 6 個 approved paths，找出 3 個已知缺陷且 0 誤報。Luna 實際修正前 3 個測試 exit 1、修正後 exit 0，且只改 3 個 source files。證據：原始 ChatGPT 對話由維護者私下保留，不隨公開版本發布；`_working/C2C_ADVISOR_2026-08-30.md`。
- 【已驗】兩次 trial 均 cleanup 至 `CLOSED`、token 0、cloudflared 0、runner 0；兩個 public URL 均 HTTP 530、temporary plugin 均已刪除、Developer Mode 為 OFF，所有 G7 `g7n` 帳號不存在。audit JSON response bytes 為 14,478，非全部 network bytes 或 quota。
- G7 通過只表示此列本機 Windows 驗收完成，不是一般 repository 的安全認證；public real repositories 仍須 scoped data authorization 與 capability expansion，病人／院內機密／憑證不得外傳。
- 本文件、gate 狀態與 trial evidence 須由 Main/Sol 各自獨立核對；本文件不取代真實使用者核准。

### 啟動約定

使用者明確說「用 C2C 做……」後，由 Codex 對目前任務執行上述既定流程；「用c2c幫我……」與「這題交給C2C」同樣有效，C2C 不分大小寫，`$c2c` 只是可選捷徑。單純提到、詢問、引用／程式碼／文件中的 C2C，或說「不要用 C2C」，都不啟動；skill discovery 也不等於 workflow activation。全域入口可從任何專案路由到維護中的 checkout，但不是 shell PATH command，也不是外部連線、帳號設定或付費使用的授權。詳見[使用說明](C2C_USAGE.md)與[全域入口 source](../skill/global-entry/SKILL.md)。

任何 system、connection、auth、cost 或 scope 擴張，必須在 action-time 取得一個真實合併 gate；同一已核准批次內不重複追問。內容、目的地、權限、model、限制或 round 超出批次時，才重開 gate。此原則不把 synthetic external trial 變成 G7 pass，也不免除真實 consent。

### 跨專案全域薄入口

全域入口的來源、安裝、target routing 與權限邊界見[使用說明](C2C_USAGE.md)及[全域入口 source](../skill/global-entry/SKILL.md)；本指南既有 snapshot、approval、撤權與 cleanup 規則不變。

### Synthetic trial scripts

先在 checkout 根目錄執行，產生器不接受參數：

```powershell
node .\scripts\prepare-c2c-pilot.mjs
```

它只建立一個新的 `.tooling/c2c-pilot/trial-*/` synthetic repository，含 3 個已知 regression、6 個 review files、baseline 0／injected defect 1 的 run evidence；不讀取 user repository、不傳送外部資料。輸出的 `manifest.json` 與 answer key 留在 generated trial 目錄，answer key 不得進入 approved paths。

實際 pilot 只有在真實使用者對完整 scope 做一次合併核准後才可執行：

```powershell
node .\scripts\run-c2c-pilot.mjs `
  --manifest "<GENERATED_MANIFEST>" `
  --model "<APPROVED_MODEL>" `
  --authorize-external-trial
```

`--authorize-external-trial` 是 operator attestation，不是 user consent；沒有合併核准前不得提供、複製或執行這個 flag。script 不使用 API，且只接受固定的 `cloudflared-2026.8.2-windows-amd64.exe`，SHA-256 必須是 `c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5`。此固定 binary、6 個 synthetic files、model、目的地、Developer mode、期限、停止與 evidence 驗證都屬於同一個 gate。

啟動程式還會逐位元組比對六個檔案的 before/after 與內建合成案例；檔名和 HEAD 相同但內容被替換也會拒絕。取得臨時網址後，入口先維持 HTTP 503，輸出 `awaiting_scope_approval`、最終 permit digest 與快照檔案位置；只有收到 `approve <已核准的 permit digest>` 才開放 OAuth 與資料服務。程式不會自行送出這個核准指令；Codex 必須先核對實際提案是否完全在使用者已批准的批次範圍內，範圍改變就停止。沒有核准、輸入 `stop` 或期限到期都必須收尾。

## Local review：三個 PowerShell 命令

在 checkout 根目錄執行。先把尖括號 placeholder 換成實值；`--files` 必須是精確的 repository-relative 路徑，使用 `/`，不可用 glob。

```powershell
Set-Location "<CHECKOUT_ROOT>"
node .\bin\c2c.js review prepare `
  --workspace "<REVIEW_REPO_ROOT>" `
  --task "<TASK_ID>" `
  --files "<REPO_REL_PATH_1>" "<REPO_REL_PATH_2>" `
  --data-class public `
  --output "<SNAPSHOT_FILE_OUTSIDE_REVIEW_REPO>"
```

`--data-class` 只能是 `public` 或 `synthetic`。`--output` 必須在 review repo 外，prepare 不授予任何存取權，也不覆蓋既有 snapshot。指令輸出會給 snapshot path、SHA-256 digest、檔案清單、期限與 `approved:false`。

```powershell
node .\bin\c2c.js review inspect `
  --snapshot "<SNAPSHOT_FILE>"
```

逐一核對輸出的 task、root、HEAD、每個檔名與完整 before/after、bytes、期限及 limits。任何新增或不明內容都不得進入 gate。

```powershell
node .\bin\c2c.js review serve `
  --snapshot "<SNAPSHOT_FILE>" `
  --approval "<APPROVED_SNAPSHOT_SHA256>" `
  --state-dir "<DEDICATED_STATE_DIR_OUTSIDE_REVIEW_REPO>"
```

只在 gate 明確核准後以前景執行 `serve`。state dir 必須是 review repo 外的專用目錄；serve 輸出的完整 local `/mcp` URL 是唯一 resource。

Windows 的 snapshot／permit 會在建立當下設定私有權限；session 將 lock／audit／auth 放在 state dir 下固定的 `.c2c-review-private` 子目錄。既有私有路徑須通過擁有者與權限檢查，不會就地修寫 ACL；review auth 不接受改存外部路徑。發現 state dir 根目錄的舊 lock／audit／auth 紀錄時明確拒絕，保留證據供處理，不得自行換 state dir 繞過單次授權。

### Synthetic remote pilot：只先產生 permit proposal

以下命令只讀取已準備的 synthetic snapshot、驗證目的地並建立 permit；不建立 state、不啟動 listener，也不代表核准：

```powershell
node .\bin\c2c.js review remote-plan `
  --snapshot "<SYNTHETIC_SNAPSHOT_FILE>" `
  --model "<APPROVED_MODEL>" `
  --resource "https://<FIXED_NAME>.trycloudflare.com/mcp" `
  --redirect-uri "https://chatgpt.com/connector_platform_oauth_redirect" `
  --output "<REMOTE_PERMIT_FILE_OUTSIDE_REVIEW_REPO>"
```

只有 `dataClass: synthetic` snapshot 可建立 permit。輸出檔以 exclusive create 寫入 review repo 外，輸出 permit path、remote permit SHA-256、model/resource/redirect target 與 `approved:false`。`resource` 必須是 permit 中的精確 public resource；不要自行改 host、path、redirect URI 或 digest。

### Synthetic remote pilot：合併核准後才 serve

```powershell
node .\bin\c2c.js review serve-remote `
  --snapshot "<SYNTHETIC_SNAPSHOT_FILE>" `
  --permit "<REMOTE_PERMIT_FILE>" `
  --approval "<APPROVED_REMOTE_PERMIT_SHA256>" `
  --state-dir "<DEDICATED_STATE_DIR_OUTSIDE_REVIEW_REPO>" `
  --port "<LOOPBACK_PORT>"
```

`--port` 可省略；指定時只供 `127.0.0.1` listener 使用，讓外部 tunnel wrapper 自己管理轉送。CLI 會先讀取並驗證 snapshot、permit 與 remote permit digest，之後才建立 local review state 並傳入 `{ snapshot, permit, approvalDigest }`；不呼叫 `tunnel.start`。成功輸出 `SYNTHETIC_REMOTE_PILOT`、local URL、exact `resource`、permit digest、OAuth pairing code 與期限；此輸出本身不等同 ChatGPT 實際連線，實際試跑證據見「目前狀態」。

## 一次合併核准 gate

一次 gate 必須同時綁定以下全部項目，之後不逐 tool 重複確認：

| 項目 | 固定內容 |
|---|---|
| task / purpose | 明確 task；`diff-review` |
| provider / model | `local-test` / `mock-reviewer` |
| scope | 完整、精確的 approved files 與 before/after；最多 20 檔 |
| bytes | 單一 before/after 最多 64 KiB；snapshot before+after 合計最多 512 KiB |
| model toolcalls | 完整 JSON-RPC body 最多 512 KiB，包含 request ID 與 error receipt；連 error body 也放不下時回 `204` 空 body 並關閉 session，不得 silent retry |
| SDK protocol | `initialize`、`ping`、`tools/list` 分開固定：最多 32 個 responses、每 response 最多 16 KiB、aggregate 最多 64 KiB；這些 constants 由 digest 綁定，並由 `inspect`/`review_info` 暴露 |
| identity | snapshot SHA-256 digest；同一 digest 只可使用一次 |
| time / calls | TTL 15 分鐘；idle 2 分鐘；最多 30 次呼叫 |
| round / destination | round 1；本機 mock review；不送外部 |

`--approval` digest 是 binding receipt，不是 human consent 的證明。synthetic test code 可以產生 digest 並供測試傳入；真實使用者流程不可自行計算後自我核准。task、scope、provider、model、任何新 content、limits、round 或 destination 改變，都必須重新 prepare 並取得新的合併核准。

上表適用 local `serve`。remote pilot 另有 snapshot digest 與 remote permit digest 兩層 binding；permit digest 必須和 model、resource、redirect URI、6 個 synthetic files、transport、期限與 closure 行為一起交給真實使用者作一次合併核准。命令列的 `--authorize-external-trial` 只代表 operator attestation，任何 flag 都不是 consent 證明；在核准前不得鼓勵或指示 copy-run `run-c2c-pilot.mjs`。

## 連線、工具與收尾

- local test client 使用 OAuth PKCE；只接受 serve 輸出的完整、精確 local `/mcp` resource，不可改 host、origin 或 path；沒有 refresh grant。
- local `serve` 只允許 `workspace.read`、`git.read` 與四個 snapshot tools：`review_info`、`read_file`、`review_diff`、`review_complete`。不提供 search、live git status/diff、project metadata 或 execution summary。
- `serve-remote` 的 remote pilot 只暴露 3 個 read tools：`review_info`、`read_file`、`review_diff`，不暴露 `review_complete`；remote resource、OAuth metadata 與 redirect URI 必須和 permit 完全相符。
- review 只讀批准 snapshot；完成、TTL、idle、call/output budget 或 audit failure 都會關閉 session。完成時先停止資料服務，再撤銷 token、關 listener，並確認 port closure、token revocation 與 metadata-only audit。
- remote pilot 用 stdin 輸入 `stop`、輸入串流 EOF，或等待 TTL／idle 關閉；EOF 在核准前後都會觸發一次收尾。停止後必須實際驗證 process／port close、token revocation 與 metadata-only audit，不能只看 CLI 輸出。
- model toolcall 的完整 JSON-RPC body cap 包含 request ID 與 error receipt；若連 error body 也無法 fit，回 `204` 空 body 並關閉 session，不得 silent retry。
- SDK `initialize`、`ping`、`tools/list` 的 protocol events 與 review tool-call counts 分開 audit、分開呈現，不得混算。
- `inspect` 與 `review_info` 必須暴露 digest 綁定的 protocol constants；不一致即停止，不重試。
- audit 只記 session hash、request ID、tool、approved paths、bytes、時間、結果與分開的 protocol events/tool-call counts；不記 token、搜尋內容或原始碼。
- 不明 send/response 結果先 inspect audit、process、port 與 session evidence；不可直接 retry 或自動重啟。

## 崩潰與目前限制

- crash 後出現 stale lock 必須先做本機 inspection；不可盲刪 lock，也不可改用另一個 state dir 逃避 single-use lock。無法判明狀態就 No-Go。
- file symlink、other reparse、8.3 alias、long path 與跨帳號 ACL 的 native evidence 已納入通過的 G7。此範圍不防管理員或已被入侵的建立者，也不把 scanner 替代為資料分類或授權判斷。
- 已完成的 remote synthetic C2C 僅涵蓋核准的一輪與六個 synthetic files。public real repositories 仍須新的 action-time scoped data authorization 與 capability expansion；不得使用病人／院內機密／憑證。

## Synthetic trial：shortcomings、修正、score 與適用性

`scripts/prepare-c2c-pilot.mjs` 只產生下列三種已知缺陷作為 answer key 對照：discount boundary 的 `&&`/`||`、pagination 的 slice end offset、以及 JavaScript suffix 缺少 `$` anchor。answer key 不得進入 approved paths；實際 advisor 結果要在本機逐項比對，記錄 missed findings、false positives、證據品質、人工介入與 cleanup 證據，再記錄修正。

評分統一依 [G8 工程試跑量表](G8_EXPERIMENT.md#先行工程試跑三案例與可用度)：連線、讀取、找錯、修正驗證、收尾五項，各 0–2 分，合計 0–10 分。只保留一份量表定義，避免跨文件標準不同。

【已驗】`trial-lMTpbx` 工程分數為連線 1、讀取 2、找錯 2、修正驗證 2、收尾 2，合計 9/10；連線扣分是曾需 manual repair。安全、授權或稽核失敗不得以高總分放行。分數只說明這一輪合成資料試跑，不是整體 real-repository certification 或 efficiency/quota savings；擴大到其他 repository 仍需獨立核准，不適用病人／院內資料、未知來源資料或未經 gate 的永久 connector。

## G7 嚴格驗收

先以 `pnpm test:g7:preflight` 或 `node scripts/g7-preflight.mjs` 檢查執行前提。預檢不安裝或啟動VM、不變更系統權限；只使用本機合成檔案並確認清理。exit0不是G7通過，exit2表示必要能力不足／不明，exit1表示預檢非預期錯誤。本機Core/Home版不支援Windows Sandbox，見 `G7_WINDOWS_ACCEPTANCE.md` 的主機紀錄與官方來源。

在 checkout 根目錄執行 `pnpm test:g7`，或 `node scripts/verify-g7.mjs`。這個入口不接受測試 filter、既有報告或略過選項，會重新執行 typecheck、build 與完整 Vitest，再以 JSON 結果判定。

- 任一步驟失敗、任一測試 skipped／todo、必要 suite 或原生能力證據缺少，都以 exit1 阻止放行。
- 原生必要項目為實際 ADS、祖先 junction、file symbolic link、長路徑、真實8.3 alias、其他 reparse tag，以及 Windows ACL 隔離。ACL 讀回不是跨帳號存取拒絕證明；缺少必要項目時應保留失敗，不能刪掉 gate 規則。
- 每輪留下獨立的 `.tooling/g7/run-*/vitest.json` 與 `gate.json`。一般 `pnpm test` 的 exit0 不等於 G7 通過。
- 【已驗】最終 `.tooling/g7/run-aKkz8M/gate.json` 的 `passed: true` 連同 28 files／260 pass／0 fail／0 skip 是本 checkout 的 G7 通過證據；歷史失敗 run 仍保留。
- 此 gate 即使通過，也只表示列出的本機驗證完成，不批准外部 connector／tunnel／資料傳送或 G8 執行。
