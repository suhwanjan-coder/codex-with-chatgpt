# Windows Private Storage Timeout Investigation

## Scope And Hypothesis

Investigate intermittent `AUTH_STORE_UNAVAILABLE` in the hardened fork at
`625053d`, using the dedicated `codex/wt-auth-20261023` worktree on ACHIH-MAIN.
Node was 24.19.0, pnpm 11.19.0, and Vitest 3.2.7. No real review, tunnel,
connector, external service, or secondary-machine run was started.

The historical 6,085 ms failure is consistent with a five-second PowerShell
timeout, but its original process result is unavailable. Timing alone does not
establish that historical root cause. This investigation distinguishes a newly
observed timeout from retrospective attribution of the August 31 event.

## Baseline

The unchanged build exited zero. The full suite reported 38 passing files,
399 passed tests, zero failed, and five skipped out of 404, in 206.57 seconds.
These are this session's measurements; the task's background figure of 399
total tests does not match the measured checkout. The historical repair report
was not edited.

## Diagnostic Boundary

Failures from Windows PowerShell requests now carry a frozen `diagnostic` property. It contains
only classification, elapsed milliseconds, status, signal, error code, and
UTF-8 byte counts of returned stdout/stderr. Missing streams are `null`, distinct
from zero bytes. OS error codes and signal names use allowlists; unknown values
become `UNKNOWN`. Arguments, input, stream contents, paths, credentials, and raw
error causes are excluded. Existing error messages remain unchanged.

Classifications distinguish timeout, spawn error, signal, non-zero exit, bad
JSON, invalid response, oversized output, unavailable code, and existing-file
code. Process errors take precedence over response parsing. Session and bridge
wrappers preserve only diagnostics produced by the private-storage error class;
unrelated filesystem errors and foreign diagnostic objects are not forwarded.

Injected-runner tests cover classification, content exclusion, exclusive-file
no-retry behavior, and session/bridge propagation. A separate, intentionally
failing synthetic probe verified transport through Vitest's worker serializer
to the stress JSON. That injected timeout is excluded from reproduction counts.

## Stress Harness

Run `node scripts/stress-private-storage.mjs --iterations 10 --workers 8 --load 16`.
Defaults are ten iterations, four workers, and no synthetic load. The six files
are review-session, review-security, review-cli, review-private-storage, bin,
and c2c-runner. The harness invokes the installed Vitest CLI directly with
`CI=true`; it does not install tools or start a real C2C workflow.

Each load lane repeatedly starts hidden Windows PowerShell with a UTF-8 BOM
`.ps1` arithmetic loop lasting 500 ms of wall time. Sixteen lanes correspond to
the machine's 16 available logical processors; CPU utilization was not sampled.
Each load child is bounded to 15 seconds, each Vitest iteration to ten minutes.
Owned load children are stopped and awaited on completion or interruption.

Results go to `_working/stress-private-storage-<timestamp>.json`, with per-run
counts, failure names, sanitized diagnostics, and load-process counts. A failed
iteration produces a non-zero harness exit. Only errors escaping to Vitest are
diagnosed by the reporter; CLI children that reduce errors to a message can
hide the underlying diagnostic. Expected negative assertions are not counted
as failures. Six selected files also cap simultaneous active test files even
when the worker limit is eight or twelve.

## First Reproduction

The two-iteration, four-worker smoke run passed once and failed once:

```text
STRESS SUMMARY workers=4 load=0 iterations=2 passed=1 failed=1 diagnostics=1 timeouts=1 loadStarted=0 loadCompleted=0 loadFailed=0
```

The native diagnostic was `ETIMEDOUT`, `SIGTERM`, status `null`, 5,125 ms,
stdout zero bytes, and stderr zero bytes. Two tests failed, but only one carried
a storage diagnostic. This initial reporter did not associate its diagnostic
with an individual failing test or retain the outer error code; later runs do.
The second failure must not be attributed to private storage from this record.

## Repeated High-Load Observation (Five-Second Bound)

```text
STRESS SUMMARY workers=8 load=16 iterations=10 passed=0 failed=10 diagnostics=115 timeouts=115 loadStarted=24111 loadCompleted=24094 loadFailed=1
```

All ten iterations completed, with 493 passed and 187 failed tests out of 680.
The 115 captured storage diagnostics were all `ETIMEDOUT`, lasting 5,003–6,319 ms.
Seven propagated as `AUTH_STORE_UNAVAILABLE`, across five iterations; ten more
propagated as `REVIEW_AUTH_STORE_UNAVAILABLE`. For example, the exact-resource
OAuth test failed with auth-store timeout at 5,033 ms, status `null`, `SIGTERM`,
and zero stdout/stderr bytes. This confirms that a helper timeout can cause an
auth-store failure on this machine. The historically named request-id audit test did not
produce that same outer error in this run; the August 31 event remains unproven.

Ninety-five timeout records had no output. Twenty already had stdout (19 with
23 bytes, one with 28 bytes); 17 of those also reported status zero and no signal.
Every record still had `ETIMEDOUT`. Timeout therefore remains a failure even when
status or output looks successful. Neither empty output nor late output proves
whether `CreateNew` already committed a file. No stream content was retained.

The load generator completed 24,094 processes; one failed for an unrecorded
reason, and 16 in-flight attempts ended during shutdown. Those shutdowns are
excluded from `loadFailed`. Test failures without a storage diagnostic remain in
the JSON; their cause was not established. Local evidence is
`_working/stress-private-storage-2026-10-23T04-23-36-536Z.json` (not committed).

## Control And Worker-Limit Probe (Five-Second Bound)

```text
STRESS SUMMARY workers=4 load=0 iterations=10 passed=7 failed=3 diagnostics=3 timeouts=3 loadStarted=0 loadCompleted=0 loadFailed=0
STRESS SUMMARY workers=12 load=0 iterations=1 passed=1 failed=0 diagnostics=0 timeouts=0 loadStarted=0 loadCompleted=0 loadFailed=0
```

The four-worker control had 676 passed and four failed tests out of 680.
Three failures carried `ETIMEDOUT` at 5,007, 5,015, and 5,013 ms, all with
status zero, no signal, 23 stdout bytes, and zero stderr bytes. They surfaced as
one `PRIVATE_STORAGE_UNAVAILABLE` and two `PRIVATE_STATE_UNAVAILABLE` errors.
The fourth failure was `creates protected Windows DACLs with exactly the allowed
SIDs`; no diagnostic escaped that test, so its cause remains unconfirmed.
The twelve-worker probe passed all 68 tests in 91,707 ms.

The mechanism is not exclusive to the synthetic generator. These sequential
runs did not isolate warmup, background activity, or individual startup/helper/
scheduler costs. Failure rates here are stress observations, not production
incidence estimates. The original historical root cause is **PARTIALLY SUPPORTED**;
the newly observed helper-timeout mechanism is confirmed.
