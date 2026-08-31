# C2C 跨機接手

## 目前結論

C2C 可按需使用，個人實用性 7/10；不是全域預設，也不是保證省額度。
說「C2C，處理這個專案的問題」就是執行既定流程，不必另加試跑口令。
先讀根目錄 `_HANDOFF.md`、[使用說明](C2C_USAGE.md)及 `skill/SKILL.md`。

## 版本與位置

- GitHub：<https://github.com/suhwanjan-coder/codex-with-chatgpt>
- 改良分支：`codex/c2c-hardened-2026-08-31`。`main` 仍是原始版本，不要把兩者混用。
- 兩機各自本機工作目錄：`$HOME\dev\codex-with-chatgpt-hardened`（PowerShell）。
- 雲端交接：使用自己的同步根目錄下 `Claude\Projects\C2C`；實際位置見私人專案索引。
- Git 同步程式；雲端同步交接、報告與已發布原始碼備份。不要直接在同步資料夾執行開發依賴。
- 雲端 `release-manifest.json` 記錄本次 commit、原始碼封存檔與各交接文件的 SHA-256。

## 舊電腦接手

以下由接手的 Codex 完成，不需要使用者逐項輸入。

1. 核對 Git、Node.js >=20 與登入狀態。若本機目錄不存在，才執行：

   ```powershell
   git clone --branch codex/c2c-hardened-2026-08-31 --single-branch https://github.com/suhwanjan-coder/codex-with-chatgpt.git "$HOME\dev\codex-with-chatgpt-hardened"
   ```

   已存在時先讀交接、核對 `git status --short --branch`、remote 與 commit；有未提交變更先保留並整合，不覆寫、不 reset。
   乾淨且已在上述分支時，才 `git pull --ff-only`。用 `git rev-parse HEAD` 對照交接 manifest；若遠端已有後續提交，先讀其交接再繼續。

2. 在本機 checkout 安裝 `package.json` 的 `packageManager` 所固定版本，不升級 lockfile。
   已有 Corepack 時可用 `corepack pnpm install --frozen-lockfile`、`corepack pnpm build`、`corepack pnpm test`。
   已有相符 pnpm 時使用 `pnpm install --frozen-lockfile`、`pnpm build`、`pnpm test`。
   缺工具就先補齊；不要為了套用這些指令而默默修改全域設定。實際測試結果取代舊紀錄，跳過不算通過。

   Windows 請採用上述本機短路徑。本次乾淨短路徑副本建置通過、397 測試通過／0 失敗／5 跳過；
   較深的 Documents 測試目錄曾出現 48 項私有儲存相關失敗，原始紀錄保留，不算驗收通過。
   已定位為 Windows PowerShell 5.1 建立過長私有目錄失敗：本機探針 247 字元成功、248 字元失敗；
   失敗的完整目標為 261 字元。限制看的是加上 session 子目錄後的完整路徑，不只是 checkout 名稱。
   此核對共用既有、相同 lockfile 的依賴，不等於在舊電腦完成全新安裝；不要以放寬 ACL 或關閉安全檢查修復。

3. 讀 `skill/SKILL.md`，保持專案內使用。核對 `node bin/c2c.js review run --help`。
   真正執行遠端 C2C 前，另外核對 cloudflared、瀏覽器登入、精確快照和目的地批准；連線一律重新建立，完成後撤權及關閉。

## 不同步的內容

不傳送 `.env`、憑證、token、瀏覽器登入資料、`node_modules`、`dist`、工具快取、
原始 `_working` 執行紀錄或活動中的 snapshot/session。雲端封存檔只取已審閱的 Git commit。
既有真實驗收證據留在維護者原機；新機器可重跑公開測試，但不把重跑測試當成原始外部驗收證據。

同步完成只代表新版本可取得，不代表舊電腦已安裝或已通過測試。換機時先核對版本，兩台不要同時修改同一分支再相互覆寫。
