import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { compareRuns, FULL_ROUTE_TIMING_SCOPE } from "./compare-c2c-runs.mjs";

const fail = code => { throw new Error(code); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
function exact(value, keys) {
  if (!object(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key))) fail("INVALID_EVENT_FIELDS");
}
function writeNewJson(file, value) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.unlinkSync(file);
    throw error;
  }
  fs.closeSync(fd);
}

export function createRouteRecorder(config, clock = () => performance.now(), now = () => new Date().toISOString()) {
  const start = clock();
  const startedAt = now();
  const { manifest, taskId, route, model, effort, outputDir } = config;
  const task = manifest?.tasks?.find(item => item.id === taskId);
  if (!task) fail("TASK_NOT_REGISTERED");
  const base = {
    taskId, route, contentDigest: task.contentDigest, model, effort,
    elapsedMs: 0, attempts: 1, setupFailures: 0, success: null, judged: false,
    timingScope: FULL_ROUTE_TIMING_SCOPE, falsePositives: null, reworkMs: null,
    quotaDelta: null, cleanupVerified: null,
  };
  // Reuse the calculator's record contract; it does not certify external evidence.
  compareRuns(manifest, [base]);
  const directory = path.resolve(outputDir);
  fs.mkdirSync(directory, { mode: 0o700 });
  let fd;
  try { fd = fs.openSync(path.join(directory, "events.jsonl"), "wx", 0o600); }
  catch (error) { throw error; }
  let terminal = false;
  let activeAttempt = false;
  let attempts = 0;
  let setupFailures = 0;
  let reworkStart = null;
  let reworkMs = 0;
  let sequence = 0;
  let lastElapsed = 0;
  const elapsed = () => {
    const value = clock() - start;
    if (!Number.isFinite(value) || value < lastElapsed) fail("INVALID_MONOTONIC_CLOCK");
    lastElapsed = value;
    return value;
  };
  const append = event => {
    fs.writeFileSync(fd, `${JSON.stringify({ sequence: ++sequence, ...event })}\n`);
    fs.fsyncSync(fd);
  };
  const close = () => { if (fd !== undefined) { fs.closeSync(fd); fd = undefined; } };
  try { append({ event: "start", elapsedMs: elapsed(), startedAt, taskId, route, contentDigest: task.contentDigest, model, effort }); }
  catch (error) { close(); throw error; }

  return {
    get terminal() { return terminal; },
    apply(event) {
      if (terminal) fail("RECORDER_TERMINAL");
      try {
      if (!object(event) || typeof event.event !== "string") fail("INVALID_EVENT");
      const t = elapsed();
      switch (event.event) {
        case "attempt_start":
          exact(event, ["event"]);
          if (activeAttempt) fail("ATTEMPT_ALREADY_ACTIVE");
          activeAttempt = true; attempts += 1;
          break;
        case "attempt_end":
          exact(event, ["event", "setupFailure"]);
          if (!activeAttempt || typeof event.setupFailure !== "boolean") fail("INVALID_ATTEMPT_END");
          activeAttempt = false;
          if (event.setupFailure) setupFailures += 1;
          break;
        case "rework_start":
          exact(event, ["event"]);
          if (attempts === 0 || reworkStart !== null) fail("INVALID_REWORK_START");
          reworkStart = t;
          break;
        case "rework_end":
          exact(event, ["event"]);
          if (reworkStart === null) fail("REWORK_NOT_ACTIVE");
          reworkMs += t - reworkStart; reworkStart = null;
          break;
        case "finish": {
          exact(event, ["event", "success", "judged", "falsePositives", "reworkObserved", "cleanupVerified", "quotaDelta"]);
          if (attempts === 0 || activeAttempt || reworkStart !== null) fail("UNFINISHED_ROUTE");
          if (typeof event.success !== "boolean" || event.judged !== true || event.reworkObserved !== true ||
              !Number.isInteger(event.falsePositives) || event.falsePositives < 0 ||
              typeof event.cleanupVerified !== "boolean" || (route === "c2c" && !event.cleanupVerified)) fail("FINISH_REQUIRES_VERIFIED_OBSERVATIONS");
          const record = { ...base, elapsedMs: t, attempts, setupFailures, success: event.success, judged: true,
            falsePositives: event.falsePositives, reworkMs, quotaDelta: event.quotaDelta,
            cleanupVerified: event.cleanupVerified, startedAt, endedAt: now(), reworkObserved: true };
          compareRuns(manifest, [record]);
          append({ ...event, elapsedMs: t });
          close();
          writeNewJson(path.join(directory, "record.json"), record);
          terminal = true;
          return record;
        }
        default: fail("UNKNOWN_EVENT");
      }
      append({ ...event, elapsedMs: t });
      return null;
      } catch (error) {
        try { this.abort(typeof error?.code === "string" ? "io-error" : "invalid-input"); } catch { /* Preserve the original error if persistence also fails. */ }
        throw error;
      }
    },
    abort(reason = "aborted") {
      if (terminal) return;
      terminal = true;
      const safeReason = ["eof", "signal", "invalid-input", "io-error", "aborted"].includes(reason) ? reason : "aborted";
      const event = { event: "incomplete", reason: safeReason, elapsedMs: elapsed(), attempts, setupFailures };
      try {
        if (fd !== undefined) append(event);
        writeNewJson(path.join(directory, "incomplete.json"), event);
      } finally { close(); }
    },
  };
}

export function runCli(args) {
  const [manifestFile, taskId, route, model, effort, outputDir, ...extra] = args;
  if (!outputDir || extra.length) fail("Usage: record-c2c-route.mjs <manifest.json> <taskId> <ordinary|c2c> <model> <effort> <new-output-directory>");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const recorder = createRouteRecorder({ manifest, taskId, route, model, effort, outputDir });
  let buffer = Buffer.alloc(0);
  let stopping = false;
  const stop = (reason, code) => {
    if (stopping) return;
    stopping = true;
    process.stdin.pause();
    try { recorder.abort(reason); } catch { process.stderr.write("RECORDER_PERSISTENCE_ERROR\n"); }
    process.exitCode = code;
    process.stdin.removeAllListeners("data");
    process.stdin.removeAllListeners("end");
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
  };
  const signal = () => stop("signal", 1);
  process.on("SIGINT", signal);
  process.on("SIGTERM", signal);
  process.stdin.on("end", () => stop("eof", 1));
  process.stdin.on("error", () => stop("io-error", 1));
  process.stdin.on("data", chunk => {
    // Bound each line before decoding or parsing; never echo input or parse errors.
    buffer = Buffer.concat([buffer, chunk]);
    let newline;
    while ((newline = buffer.indexOf(10)) !== -1) {
      if (newline > 8192) { stop("invalid-input", 1); return; }
      const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
      try {
        const event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
        const record = recorder.apply(event);
        process.stdout.write(`${JSON.stringify(record ? { event: "FINISHED", record } : { event: "ACK", command: event.event })}\n`);
        if (record) { stop("aborted", 0); return; }
      } catch { stop("invalid-input", 1); return; }
    }
    if (buffer.length > 8192) stop("invalid-input", 1);
  });
  process.stdout.write(`${JSON.stringify({ event: "READY", taskId, route })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runCli(process.argv.slice(2)); }
  catch { process.stderr.write("RECORDER_START_FAILED\n"); process.exitCode = 1; }
}
