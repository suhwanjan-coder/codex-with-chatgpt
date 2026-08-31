# 2026-08-31 | Windows release checkout | Codex

## 1. Goal And Scope
Deliver usable, opt-in C2C for controlled non-sensitive repositories and finish
the current new-machine portability repair. User approved remembering, Git push
and cloud sync. Do not reopen the completed ten-pair batch; this round does not
require the user to operate the old computer.

## 2. Important Paths
All paths below are relative to this checkout; discover its actual location.
- Usage: docs/C2C_USAGE.md; cross-machine setup: docs/C2C_CROSS_MACHINE.md.
- Acceptance: docs/C2C_REAL_ACCEPTANCE.md; method: docs/C2C_MEASUREMENT.md.
- Workflow: skill/SKILL.md; browser recipe: skill/references/chatgpt-connector.md.
- Repair evidence: docs/C2C_REPAIR_2026-08-31.md; final post-repair results and
  current commit: cloud release-manifest.json (not a tracked repository file).
- Private historical evidence: _working/ (maintainer machine only, not published).
- Remote: https://github.com/suhwanjan-coder/codex-with-chatgpt
- Release branch: codex/c2c-hardened-2026-08-31 (not upstream main).
- Cloud release-manifest.json: publication status, current commit, hashes and release
  checks. Do not copy final post-repair counts into this handoff.

## 3. Verified Progress
Ten prospective pairs are complete and closed: Ordinary10/10, C2C8/10, 30 real
scoped reads; C2C median full-route time1.92x Ordinary. Personal-use score7/10.
Do not rerun or reopen this batch. Real cleanup observed: CLOSED/token0,
endpoint stopped, temporary connector removed, prior developer-mode setting
restored. The previous published commit is
`7cf5eb67bf94fabababb99ec62f6aa46a082607d`.

Historical old-machine evidence: fresh-install build passed; 402 tests had 391
passed, 11 failed and 0 skipped. An isolated CLI pass does not erase that full
suite failure. Nine helper cases with empty output and exit 0 were not reproduced
in the maintainer environment. The missing-cache test defect is corrected;
the repaired suite's outcome on the old machine remains unverified.

Current new-machine baseline: a true fresh short-path clone initially had no
`node_modules` or `.tooling`; Node 24.19.0 and pnpm 11.19.0 installed 156
packages from its own store, downloading 156 and reusing 0. Build passed; the
baseline had 402 tests with 397 passed, 0 failed and 5 skipped. These are
baseline facts, not post-repair results. The post-repair full-suite result and
current commit must be read from docs/C2C_REPAIR_2026-08-31.md and
release-manifest.json rather than duplicated here.

## 4. Decisions
C2C means execute the established workflow, not request another trial. Ordinary
is default; Council is for major judgment. Codex owns delivery and verification.
User wants working flows repaired and improved, not indefinitely held at No-Go.
Quota clarification: moving work to a genuinely separate quota pool can reduce
Codex workload, but net savings and this batch's advisor quota pool were not
measured. ChatGPT Work shares Codex usage per official pricing checked2026-08-31:
https://learn.chatgpt.com/docs/pricing . Wall time is not a quota measurement.
The 7/10 opt-in C2C decision is unchanged. This repair is test-portability work
only; it does not relax ACLs or change the approved data boundary.

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
One new-machine full rerun had AUTH_STORE_UNAVAILABLE; isolated and later
diagnostic full reruns passed. Root cause remains unconfirmed; preserve the
failed evidence and do not disable storage checks. See the repair report.

## 8. Next Action
Continue normal on-demand use of the repaired workflow. Check the repair report,
cloud release-manifest.json and remote branch for final verification and
publication status. Do not reopen the completed comparison or require old-machine
work. If the intermittent storage failure recurs, capture bounded local process
metadata and investigate before claiming its cause is fixed.
Use a fresh task-bound connection when C2C is requested. Do not assume browser
login, connector state or installed tooling transferred with documents.

## 9. User Preferences
Traditional Chinese, concise reports. One keyword: C2C plus project/question.
Execute within the approved envelope without repeated questions; new scope gets
one combined approval. Integrate improvements into one coherent plan.

## 10. Limits And Deferred Work
Quota pool/backend identity unknown; warm known-task benchmark, not blind model
ranking. Five native file-symlink tests remain skips unless the repair manifest
records otherwise. No universal mutable-root containment or post-change speedup
claim. Raw answers, session metadata and original logs remain local; the public
handoff contains only sanitized documents and the published source archive.
Future cross-machine installation and execution remain optional and require
verification on that machine; publication alone does not prove old-machine
repair. The deeper Documents clone failed48 private-storage-related tests; the
short local clone passed. Preserve that failed run and use the documented short
path; do not weaken ACL or storage checks to make a long-path deployment pass.
Historical path probe: PowerShell5.1 DirectoryInfo.Create passed at 247
characters and failed at 248; the failing nested target was261characters.
This does not identify the old machine's 11 failures, whose cause remains
unknown. Neither CRLF nor the reused dependency junction caused the path probe
failure.
