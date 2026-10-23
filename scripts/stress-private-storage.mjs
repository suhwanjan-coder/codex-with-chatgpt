import { spawn } from "node:child_process";
import fs from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(here), "..");
const files = ["review-session", "review-security", "review-cli", "review-private-storage", "bin", "c2c-runner"].map((name) => `tests/${name}.test.ts`);

// Vitest serializes enumerable error properties across its worker boundary.
// Save only our fixed diagnostic schema, never stacks, messages, or process output.
function diagnostic(error) {
  const d = error?.diagnostic;
  if (!d || !["timeout", "spawn-error", "signal", "non-zero-exit", "bad-json", "invalid-response", "output-too-large", "unavailable-code", "exists-code"].includes(d.classification)) return [];
  const number = (value) => Number.isSafeInteger(value) ? value : null;
  const symbol = (value, allowed) => value === null ? null : typeof value === "string" && Object.hasOwn(allowed, value) ? value : "UNKNOWN";
  return [{ classification: d.classification, durationMs: number(d.durationMs), status: number(d.status),
    signal: symbol(d.signal, constants.signals), errorCode: symbol(d.errorCode, constants.errno),
    stdoutBytes: number(d.stdoutBytes), stderrBytes: number(d.stderrBytes) }];
}

export default class StorageStressReporter {
  onFinished(suites = [], errors = []) {
    const report = { passed: 0, failed: 0, skipped: 0, failedTests: [], failureDetails: [], diagnostics: [], unhandledErrors: errors.length };
    function visit(task, ancestors = []) {
      const names = [...ancestors, task.name];
      for (const error of task.result?.errors ?? []) {
        const diagnostics = diagnostic(error);
        report.diagnostics.push(...diagnostics);
        const code = ["PRIVATE_STORAGE_UNAVAILABLE", "PRIVATE_STORAGE_EXISTS", "STATE_DIRECTORY_UNAVAILABLE", "PRIVATE_STATE_UNAVAILABLE",
          "WORKSPACE_LOCKED_OR_STATE_UNAVAILABLE", "APPROVAL_USED_OR_AUDIT_UNAVAILABLE", "AUTH_STORE_UNAVAILABLE", "REVIEW_AUTH_STORE_UNAVAILABLE"].includes(error.message) ? error.message : "OTHER";
        report.failureDetails.push({ test: names.join(" > "), code, diagnostics });
      }
      if (task.type === "test") {
        if (task.result?.state === "pass") report.passed++;
        else if (task.result?.state === "fail") { report.failed++; report.failedTests.push(names.join(" > ")); }
        else report.skipped++;
      }
      for (const child of task.tasks ?? []) visit(child, names);
    }
    for (const suite of suites) visit(suite);
    for (const error of errors) report.diagnostics.push(...diagnostic(error));
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
      const child = spawn(command, argv, { cwd: root, env, stdio: "ignore", windowsHide: true, timeout: load ? 15_000 : 600_000 });
      children.add(child);
      let spawnError = false;
      child.on("error", () => { spawnError = true; });
      child.on("close", (code, signal) => { children.delete(child); resolve({ code, signal, spawnError }); });
    });
  }
  async function loadLoop() {
    while (!stopping) {
      loadStats.started++;
      const status = await run("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", path.join(root, "scripts", "stress-private-storage-load.ps1")], process.env, true);
      if (!stopping) loadStats[status.code === 0 ? "completed" : "failed"]++;
    }
  }
  const stop = () => { stopping = true; for (const child of children) child.kill(); };
  const interrupt = () => { interrupted = true; stop(); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const loads = Array.from({ length: options.load }, loadLoop);
  try {
    for (let iteration = 1; iteration <= options.iterations && !stopping; iteration++) {
      const reportFile = output.replace(/\.json$/, `-${iteration}.json`);
      const start = performance.now();
      console.log(`STRESS START iteration=${iteration}/${options.iterations} workers=${options.workers} load=${options.load}`);
      const status = await run(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", ...files,
        "--maxWorkers", String(options.workers), "--reporter", here], { ...process.env, CI: "true", C2C_STORAGE_STRESS_RESULT: reportFile });
      const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, "utf8")) : null;
      const passed = status.code === 0 && report !== null && report.failed === 0 && report.unhandledErrors === 0;
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
