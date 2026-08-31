import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const EXPECTED_TASKS = 10;
export const FULL_ROUTE_TIMING_SCOPE = "full-route";
const REQUIRED = ["taskId", "route", "contentDigest", "model", "effort", "elapsedMs",
  "attempts", "setupFailures", "success", "judged", "timingScope", "falsePositives", "reworkMs", "quotaDelta", "cleanupVerified"];
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = code => { throw new TypeError(code); };
const finite = value => typeof value === "number" && Number.isFinite(value);
function validateManifest(manifest) {
  if (!object(manifest) || !Array.isArray(manifest.tasks)) fail("INVALID_MANIFEST_TASKS");
  const ids = new Set();
  return manifest.tasks.map((task, index) => {
    if (!object(task) || typeof task.id !== "string" || task.id.length === 0 ||
        typeof task.contentDigest !== "string" || task.contentDigest.length === 0) fail(`INVALID_MANIFEST_TASK:${index}`);
    if (ids.has(task.id)) fail(`DUPLICATE_MANIFEST_TASK:${task.id}`);
    ids.add(task.id);
    return { id: task.id, contentDigest: task.contentDigest };
  });
}
function validateRecord(record, index, tasks) {
  if (!object(record)) fail(`INVALID_RECORD:${index}`);
  for (const key of REQUIRED) if (!has(record, key)) fail(`MISSING_RECORD_FIELD:${key}`);
  if (typeof record.taskId !== "string" || record.taskId.length === 0) fail("INVALID_RECORD_TASK");
  const task = tasks.get(record.taskId);
  if (!task) fail(`INVALID_RECORD_TASK:${record.taskId}`);
  if (typeof record.contentDigest !== "string" || record.contentDigest !== task.contentDigest) fail(`CONTENT_DIGEST_MISMATCH:${record.taskId}`);
  if (record.route !== "ordinary" && record.route !== "c2c") fail("INVALID_RECORD_ROUTE");
  if (typeof record.model !== "string" || record.model.length === 0) fail("INVALID_RECORD_MODEL");
  if (typeof record.effort !== "string" || record.effort.length === 0) fail("INVALID_RECORD_EFFORT");
  if (!finite(record.elapsedMs) || record.elapsedMs < 0) fail("INVALID_ELAPSED_MS");
  if (!Number.isInteger(record.attempts) || record.attempts < 1) fail("INVALID_ATTEMPTS");
  if (!Number.isInteger(record.setupFailures) || record.setupFailures < 0 || record.setupFailures > record.attempts) fail("INVALID_SETUP_FAILURES");
  if (record.success !== null && typeof record.success !== "boolean") fail("INVALID_SUCCESS");
  if (typeof record.judged !== "boolean") fail("INVALID_JUDGED");
  if (typeof record.timingScope !== "string" || record.timingScope.length === 0) fail("INVALID_TIMING_SCOPE");
  if (record.success === true && record.judged !== true) fail("SUCCESS_REQUIRES_JUDGED");
  if (record.falsePositives !== null && (!Number.isInteger(record.falsePositives) || record.falsePositives < 0)) fail("INVALID_FALSE_POSITIVES");
  if (record.reworkMs !== null && (!finite(record.reworkMs) || record.reworkMs < 0)) fail("INVALID_REWORK_MS");
  if (record.reworkMs !== null && record.reworkMs > record.elapsedMs) fail("REWORK_EXCEEDS_ELAPSED");
  if (record.quotaDelta !== null && !finite(record.quotaDelta)) fail("INVALID_QUOTA_DELTA");
  if (record.cleanupVerified !== null && typeof record.cleanupVerified !== "boolean") fail("INVALID_CLEANUP_VERIFIED");
}
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
const fullyJudged = record => Boolean(record && record.judged === true && typeof record.success === "boolean");
const fullRouteTiming = record => Boolean(record && record.timingScope === FULL_ROUTE_TIMING_SCOPE);
const total = (records, key) => records.reduce((sum, record) => sum + record[key], 0);
const optionalTotal = (records, key) => records.length > 0 && records.every(record => record[key] !== null)
  ? total(records, key) : null;
function summarize(records) {
  const judged = records.filter(fullyJudged);
  return {
    submittedRuns: records.length,
    fullyJudgedRuns: judged.length,
    successCount: judged.filter(record => record.success === true).length,
    successRate: judged.length ? judged.filter(record => record.success === true).length / judged.length : null,
    medianElapsedMs: median(records.map(record => record.elapsedMs)),
    totalElapsedMs: total(records, "elapsedMs"),
    attempts: total(records, "attempts"),
    setupFailures: total(records, "setupFailures"),
    failedRuns: records.filter(record => record.success === false).length,
    falsePositivesTotal: optionalTotal(records, "falsePositives"),
    reworkMsTotal: optionalTotal(records, "reworkMs"),
    quotaDeltaTotal: optionalTotal(records, "quotaDelta"),
  };
}
// Keep well-formed source rows in submitted summaries; these reasons only gate decision evidence.
function pairIneligibilityReasons(ordinary, c2c) {
  const reasons = [];
  if (!ordinary) reasons.push("MISSING_ORDINARY_RECORD");
  if (!c2c) reasons.push("MISSING_C2C_RECORD");
  if (ordinary && !fullyJudged(ordinary)) reasons.push("ORDINARY_NOT_FULLY_JUDGED");
  if (c2c && !fullyJudged(c2c)) reasons.push("C2C_NOT_FULLY_JUDGED");
  if (ordinary && !fullRouteTiming(ordinary)) reasons.push("ORDINARY_TIMING_NOT_FULL_ROUTE");
  if (c2c && !fullRouteTiming(c2c)) reasons.push("C2C_TIMING_NOT_FULL_ROUTE");
  if (ordinary && c2c && ordinary.model !== c2c.model) reasons.push("MODEL_MISMATCH");
  if (ordinary && c2c && ordinary.effort !== c2c.effort) reasons.push("EFFORT_MISMATCH");
  if (ordinary && ordinary.falsePositives === null) reasons.push("ORDINARY_FALSE_POSITIVES_UNKNOWN");
  if (c2c && c2c.falsePositives === null) reasons.push("C2C_FALSE_POSITIVES_UNKNOWN");
  if (ordinary && ordinary.reworkMs === null) reasons.push("ORDINARY_REWORK_UNKNOWN");
  if (c2c && c2c.reworkMs === null) reasons.push("C2C_REWORK_UNKNOWN");
  if (c2c && c2c.cleanupVerified !== true) reasons.push("C2C_CLEANUP_UNVERIFIED");
  return reasons;
}
export function compareRuns(manifest, records) {
  const registered = validateManifest(manifest);
  if (!Array.isArray(records)) fail("INVALID_RECORDS");
  const tasks = new Map(registered.map(task => [task.id, task]));
  const byKey = new Map();
  for (let index = 0; index < records.length; index += 1) {
    validateRecord(records[index], index, tasks);
    const record = records[index];
    const key = `${record.taskId}\0${record.route}`;
    if (byKey.has(key)) fail(`DUPLICATE_RECORD:${record.taskId}:${record.route}`);
    byKey.set(key, record);
  }
  const routes = { ordinary: [], c2c: [] };
  for (const record of records) routes[record.route].push(record);
  const missing = { ordinary: [], c2c: [] };
  const unjudged = { ordinary: [], c2c: [] };
  const matchedTaskIds = [];
  const matched = { ordinary: [], c2c: [] };
  const ineligiblePairs = [];
  for (const task of registered) {
    for (const route of ["ordinary", "c2c"]) {
      const record = byKey.get(`${task.id}\0${route}`);
      if (!record) missing[route].push(task.id);
      else if (!fullyJudged(record)) unjudged[route].push(task.id);
    }
    const ordinary = byKey.get(`${task.id}\0ordinary`);
    const c2c = byKey.get(`${task.id}\0c2c`);
    const reasons = pairIneligibilityReasons(ordinary, c2c);
    if (reasons.length === 0) {
      matchedTaskIds.push(task.id);
      matched.ordinary.push(ordinary);
      matched.c2c.push(c2c);
    } else {
      ineligiblePairs.push({ taskId: task.id, reasons });
    }
  }
  const ordinary = summarize(routes.ordinary); const c2c = summarize(routes.c2c);
  const matchedOrdinary = summarize(matched.ordinary);
  const matchedC2c = summarize(matched.c2c);
  const ordinaryMedian = matchedOrdinary.medianElapsedMs; const c2cMedian = matchedC2c.medianElapsedMs;
  const ordinaryRate = matchedOrdinary.successRate;
  const c2cRate = matchedC2c.successRate;
  const stopRuleEvaluated = registered.length === EXPECTED_TASKS && matchedTaskIds.length === EXPECTED_TASKS;
  const elapsedThresholdMs = ordinaryMedian === null ? null : ordinaryMedian * 1.25;
  const elapsedRatio = ordinaryMedian === null || ordinaryMedian === 0 || c2cMedian === null ? null : c2cMedian / ordinaryMedian;
  const stopRuleTriggered = stopRuleEvaluated && ordinaryRate !== null && c2cRate !== null && ordinaryMedian !== null && c2cMedian !== null && c2cRate <= ordinaryRate && c2cMedian > elapsedThresholdMs;
  return {
    comparisonReady: stopRuleEvaluated,
    registeredTaskCount: registered.length,
    expectedTaskCount: EXPECTED_TASKS,
    matchedTaskIds,
    missing,
    unjudged,
    ineligiblePairs,
    ordinary,
    c2c,
    comparison: {
      matchedTaskCount: matchedTaskIds.length,
      ordinary: matchedOrdinary,
      c2c: matchedC2c,
      successRate: { ordinary: ordinaryRate, c2c: c2cRate },
      medianElapsedMs: { ordinary: ordinaryMedian, c2c: c2cMedian },
      elapsedThresholdMs,
      elapsedRatio,
      stopRuleEvaluated,
      stopRuleTriggered,
    },
    recommendation: stopRuleTriggered ? "restrict-and-improve" : "evidence-limited",
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [manifestFile, recordsFile, ...extra] = process.argv.slice(2);
  if (!manifestFile || !recordsFile || extra.length > 0) {
    process.stderr.write("Usage: compare-c2c-runs.mjs <manifest.json> <records.json>\n");
    process.exitCode = 1;
  } else {
    try {
      const read = file => JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
      process.stdout.write(`${JSON.stringify(compareRuns(read(manifestFile), read(recordsFile)), null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
