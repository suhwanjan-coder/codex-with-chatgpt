# Extreme-load test failures — 2026-10-23

## Scope and evidence

Windows 11, Node 24.19.0, base `0baa30d`, branch `codex/wt-load-20261023`.
Only synthetic fixtures and existing loopback servers were used. No real tunnel,
connector, external review, global configuration, or other checkout was changed.

The observed baseline was **451 tests: 446 passed, 0 failed, 5 skipped**, with one
unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"`; therefore exit **1**.
The supplied 445-test baseline was not the current checkout's collected total.
Install with the frozen lockfile and the initial build both exited 0.
An intermediate instrumentation-only full run collected 453 tests (447 passed,
one 30 s CLI-test timeout, five skipped) and one RPC error; it is not part of the
paired stress counts or final consecutive validation.

The paired load command is
`node scripts/stress-private-storage.mjs --iterations 3 --workers 8 --load 16`.
It selects 77 tests (231 executions), not the earlier investigation's 68.
The reporter records full structural error messages and code stack frames,
duration, and separate native-storage/child-process metadata; arbitrary payloads
and non-code paths are redacted. No message in the 52 measured pre-fix failures
was redacted. Per-iteration checkpoints distinguish pending work from skips.

The host's inherited PowerShell policy initially prevented the load helper from
running. Both paired runs use a verified process-only `-ExecutionPolicy Bypass`
and fail if load preflight or a load child fails. No policy setting is changed.
The `.ps1` is unchanged, retains its UTF-8 BOM, and has SHA-256
`80F2EEB79A939B113EDF94B820E7E4CE72DAA459E309FDF9136A139080814B9B`.
The harness iteration cap is 30 minutes: the former ten-minute cap censored an
exploratory run. This changes neither a product nor a test-process deadline.

## The eleven requested cases

`V` means **vitest test timeout** and the exact two-line error is:

```text
Test timed out in 30000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
```

It originates at `vitest.config.ts:6` and Vitest 3.2.7's
`@vitest/runner/dist/chunk-hooks.js:2006` (`withTimeout`, including the elapsed-time
check after synchronous work). Locations below are from the instrumented pre-fix
stacks; the current declaration is given after the arrow. Each failure occurrence
has exactly one class. Cases 4 and 6 also had a separate child-timeout occurrence;
those are counted as child timeouts, never double-counted as V.

| # | Test (exact title) | Class and observed evidence | Action | After fix |
|---|---|---|---|---|
| 1 | runs a real loopback bridge/session after approval and exposes an awaitable cleanup handle | V, 3/3; 45.984–69.400 s; `tests/c2c-runner.test.ts:220` → `:224` | 160 s lifecycle budget; worker yield; retain startup diagnostic in assertion | 3/3 passed; 37.215–48.852 s |
| 2 | stops the tunnel when the snapshot deadline callback fires | V, 3/3; 37.747–60.249 s; `tests/c2c-runner.test.ts:255` → `:261` | Same budget; require successful startup before firing deadline | 3/3 passed; 33.069–41.484 s |
| 3 | rejects legacy commands before state, global configuration, or network side effects | V, 2/3; 39.225/40.080 s; `tests/review-cli.test.ts:115` → `:78` | Await seven child commands; outer budget 240 s | 3/3 passed; 19.364–34.549 s |
| 4 | prepares public, synthetic, or non-sensitive unapproved snapshots outside the reviewed root and inspects their exact digest | V, iterations 1/2: 48.235/31.791 s; `tests/review-cli.test.ts:141` → `:104` | Await six commands; child 30 s, outer 210 s | 3/3 passed; 29.783–48.535 s |
| 5 | rejects unclassified data from remote-plan before writing a permit | V, controlled reproduction only: 36.422 s; `tests/review-cli.test.ts:255` → `:218`; natural pre-run passed 3/3 | Await two commands; outer 90 s; same controlled delay then passed in 33.814 s | 3/3 passed; 10.464–15.439 s |
| 6 | plans and serves an explicitly reviewed non-sensitive snapshot with the bounded review mode | V, iterations 1/2: 30.111/30.152 s; `tests/review-cli.test.ts:379` → `:342` | Await prepare/plan/serve; 90 s serve child, 180 s outer | 3/3 passed; 33.036–39.589 s |
| 7 | rejects review-disallowed scopes, refresh grants, and external redirect URIs | V, iteration 3: 32.417 s; `tests/review-security.test.ts:222` → `:223` | 150 s suite budget; fixture TTL 300 s | 3/3 passed; 18.053–29.250 s |
| 8 | returns generic non-leaking OAuth errors for malformed JSON and wrong-type POST fields | V, iteration 3: 36.265 s; `tests/review-security.test.ts:246` → `:247` | Same budget/fixture correction | 3/3 passed; 21.984–28.001 s |
| 9 | issues only the requested review scopes, revokes tokens on close, and closes the listener | V, iterations 1/3: 32.150/38.009 s; `tests/review-security.test.ts:297` → `:298` | Same budget/fixture correction | 3/3 passed; 19.096–21.345 s |
| 10 | uses a unique private auth workspace for every review digest | V, 3/3; 33.859–51.705 s; `tests/review-security.test.ts:306` → `:307` | Allow both native sessions within the outer budget | 3/3 passed; 32.894–51.362 s |
| 11 | allows only one active snapshot per workspace in its dedicated state directory | V, 3/3; 40.841–46.959 s; `tests/review-session.test.ts:140` → `:143` | 130 s suite budget; yield between native session operations | 3/3 passed; 24.274–28.787 s |

Case 4 iteration 3 instead threw `CLI_CHILD_PROCESS_FAILED` at
`tests/helpers.ts:17`, `tests/review-cli.test.ts:26`, caller `:148`: `ETIMEDOUT`,
15,274 ms, SIGTERM, null status, zero output bytes. Case 6 iteration 3 had the
same class/error at caller `:384`, 15,369 ms. These are **in-test child-process
timeouts**, imposed by the former 15-second `spawnSync` option, not evidence of
a native-storage timeout. The outer 30-second deadline could otherwise expire
before the 20-second serve deadline even began, after prepare/plan/setup.

For case 5, a setup-file probe delayed only fixture `git init` by 29,013 ms;
the actual two CLI children completed in 4,276/1,815 ms with expected exits 0/1.
All assertions completed, then Vitest rejected the elapsed time. The unchanged
29-second delay passed after the fix. This demonstrates the test-budget defect;
it does **not** recover the exact cause of the old historical failure.

## Fixes and retained bounds

The Windows product still allows **10,000 ms per PowerShell request**, 16 KiB
output, and one attempt. No ACL, owner, DACL, reparse, symlink, CreateNew, approval,
scope, digest, call/byte-budget, or cleanup predicate changed.

Test budgets now compose the work they wait for: up to ten native requests plus
30 s setup for session tests (130 s), twelve plus setup for bridge tests (150 s),
thirteen plus setup for a runner lifecycle (160 s), and eight native operations
for the largest ACL case (80 s, with no Git fixture). CLI commands allow 20 s startup/scheduling plus one native
request (30 s); serve allows startup plus seven requests (90 s). Outer CLI budgets
sum children plus 30 s fixture setup. The runner import case allows 30 s setup
plus its unchanged 15 s child bound. Existing explicitly short runner tests keep
their own deadlines. These are test completion limits, not latency guarantees.

Four native ACL readback failures were **in-test child-process timeouts**:
`ACL_READBACK_UNAVAILABLE`, 5,059–5,323 ms at
`tests/review-private-storage.test.ts:41/:51` (pre-fix). Their 5 s helper deadline
was shorter than the product helper it checks. Readback now has the same 10 s
bound; all real ACL assertions remain.

The CLI smoke fixture's 15 s TTL competed with up to seven native startup
requests. It now has a 90 s TTL, a 100 s child limit and a 130 s outer limit.
It still waits for real absolute expiry and checks the expired audit and removed
lock. One pre-run child timed out at 26,195 ms (25 s bound); another returned 1
at `tests/bin.test.ts:40` (`expected 1 to be +0 // Object.is equality`). The latter
had no captured child output and remains **other**, with its exact exit reason
unverified. Do not retrospectively label it a storage or expiry failure.

The shared asynchronous CLI helper keeps the worker event loop available and
waits for child close after deadline/marker termination before fixture cleanup.
Native test sequences yield between cases or session opens. The three pre-run
unhandled RPC failures are **other**, separately counted from test failures:
`[vitest-worker]: Timeout calling "onTaskUpdate"`, emitted by Vitest's
`dist/chunks/rpc.-pEldfrD.js:53`, with the 60 s RPC timer in
`dist/chunks/index.B521nVV-.js:3/:59`. A standalone two-by-35-second blocking probe
did not reproduce this error, so event-loop starvation is a hypothesis, not a
proven exclusive root cause. Post-run RPC results are reported separately.

The CLI previously printed only the fixed error code, and the runner converted
the error to a string. `privateStorageDiagnosticLine` now preserves only an
internally constructed, frozen diagnostic object at those boundaries. CLI stderr
is synchronously flushed before exit 1. Runner startup cleanup still runs.
Injected ETIMEDOUT regressions verify both paths and absence of raw process output,
causes and fixture paths. No bridge response payload gains diagnostics.

## Paired measurements and final validation

| Run | Passed | Failed | Skipped | Unhandled RPC | Duration |
|---|---:|---:|---:|---:|---:|
| Before 1 | 62 | 15 | 0 | 1 | 505.630 s |
| Before 2 | 62 | 15 | 0 | 1 | 533.461 s |
| Before 3 | 55 | 22 | 0 | 1 | 523.865 s |
| After 1 | 77 | 0 | 0 | 0 | 429.912 s |
| After 2 | 77 | 0 | 0 | 0 | 399.224 s |
| After 3 | 77 | 0 | 0 | 0 | 410.602 s |

| Exclusive failure class | Before (231 executions) | After (231 executions) |
|---|---:|---:|
| storage-timeout (diagnostic lost) | 0 | 0 |
| vitest test timeout | 43 | 0 |
| in-test child-process timeout | 8 | 0 |
| port/listener race | 0 | 0 |
| cleanup/teardown race | 0 | 0 |
| assertion on timing | 0 | 0 |
| other test failure | 1 | 0 |
| Unhandled errors (separate) | 3 | 0 |

Pre-run load: 8,234 started, 8,218 completed, zero failed; 16 were stopped at normal
harness shutdown. There were no pending tests or storage diagnostics in that
paired pre-run. Exploratory/censored runs, the controlled case-5 probe, and an
early restarted post-run are excluded from the paired counts.

Post-run load: 8,413 started, 8,397 completed, 0 failed.
Both pre/post runs used the same load helper, worker/load parameters, 77-test
cohort, reporter and 30-minute harness cap.

Local evidence (uncommitted `_working/`):

- Before: `stress-private-storage-2026-10-23T08-37-13-830Z.json` and its three per-run reports.
- After: `stress-private-storage-2026-10-23T09-14-35-367Z.json` and its three per-run reports.
- Controlled case 5: `unclassified-probe-before2.json` / `.jsonl`, `unclassified-probe-after.json` / `.jsonl`.
- Boundary/helper regressions: `load-fix-unit.log` (10 passed).
- Assertion preservation: `load-assertion-audit.json` (343 preserved, one added).

Final `corepack pnpm build` exited 0 (`load-final-build.log`). Both immediately
consecutive `corepack pnpm test` runs used the default reporter plus the same
content-free reporter, without a file filter; both exited 0:

| Run | Passed | Failed | Skipped | Unhandled | Duration |
|---|---:|---:|---:|---:|---:|
| Final full 1 | 461 | 0 | 0 | 0 | 199.21 s |
| Final full 2 | 461 | 0 | 0 | 0 | 187.38 s |

Each collected 461 tests in 45 files: baseline 451 plus ten new regressions.
Evidence: `load-full-final-1.log/.json` and `load-full-final-2.log/.json`.
The literal requested **five skips were not reproduced**: these five unchanged
native file-symlink cases ran and passed in both final runs instead:

- `tests/review-windows-native.test.ts`: `[G7:FILE_SYMLINK] rejects an actual file symlink to an outside file`.
- `tests/windows-legacy.test.ts`: `rejects a file symlink escaping the workspace` (the baseline selected its `CANNOT_VERIFY` skip branch).
- `tests/workspace-config.test.ts`: `blocks a native outside file symlink for .c2cignore when available`.
- `tests/workspace-config.test.ts`: `blocks a native outside file symlink for .c2c.json when available`.
- `tests/workspace-config.test.ts`: `blocks a native outside file symlink for package.json when available`.

These three test files and their skip predicates are unchanged. A separate Node
process, outside Vitest, confirmed actual file-symlink creation and `lstat` type
(`symlink-capability-final.log`); its fixture was removed. The current parent
process is not an administrator. No global setting or privilege was changed by
this task. The time/source of the capability change from baseline EPERM is not
established. No mock or forced skip was added to manufacture the requested count.
Thus both final runs have zero failures and stronger native coverage, but the
literal acceptance criterion of exactly five skips remains a disclosed deviation.


## Assertion and line-change audit

A TypeScript AST comparison against `0baa30d` found all **343 existing assertion
statements** preserved in the six modified existing test files, plus one new
runner-start assertion. The only normalized assertion text change adds the
runner's diagnostic as Vitest's failure message; its predicate remains identical.
The ten new regression cases cover formatting/redaction, child lifecycle,
checkpoint accounting, actual load execution, and CLI/runner propagation.

The following inventory lists every changed line in existing test files (old
positions refer to `0baa30d`; new positions refer to this revision). New-only
regression files are covered above. A dash means a pure insertion or deletion.

| File | Old changed lines | New changed lines | Reason |
|---|---|---|---|
| `tests/bin.test.ts` | — | 7 | Import shared async child runner or worker yield/diagnostic helper; remove obsolete direct spawn import. |
| `tests/bin.test.ts` | 9 | 10–11 | Allow seven native startup requests before exercising real expiry; expiry/audit/lock assertions unchanged. |
| `tests/bin.test.ts` | 26 | 28 | Await asynchronous CLI/session operations while preserving order and assertions. |
| `tests/bin.test.ts` | 34 | 36 | Await the owned child through close; timeout errors retain metadata and cleanup cannot race child exit. |
| `tests/bin.test.ts` | 36 | 38 | Replace the old marker/child helper with the shared bounded async lifecycle; no test predicate removed. |
| `tests/bin.test.ts` | 45 | 47 | Outer test bound covers all child bounds plus fixture setup. |
| `tests/c2c-runner.test.ts` | — | 8 | Import shared async child runner or worker yield/diagnostic helper; remove obsolete direct spawn import. |
| `tests/c2c-runner.test.ts` | 18 | 19 | Run the same cleanup, then yield so queued worker RPC can complete. |
| `tests/c2c-runner.test.ts` | — | 24, 215, 228, 249, 265, 282, 304 | Yield between synchronous native sequences; all assertions and native calls remain. |
| `tests/c2c-runner.test.ts` | 67 | 69 | Outer budget = 30 s fixture setup + unchanged 15 s import child. |
| `tests/c2c-runner.test.ts` | 171 | 173–174 | Suite budget covers its sequential native requests plus fixture/setup allowance. |
| `tests/c2c-runner.test.ts` | 226 | 231, 268 | Preserve startup predicate and include diagnostics; deadline case additionally requires successful startup. |
| `tests/review-cli.test.ts` | 3 | 7 | Import shared async child runner or worker yield/diagnostic helper; remove obsolete direct spawn import. |
| `tests/review-cli.test.ts` | 18–22, 27–28, 31–67 | 18–25, 30–31, 34–37 | Compose child/outer budgets; use bounded async runner that settles after close and preserves captured output. |
| `tests/review-cli.test.ts` | 82, 88, 96, 98, 102, 108, 112, 127, 134, 141, 156, 164, 169, 183, 189, 206, 211, 232, 242, 248, 261, 270, 284, 289, 299, 309, 328, 338, 377, 388, 421, 426, 437, 443 | 52, 58, 66, 68, 72, 78, 82, 97, 104, 111, 126, 134, 139, 153, 159, 176, 181, 202, 212, 218, 231, 240, 254, 259, 269, 279, 298, 308, 347, 358, 391, 396, 407, 413 | Await asynchronous CLI/session operations while preserving order and assertions. |
| `tests/review-cli.test.ts` | 94, 106, 132, 162, 181, 204, 246, 282, 321, 370, 419, 453 | 64, 76, 102, 132, 151, 174, 216, 252, 291, 340, 389, 423 | Outer test bound covers all child bounds plus fixture setup. |
| `tests/review-private-storage.test.ts` | 6 | 4, 7 | Import shared async child runner or worker yield/diagnostic helper; remove obsolete direct spawn import. |
| `tests/review-private-storage.test.ts` | — | 37, 47 | Measure native ACL readback elapsed time. |
| `tests/review-private-storage.test.ts` | 39–40, 48–49 | 41–42, 51–52 | Match native ACL readback to the product 10 s bound; attach child metadata without output. |
| `tests/review-private-storage.test.ts` | 53 | 56 | Run the same cleanup, then yield so queued worker RPC can complete. |
| `tests/review-private-storage.test.ts` | 55 | 58–59 | Suite budget covers eight native operations, with no Git fixture. |
| `tests/review-security.test.ts` | 80 | 80–81 | Keep the two-session fixture valid through up to twelve native helper bounds. |
| `tests/review-security.test.ts` | 195 | 196 | Suite budget covers its sequential native requests plus fixture/setup allowance. |
| `tests/review-session.test.ts` | — | 3 | Import shared async child runner or worker yield/diagnostic helper; remove obsolete direct spawn import. |
| `tests/review-session.test.ts` | 39 | 40 | Run the same cleanup, then yield so queued worker RPC can complete. |
| `tests/review-session.test.ts` | 41 | 42–43 | Suite budget covers its sequential native requests plus fixture/setup allowance. |
| `tests/review-session.test.ts` | 128, 140, 165 | 130, 143, 170 | Await asynchronous CLI/session operations while preserving order and assertions. |
| `tests/review-session.test.ts` | — | 140, 148, 150, 176 | Yield between synchronous native sequences; all assertions and native calls remain. |
| `tests/helpers.ts` | — | 5, 10–26 | Content-free child failure metadata and allowlisted errno/signal names. |

## Remaining limits

Finite overload runs are evidence for this machine and version, not a guarantee
under arbitrary resource starvation. Native ten-second timeouts still fail closed;
they are not retried. An exploratory run did observe native ETIMEDOUT at roughly
10.2–11.7 s, which includes process termination/scheduling overhead.
The historical 11 lacked complete diagnostics; case 5 and the extra binary exit
cannot be retroactively attributed with certainty. No port/listener race or
cleanup race was established by these captured failures. The former marker helper
did reject before child close; its replacement is tested independently.
The baseline file-symlink EPERM conditions no longer reproduce; final runs execute
all five cases, as detailed above. The requested exact skip count remains unmet.
No real tunnel, browser, connector, external model, or patient/user data was tested.
