# Documentation audit — 2026-10-23

## Scope and method

Baseline: `625053d8eb13e839d6a60c4d4e7fbc2709b26b6f`, branch
`codex/wt-docs-20261023`, Windows 11 (ACHIH-MAIN). This audit read all 22 original
in-scope files completely: both READMEs, all 12 files in `docs/`, all five named
skill/metadata/reference files, `package.json`, and both original examples.
`.npmrc`, `pnpm-workspace.yaml`, CLI/review/runner implementations and relevant
tests supplied ground truth. The CLI outputs and script/config table were captured
before edits; no real C2C run, tunnel, browser or remote service was started.

The first column below uses **baseline line numbers**. Evidence in unchanged
source/test files uses their current line numbers. References to edited documents
inside the evidence/action columns use the final documentation line numbers unless
explicitly marked baseline. The action column locates the corresponding minimal
fix in the following fixes commit. Rows group related statements; the counts are
rows, not individual sentences. Newly added `examples/README.md` and this audit
were also read back.

`WRONG` means false for this fork; `STALE` means superseded status;
`AMBIGUOUS` means a concrete reader action can confuse current and historical
behavior; `HISTORICAL-OK` means correctly scoped history; `OK` means consistent
with the checked source or explicit operator policy. Historical consistency is
not a new verification of private logs, UI observations or external policies.
The owner prohibited delegation, so the same agent performed discovery, source
cross-checking and a separate final diff/read-back pass; no independent-agent
review is claimed.

## Ground truth collected first

All eight help invocations exited 0. Their exact output is reproduced below.
`--help` does not show required-vs-optional status: that distinction and effective
defaults were checked in source, not inferred from help formatting.

| CLI entry | Required options (exact spelling) | Optional options and effective defaults | Evidence |
| --- | --- | --- | --- |
| `c2c` | None | `-h, --help`; `-v, --version`; only review/help commands visible | `src/cli/index.ts:125`; captured root help |
| `review` | Subcommand for work | `-h, --help`; inspect, prepare, remote-plan, run, serve, serve-remote | `src/cli/review.ts:39`; captured review help |
| `review inspect` | `--snapshot <file>` | `-h, --help`; no path default | `src/cli/review.ts:77` |
| `review prepare` | `--workspace <path>`, `--task <id>`, `--files <paths...>`, `--data-class <class>`, `--output <file>` | `--base <commit>` defaults to HEAD; `-h, --help`. Classes public/non-sensitive/synthetic; no default class or workspace. Complete commit OID required, not HEAD/ref expressions. | `src/cli/review.ts:55`; `src/review/snapshot.ts:421`; `src/review/snapshot.ts:433` |
| `review remote-plan` | `--snapshot <file>`, `--model <model>`, `--resource <url>`, `--redirect-uri <url>`, `--output <file>` | `--reviewed-snapshot <sha256>` is required for public/non-sensitive, forbidden for synthetic; `-h, --help`. No model/destination default. | `src/cli/review.ts:83`; `src/review/remote-permit.ts:54` |
| `review run` | `--snapshot <file>`, `--model <model>`, `--state-dir <path>`, `--authorize-external-review`, `--reviewed-snapshot <sha256>` | `-h, --help`; no model/state defaults, no TTL/port/idle flags. Public/non-sensitive only; idle 5 minutes; snapshot must have at least 5 minutes remaining. | `src/cli/review.ts:40`; `scripts/run-c2c.mjs:17`; `scripts/run-c2c.mjs:85` |
| `review serve` | `--snapshot <file>`, `--approval <sha256>`, `--state-dir <path>` | `-h, --help`; loopback port 0 (system-assigned), idle 2 minutes. Mode LOCAL_MOCK_ONLY. | `src/cli/review.ts:110`; `src/cli/review.ts:119`; `src/review/session.ts:103` |
| `review serve-remote` | `--snapshot <file>`, `--permit <file>`, `--approval <sha256>`, `--state-dir <path>` | `--port <port>` accepts integer 0..65535, omitted prefers 48765 and falls back to ephemeral on conflict; `-h, --help`. Idle 2 minutes. Mode SYNTHETIC_REMOTE_PILOT or BOUNDED_REMOTE_REVIEW. Does not start a tunnel. | `src/cli/review.ts:31`; `src/cli/review.ts:133`; `src/config/paths.ts:53`; `src/bridge/server.ts:59`; `src/bridge/server.ts:300` |

New CLI snapshots default to 15 minutes from preparation, 30 tool calls and
512 KiB aggregate tool output. Input caps are 20 paths, 64 KiB per before/after
side and 512 KiB combined content. Protocol responses have a separate
32 responses / 16 KiB each / 64 KiB total budget. These are not CLI flags;
see `src/review/snapshot.ts:11` and `src/review/snapshot.ts:425`.
The library supports stricter/custom bounded inputs, while CLI prepare uses its
defaults. Missing legacy dataClass is locally parseable but cannot obtain a
remote permit (`tests/review-data-class.test.ts:31`); CLI prepare requires a class.

All 17 syntactically valid legacy probes returned exit 1 and the exact message:

```text
✗ LEGACY_COMMAND_DISABLED: use c2c review --help.
```

Probed: `start`, `setup`, `stop`, `restart`, `status`, `doctor`, `pair`, `unpair`,
`logs`, `workspace`, `sandbox-allow`, `update-check`, `serve --workspace <this-worktree>`,
`session get`, `session set --url https://example.invalid/`, `session clear`, and
`record --task docs-audit --iteration 1`. A dedicated nonexistent C2C_STATE_DIR
remained nonexistent. `update` is not registered: exit 1,
`error: unknown command 'update'`. Required-argument parsing can reject an
incomplete legacy command before the hook; legacy `--help` can still display
reference options and does not authorize execution. Evidence: `src/cli/index.ts:132`
and `tests/review-cli.test.ts:94`.

| Package/config entry | Exact value | Evidence |
| --- | --- | --- |
| build | `tsc -p tsconfig.json` | `package.json:13` |
| dev | `tsx src/cli/index.ts` (same legacy rejection hook) | `package.json:14`; `src/cli/index.ts:132` |
| test | `vitest run` | `package.json:15` |
| test:g7 | `node scripts/verify-g7.mjs` | `package.json:16` |
| test:g7:windows-native | `node scripts/verify-g7-windows.mjs` | `package.json:17` |
| test:g7:preflight | `node scripts/g7-preflight.mjs` | `package.json:18` |
| test:watch | `vitest` | `package.json:19` |
| typecheck | `tsc --noEmit` | `package.json:20` |
| engines.node / packageManager | `>=20` / `pnpm@11.19.0` | `package.json:9`; `package.json:22` |
| MCP SDK | `1.30.0` | `package.json:24` |
| pnpm store | `.tooling/pnpm-store` | `.npmrc:1` |
| allowed dependency builds | `esbuild: true` | `pnpm-workspace.yaml:1` |

Observed executable versions: `node --version` -> `v24.19.0`;
`$env:CI='true'; corepack pnpm --version` -> `11.19.0`;
`Get-Command pnpm -ErrorAction SilentlyContinue` returned no command.
The owner supplied the October 23 non-TTY/store-change install observation
quoted in F08. It is explicitly attributed rather than represented as an
installation reproduced during this audit; no dependency reinstall was needed.

## Inconsistencies and fixes

Row counts: WRONG 4; STALE 2; AMBIGUOUS 21; HISTORICAL-OK 10; OK 15.

| file:line | statement | actual behaviour (evidence: command output or path:line) | classification | action |
| --- | --- | --- | --- | --- |
| docs/HARDENED_REVIEW.md:91 | F01 — `--data-class` can only be public or synthetic; a maintainer would exclude a valid non-sensitive review. | `review prepare --help`: "public, non-sensitive, or synthetic"; required option and validation at `src/cli/review.ts:59` and `src/cli/review.ts:63`; `tests/review-cli.test.ts:120` tests all three. | WRONG | List all three, require explicit classification, and distinguish legacy unclassified input: `docs/HARDENED_REVIEW.md:91` |
| docs/HARDENED_REVIEW.md:124 | F02 — Only a synthetic snapshot can create a remote permit; this blocks the documented real-review route. | `src/review/remote-permit.ts:54` rejects attestation on synthetic but requires the matching digest for public/non-sensitive; `tests/review-cli.test.ts:357` plans and serves non-sensitive review. | WRONG | Keep the synthetic example and document the other classes and conditional flag: `docs/HARDENED_REVIEW.md:124` |
| docs/HARDENED_REVIEW.md:26; docs/HARDENED_REVIEW.md:98 | F03 — The before side is always pinned HEAD, and inspect is described using HEAD/bytes rather than its actual fields. | `src/review/snapshot.ts:433` selects explicit baseCommit or HEAD; `src/cli/review.ts:60` exposes `--base`; `tests/review-data-class.test.ts:46` proves historical before/current-worktree after. Inspect emits snapshot/baseCommit, not a HEAD or per-file byte-count field (`src/cli/review.ts:80`); operators can calculate UTF-8 bytes. | WRONG | Describe HEAD as the default, inspect taskId/baseCommit and calculate UTF-8 bytes: `docs/HARDENED_REVIEW.md:26`; `docs/HARDENED_REVIEW.md:98` |
| docs/HARDENED_REVIEW.md:169 | F04 — The exclusive audit-field list omits destination metadata; a reader would understate what is persisted. | `src/review/session.ts:191` records remote_review metadata and `src/review/session.ts:199` serializes it; `src/bridge/server.ts:100` supplies resource, redirectUri, model, permitDigest. | WRONG | Include remote approval metadata, retain the no-token/no-source-content boundary: `docs/HARDENED_REVIEW.md:169` |
| docs/G8_EXPERIMENT.md:5 | F05 — Current usability is 8/10 and complete timing/rework comparison is not accepted. | `docs/C2C_REAL_ACCEPTANCE.md:11` explicitly supersedes 8/10 with 7/10; `docs/C2C_REAL_ACCEPTANCE.md:36` records the completed comparison; `docs/C2C_MEASUREMENT.md:9` confirms supersession. This is reconciliation of published records, not a new benchmark. | STALE | Update only the current-status paragraph, preserve preregistration and original synthetic scores: `docs/G8_EXPERIMENT.md:5` |
| docs/HARDENED_REVIEW.md:41; docs/HARDENED_REVIEW.md:176 | F06 — Public real repositories still require capability expansion, as in the earlier synthetic-only phase. | Real public/non-sensitive support already exists: `src/cli/review.ts:40`, `scripts/run-c2c.mjs:85`, `tests/review-cli.test.ts:357`; completed real-use report at `docs/C2C_REAL_ACCEPTANCE.md:15`. | STALE | Replace pending implementation language with the existing run route while retaining scoped approval: `docs/HARDENED_REVIEW.md:41`; `docs/HARDENED_REVIEW.md:176` |
| README.md:49; README.md:113; README.md:190 | F07 — Deep links to upstream install/developer sections expose setup, sandbox helpers, automatic setup and a 76-test example without an adjacent fork marker. | The top marker at baseline `README.md:17` is correct, but standalone section readers miss it. Root help lists only review/help; `src/cli/index.ts:132` rejects legacy actions. | AMBIGUOUS | Add short historical notes under all three headings; retain every upstream command and count: `README.md:54`; `README.md:120`; `README.md:199` |
| README.md:14; README.zh-CN.md:12; docs/C2C_CROSS_MACHINE.md:36 | F08 — Installation omits the non-TTY store-migration prerequisite and can lead a maintainer to use unavailable bare pnpm. | Observed here: `node --version` -> `v24.19.0`; `corepack pnpm --version` with CI=true -> `11.19.0`; `Get-Command pnpm` -> no command. `.npmrc:1` is `store-dir=.tooling/pnpm-store`. Owner-supplied 2026-10-23 install output: `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` when old node_modules used a different store; CI=true allowed purge/reinstall. Reinstallation was not repeated in this audit. | AMBIGUOUS | Add PowerShell CI/Corepack instructions, local store and replacement consequence: `README.md:16`; `README.zh-CN.md:3`; `docs/C2C_CROSS_MACHINE.md:39` |
| README.md:13; README.zh-CN.md:11 | F09 — Shared quota is stated as an undated current fact, although this audit concerns repository behavior. | The supporting record is dated 2026-08-31 at `docs/C2C_REAL_ACCEPTANCE.md:58` and `docs/C2C_USAGE.md:57`; current external quota policy is not established by source code or this audit. | AMBIGUOUS | Attribute the statement to that historical report, without claiming a new verification: `README.md:13`; `README.zh-CN.md:3` |
| docs/architecture.md:3; docs/architecture.md:31; docs/architecture.md:39; docs/architecture.md:54 | F10 — Standalone architecture describes live workspace reads, eight tools, refresh tokens, --json everywhere, daemon reuse and automatic tunnel/doctor repair. | Current tools: `src/mcp/server.ts:45` through `src/mcp/server.ts:107`; CLI flags: `src/cli/review.ts:40`; no refresh in review: `src/auth/oauth.ts:420`; bridge tunnel start returns `PUBLIC_TUNNEL_DISABLED` at `src/bridge/server.ts:268`. Historical module descriptions are not the fork contract. | AMBIGUOUS | Add a document-wide historical banner with current differences and guide link: `docs/architecture.md:3` |
| docs/protocol.md:3; docs/protocol.md:98; docs/protocol.md:127; docs/protocol.md:158; docs/protocol.md:163 | F11 — Standalone protocol instructs PLAN/EXECUTED loops, record/session commands, maxIterations=12 and a live-workspace boot prompt. | `src/cli/index.ts:132` blocks record/session; `src/mcp/server.ts:45` exposes snapshot tools only. `rg -n maxIterations src scripts tests` finds only the config type (`src/workspace/manager.ts:60`) and parsing assertions (`tests/workspace.test.ts:158`), not a runtime loop. | AMBIGUOUS | Preserve protocol and example numbers, label the entire document historical and link current workflow: `docs/protocol.md:3` |
| docs/security.md:5; docs/security.md:23; docs/security.md:26; docs/security.md:35; docs/security.md:42 | F12 — Standalone security text promises workspace-wide scopes, one-hour/30-day refresh behavior, .env.example access and OS-convention state storage. | Review scopes are workspace.read/git.read (`src/auth/oauth.ts:200`); access TTL is bounded by review expiry (`src/auth/oauth.ts:407`), refresh rejected (`src/auth/oauth.ts:420`); `.env.example` rejected (`src/review/snapshot.ts:140`); dedicated state/private child (`src/review/session.ts:106`). | AMBIGUOUS | Mark upstream guarantees historical, summarize actual fork boundaries and point to operating guide: `docs/security.md:3` |
| docs/troubleshooting.md:3; docs/troubleshooting.md:14; docs/troubleshooting.md:32; docs/troubleshooting.md:50; docs/troubleshooting.md:56; docs/troubleshooting.md:76 | F13 — First move is doctor; other recipes repair/restart/re-pair, install arbitrary cloudflared or rewrite global sandbox configuration. | All listed legacy actions return `LEGACY_COMMAND_DISABLED: use c2c review --help.` (captured CLI probes); `src/cli/index.ts:132`; current runner pins binary/hash at `scripts/run-c2c.mjs:19` and `scripts/run-c2c.mjs:54`. | AMBIGUOUS | Add a historical banner directing installation and uncertain-session handling to fork guides: `docs/troubleshooting.md:3` |
| docs/C2C_CROSS_MACHINE.md:10; docs/C2C_CROSS_MACHINE.md:41; docs/C2C_CROSS_MACHINE.md:45 | F14 — A present-day installer is sent only to August repair/manifest results; the dated baseline can be mistaken for current test totals. | `docs/C2C_REPAIR_2026-08-31.md:40` labels several distinct historical runs (402/404 totals). The user supplied a 399-test October baseline; this audit records its own final run separately. | AMBIGUOUS | Add a dated pointer to this audit without changing any historical counts: `docs/C2C_CROSS_MACHINE.md:12` |
| docs/C2C_CROSS_MACHINE.md:59; skill/SKILL.md:52 | F15 — Checking cloudflared generically suggests that a PATH/current version is enough to run the fork. | `scripts/run-c2c.mjs:19` fixes `.tooling/downloads/cloudflared-2026.8.2-windows-amd64.exe`; `scripts/run-c2c.mjs:54` checks SHA-256 before lifecycle side effects. Synthetic runner uses the same hash at `scripts/run-c2c-pilot.mjs:43`. | AMBIGUOUS | Name the Windows binary requirement and link the existing hash: `docs/C2C_CROSS_MACHINE.md:73`; `skill/SKILL.md:55` |
| docs/C2C_CROSS_MACHINE.md:58; docs/C2C_USAGE.md:13 | F16 — Project-only setup and a historical global installation statement leave unclear whether clone/reload installs the cross-project entry. | `skill/global-entry/SKILL.md:20` requires host-specific adjacent implementation.json and validates the maintained checkout; `skill/global-entry/SKILL.md:51` grants no installation permission. Baseline `_HANDOFF.md:19` describes three installed router files, not an automatic clone hook. | AMBIGUOUS | Distinguish project default, separately installed router and historical host state: `docs/C2C_CROSS_MACHINE.md:70`; `docs/C2C_USAGE.md:14` |
| docs/HARDENED_REVIEW.md:9 | F17 — Synthetic is only legacy evidence; a reader could infer that the CLI no longer accepts it. | `src/cli/review.ts:59` still accepts synthetic, as do local serve/remote-plan; only the real runner rejects it (`scripts/run-c2c.mjs:90`). | AMBIGUOUS | Separate current task workflow from still-supported synthetic testing: `docs/HARDENED_REVIEW.md:9` |
| docs/HARDENED_REVIEW.md:24 | F18 — The offline-cache trust-lockfile sentence can be read as the current installation configuration. | The complete `.npmrc:1` only sets local store; `pnpm-workspace.yaml:1` only lists esbuild in allowBuilds. No trust-lockfile setting is present in these tracked files. The older private install log was not accessed. | AMBIGUOUS | Label the earlier offline installation remark historical and point to actual current files: `docs/HARDENED_REVIEW.md:24` |
| docs/HARDENED_REVIEW.md:137; docs/HARDENED_REVIEW.md:157 | F19 — Optional remote port and local-only idle table do not tell operators which defaults the runner actually uses; remote mode output is only described for synthetic. | `src/cli/review.ts:31` validates 0..65535; `src/cli/review.ts:119` sets local port=0; `src/config/paths.ts:53` and `src/bridge/server.ts:300` give remote default 48765 with fallback (`src/bridge/server.ts:59`). `src/review/session.ts:103` defaults idle to 120000 ms; `scripts/run-c2c.mjs:17`/`:93`/`:227` use and require 300000 ms. `src/cli/review.ts:159` selects both mode labels. | AMBIGUOUS | Add exact per-entry defaults, remaining-TTL requirement and both mode labels: `docs/HARDENED_REVIEW.md:137`; `docs/HARDENED_REVIEW.md:157` |
| docs/HARDENED_REVIEW.md:165 | F20 — Remote pilot stops via stdin stop/EOF; placed after serve-remote it can be applied to the direct server command. | `scripts/pilot-input.mjs:61` handles stop and `scripts/pilot-input.mjs:79` handles EOF for runners; direct serve/serve-remote only register SIGINT/SIGTERM (`src/cli/review.ts:125`, `src/cli/review.ts:167`). | AMBIGUOUS | Name both runners and explicitly distinguish direct-server shutdown: `docs/HARDENED_REVIEW.md:165` |
| docs/HARDENED_REVIEW.md:188; docs/HARDENED_REVIEW.md:195; docs/G7_WINDOWS_ACCEPTANCE.md:7; docs/G7_WINDOWS_ACCEPTANCE.md:17 | F21 — G7 is called passed in this checkout and bare pnpm examples may be followed as a current host result. | The 260-test run is dated August 30 in the published G7 record; current normal-suite success cannot satisfy strict G7 when skips remain (`scripts/verify-g7.mjs:48`, `scripts/verify-g7.mjs:67`). Bare pnpm is absent on this host (F08). | AMBIGUOUS | Add dated historical-vs-current notes and Corepack/CI usage; keep the original G7 results: `docs/HARDENED_REVIEW.md:188`; `docs/G7_WINDOWS_ACCEPTANCE.md:7` |
| docs/G7_WINDOWS_ACCEPTANCE.md:13 | F22 — The rerunnable native-driver entry does not disclose its maintainer-specific Node executable dependency. | `scripts/verify-g7-windows.mjs:8` hardcodes bundledNode and `scripts/verify-g7-windows.mjs:186` launches it. Help/no-authorization safety does not make that path portable. | AMBIGUOUS | Document the host dependency; defer changing the driver to an owner decision: `docs/G7_WINDOWS_ACCEPTANCE.md:15` |
| docs/G8_EXPERIMENT.md:122 | F23 — The historical preregistration says "currently strict No-Go", which can be mistaken for the present opt-in decision. | `docs/G8_EXPERIMENT.md:37` scopes the historical formal G8; `docs/C2C_REAL_ACCEPTANCE.md:8` permits opt-in C2C, and `docs/C2C_REAL_ACCEPTANCE.md:54` explicitly says restriction is not disabling it. | AMBIGUOUS | Add dated scope note immediately before the retained No-Go text: `docs/G8_EXPERIMENT.md:122` |
| skill/references/chatgpt-connector.md:13 | F24 — The example state root is relative _working/c2c-rNN-..., although the paragraph requires outside the reviewed repository. | `scripts/run-c2c.mjs:39` rejects in-root state; `src/review/session.ts:37` enforces the same boundary. Running the example from the reviewed root would fail. | AMBIGUOUS | Use an absolute task-root placeholder explicitly outside the target repository: `skill/references/chatgpt-connector.md:14` |
| skill/references/chatgpt-connector.md:15 | F25 — Send the exact approved permit digest through stdin; a reader may send the digest alone. | `scripts/pilot-input.mjs:69` matches only `^approve ([a-f0-9]{64})$`; the canonical skill already supplies this syntax. | AMBIGUOUS | Spell out the required approve prefix: `skill/references/chatgpt-connector.md:17` |
| examples/c2c.json:1; examples/c2cignore.example:1 | F26 — Unlabelled maxIterations example suggests an active loop; ignore comment suggests immediate invisibility to ChatGPT. | maxIterations is only parsed (`src/workspace/manager.ts:60`, `tests/workspace.test.ts:158`); snapshot ignores apply at creation (`src/review/snapshot.ts:415` and `src/review/snapshot.ts:423`), while session reads saved bytes (`src/review/session.ts:272`). | AMBIGUOUS | Keep JSON unchanged, add `examples/README.md:3` and correct the ignore comment at `examples/c2cignore.example:1` |
| docs/C2C_MEASUREMENT.md:4; docs/C2C_MEASUREMENT.md:16; docs/C2C_MEASUREMENT.md:41; docs/C2C_MEASUREMENT.md:126 | F27 — Commands and relative aggregate/manifest references can look like shipped files or instructions to repeat the completed batch. | `docs/C2C_REAL_ACCEPTANCE.md:71` says raw evidence is maintainer-local and unpublished; `git ls-files docs examples skill` has no aggregate or manifest. Measurement status itself says complete at baseline `docs/C2C_MEASUREMENT.md:3`. | AMBIGUOUS | Add only a dated historical/local-artifact note; preserve all numeric results and original commands: `docs/C2C_MEASUREMENT.md:3` |

## Checked and found consistent

The following rows cover the remaining command, policy, path, count, date and historical claims, including every unchanged in-scope file. “Retain” is a deliberate disposition, not an unread file.

| file:line | statement | actual behaviour (evidence: command output or path:line) | classification | action |
| --- | --- | --- | --- | --- |
| README.md:3; README.zh-CN.md:3 | C01 — Opt-in task-bound snapshot review; Codex retains planning/execution/verification; public/non-sensitive real use requires digest and destination approval. | `skill/SKILL.md:11` defines the operator workflow; `src/cli/review.ts:40`, `src/review/remote-permit.ts:54`, and `scripts/run-c2c.mjs:218` enforce its machine-visible bindings. | OK | Retain; operational opt-in/consent remains an operator obligation, not inferred from a digest. |
| README.md:17; README.md:21; README.md:137; README.md:172; README.md:208; README.md:226; README.zh-CN.md:14; README.zh-CN.md:19 | C02 — Upstream quota sales pitch, live workspace diagram, eight tools, broad file promises, refresh/long-lived session behavior, old layout and V1 zero-touch claims. | Both baseline README banners explicitly mark all following upstream material historical (`README.md:17`, `README.zh-CN.md:14`). Current counter-contract is `src/mcp/server.ts:45`, `src/auth/oauth.ts:200`, `src/review/snapshot.ts:140`, `src/cli/index.ts:132`. | HISTORICAL-OK | Keep original bilingual upstream text, layout, diagrams and license; F07 adds nearby install-section reminders. |
| README.md:195; README.zh-CN.md:139 | C03 — 76 tests in the upstream developer example. | Covered by the explicit upstream-history banners at baseline `README.md:17` and `README.zh-CN.md:14`; it is not the hardened-fork baseline. Current test evidence is recorded separately in this audit. | HISTORICAL-OK | Do not replace an upstream historical number with current suite totals. |
| README.md:10; README.zh-CN.md:9; docs/C2C_USAGE.md:52; skill/SKILL.md:98 | C04 — Ten pairs, 7/10 personal score, Ordinary 10/10 vs C2C 8/10, 1.92x median and unknown quota. | `docs/C2C_REAL_ACCEPTANCE.md:11`, `docs/C2C_REAL_ACCEPTANCE.md:36`, and `docs/C2C_MEASUREMENT.md:130` agree: 431198.44065 / 224997.38965 = 1.91646, rounded 1.92. Original private records were not reread. | HISTORICAL-OK | Preserve the published historical comparison; do not claim fresh external acceptance. |
| docs/C2C_CROSS_MACHINE.md:15; docs/C2C_CROSS_MACHINE.md:18; docs/C2C_CROSS_MACHINE.md:27; docs/C2C_CROSS_MACHINE.md:61 | C05 — Fork branch and repository location, short non-synced checkout, no reset of local changes, no syncing dependencies or private run state. | Local `git log -6 --oneline` identifies 625053d, b6b71dc, 7cf5eb6 and upstream archive 389ffd9; the provided task identifies the base fork branch. `package.json:12` builds local dist; `scripts/run-c2c.mjs:125` and `src/review/session.ts:108` create private state. Remote publication/manifest not checked. | OK | Retain instructions as destination/handling policy, not proof of current remote publication. |
| docs/C2C_CROSS_MACHINE.md:41; docs/C2C_CROSS_MACHINE.md:48; docs/C2C_CROSS_MACHINE.md:54 | C06 — 156-package fresh install, 402-test baseline, old-host 11 failures, 247/248/261-character probe and 48 deeper-path failures. | `docs/C2C_REPAIR_2026-08-31.md:12` through `docs/C2C_REPAIR_2026-08-31.md:21` records install/test baselines; baseline `_HANDOFF.md:146` and `_HANDOFF.md:149` record path observations and unresolved causation. These are explicitly historical; private logs are outside permitted access. | HISTORICAL-OK | Keep all historical numbers and uncertainty; F14 only adds the current-audit pointer. |
| docs/C2C_USAGE.md:5; docs/C2C_USAGE.md:17; docs/C2C_USAGE.md:21; skill/global-entry/SKILL.md:1; skill/global-entry/agents/openai.yaml:1; skill/agents/openai.yaml:1 | C07 — Natural-language C2C requests, optional $c2c, implicit discovery but explicit task activation; thin router preserves caller/target roots and fails on missing binding. | `skill/global-entry/SKILL.md:8` defines intent/negative cases; `skill/global-entry/SKILL.md:20` through `skill/global-entry/SKILL.md:49` defines binding/target/absolute paths; both YAML policies are true. `bin/c2c.js:9` resolves built CLI via file URL. Host-specific implementation.json is intentionally absent from tracked source. | OK | Keep metadata and router source unchanged; policy consistency verified, live host skill discovery not exercised. |
| docs/C2C_USAGE.md:28; docs/C2C_USAGE.md:33; docs/C2C_USAGE.md:41; skill/SKILL.md:26; skill/SKILL.md:76 | C08 — Snapshot-only advice, reviewed real classes, no sensitive data, scoped consent, fresh retry only after terminal cleanup, no silent global repair. | `src/review/snapshot.ts:420` validates classes; `src/review/session.ts:129` enforces single-use within dedicated state; `scripts/run-c2c.mjs:85` validates admission; `tests/review-content.test.ts:4` covers content screening. Operator consent/provenance and prohibition on changing state dirs remain policies (`skill/SKILL.md:47`, `docs/HARDENED_REVIEW.md:174`). | OK | Retain. Do not elevate policy into an across-all-state-directories technical guarantee. |
| docs/HARDENED_REVIEW.md:79; docs/HARDENED_REVIEW.md:83; docs/HARDENED_REVIEW.md:93; docs/HARDENED_REVIEW.md:100; docs/HARDENED_REVIEW.md:115; docs/HARDENED_REVIEW.md:128 | C09 — PowerShell examples use real prepare/inspect/serve/remote-plan/serve-remote flags, exact relative paths and outside-root outputs/state. | All options match captured help; `src/cli/review.ts:55`, `src/cli/review.ts:77`, `src/cli/review.ts:83`, `src/cli/review.ts:110`, `src/cli/review.ts:133`; `src/review/snapshot.ts:108` rejects globs/backslashes/traversal; `src/cli/review.ts:25` rejects in-root output. | OK | Keep examples; F01/F02/F03/F19 correct adjacent descriptions, not the already-valid commands. |
| docs/HARDENED_REVIEW.md:109; docs/HARDENED_REVIEW.md:174 | C10 — Private Windows snapshot/permit creation, .c2c-review-private lock/audit/auth child, existing-path validation, legacy-state refusal, no blind stale-lock deletion. | `src/review/private-storage.ts:180` and `src/review/private-storage.ts:200` implement private creation; `src/review/session.ts:56`, `src/review/session.ts:108`, `src/review/session.ts:129`; `tests/review-session.test.ts:78` and `tests/review-session.test.ts:88` check layout/refusal. | OK | Retain Windows-specific scope and operational stale-lock handling. |
| docs/HARDENED_REVIEW.md:145; docs/HARDENED_REVIEW.md:148; docs/HARDENED_REVIEW.md:149; docs/HARDENED_REVIEW.md:152 | C11 — Local mock provider/model/purpose, 20 files, 64 KiB per side, 512 KiB content/output, 15-minute TTL, 2-minute idle, 30 calls, protocol 32/16 KiB/64 KiB. | `src/review/snapshot.ts:11` through `src/review/snapshot.ts:21` defines limits; `src/review/snapshot.ts:417` defines mock-reviewer; `src/review/snapshot.ts:444` defines local-test/diff-review; `src/review/session.ts:103`, `src/review/session.ts:173`, `src/review/session.ts:234` enforce budgets. | OK | Retain local defaults and separate protocol budget; F19 clarifies runner-specific idle without changing these values. |
| docs/HARDENED_REVIEW.md:161; docs/HARDENED_REVIEW.md:162; docs/HARDENED_REVIEW.md:163; skill/SKILL.md:59; skill/SKILL.md:62 | C12 — Local four tools, remote three read tools, exact OAuth resource/redirect and no refresh grant. | `src/mcp/server.ts:45`, `src/mcp/server.ts:95`, `src/bridge/server.ts:210`, `src/auth/oauth.ts:200`, `src/auth/oauth.ts:303`, `src/auth/oauth.ts:403`, `src/auth/oauth.ts:420`; tested by `tests/review-cli.test.ts:357` and review OAuth suites. | OK | Retain; no live directory/search/git tools are advertised by this fork. |
| docs/HARDENED_REVIEW.md:164; docs/HARDENED_REVIEW.md:166; docs/HARDENED_REVIEW.md:167; docs/HARDENED_REVIEW.md:168; skill/SKILL.md:65 | C13 — Closure on completion/expiry/budget/audit failure, separate protocol accounting, empty 204 when output cannot fit, revocation does not erase prior disclosure. | `src/review/session.ts:173`, `src/review/session.ts:185`, `src/review/session.ts:234`; `src/mcp/http.ts:40` suppressResponse path; `src/bridge/server.ts:330` shutdown and `src/bridge/server.ts:348` expiry callback; `tests/review-session.test.ts:94`/`:104` and `tests/review-security.test.ts` cover enforcement. | OK | Retain; real endpoint/UI cleanup is an operator check, not certified by a printed receipt. |
| docs/HARDENED_REVIEW.md:56; docs/HARDENED_REVIEW.md:62; docs/HARDENED_REVIEW.md:66; docs/HARDENED_REVIEW.md:73; docs/HARDENED_REVIEW.md:75; docs/HARDENED_REVIEW.md:180 | C14 — Synthetic generator takes no args, creates one trial repo, 3 regressions/6 files, baseline 0/defect 1; runner pins binary/hash, checks exact bytes, awaits approve and supports stop/EOF. | `scripts/prepare-c2c-pilot.mjs:109` through `scripts/prepare-c2c-pilot.mjs:139` records cases and exits; `scripts/prepare-c2c-pilot.mjs:145` rejects args; `scripts/run-c2c-pilot.mjs:18`, `scripts/run-c2c-pilot.mjs:43`, `scripts/run-c2c-pilot.mjs:52`, `scripts/pilot-input.mjs:61` implement the contract. | OK | Retain synthetic examples and fixed hash. No pilot was run during this audit. |
| docs/HARDENED_REVIEW.md:30; docs/HARDENED_REVIEW.md:32; docs/HARDENED_REVIEW.md:38; docs/HARDENED_REVIEW.md:184; docs/G7_WINDOWS_ACCEPTANCE.md:15; docs/G8_EXPERIMENT.md:29 | C15 — August G7 run identifiers/times, 260-test pass, failed earlier trial, 13 synthetic reads, 3 defects, 14478 response bytes and 9/10 synthetic rubric. | The same dated events appear in baseline `docs/G7_WINDOWS_ACCEPTANCE.md:15`/`:17`, `docs/G8_EXPERIMENT.md:29` through `:35`, and `docs/HARDENED_REVIEW.md:32` through `:40`; rubric sum is 1+2+2+2+2=9. Private raw evidence was not opened. | HISTORICAL-OK | Preserve the events, failures, dates and scores; F21 prevents claiming a fresh G7 pass. |
| docs/G7_WINDOWS_ACCEPTANCE.md:7; docs/G7_WINDOWS_ACCEPTANCE.md:9; docs/G7_WINDOWS_ACCEPTANCE.md:11; docs/G7_WINDOWS_ACCEPTANCE.md:21; docs/HARDENED_REVIEW.md:190 | C16 — Preflight exit 0/2/1; formal gate reruns typecheck/build/all tests, refuses skips/todos and missing seven native evidence IDs; no external authorization. | `scripts/g7-preflight.mjs:26`; `scripts/verify-g7.mjs:7` has seven IDs; `scripts/verify-g7.mjs:43`, `:48`, `:67`, `:75`, `:81`, `:105` implement strict evaluation, commands and output paths. `scripts/verify-g7-windows.mjs:93` refuses absent authorization. | OK | Retain gate policy and UAC requirements. No elevated/native G7 run was needed for documentation changes. |
| docs/G8_EXPERIMENT.md:11; docs/G8_EXPERIMENT.md:37; docs/G8_EXPERIMENT.md:59; docs/G8_EXPERIMENT.md:71; docs/G8_EXPERIMENT.md:85; docs/G8_EXPERIMENT.md:93 | C17 — Historical preregistration: synthetic five-part rubric, recommended N=12, strata/order, 30-minute work limit, six time components, all-attempt denominator, 1.25 AND stopping rule and record schema. | The file labels this design historical at `docs/G8_EXPERIMENT.md:5` and preregistered at `docs/G8_EXPERIMENT.md:39`; the later ten-pair measurement explicitly separates it at `docs/C2C_MEASUREMENT.md:9`. This is a study protocol, not a CLI default. | HISTORICAL-OK | Preserve every preregistered number, schema and formal-study limitation; update only the stale current-status paragraph (F05) and add F23 note. |
| docs/C2C_MEASUREMENT.md:11; docs/C2C_MEASUREMENT.md:19; docs/C2C_MEASUREMENT.md:59; docs/C2C_MEASUREMENT.md:106 | C18 — Recorder CLI/event shapes, new directory, READY/ACK/FINISHED, monotonic full-route clock, incomplete EOF, metric calculator versus independent evidence judgment. | `scripts/record-c2c-route.mjs:26`, `:41`, `:75`, `:96`, `:125`, `:167`, `:173`; `scripts/compare-c2c-runs.mjs:5`, `:135`, `:139`; `scripts/check-c2c-answer-evidence.mjs:11` and `:50` separate excerpt/length checks from truth. | OK | Retain the method; F27 identifies the historical inputs and does not rerun or alter the batch. |
| docs/C2C_MEASUREMENT.md:124; docs/C2C_REAL_ACCEPTANCE.md:3; docs/C2C_REAL_ACCEPTANCE.md:13; docs/C2C_REAL_ACCEPTANCE.md:36; docs/C2C_REAL_ACCEPTANCE.md:56; docs/C2C_REAL_ACCEPTANCE.md:69 | C19 — Full historical ten-pair numbers, 397/0/5 integration result, 30 versus 27 reads, failed answers, invalid R03/replacement, warm known-task limitations and local evidence paths. | Cross-document consistency checked against baseline `docs/C2C_MEASUREMENT.md:126` through `:150` and `docs/C2C_REAL_ACCEPTANCE.md:36` through `:76`; raw records are explicitly private at `docs/C2C_REAL_ACCEPTANCE.md:71`. 330476.2829 ms rounds to 5.51 minutes. These records are not a current test run. | HISTORICAL-OK | Keep all results unchanged; only F27 adds a dated note to the measurement document. |
| docs/C2C_REAL_ACCEPTANCE.md:20; docs/C2C_REAL_ACCEPTANCE.md:31 | C20 — Historical legacy-helper repairs are distinguished from the snapshot-only runtime and do not claim universal containment. | Relevant current safeguards: `src/workspace/git.ts:235` uses raw NUL endpoint metadata and `src/workspace/git.ts:376` disables external diff/textconv; `src/workspace/config.ts:8` verifies opened descriptors; `src/review/snapshot.ts:108` enforces snapshot paths. `docs/C2C_REAL_ACCEPTANCE.md:31` explicitly scopes the old helper issues. | HISTORICAL-OK | Retain repair history; no new vulnerability/security-certification claim. |
| docs/C2C_REPAIR_2026-08-31.md:1; docs/C2C_REPAIR_2026-08-31.md:12; docs/C2C_REPAIR_2026-08-31.md:25; docs/C2C_REPAIR_2026-08-31.md:40; docs/C2C_REPAIR_2026-08-31.md:48; docs/C2C_REPAIR_2026-08-31.md:70 | C21 — Dated portability repair, 402/404 totals, one AUTH_STORE_UNAVAILABLE run, final 399/0/5 of 404, 15s CLI fixture/25s timeout and unverified secondary host. | `tests/bin.test.ts:9` and `tests/bin.test.ts:10` preserve 15s/25s; `tests/g7-windows-driver.test.ts:199` and `tests/g7-windows-driver.test.ts:208` cover missing-cache/private PowerShell helper diagnostics; `git log --oneline` contains b6b71dc "test: harden Windows cross-machine verification". Numeric records remain historical and are not independently reconstructed from inaccessible logs. | HISTORICAL-OK | Leave the entire repair document byte-for-byte unchanged; do not erase intermittent failure or relabel old-host verification. |
| skill/SKILL.md:37; skill/SKILL.md:69; skill/SKILL.md:91; skill/references/chatgpt-connector.md:38; skill/references/chatgpt-connector.md:60 | C22 — Current task steps: prepare/inspect/run, approval, prompt stop before local fixes, cleanup evidence, mechanical answer excerpts/word count and full-route measurement. | `src/cli/review.ts:40`; `scripts/run-c2c.mjs:85`, `:148`, `:218`; `scripts/check-c2c-answer-evidence.mjs:11`, `:33`, `:38`, `:50`; `scripts/record-c2c-route.mjs:26`. Browser-side cleanup remains a manual observed requirement. | OK | Retain workflow; F15/F24/F25 clarify prerequisites, state placement and stdin syntax. |
| skill/references/chatgpt-connector.md:3; skill/references/chatgpt-connector.md:20; skill/references/chatgpt-connector.md:31 | C23 — Specific browser APIs, OAuth popup/tab steps, plugin UI labels and model/effort observations. | The recipe explicitly dates observations 2026-08-31 and requires the active browser skill/current visible UI at `skill/references/chatgpt-connector.md:3`; it does not assert those APIs are a current universal browser contract. | HISTORICAL-OK | Keep dated UI recipe; no browser, connector or account state accessed to revalidate it. |
| package.json:9; package.json:12; package.json:22; package.json:24 | C24 — Declared Node >=20, eight scripts, pnpm@11.19.0 and SDK 1.30.0. | Read package.json completely; every script target exists. `.npmrc:1` pins local store; `pnpm-workspace.yaml:1` permits esbuild. Current executable probes returned Node v24.19.0 and Corepack pnpm 11.19.0. | OK | Leave package.json/scripts/engines and install config unchanged. Declared minimum is not a claim of testing every Node 20 release. |
| examples/c2cignore.example:2; examples/c2cignore.example:5; examples/c2cignore.example:8 | C25 — Sensitive defaults remain enforced; custom internal-notes/ and fixtures/**/*.snap use gitignore syntax. | `src/workspace/ignore.ts:84` loads .c2cignore via the safe config reader; `src/review/snapshot.ts:24` keeps static deny rules and `src/review/snapshot.ts:135` applies both static/custom rules. | OK | Keep sample patterns and sensitive-default comments; F26 clarifies timing and adds usage context. |

## Open decisions and verification limits

1. **MCP tool descriptions with explicit historical base.** `src/mcp/server.ts:67`
   calls before a fixed HEAD pair, and `src/mcp/server.ts:84` says pinned HEAD.
   With `--base`, actual bytes come from the requested base commit
   (`src/review/snapshot.ts:433`; `tests/review-data-class.test.ts:46`). The operator
   guide now describes the real behavior (F03), but changing these code-embedded
   tool descriptions needs a separate source change. No source was edited here.
2. **Native G7 driver portability.** F22 documents the fixed Node path in
   `scripts/verify-g7-windows.mjs:8`. Replacing it with a validated portable
   executable is a separate code decision; this audit did not run UAC/native G7.
3. **External or private facts.** Remote branch/publication state, cloud
   release-manifest hashes, current global skill installation, current ChatGPT UI
   and quota rules, original benchmark answers/logs, old-machine results and the
   intermittent AUTH_STORE_UNAVAILABLE root cause were not reverified. The audit
   checked their published dates, scope and cross-document consistency only.
   No prior `_working/` content, auth state or private source data was read.
4. **Policy versus implementation.** Consent/provenance, once-per-batch approval,
   not switching state directories to evade a receipt, and UI cleanup are operator
   duties. Local tests and digest checks do not prove those duties were followed
   in a real external run. No new external/security/performance acceptance is claimed.

## Final validation

Build and the full suite were each run exactly once after the documentation
edits, with `CI=true`, Node v24.19.0 and Corepack pnpm 11.19.0. Build exited 0
(9.44 seconds). The full suite exited 1:

```text
Test Files  7 failed | 31 passed (38)
     Tests  21 failed | 378 passed | 5 skipped (404)
    Errors  1 error
  Duration  310.53s
```

**The no-regression acceptance criterion is NOT met.** These are this run's
actual totals, not the owner's supplied 394/0/5 baseline (399 tests). The total
count difference has not been reconciled. The source/tests/package configuration
were not changed, but this fact alone does not establish the cause of failure.
The OK rows above establish documentation/source consistency, not a passing
runtime/security certification. Test references identify assertions in source;
they must not be interpreted as claims that every cited test passed this run.

Failure distribution from the captured output:

| Test file | Failed | Observed failure |
| --- | --- | --- |
| `tests/bin.test.ts` | 1 | CLI status 1 rather than 0 (`:38`) |
| `tests/c2c-runner.test.ts` | 3 | PRIVATE_STORAGE_UNAVAILABLE |
| `tests/review-cli.test.ts` | 3 | 30000 ms timeout; two null process statuses |
| `tests/review-private-storage.test.ts` | 1 | ACL_READBACK_UNAVAILABLE |
| `tests/review-remote-bridge.test.ts` | 1 | APPROVAL_USED_OR_AUDIT_UNAVAILABLE |
| `tests/review-security.test.ts` | 8 | Private state/lock/auth-store failures |
| `tests/review-session.test.ts` | 4 | Private state/lock/audit failures |

Vitest also reported `[vitest-worker]: Timeout calling "onTaskUpdate"`.
The five skips concern denied native file-symlink creation. No test was retried,
weakened or changed. A separate code/environment investigation is needed before
claiming 0 failed; this audit does not assign an unverified root cause.

The runner finished its summary before output capture returned. A leftover
PowerShell ACL helper was confirmed to belong to this worktree and this run,
then stopped; its retained pipe handles were released after process exit to
recover the original output. The wrapper's 1099.98 seconds includes this capture
delay, not a second test run. Temporary test files stayed within this worktree.
Raw build/test output and result metadata are retained in this task's own
uncommitted `_working/docs-audit-{build,test}.log` and corresponding result JSON.

`python -X utf8 _working/docs-audit-verify.py` checked all 17 changed files:
U+FFFD 0; literal question mark adjacent to CJK 0; double-question 0;
UTF-8/CRLF/no-BOM errors 0; 65 local links valid; all 52 rows have evidence and
all 27 actionable rows reference changed-file locations. The two protected
historical reports are unchanged, and the measurement file differs only by its
dated note. `git diff --check` passed. No source/test changes, external session,
push, remote change, other checkout or additional worktree was involved.

## Captured CLI help

The output below was obtained with `node bin/c2c.js` from this worktree.
No review action was run to collect it.

```text
$ node bin/c2c.js --help
Usage: c2c [options] [command]

Codex with ChatGPT: approved snapshot review.

Options:
  -v, --version   output the version number
  -h, --help      display help for command

Commands:
  help [command]  display help for command
  review          Approved, single-use snapshot review
exit=0

$ node bin/c2c.js review --help
Usage: c2c review [options] [command]

Approved, single-use snapshot review

Options:
  -h, --help              display help for command

Commands:
  help [command]          display help for command
  inspect [options]
  prepare [options]
  remote-plan [options]
  run [options]           Run one explicitly approved real-repository C2C review
  serve [options]
  serve-remote [options]
exit=0

$ node bin/c2c.js review inspect --help
Usage: c2c review inspect [options]

Options:
  --snapshot <file>
  -h, --help         display help for command
exit=0

$ node bin/c2c.js review prepare --help
Usage: c2c review prepare [options]

Options:
  --workspace <path>
  --task <id>
  --files <paths...>    exact repository-relative file paths
  --data-class <class>  public, non-sensitive, or synthetic
  --base <commit>       optional pinned base commit OID
  --output <file>       new local snapshot file outside the reviewed repository
  -h, --help            display help for command
exit=0

$ node bin/c2c.js review remote-plan --help
Usage: c2c review remote-plan [options]

Options:
  --snapshot <file>
  --model <model>
  --resource <url>
  --redirect-uri <url>
  --reviewed-snapshot <sha256>  explicit attestation for public or non-sensitive
                                snapshot bytes
  --output <file>               new local permit file outside the reviewed
                                repository
  -h, --help                    display help for command
exit=0

$ node bin/c2c.js review run --help
Usage: c2c review run [options]

Run one explicitly approved real-repository C2C review

Options:
  --snapshot <file>             prepared, inspected public or non-sensitive
                                snapshot
  --model <model>
  --state-dir <path>            dedicated state outside the reviewed repository
  --authorize-external-review   operator attestation of actual scoped user
                                consent
  --reviewed-snapshot <sha256>  exact snapshot digest reviewed for non-sensitive
                                content
  -h, --help                    display help for command
exit=0

$ node bin/c2c.js review serve --help
Usage: c2c review serve [options]

Options:
  --snapshot <file>
  --approval <sha256>  digest explicitly approved for this single local mock
                       review
  --state-dir <path>   dedicated state directory outside the reviewed repository
  -h, --help           display help for command
exit=0

$ node bin/c2c.js review serve-remote --help
Usage: c2c review serve-remote [options]

Options:
  --snapshot <file>
  --permit <file>
  --approval <sha256>  digest explicitly approved for this remote review
  --state-dir <path>   dedicated state directory outside the reviewed repository
  --port <port>        preferred loopback port for an externally owned tunnel
                       wrapper
  -h, --help           display help for command
exit=0
```
