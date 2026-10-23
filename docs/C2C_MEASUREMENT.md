# Prospective Full-Route Measurement

> 2026-10-23 documentation note: this is the completed 2026-08-31 measurement protocol and record. The manifest, `aggregate/` references and `_working/` evidence below are maintainer-local artifacts, not files shipped in this checkout or instructions to rerun the closed batch. Numeric results are preserved; see [the documentation audit](DOCS_AUDIT_2026-10-23.md) for current checks.

Status: all20 accepted prospective clocks and independent aggregate sign-off
are complete; see aggregate/FINAL_RECONCILIATION.md. Human authorized the batch with
"核准進行,do it". Receipt: `_working/measurement-batch-2026-08-31/AUTHORIZATION.md`.
This supplements the active ten-pair goal. It does not rewrite the historical
G8 design, the first manifest or original failures. The earlier8/10 assessment is
superseded by7/10 after full-route measurement, not silently retained as final.
The user-facing command remains `C2C`; these steps belong to the operator.

## Recorder Commands

From the project root, before any task-specific preparation:

```powershell
node scripts/record-c2c-route.mjs _working/real-batch-2026-08-31/manifest.json R01 ordinary gpt-5.6-sol high _working/measurement-R01-ordinary
```

The parent directory must exist; the final output directory must be new. Keep
this process alive and submit one JSON line per event through its stdin:

```json
{"event":"attempt_start"}
{"event":"attempt_end","setupFailure":false}
{"event":"rework_start"}
{"event":"rework_end"}
{"event":"finish","success":true,"judged":true,"falsePositives":0,"reworkObserved":true,"cleanupVerified":true,"quotaDelta":null}
```

These are event shapes, not a pre-approved transcript: omit rework events only
when none occurred; set actual observations at finish. Never pre-send finish.
`READY` confirms the clock is running; `ACK` confirms an event was recorded.
Only `FINISHED` plus the complete evidence checks below allow use of `record.json`.
`events.jsonl` preserves the measured sequence. EOF, signals or invalid commands
produce nonzero exit and incomplete evidence, not an accepted final record.
The clock neither starts nor stops the separate advisor service; always perform
service cleanup even if the clock process fails. No pause/resume/import exists.

## Scope And Limits

- Repeat the same R01-R10 tasks and exact public Git blobs registered in
  `_working/real-batch-2026-08-31/manifest.json`. Do not change its contents.
- Record new batch consent separately before any tunnel or advisor submission.
  Existing consent covered the completed batch, not unlimited repetitions.
- Same requested advisor settings: `gpt-5.6-sol`, `high`; record actual CLI/UI
  observations. Unknown effective backend identity remains unknown.
- Ten Ordinary arms and ten C2C arms. Each C2C task has at most one new service
  admission, a 15-minute service lifetime, and no automatic replacement session.
  A bounded reconnect inside that same live service is included and recorded.
- Each arm has a 30-minute total work limit. At that limit stop task work, revoke
  access, finish cleanup and record failure. Mandatory cleanup time remains in
  total elapsed even when it extends beyond the work limit. No timeout is erased.
- Odd tasks: Ordinary first. Even tasks: C2C first. One arm at a time; no
  overlapping model work or unrelated repository work inside its clock.
- These are known-task repeatability measurements, not new blind-discovery
  evidence. Keep the first batch visible; do not pool the two batches as twenty
  independent tasks or claim general model superiority.

## Identical Clock Boundaries

Start the recorder BEFORE task-specific source checks, snapshot/input preparation,
model-selection checks or connector setup. End only AFTER answer capture, local
adjudication, required correction/testing, and route cleanup. The long-lived
recorder uses monotonic elapsed time; timestamps are labels, not the timer.

Both routes include preparation, model/tool execution, waiting, verification,
repair and cleanup. Preparing shared installed dependencies before the batch is
allowed but must be disclosed as a warm-environment benchmark, not cold install.
For C2C restore the original developer-mode setting within each arm so its cost is
included consistently; remove the temporary plugin before finishing the arm.

Never pause the clock for retries, slow UI, policy failures, human interruption or
debugging. Mark interventions in a separate operator note. If an unrelated event
invalidates comparability, preserve the attempted arm and disclose the deviation;
do not silently replace it with a cleaner sample.

## Attempts, Rework And Evidence

- Begin an attempt before preparation. Close it with whether setup failed.
  A model refusal, wrong answer or empty response is a task failure, not
  automatically a setup failure. Preserve raw errors and original answers.
- Start a rework window when correcting an unsuccessful setup or rejected result;
  end it when that correction is complete. Initial ordinary review/testing is
  verification, not rework. Rework is a subset of total elapsed, never added twice.
- Explicitly attest complete rework observation at finish. Zero is valid only
  when the entire arm was observed and no correction was needed; unknown is not0.
- Keep answer quality separate from repairs: original task success and false
  positives use the same manifest acceptance checks for both arms. Rejecting an
  unsupported finding does not retroactively turn the original answer into a pass.
- Use a fresh verifier supplied only the task, frozen source and that arm's answer.
  Do not provide the other arm's answer or prior adjudication. Its work is timed.
- A review task is complete with a verified disposition; it need not invent bugs.
  If an actual code change is needed, perform and test it in an isolated local
  output. Do not alter the pinned input clone or reuse one arm's repair in the other.
- C2C closure needs real scoped read/audit evidence, CLOSED receipt, no valid token,
  stopped endpoint, plugin removal and developer-mode restoration. A recorder
  boolean is an operator attestation, not an independent security proof.
- Quota remains null unless directly observable. Never derive it from bytes,
  reasoning time or coarse UI percentages. Record public-source verification and
  content hashes, model observations, answers, checks, cleanup and deviations in
  the new batch's evidence index, separate from the metric-only clock log.
  Like judgment and cleanup, a supplied numeric quota is an operator observation
  requiring independent evidence; accepting that number does not verify it. The
  existing batch has no such observation and must continue to use null.

## Decision Rules

Only a prospective, fully observed record may use `timingScope: "full-route"`.
Do not import old CLI/service intervals, reconstruct clean totals from file mtimes,
backdate start events, exclude failed attempts or weaken comparator requirements.
An aborted/missing recorder artifact remains missing evidence, not a zero-cost arm.

Use `scripts/compare-c2c-runs.mjs` only after all ten pairs have source-matched
records, verified outcomes, known rework/false positives and C2C cleanup evidence.
It is a metric calculator, not an independent evidence validator. Its
`comparisonReady` flag alone cannot prove authorization, real reads, correct
source/model, run order, complete observation or cleanup. Before using its
recommendation, a fresh reviewer must reconcile every arm with its clock log,
raw attempt artifacts and evidence index; missing evidence keeps the goal open.
If success is not improved AND median total elapsed is strictly over1.25 times
Ordinary, restrict C2C to cases with demonstrated benefit and verify a concrete
workflow improvement. This does not prohibit opt-in C2C use or restart G1.

## Completed Batch And Deviations

The twenty accepted records and hashed evidence index are in
`_working/measurement-batch-2026-08-31/aggregate/`. The calculator reports
Ordinary10/10,C2C8/10; median224997.38965ms versus431198.44065ms (1.91646x),
so the rule requires restrict-and-improve. This is a workflow sample, not a
general accuracy or quota claim. Aggregate review/integration cost is outside
per-arm clocks; UI personalization and unknown effective backends are confounds.

Original R03 Ordinary was stopped before a genuine answer check. Its clock is
INVALID and excluded; at least330476.2829ms wasted elapsed plus unmeasured later
verification remains disclosed. One explicitly approved prospective replacement
ran after R10, deviating from the planned alternating order. Its final PASS was
a transparent commander adjudication after a reviewer withdrew substantive
objections but falsely asserted more than500words; actual saved answer430.
Both incorrect verdicts remain preserved for independent reconciliation.
Final independent Sol reconciliation accepted the replacement and all10pairs.
R01/R02's older verdict schema was corroborated against full actual historical
source/answer tool outputs and final replies, all before original clock finish;
see aggregate/historical-read-reconciliation.json. No retrospective field edits.

The new answer-evidence checker verifies exact excerpts, explicit attestations
and whitespace-delimited length before finish. It never certifies source truth,
promotes a failed answer, or retroactively repairs old clocks. Browser cleanup
now waits for a visible installed-plugin list/name absence and a settled enabled
toggle. These are verified correctness/reliability improvements, not evidence of
speedup: no post-change paired benchmark or extra external batch was performed.
