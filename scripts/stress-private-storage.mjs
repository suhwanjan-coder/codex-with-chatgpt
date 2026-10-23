import { spawn } from "node:child_process";
import fs from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(here), "..");
const files = ["review-session", "review-security", "review-cli", "review-private-storage", "bin", "c2c-runner"].map((name) => `tests/${name}.test.ts`);

export function windowsLoadCommand() {
  return { command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "stress-private-storage-load.ps1")] };
}

// Vitest serializes enumerable error properties across its worker boundary.
// Save only our fixed diagnostic schema, never process output.
function diagnostic(error) {
  const d = error?.diagnostic;
  if (!d || !["timeout", "spawn-error", "signal", "non-zero-exit", "bad-json", "invalid-response", "output-too-large", "unavailable-code", "exists-code"].includes(d.classification)) return [];
  const number = (value) => Number.isSafeInteger(value) ? value : null;
  const symbol = (value, allowed) => value === null ? null : typeof value === "string" && Object.hasOwn(allowed, value) ? value : "UNKNOWN";
  return [{ classification: d.classification, durationMs: number(d.durationMs), status: number(d.status),
    signal: symbol(d.signal, constants.signals), errorCode: symbol(d.errorCode, constants.errno),
    stdoutBytes: number(d.stdoutBytes), stderrBytes: number(d.stderrBytes) }];
}

const storageCodes = ["PRIVATE_STORAGE_UNAVAILABLE", "PRIVATE_STORAGE_EXISTS", "STATE_DIRECTORY_UNAVAILABLE", "PRIVATE_STATE_UNAVAILABLE",
  "WORKSPACE_LOCKED_OR_STATE_UNAVAILABLE", "APPROVAL_USED_OR_AUDIT_UNAVAILABLE", "AUTH_STORE_UNAVAILABLE", "REVIEW_AUTH_STORE_UNAVAILABLE"];

export function textDiagnostics(text) {
  if (typeof text !== "string") return [];
  return [...text.matchAll(/^C2C_PRIVATE_STORAGE_DIAGNOSTIC (\{[^\r\n]{1,512}\})\r?$/gm)].flatMap(match => {
    try { return diagnostic({ diagnostic: JSON.parse(match[1]) }); } catch { return []; }
  });
}

// Failure messages can contain snapshot bytes or CLI output. Retain only known
// structural errors; stack frames are code locations, never fixture/user paths.
export function failureEvidence(error) {
  const raw = typeof error?.message === "string" ? error.message : "";
  const safe = /^(?:Test|Hook) timed out in \d+ms\.[\s\S]*$/.test(raw) &&
    /^.*timed out in \d+ms\.\nIf this is a long-running (?:test|hook), pass a timeout value as the last argument or configure it globally with "(?:testTimeout|hookTimeout)"\.$/.test(raw);
  const primitive = /^(?:expected (?:null|undefined|true|false|[+-]?\d+) to be (?:null|undefined|true|false|[+-]?\d+)(?: \/\/ Object\.is equality)?|fetch failed|CLI_TIMEOUT|CLI_CHILD_PROCESS_FAILED|(?:PRIVATE_STORAGE|PRIVATE_STATE|AUTH_STORE|REVIEW_AUTH_STORE|STATE_DIRECTORY|WORKSPACE_LOCKED_OR_STATE|APPROVAL_USED_OR_AUDIT)_UNAVAILABLE)$/;
  const structural = raw.split(/\r?\n/).every(line => {
    const value = line.replace(/^(?:Error: |✗ )/, "").replace(/^: /, "");
    return value === "" || storageCodes.includes(value) || primitive.test(value) ||
      ["ACL_READBACK_UNAVAILABLE", "REVIEW_WORKSPACE_MISMATCH", "SESSION_CLOSED", "SNAPSHOT_EXPIRED"].includes(value);
  });
  const withoutDiagnostics = raw.replace(/^C2C_PRIVATE_STORAGE_DIAGNOSTIC \{[^\r\n]*\}\r?\n?/gm, "");
  const embedded = textDiagnostics(raw);
  const hasDiagnosticMessage = embedded.length && withoutDiagnostics.split(/\r?\n/).every(line => {
    const value = line.replace(/^(?:Error: |✗ )/, "").replace(/^: /, "");
    return value === "" || storageCodes.includes(value) || primitive.test(value);
  });
  const message = safe || structural || raw === '[vitest-worker]: Timeout calling "onTaskUpdate"' ? raw
    : hasDiagnosticMessage ? raw.replace(/^C2C_PRIVATE_STORAGE_DIAGNOSTIC \{[^\r\n]*\}\r?$/gm, line => {
      const parsed = textDiagnostics(line)[0];
      return parsed ? `C2C_PRIVATE_STORAGE_DIAGNOSTIC ${JSON.stringify(parsed)}` : "[invalid diagnostic redacted]";
    })
      : "[non-structural message redacted]";
  const frames = String(error?.stack ?? "").split(/\r?\n/).filter(line => /^\s+at /.test(line)).map(line => {
    const normalized = line.replaceAll("\\", "/");
    const prefix = root.replaceAll("\\", "/") + "/";
    const index = normalized.indexOf(prefix);
    if (index >= 0) {
      const location = normalized.slice(index + prefix.length).match(/^((?:tests|src|scripts|node_modules)\/[A-Za-z0-9_@./+~=-]+:\d+:\d+)\)?$/)?.[1];
      if (location && !location.includes("../")) {
        const before = normalized.slice(0, index).replace(/file:\/\/\/$/, "");
        const after = normalized.endsWith(")") ? ")" : "";
        if (/^\s+at (?:[A-Za-z0-9_.$<> \[\]-]+ \()?\s*$/.test(before)) return `${before}${location}${after}`;
        return `    at ${location}`;
      }
    }
    return /^\s+at (?:[A-Za-z0-9_.<> ]+ \(node:[A-Za-z0-9_/:]+\)|new Promise \(<anonymous>\))$/.test(line) ? line : "    at [non-code frame redacted]";
  });
  return { message, stack: [message, ...frames].join("\n") };
}

export default class StorageStressReporter {
  onInit(context) { this.context = context; }
  onTaskUpdate() {
    this.writeReport(this.context.state.getFiles(), this.context.state.getUnhandledErrors(), false);
  }
  onFinished(suites = [], errors = []) {
    this.writeReport(suites, errors, true);
  }
  writeReport(suites, errors, complete) {
    const report = { complete, passed: 0, failed: 0, skipped: 0, pending: 0, failedTests: [], failureDetails: [], diagnostics: [], tests: [], unhandledErrors: errors.length };
    function visit(task, ancestors = []) {
      const names = [...ancestors, task.name];
      for (const error of task.result?.errors ?? []) {
        const diagnostics = [...diagnostic(error), ...textDiagnostics(error.message)];
        report.diagnostics.push(...diagnostics);
        const code = storageCodes.includes(error.message) ? error.message : "OTHER";
        report.failureDetails.push({ test: names.join(" > "), code, ...failureEvidence(error), durationMs: task.result?.duration ?? null,
          diagnostics, childDiagnostics: diagnostic({ diagnostic: error.childProcess }) });
      }
      if (task.type === "test") {
        report.tests.push({ test: names.join(" > "), state: task.result?.state ?? "skip", durationMs: task.result?.duration ?? null });
        if (task.result?.state === "pass") report.passed++;
        else if (task.result?.state === "fail") { report.failed++; report.failedTests.push(names.join(" > ")); }
        else if (task.result?.state === "skip" || task.result?.state === "todo" || task.mode === "skip" || task.mode === "todo") report.skipped++;
        else report.pending++;
      }
      for (const child of task.tasks ?? []) visit(child, names);
    }
    for (const suite of suites) visit(suite);
    for (const error of errors) {
      report.diagnostics.push(...diagnostic(error));
      report.failureDetails.push({ test: "[unhandled]", code: "OTHER", ...failureEvidence(error), diagnostics: diagnostic(error), childDiagnostics: [] });
    }
    fs.writeFileSync(process.env.C2C_STORAGE_STRESS_RESULT, JSON.stringify(report));
  }
}

async function main() {
  const options = { iterations: 10, workers: 4, load: 0 };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2);
    const value = Number(args[i + 1]);
    if (!args[i].startsWith("--") || !Object.hasOwn(options, key) || !Number.isSafeInteger(value) || value < (key === "load" ? 0 : 1) || value > 100) {
      throw new Error("Usage: node scripts/stress-private-storage.mjs [--iterations 10] [--workers 4] [--load 0..100]");
    }
    options[key] = value;
  }
  if (options.load && process.platform !== "win32") throw new Error("PowerShell load requires Windows");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = path.join(root, "_working", `stress-private-storage-${stamp}.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const result = { startedAt: new Date().toISOString(), node: process.version, platform: process.platform, ...options, files, runs: [] };
  let stopping = false;
  let interrupted = false;
  const children = new Set();
  const loadStats = { started: 0, completed: 0, failed: 0 };
  function run(command, argv, env, load = false) {
    return new Promise((resolve) => {
      const start = performance.now();
      // The old ten-minute outer deadline censored this machine's load run.
      const child = spawn(command, argv, { cwd: root, env, stdio: "ignore", windowsHide: true, timeout: load ? 15_000 : 1_800_000 });
      children.add(child);
      let spawnError = false;
      child.on("error", () => { spawnError = true; });
      child.on("close", (code, signal) => { children.delete(child); resolve({ code, signal, spawnError, durationMs: Math.round(performance.now() - start) }); });
    });
  }
  async function loadLoop() {
    while (!stopping) {
      loadStats.started++;
      const { command, args } = windowsLoadCommand();
      const status = await run(command, args, process.env, true);
      if (!stopping) loadStats[status.code === 0 ? "completed" : "failed"]++;
    }
  }
  const stop = () => { stopping = true; for (const child of children) child.kill(); };
  const interrupt = () => { interrupted = true; stop(); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const loads = [];
  try {
    if (options.load) {
      const { command, args } = windowsLoadCommand();
      result.loadPreflight = await run(command, args, process.env, true);
      if (result.loadPreflight.code !== 0 || result.loadPreflight.spawnError) throw new Error("LOAD_PREFLIGHT_FAILED");
    }
    loads.push(...Array.from({ length: options.load }, loadLoop));
    for (let iteration = 1; iteration <= options.iterations && !stopping; iteration++) {
      const reportFile = output.replace(/\.json$/, `-${iteration}.json`);
      const start = performance.now();
      console.log(`STRESS START iteration=${iteration}/${options.iterations} workers=${options.workers} load=${options.load}`);
      const status = await run(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", ...files,
        "--maxWorkers", String(options.workers), "--reporter", here], { ...process.env, CI: "true", C2C_STORAGE_STRESS_RESULT: reportFile });
      const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, "utf8")) : null;
      const passed = status.code === 0 && report?.complete === true && report.failed === 0 && report.unhandledErrors === 0 && loadStats.failed === 0;
      const entry = { iteration, passed, durationMs: Math.round(performance.now() - start), ...status, report };
      result.runs.push(entry);
      fs.writeFileSync(output, JSON.stringify({ ...result, loadStats }, null, 2) + "\n");
      console.log(`STRESS iteration=${iteration}/${options.iterations} workers=${options.workers} load=${options.load} result=${passed ? "PASS" : "FAIL"} passed=${report?.passed ?? "unknown"} failed=${report?.failed ?? "unknown"} skipped=${report?.skipped ?? "unknown"} diagnostics=${report?.diagnostics.length ?? 0} durationMs=${entry.durationMs}`);
    }
  } finally {
    stop();
    await Promise.all(loads);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    result.finishedAt = new Date().toISOString();
    result.loadStats = loadStats;
    result.interrupted = interrupted;
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  }
  const passed = result.runs.filter((run) => run.passed).length;
  const diagnostics = result.runs.flatMap((run) => run.report?.diagnostics ?? []);
  console.log(`STRESS SUMMARY workers=${options.workers} load=${options.load} iterations=${result.runs.length} passed=${passed} failed=${result.runs.length - passed} diagnostics=${diagnostics.length} timeouts=${diagnostics.filter((d) => d.classification === "timeout").length} loadStarted=${loadStats.started} loadCompleted=${loadStats.completed} loadFailed=${loadStats.failed}`);
  console.log(`STRESS JSON ${path.relative(root, output)}`);
  process.exitCode = interrupted || passed !== options.iterations ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === here) {
  main().catch(() => { console.error("STRESS HARNESS FAILED (check arguments and local tooling)"); process.exitCode = 1; });
}
