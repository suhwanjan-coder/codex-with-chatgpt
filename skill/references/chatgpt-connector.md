# ChatGPT Connector Operator Recipe

Observed working on 2026-08-31. Load the active browser skill and its documented
runtime first. UI labels can change: inspect current visible state, not hidden
application data. This recipe is project-local, not a global installation.

## One Approved Batch

1. Confirm exact task/content/provider/budgets against actual user consent once.
   A printed permit digest is a binding, not consent. Do not re-ask within scope.
2. Preserve the original developer-mode setting. Enable it only for the approved
   connector work; do not alter CSP, MFA, other plugins, or account security.
3. Prepare a fresh reviewed snapshot and use a short dedicated state root outside
   the reviewed repository, for example `<ABSOLUTE_TASK_ROOT>/c2c-rNN-<digest-prefix>`
   with TASK_ROOT outside that repository. Its own `_working/` is still inside it.
4. Start `review run`, verify its emitted resource and scope, then send the exact
   line `approve <permitDigest>` through stdin (the bare digest is not accepted).
   No data is served before that step.

## Connect And Review

1. Create a uniquely named temporary plugin from the actual emitted MCP URL.
   Use OAuth, not the no-auth option. Keep the selected model/effort unchanged.
2. Select its sign-in button. The OAuth popup can appear in
   `browser.user.openTabs()`, not `browser.tabs.list()`.
   Match its observed title and exact approved origin, then pass that returned
   object to `browser.user.claimTab(...)`. Never guess a tab id.
3. Enter the runner's short-lived pairing code only in that approved popup.
   After Connect, the popup closes itself; discard its stale tab binding.
4. On the plugin settings page, refresh once and confirm the three read tools:
   `review_info`, `read_file`, `review_diff`. Do not infer failure from a briefly
   empty action list while refresh is pending.
5. Open a fresh ChatGPT conversation and select the exact new plugin via `@C2C`.
   Preserve its selection chip: append the task text instead of replacing the
   entire editor value. Check the intended model and effort in visible UI.
6. Specify the exact task, file versions, source-only evidence and no writes.
   Do not provide the baseline answer or reference-test answer key. Limit browser
   readback to the current conversation, avoiding unrelated sidebar content.

## Close Before Fixing

1. Capture the actual final answer and conversation URL, then send `stop` promptly.
   Do not keep the tunnel open while testing or editing locally.
2. Check CLOSED receipt, zero auth tokens, closed public endpoint and scoped audit.
   Remove the temporary plugin; wait until the installed-plugin list is visible
   AND the exact plugin name is absent before navigating to Security. An old
   detail view with no matching name is not proof of removal.
   A historical search suggestion alone does not prove a plugin is still installed.
3. Restore the batch's original developer-mode setting and read it back after the
   pending update settles. If restoring OFF, require unchecked AND enabled, not a
   disabled toggle with an optimistic value. Keep original failure evidence.
4. Verify each finding locally before changing code. A reproduced boundary value
   is not automatically a bug without a relevant policy or contract.
5. Require exact original-answer excerpts from the independent reviewer, not
   translations or paraphrases. Run the answer-evidence checker from SKILL.md;
   count length mechanically, preserve wrong verdicts, and reconcile substance
   before ending the route clock. This checks evidence form, not answer truth.

Revocation stops future reads. It does not erase content already sent to ChatGPT.
Never send patient data, hospital secrets or credentials.

For timing, start one consistent route clock before preparation and end it after
local acceptance and cleanup. Preserve setup, retries and repair intervals. The
ChatGPT displayed reasoning duration and the runner service interval are partial
measurements, never substitutes for that full-route clock.
For paired measurements, follow [the prospective protocol](../../docs/C2C_MEASUREMENT.md)
and start the route recorder before step 1 of task-specific preparation. The
recorder does not start a review or authorize another external batch.
