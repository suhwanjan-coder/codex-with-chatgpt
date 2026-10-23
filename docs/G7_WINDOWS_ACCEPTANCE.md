# G7 Windows 驗收門檻

這是本機隔離版的驗收門檻與已驗結果，不是外部 C2C 上線許可。不得為了取得綠燈而省略必要項目。

## 可重跑入口

2026-10-23 補註：本文件的 260-test pass 與主機能力是 2026-08-30 歷史紀錄，不是目前 checkout 的重新驗收。Windows 無 pnpm PATH 時用 `corepack pnpm` 取代下列 `pnpm`，非互動執行先設 `$env:CI='true'`；一般測試結果另見[文件稽核](DOCS_AUDIT_2026-10-23.md)。

先執行 `node scripts/g7-preflight.mjs`，或 `pnpm test:g7:preflight`。此預檢只檢查Windows／Node／Git、實際file symlink能力及探測檔清理，另列出隔離工具與Windows功能查詢結果；不啟動VM、不連外、不安裝軟體、不修改帳號／ACL／系統權限。它會短暫建立專案內的合成探測檔，結束時清理。

預檢exit0只表示這些執行前提通過，不代表G7通過；必要能力不足／無法確認回exit2，非預期錯誤回exit1。`OTHER_REPARSE`及`ACL_ISOLATION`仍須正式驗收。不要以預檢綠燈批准C2C或G8。

在此 checkout 使用 `node scripts/verify-g7.mjs`，或 `pnpm test:g7`。入口重新 typecheck、build、跑全部 tests，保存 `.tooling/g7/run-*/vitest.json` 與 `gate.json`。exit1 可表示程式缺陷，也可表示環境缺乏必要能力；看 `reasons` 分辨，不能只看一般 Vitest exit0。

另有 Codex 內部入口 `pnpm test:g7:windows-native`，對應 `scripts/verify-g7-windows.mjs`。此 native driver 仍使用 `scripts/verify-g7-windows.mjs` 中固定的維護者 Node 路徑，換機時須先核對，不是跨機通用入口。未帶明確授權旗標時不建立 fixture、不提權、不建立帳號。它不是新的使用者口令，你仍只需交辦「C2C」。已驗流程先以同一 normal Windows user 執行 `ValidateOnly` preflight，再取得 UAC 同意；不得全域設定 Git `safe.directory`。

【歷史證據】2026/08/30 22:57 的 `.tooling/g7/run-hrnoPh/` 為嚴格 G7 exit 1：28 個測試檔、252 項通過、0 項失敗、2 項 file symlink skipped；該失敗保留。

【已驗】使用者於 23:12 明確核准合併 scope。23:39 的 `.tooling/g7/run-aKkz8M/gate.json` 為 `passed: true`：typecheck、build、Vitest 均通過，28 個測試檔、260 項通過、0 項失敗、0 skipped、59.97 秒。實際 native integration 已驗 PS5.1 entry/default parent/shared hash、ADS、native long path、真實 8.3 alias、module inheritance、SID type、file symlink、other reparse 與 ACL isolation；temporary standard account 對受保護目標拒絕 5/5，正向控制讀寫 2/2，cleanup 完成。帳號名稱限制依 [Microsoft NetUserAdd 文件](https://learn.microsoft.com/en-us/windows/win32/api/lmaccess/nf-lmaccess-netuseradd) 修正。

## 必要證據

| ID | 所需實證 | 不可替代成什麼 |
|---|---|---|
| NATIVE_ADS | 實際建立並讀回合成 NTFS alternate data stream，再驗證快照入口拒絕 | 只有冒號字串的單元測試 |
| ANCESTOR_JUNCTION | 路徑的祖先 junction 指向 repo 外時拒絕 | 只測 repo root 或末端檔案 |
| FILE_SYMLINK | 真實 file symbolic link 在 hardened 快照路徑遭拒 | directory junction 或 hardlink |
| LONG_PATH | 合成的超過260字元實際路徑可建立，且安全擷取或明確拒絕 | 建立 fixture 失敗卻讓測試通過 |
| SHORT_ALIAS | 已確認存在且不同的8.3 alias 經快照入口拒絕 | GetShortPathName 回傳原始長名稱 |
| OTHER_REPARSE | Windows 非一般 symlink／junction 的實際 reparse 案例與拒絕證據 | 只有熟悉的兩種 link 測試 |
| ACL_ISOLATION | 實際 snapshot／state／audit／lock／auth 的權限與授權邊界驗證，包括非授權安全性主體的有效存取結果 | POSIX mode0600、只列出 DACL、同一帳號自行讀寫 |

上述 ID 須對應 `tests/review-windows-native.test.ts` 的實際測試；缺少實作就維持 `NATIVE_EVIDENCE_REQUIRED`，不是新增空白 pass 測試。跨帳號驗證應涵蓋機敏快照／auth 的讀取拒絕，以及 state／audit／lock 的未授權寫入拒絕；只驗證檔案存在不夠。

## 下一個授權邊界

2026-08-30續做時讀回主機 `EditionID=Core`（Home）。[Microsoft官方說明](https://learn.microsoft.com/en-au/windows/security/application-security/application-isolation/windows-sandbox/)明列Windows Home不支援Windows Sandbox。因此不提供強裝Home版Sandbox的繞過指令，也不為此專案自行升級Windows。已安裝VirtualMachinePlatform不等於已具備可用的Windows Sandbox。

已驗的一次性本機 synthetic 驗收不把安裝 VM 列為唯一前提：一般權限的 driver 先建立受保護的新測試目錄及正式程式產生的資料，再由一次 UAC helper 建立原生 fixture，使用臨時標準帳號實際測試權限。完整測試仍以一般權限執行，不把 Node／Vitest 整套提升為管理員。

這不是 VM 或通用沙盒。提權與臨時帳號必須取得使用者明確合併核准，UAC 由本人同意；不得從「繼續」或命令旗標自行推論核准。已驗 run 未改現有帳號、祖先目錄 ACL、Developer Mode、登錄、系統權限原則或 volume 設定；新建 C2C 私有檔案／目錄在建立當下設定權限，與修改既有系統設定分開處理。

驗收同時需要正向控制：臨時標準帳號能讀寫指定控制檔，卻不能讀寫受保護目標；不能把找不到檔案、分享鎖定或無法走到父目錄當成權限隔離成功。特權 helper 必須撤回 impersonation、關閉 handle、以建立時 SID 精確刪除臨時帳號，再交由一般權限程序完成測試與清理。逾時或狀態不明時保留 receipt／fixture 供查明，不盲目重試或假定程序已停止。

檔案隔離防護的對象是其他一般 Windows 帳號；不宣稱能防止管理員或已被入侵的建立者自行更改程式、權限與測試資料。無法滿足這個限定範圍時，再使用另行批准的專用 Windows 測試環境。

僅使用合成 repo 與合成 token。保留程序與檔案清理證據；不掛載真實網路分享、不使用病人資料／院內機密、不啟動 public tunnel、不建立真實 connector、不傳送給外部顧問。語法上的 UNC／device namespace 拒絕可測，但不得冒稱已驗證實際遠端檔案系統。

即使這些測試全部通過，外部試驗仍須獨立取得 action-time 合併核准；G8 另依 `G8_EXPERIMENT.md` 執行，不能從 G7 的結果推論額度或效率收益。
