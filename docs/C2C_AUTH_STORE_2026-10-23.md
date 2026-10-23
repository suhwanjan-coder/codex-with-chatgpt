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

## Bounded Mitigation

The diagnostic version with the original five-second bound is preserved in
commit `d435154`. The mitigation raises only the configured PowerShell timeout
to ten seconds. This provides bounded headroom for the observed deadline
failures; censored timeout durations do not establish a required completion
time or a guarantee under arbitrary load. Synchronous failures can now take
longer to return.

No operation is retried. In particular, no-output timeout does not make file
creation idempotent: `CreateNew` may already have committed before termination,
and another attempt could return `EXISTS`. A late-output timeout still fails.
The script, ACL/owner/DACL checks, path checks, buffer limit, exclusive creation,
and verification predicates are unchanged. No security assertion was removed.

A separate mocked-process regression requires a finite timeout above five and
at most ten seconds, one invocation, and unchanged launch/buffer protections.
It failed against the five-second version with `expected 5000 to be greater
than 5000`. The real ACL tests remain separate and unmocked. Diagnostic tests
also cover the observed timeout-with-status-zero-and-output case.

## Post-Mitigation Observation

```text
STRESS SUMMARY workers=8 load=16 iterations=1 passed=0 failed=1 diagnostics=0 timeouts=0 loadStarted=3006 loadCompleted=2990 loadFailed=0
```

The same high-load configuration completed one iteration in 465,579 ms, with
57 passed and 11 failed tests. No private-storage diagnostic escaped to the
reporter. This is not a clean high-load pass or proof that all helper timeouts
were eliminated: the eleven failures were classified `OTHER`, and nested CLI
errors or assertion failures can hide a storage diagnostic. The JSON retains
all failure names. One post-mitigation iteration cannot establish a failure-rate
improvement against ten earlier iterations. No assertion or unrelated test
deadline was relaxed to turn these failures into passes.

The required four-worker, two-iteration acceptance smoke then passed end to end:

```text
STRESS SUMMARY workers=4 load=0 iterations=2 passed=2 failed=0 diagnostics=0 timeouts=0 loadStarted=0 loadCompleted=0 loadFailed=0
```

Both iterations passed all 68 tests (136 total), in 198,377 and 189,783 ms.
The aggregate and per-iteration JSON files were written successfully; the
aggregate is `_working/stress-private-storage-2026-10-23T06-09-57-716Z.json`.

## Final Verification

`CI=true corepack pnpm build` exited zero. The diagnostic and timeout regression
files passed all 11 tests. Three consecutive full `corepack pnpm test` runs,
each with `CI=true` and no synthetic load, then exited zero:

| Run | Files passed | Tests passed | Failed | Skipped | Total | Duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 39 | 404 | 0 | 5 | 409 | 171.30 s |
| 2 | 39 | 404 | 0 | 5 | 409 | 233.29 s |
| 3 | 39 | 404 | 0 | 5 | 409 | 210.96 s |

The same five file-symlink skips remain: one in review-windows-native, three in
workspace-config (.c2cignore, .c2c.json, package.json), and one in windows-legacy.
No existing test line or assertion was removed or changed: 108 lines were added
to review-private-storage and the isolated timeout regression adds 23 lines.
The PowerShell script hash is unchanged from the baseline:
`b65eab021d70978379163bbc1d6f4c583f7a4f1598fc5f67a709507110cefc45`.
The load helper has a UTF-8 BOM. Raw logs, JSON, and intentionally failing probes
remain uncommitted in `_working/`; the historical repair report is unchanged.

## Remaining Limits

The historical event, high-load failures without diagnostics, the single failed
load process, and failures hidden behind CLI/assertion boundaries remain
unattributed. The ten-second setting is bounded mitigation, not a measured
optimal deadline or a guarantee of high-load success. No production incidence,
second-machine, or POSIX execution was measured. The existing 30-second test
deadline was unchanged. Independent review was not performed because this task
explicitly prohibited delegation. No push or deployment was performed.
