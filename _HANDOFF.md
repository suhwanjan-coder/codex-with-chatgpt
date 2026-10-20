# 2026-09-01 | Windows release checkout | Codex

## Latest Status: Natural-Language Entry Corrected (2026-09-01 00:22, ACHIH-MAIN, Codex)
After the memory-only handoff, the user asked to continue. The explicit opt-in
global entry is now installed at `C:\Users\suhwa\.codex\skills\c2c` on this
machine. The user corrected the interface requirement: ordinary requests such as
"用 C2C 做...", "用c2c幫我...", or "這題交給 C2C" must work without a special
command. `$c2c` is optional, not a requirement. Both skill metadata files now use
allow_implicit_invocation: true for language-based discovery; workflow execution
still requires the user's explicit current-task C2C intent. Questions, quotations,
negations and ordinary tasks do not start it. Ordinary stays the default. No PATH,
Codex settings, runtime code, external connection, or old machine was changed.

Do not confuse a technical entrypoint check with acceptance of the user's actual
working style. The user explicitly said our conversation still fails to connect
after many projects: requiring a special command repeated that mismatch. Use his
natural wording and existing context; do not make him learn internal terminology.

The installed SKILL.md and agents/openai.yaml come from `skill/global-entry/`;
adjacent `implementation.json` binds this checkout as the implementation. Do not
copy that host binding to another machine. The router preserves the caller or
explicit target Git root and passes an absolute --workspace; it never silently
uses the implementation as the review target. Existing data approval, snapshot,
ACL, revocation, and cleanup boundaries remain unchanged.

Verification: independent review passed after two corrections (atomic installation
and no additional classification questionnaire). Three installed files matched
staged SHA-256. Native Codex skills/list found exactly one enabled user-scope c2c
in this checkout and in the unrelated `_scratch` workspace, with no C2C parsing
errors. Cross-repository local prepare/inspect and two rejection cases passed,
including the native private-file ACL check. Evidence: `_working/global-entry-smoke/`.
The optional Python quick_validate helper lacked PyYAML; native catalog loading
was verified instead. The September 1 correction has a separate eight-scenario
independent trigger review and fresh native catalog records under
`_working/c2c-natural-language-2026-09-01/`; old payload hashes/policy in the
August 31 installation record are historical, not current. No remote review or
new external benchmark was run.

This narrow global-entry installation supersedes the earlier blanket prohibition
for this entry only. Do not re-ask whether cross-project invocation is wanted.
Published repair baseline: b6b71dc3c11b05c2aec0571e009b8a181e5d47ab.
The global-entry source/docs and this handoff are local, not committed/pushed or
part of that published commit/cloud manifest. The old machine remains unverified.

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
No legacy setup/start/sandbox helpers, automatic global activation, permanent tunnel,
paid API, or patient/hospital/credential disclosure. Never sync tokens, auth
state, node_modules or active session directories. Revocation does not erase
already received ChatGPT data. Never resend an uncertain external request.
One new-machine full rerun had AUTH_STORE_UNAVAILABLE; isolated and later
diagnostic full reruns passed. Root cause remains unconfirmed; preserve the
failed evidence and do not disable storage checks. See the repair report.

## 8. Next Action
Accept the user's natural-language request to use C2C for the next actual task;
do not ask them to rewrite it as `$c2c`. If the current app catalog is stale,
reload or open a fresh task; do not reinstall or modify global settings implicitly.
The local global-entry changes are not yet published; publication is separate from
the completed local installation. Do not reopen the completed comparison or
require old-machine work. If the intermittent storage failure recurs, capture bounded local process
metadata and investigate before claiming its cause is fixed.
Use a fresh task-bound connection when C2C is requested. Do not assume browser
login, connector state or installed tooling transferred with documents.

## 9. User Preferences
Traditional Chinese, concise reports. Natural-language C2C plus project/question;
no required dollar prefix, slash command, mode selection or technical vocabulary.
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
