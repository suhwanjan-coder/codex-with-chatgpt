# G8 未來實驗 protocol

## 目的與前置註冊

本文件下方的歷史正式實驗設計保持原樣，不事後改寫樣本數或驗收標準。另一次已核准的十案公開 repository 批次已完成真實 ChatGPT 讀取、撤權與內容對照，完整端到端耗時與返工補量測也已驗收，個人按需實用性更新為 7/10，詳見[真實使用報告](C2C_REAL_ACCEPTANCE.md)。淨額度效益仍未知；不得把它冒充下方正式設計已完成。

## 先行工程試跑：三案例與可用度

這是正式 G8 對照實驗之前的工程試跑，不是縮減 G8 樣本數、也不取代 G7。目的為打通 C2C local workflow、發現缺口並改良；既有經明確核准的 ChatGPT synthetic 試跑保留為歷史 evidence，不是本階段 real-repository acceptance，也不是本文件的授權來源。未來不同 scope 仍須另有明確合併核准。

- 【試跑預註冊】使用產生器的單一合成 repository、3 個可重現缺陷、6 個精確 before/after 檔案；answer key 不提供顧問。實際內容須與內建案例逐位元組相符。
- 【試跑預註冊】一輪、最多 30 次資料工具呼叫、512 KiB 輸出、15 分鐘服務期限；不自動重試或換範圍。另記從設定開始到確認收尾的總耗時，不把 15 分鐘服務期限當作完整 setup 耗時。
- 【試跑預註冊】保留原始 findings，Codex 逐條以測試核實。未找到、誤報、操作介入、連線失敗都保留，不只展示修好後的結果。修正只在本機進行，顧問沒有寫入權限。

下列五項各 0–2 分，於試跑前鎖定。任一項缺少實測證據填 `NA`，總分也填 `NA`，不可將未知當作 0 或用其餘項目外推滿分。

| 項目 | 0 分 | 1 分 | 2 分 |
|---|---|---|---|
| 連線 | 未完成真實 client 授權與連線 | 需額外手動修復才接通 | 依批准流程一次接通，無額外修復 |
| 讀取 | 無法讀取，或讀到非批准內容 | 只取得部分批准內容 | 正確取得六檔所需 before/after，未越界 |
| 找錯 | 沒有找出可驗證缺陷 | 找出部分缺陷，或另有誤報 | 三個缺陷均被找出，且無誤報 |
| 修正驗證 | 無可用修正結果 | 只有部分案例修正並通過測試 | Codex 驗證後的三個修正皆通過測試 |
| 收尾 | 存取仍有效、程序殘留或稽核失敗 | 需額外手動修復才完成收尾 | 正常停止後 token 失效、程序與 port 關閉且 audit 完整 |

總分只是本輪工程可用度，不是一般 repository 安全認證、統計成功率或額度收益。出現越界、授權錯配、稽核缺失，無論總分多少都停止該輪並修復。每次改良後的新試跑保留自己的版本、分數與證據，不覆蓋舊結果；是否擴大使用仍須符合 G7 與獨立核准條件。

每輪記錄：`trial_id`、程式版本與 diff hash、snapshot/permit digest、實際 model、起訖時間、各階段耗時、三案例命中結果、誤報、人工介入、五項分數、總分、停止原因、audit 與關閉驗證路徑。觀察不到的額度填 `NA`。合成資料只能證明這一輪流程，不能推論真實任務的效益。

### 2026-08-30 工程試跑結果【已驗】

- 【歷史證據】`trial-yqNyrz` OAuth connected 後，在 prompt 前因 2 分鐘 idle 到期；cleanup `CLOSED`、token 0、plugin removed。此失敗保留。
- 【已驗】`trial-lMTpbx` 使用同一 6 個 synthetic files、`gpt-5.6-sol` High，在未變更的 15 分鐘 TTL 內完成 5 分鐘 idle。ChatGPT 完成 13 個資料呼叫（1 info、6 diff、6 read），只讀 6 個 approved paths，找出 3 個已知 defects、0 false positives。
- 【已驗】Luna 修正前 3 個測試 exit 1、修正後 exit 0，且只改 3 個 source files。工程 rubric 為 1+2+2+2+2 = 9/10；連線扣分原因為 manual repair。
- 【已驗】兩次 cleanup 均為 `CLOSED`、token 0、cloudflared 0、runner 0、public URL HTTP 530、temporary plugin deleted、Developer Mode OFF；所有 G7 `g7n` accounts absent。audit JSON response bytes 為 14,478，並非全部 network bytes 或 quota。
- 正式 12 個 paired tasks 未執行；quota savings 為 `NA`。此結果不是 overall real-repository certification、統計成功率或效率收益。

## 正式 G8：配對比較

以下所有帶有 `【預註冊】` 標記的設計、定義、量測欄位與停止規則，必須在第一個 run 前鎖定，不得依結果事後改寫。

- 【預註冊】取 10 至 20 個 paired、非敏感 task；建議 `N=12`，分層各 3 個：bug、multifile logic、security、tests。
- 【預註冊】每一對使用相同 frozen task、相同 starting state、相同輸入與相同 acceptance criteria；每次 run 前恢復同一 frozen state。
- 【預註冊】預先 counterbalance 執行順序（Ordinary Codex 先或 C2C 先），並保留實際順序與任何偏離理由。
- 【預註冊】兩組使用等價、已核准的 commander/advisor model settings。每次在 run time 記錄實際 model、版本、effort/config；不可憑記憶補寫或杜撰版本。
- 【預註冊】品質由不知道 arm 身分的獨立 reviewer 依 rubric 評分；固定 correctness、safety、scope、maintainability 四項、評分範圍、權重、缺資料處理與爭議處理。

### 【預註冊】Correctness rubric anchors

【預註冊】Correctness 使用 0 至 4 分，並在每次盲評使用以下錨點：

| 分數 | 錨點 |
|---:|---|
| 4 | 完整符合 acceptance criteria；功能與邊界行為正確；相關測試或可重現證據通過，無 correctness 缺陷。 |
| 3 | 核心 acceptance criteria 全部符合；僅有不影響交付的輕微缺口，例如非核心 edge case、文件或測試補強。 |
| 2 | 部分符合；有一項以上 material defect、未完成 acceptance 或需要人工修正才能交付。 |
| 1 | 僅有零碎或大幅偏離的結果；主要流程不可用、不可重現或 correctness 明顯失敗。 |
| 0 | 沒有可用結果、完全答非所問，或結果因 correctness/safety/boundary 問題不可採用。 |

## 預註冊定義與量測

- 【預註冊】`success`：通過事先寫定的 acceptance checks，且獨立盲評確認無 safety 或 boundary violation。人為介入不抹掉紀錄，另標記 `human_repaired` 與介入次數；人工修復後的結果要與原始成功分開報告。
- 【預註冊】`success_not_improved`：同一批 paired task 中，C2C success rate 沒有嚴格高於 Ordinary Codex；持平即算 not improved。
- 【預註冊】每次 run 固定採用 30 分鐘 timeout；計時從 setup 開始，達到 timeout 即結束並記錄，不延長或自動重跑。
- 【預註冊】每個 run 記錄 `setup_mode`（`cold` 或 `warm`）、`setup_cold_ms`、`setup_warm_ms` 與實際採用的 `setup_ms`；cold/warm setup 分開量測，不混合成一個平均值。
- 【預註冊】primary `total_time_ms` 是 end-to-end wall-clock，公式為 `total_time_ms = end_time_ms - start_time_ms`；`start_time` 是 setup 開始，`end_time` 是 accepted result、stopped 或 timeout 的實際時間。
- 【預註冊】時間分解必須回算 primary total：`total_time_ms = setup_ms + model_tool_execution_ms + debug_ms + rework_ms + human_intervention_ms + other_wait_ms`。六段時間互斥、不重疊並覆蓋整個 wall-clock 區間；`end_to_end_ms` 若另存只能是同值核對欄，不得再加回 `total_time_ms`。
- 【預註冊】分開記錄 `model_tool_execution_ms`、`debug_ms`、`rework_ms`、`human_interventions`、`human_intervention_ms` 與 `other_wait_ms`；人工介入包含在 primary end-to-end，但不可同時算入其他段。
- 【預註冊】每個 provider 分開記錄可由觀察介面得到的精確 `bytes` 與精確 quota 使用量；觀察不到就填 `NA`。不得從百分比反推 tokens、bytes 或 quota。
- 【預註冊】quota savings 不是預設結論；只有 paired data 可支持時才報告。小樣本只作 directional，不作統計顯著性宣稱。

### 【預註冊】Run status 與納入規則

【預註冊】每次已開始的 run 都保留，不因未完成而刪除或改成 complete-case；primary success rate 與 primary total-time median 的分母包含所有 attempted runs，避免 survivorship bias。失敗與 timeout 的 wall-clock 仍算入其 run 的 `total_time_ms`。

| `run_status` | 判定 | `success` |
|---|---|---|
| `accepted` | 通過 acceptance 並產生可接受結果 | `true` |
| `failed` | 未達 acceptance，非 timeout 或 safety stop | `false` |
| `timed_out` | 到達固定 30 分鐘 timeout | `false` |
| `stopped_safety` | boundary/auth/audit/safety stop | `false` |
| `stopped_manual_repair` | 觸發連續兩次 manual repair stop | `false` |

【預註冊】每個非 `accepted` run 另填 `failure_class` 與 `stop_reason`；可作完成 runs 的次要診斷，但不得從 primary 統計中排除。

## 立即停止條件

【預註冊】任一 task 立刻停止並標記 `stopped_safety`：boundary leak、auth mismatch、audit 缺失、safety failure 或跳過安全檢查。連續兩次需要人工 repair 也立即停止後續 runs，保留完整 evidence。

【預註冊】Performance stop 只使用以下 AND 條件，不得以 OR 觸發：`success_not_improved` 且 `median(C2C total_time_ms) / median(Ordinary Codex total_time_ms) > 1.25`。兩個 median 都在同一批可比較的 paired task 上計算，且納入所有 attempted runs，包括 failed、timed-out 與 stopped runs；任一條件單獨成立都不能停止。

【預註冊】`median(C2C_i total_time_ms / Ordinary_i total_time_ms)` 是次要 paired-ratio diagnostic，只用於描述配對差異，不得取代上述 primary stopping metric。

## 每 task record schema【預註冊】

【預註冊】每個 arm 各一列，兩列以 `pair_id` 配對；空值用 `NA`，不得臆測：

```text
pair_id,task_id,stratum,task_hash,starting_state_hash,arm,order,
commander_model,commander_version,advisor_model,advisor_version,effort_config,
start_time,end_time,run_status,failure_class,setup_mode,setup_cold_ms,
setup_warm_ms,setup_ms,model_tool_execution_ms,debug_ms,rework_ms,
human_interventions,human_intervention_ms,other_wait_ms,end_to_end_ms,total_time_ms,
bytes_by_provider_exact,quota_by_provider_exact,success,human_repaired,
quality_correctness,quality_safety,quality_scope,quality_maintainability,
rubric_total,stop_reason,evidence_paths,notes
```

## 空白 decision table【預註冊】

| 指標 | Ordinary Codex | C2C | paired 判定 | 證據 |
|---|---|---|---|---|
| success rate |  |  |  |  |
| quality rubric |  |  |  |  |
| median total time |  |  |  |  |
| median paired time ratio |  |  |  |  |
| human interventions |  |  |  |  |
| bytes by provider |  |  |  |  |
| quota by provider |  |  |  |  |

## 未來外部試用 gate【預註冊】

2026-10-23 補註：下方「現在嚴格 No-Go」保留的是當時正式 G8 設計的授權狀態，不代表目前按需 C2C 已停用，也不授權新的外部試用；目前流程見[使用說明](C2C_USAGE.md)。

【預註冊】現在嚴格 No-Go。若未來提出 external trial，必須另批一個明確 approval batch，且在任何 send 前完成並留證：connector endpoint、資料分類與 data controls 已審核；revocation 已實測；scope、destination、provider/model、task/content、limits 與 round 都在同一 action-time gate 內。外部試用不得沿用本機 local-test 的核准或假設。
