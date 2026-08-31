# 2026-08-31 | Windows release checkout | Codex

## 1. Goal And Scope
Deliver usable, opt-in C2C for controlled non-sensitive repositories and make
this hardened version continuable across two Windows machines. User approved
remembering, Git push and cloud sync. Do not reopen the completed ten-pair batch.

## 2. Important Paths
All paths below are relative to this checkout; discover its actual location.
- Usage: docs/C2C_USAGE.md; cross-machine setup: docs/C2C_CROSS_MACHINE.md.
- Acceptance: docs/C2C_REAL_ACCEPTANCE.md; method: docs/C2C_MEASUREMENT.md.
- Workflow: skill/SKILL.md; browser recipe: skill/references/chatgpt-connector.md.
- Private historical evidence: _working/ (maintainer machine only, not published).
- Remote: https://github.com/suhwanjan-coder/codex-with-chatgpt
- Release branch: codex/c2c-hardened-2026-08-31 (not upstream main).
- Cloud release-manifest.json: publication commit, hashes and release checks.

## 3. Verified Progress
Ten prospective pairs completed: Ordinary10/10, C2C8/10, 30 real scoped reads;
C2C median full-route time1.92x Ordinary. Personal-use score7/10. Real cleanup
observed: CLOSED/token0, endpoint stopped, temporary connector removed, prior
developer-mode setting restored. Prior full suite:397pass/0fail/5native-symlink
skips, build passed. Publication recheck plus a clean short-path Git clone both
passed397/0failed/5skipped and build. Clone reused same-lockfile dependencies;
it is not a fresh dependency install on the old computer. See cloud manifest.

## 4. Decisions
C2C means execute the established workflow, not request another trial. Ordinary
is default; Council is for major judgment. Codex owns delivery and verification.
User wants working flows repaired and improved, not indefinitely held at No-Go.
Quota clarification: moving work to a genuinely separate quota pool can reduce
Codex workload, but net savings and this batch's advisor quota pool were not
measured. ChatGPT Work shares Codex usage per official pricing checked2026-08-31:
https://learn.chatgpt.com/docs/pricing . Wall time is not a quota measurement.

## 5. Failed Approaches
Do not rerun external work to repair paperwork, backdate timers, trust unchecked
grader quotes, or turn a policy boundary into a confirmed defect. Do not restore
the stale mock-only/No-Go or8/10 states from older documents or project indexes.

## 6. Working Commands
From this checkout with Node>=20 and the package.json-pinned pnpm installed:
- pnpm install --frozen-lockfile
- pnpm build
- pnpm test
- node bin/c2c.js review prepare --help
- node bin/c2c.js review run --help
- node scripts/check-c2c-answer-evidence.mjs <answer> <verdict>
See cross-machine setup before installing on a new host.

## 7. Unsafe Or Flaky
No legacy setup/start/sandbox helpers, global skill install, permanent tunnel,
paid API, or patient/hospital/credential disclosure. Never sync tokens, auth
state, node_modules or active session directories. Revocation does not erase
already received ChatGPT data. Never resend an uncertain external request.

## 8. Next Action
On the other computer, obtain this release branch into a local checkout, read
this file plus the usage/skill guide, install dependencies and verify locally.
Use a fresh task-bound connection when C2C is requested. Do not assume browser
login, connector state or installed tooling transferred with documents.

## 9. User Preferences
Traditional Chinese, concise reports. One keyword: C2C plus project/question.
Execute within the approved envelope without repeated questions; new scope gets
one combined approval. Integrate improvements into one coherent plan.

## 10. Limits And Deferred Work
Quota pool/backend identity unknown; warm known-task benchmark, not blind model
ranking. Five native file-symlink tests previously skipped for WindowsEPERM.
No universal mutable-root containment or post-change speedup claim. Raw answers,
session metadata and original logs remain local; cloud handoff holds sanitized
documents and the published source archive. Old-computer installation and
execution require verification there; publication alone does not prove them.
The deeper Documents clone failed48 private-storage-related tests; the short
local clone passed. Preserve that failed run and use the documented short path;
do not weaken ACL or storage checks to make a long-path deployment pass.
Independent probe isolated PowerShell5.1 DirectoryInfo.Create:247characters
passed,248failed; the failing nested target was261characters. Neither CRLF nor
the reused dependency junction caused this failure.
