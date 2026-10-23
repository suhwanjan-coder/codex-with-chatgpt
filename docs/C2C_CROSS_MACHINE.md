# C2C 跨機接手

## 目前結論

C2C 可按需使用，個人實用性 7/10；不是全域預設，也不是保證省額度。
這個 7/10 決定維持不變。說「C2C，處理這個專案的問題」就是執行既定
流程，不必另加試跑口令；十對外部比較已完成，不要重跑或重開。
本次新機修復只處理測試可攜性，不放寬 ACL，也不改變資料邊界。先讀根目錄
`_HANDOFF.md`、[使用說明](C2C_USAGE.md)、`skill/SKILL.md` 及
`docs/C2C_REPAIR_2026-08-31.md`。修復後測試結果與版本以該修復文件
及雲端 `release-manifest.json` 的實際記錄為準；manifest 不在 Git checkout 內。
2026-10-23 補註：上述為 2026-08-31 修復紀錄；本次文件稽核與驗證另見
[文件稽核](DOCS_AUDIT_2026-10-23.md)，歷史測試數字不代表目前測試總數。

## 版本與位置

- GitHub：<https://github.com/suhwanjan-coder/codex-with-chatgpt>
- 改良分支：`codex/c2c-hardened-2026-08-31`。`main` 仍是原始版本，不要把兩者混用。
- 前一個已發布基線 commit：`7cf5eb67bf94fabababb99ec62f6aa46a082607d`。
- 各機請使用短、非同步的本機開發目錄；不要直接在同步資料夾執行開發依賴。
- 雲端 `release-manifest.json` 記錄修復後的發布狀態、commit、原始碼封存檔與各交接文件的 SHA-256。
- 發布狀態須同時核對雲端 manifest 與遠端分支，不只依賴交接文字。

## 未來跨機接手（選用）

本節只供日後另一台 Windows 主機需要接手時使用。本次新機修復不需要使用者
操作舊電腦，也不把舊機結果當成已修好；以下由接手的 Codex 或 maintainer 完成。

1. 核對 Git、Node.js >=20 與登入狀態。若本機目錄不存在，才執行：

   ```powershell
   git clone --branch codex/c2c-hardened-2026-08-31 --single-branch https://github.com/suhwanjan-coder/codex-with-chatgpt.git "$env:USERPROFILE\dev\codex-with-chatgpt-hardened"
   ```

   已存在時先讀交接、核對 `git status --short --branch`、remote 與 commit；有未提交變更先保留並整合，不覆寫、不 reset。
   乾淨且已在上述分支時，才 `git pull --ff-only`。用 `git rev-parse HEAD` 對照交接 manifest；若遠端已有後續提交，先讀其交接再繼續。

2. 在本機 checkout 安裝 `package.json` 的 `packageManager` 所固定版本，不升級 lockfile。
   Windows PowerShell 的非互動執行先設定 `$env:CI='true'`，再依序執行：

   ```powershell
   $env:CI='true'
   corepack pnpm install --frozen-lockfile
   corepack pnpm build
   corepack pnpm test
   ```

   2026-10-23 本機 `pnpm` 不在 PATH，`corepack pnpm` 可用（11.19.0）。已有相符 pnpm 時也可使用 `pnpm`，但非互動執行仍先設 `CI=true`。
   `.npmrc` 將 store 固定為 `.tooling/pnpm-store`；若舊 `node_modules` 來自不同 store，沒有 TTY 且未設 CI 時，重新安裝會以 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 中止。
   `CI=true` 允許 pnpm 移除並重建該依賴目錄；不改 lockfile 或全域 store 設定。`pnpm-workspace.yaml` 僅明確允許 `esbuild` 的建置腳本。
   缺工具就先補齊；不要為了套用這些指令而默默修改全域設定。實際測試結果取代舊紀錄，跳過不算通過。

   本次 maintainer 新機 baseline 是真正 fresh 的短路徑 clone，起初沒有
   `node_modules` 或 `.tooling`；Node 24.19.0、pnpm 11.19.0，安裝下載 156、
   reused 0、使用自己的 store，build passed，402 測試為 397 passed、0 failed、
   5 skipped。這只是 baseline，不是 post-repair 結果；完成後只從
   `docs/C2C_REPAIR_2026-08-31.md` 與 `release-manifest.json` 讀取實際結果和
   current commit，不要把 baseline counts 當成修復結果。

   舊機的歷史資料是 fresh-install build passed；402 測試為 391 passed、11
   failed、0 skipped。單獨重跑 CLI 通過不會抹除整批失敗；9 個 helper 空輸出且
   exit 0 的案例未在維護者環境重現。缺少快取的測試缺陷已修正，但修正版在舊機
   的結果仍未驗證；本輪不要求使用者操作舊機，不以放寬 ACL 或關閉安全檢查修復。
   新機另有一次 auth-store 偶發失敗，後續通過不抹除它；詳見修復報告的剩餘限制。

   歷史長路徑探針在 Windows PowerShell 5.1 為 247 字元通過、248 字元失敗，
   失敗巢狀目標為 261 字元。這是歷史可攜性觀察，不是舊機 11 項失敗的解釋。
   較深的 Documents clone 曾有 48 項私有儲存相關失敗；原始紀錄保留，不算驗收通過。

3. 讀 `skill/SKILL.md`，預設保持專案內使用。核對 `node bin/c2c.js review run --help`。
   若另行安裝跨專案薄入口，使用 `skill/global-entry/`，並建立該機專用的 `implementation.json`；不要直接複製他機路徑或把整份 workflow 當作薄入口。詳見[使用說明](C2C_USAGE.md)。
   真正執行遠端 C2C 前，另外核對瀏覽器登入、精確快照和目的地批准；連線一律重新建立，完成後撤權及關閉。
   `review run` 不使用 PATH 中任意版本的 cloudflared；它要求 checkout 內 `.tooling/downloads/cloudflared-2026.8.2-windows-amd64.exe`，並核對[操作指南](HARDENED_REVIEW.md#synthetic-trial-scripts)所列 SHA-256。單純安裝最新版不滿足這個條件；此 runner 目前限定該 Windows 執行檔。

## 不同步的內容

不傳送 `.env`、憑證、token、瀏覽器登入資料、`node_modules`、`dist`、工具快取、
內部執行證據或活動中的 snapshot/session。封存檔只取已審閱的 Git commit。
既有真實驗收證據留在維護環境；新機器可重跑公開測試，但不把重跑測試當成原始外部驗收證據。

同步或發布只代表版本可取得，不代表舊電腦已安裝或已通過測試。本輪不需舊電腦動作；
日後選用跨機接手時先核對版本，兩台不要同時修改同一分支再相互覆寫。
