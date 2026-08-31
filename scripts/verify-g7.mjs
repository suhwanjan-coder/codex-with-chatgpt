import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REQUIRED_NATIVE_CHECKS = Object.freeze([
  "NATIVE_ADS", "ANCESTOR_JUNCTION", "FILE_SYMLINK", "LONG_PATH", "SHORT_ALIAS",
  "OTHER_REPARSE", "ACL_ISOLATION",
]);
export const REQUIRED_SUITES = Object.freeze([
  "bin", "endpoint", "g7-gate", "git", "mcp-integration", "oauth", "pairing", "port",
  "review-cli", "review-faults", "review-security", "review-session", "review-snapshot",
  "review-windows-native", "sandbox-allow", "search", "tunnel", "windows-legacy", "workspace",
].map((name) => `tests/${name}.test.ts`));

function suitePath(name) {
  const relative = path.relative(root, path.resolve(root, name));
  return relative.split(path.sep).join("/");
}

function discoverSuites(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? discoverSuites(file) : entry.isFile() && entry.name.endsWith(".test.ts") ? [suitePath(file)] : [];
  });
}

// A green unit-test runner is not acceptance when safety checks are absent/skipped.
export function evaluateG7(report, platform = process.platform, discoveredSuites = []) {
  const reasons = [];
  if (platform !== "win32") reasons.push("WINDOWS_REQUIRED");
  if (!report || typeof report !== "object" || !Array.isArray(report.testResults)) {
    return { passed: false, reasons: [...reasons, "INVALID_TEST_REPORT"] };
  }
  const suites = report.testResults;
  if (suites.some((suite) => !suite || typeof suite !== "object" || typeof suite.name !== "string" ||
      !Array.isArray(suite.assertionResults) || suite.assertionResults.some((test) =>
        !test || typeof test !== "object" || typeof test.title !== "string" || typeof test.status !== "string"))) {
    return { passed: false, reasons: [...reasons, "INVALID_TEST_REPORT"] };
  }
  const assertions = suites.flatMap((suite) => suite.assertionResults);
  if (report.success !== true || report.numFailedTests !== 0 || report.numFailedTestSuites !== 0 ||
      (report.numRuntimeErrorTestSuites ?? 0) !== 0) reasons.push("TEST_RUN_NOT_CLEAN");
  if (!assertions.length || !Number.isInteger(report.numTotalTests) || report.numTotalTests !== assertions.length) {
    reasons.push("INCOMPLETE_TEST_REPORT");
  }
  if (report.numPendingTests !== 0 || (report.numTodoTests ?? 0) !== 0) reasons.push("SKIPPED_OR_TODO_TESTS");
  for (const suite of suites) {
    if (suite.status !== "passed" || !Array.isArray(suite.assertionResults) || !suite.assertionResults.length) {
      reasons.push(`SUITE_NOT_PASSED:${path.basename(String(suite.name ?? "unknown"))}`);
    }
  }
  for (const assertion of assertions) {
    if (assertion.status !== "passed") reasons.push(`TEST_NOT_PASSED:${assertion.fullName ?? assertion.title ?? "unknown"}`);
  }
  const required = new Set([...REQUIRED_SUITES, ...discoveredSuites]);
  for (const name of required) {
    const matches = suites.filter((suite) => suitePath(suite.name) === name);
    if (matches.length !== 1) reasons.push(`MISSING_OR_DUPLICATE_SUITE:${name}`);
  }
  for (const suite of suites) {
    if (!required.has(suitePath(suite.name))) reasons.push(`UNEXPECTED_SUITE:${suitePath(suite.name)}`);
  }
  const nativeSuite = suites.find((suite) => suitePath(suite.name) === "tests/review-windows-native.test.ts");
  const nativeTests = nativeSuite?.assertionResults ?? [];
  for (const id of REQUIRED_NATIVE_CHECKS) {
    const matching = nativeTests.filter((test) => String(test.title).includes(`[G7:${id}]`));
    if (matching.length !== 1 || matching[0].status !== "passed") reasons.push(`NATIVE_EVIDENCE_REQUIRED:${id}`);
  }
  return { passed: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function main() {
  if (process.argv.length !== 2) throw new Error("G7 runner accepts no filters, report overrides, or skip options");
  const evidenceRoot = path.join(root, ".tooling", "g7");
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(evidenceRoot, "run-"));
  const reportFile = path.join(runDir, "vitest.json");
  const discoveredSuites = discoverSuites(path.join(root, "tests"));
  const commands = [
    ["typecheck", ["node_modules/typescript/bin/tsc", "--noEmit"]],
    ["build", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]],
    ["tests", ["node_modules/vitest/vitest.mjs", "run", "--reporter=default", "--reporter=json", `--outputFile.json=${reportFile}`]],
  ];
  const execution = commands.map(([name, args]) => {
    const result = spawnSync(process.execPath, args, {
      cwd: root, stdio: "inherit", shell: false, windowsHide: true, timeout: 180_000,
    });
    return { name, exitCode: result.status, signal: result.signal, error: result.error?.code ?? null };
  });
  let report;
  try { report = JSON.parse(fs.readFileSync(reportFile, "utf8")); } catch { /* Missing or malformed evidence fails closed. */ }
  const gate = evaluateG7(report, process.platform, discoveredSuites);
  for (const step of execution) {
    if (step.exitCode !== 0 || step.signal || step.error) gate.reasons.push(`COMMAND_FAILED:${step.name}`);
  }
  gate.passed = gate.reasons.length === 0;
  const result = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), platform: process.platform,
    node: process.version, scope: "local Windows G7; never external deployment approval",
    execution, expectedSuites: [...new Set([...REQUIRED_SUITES, ...discoveredSuites])], ...gate,
  };
  const gateFile = path.join(runDir, "gate.json");
  fs.writeFileSync(gateFile, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(JSON.stringify({ ...result, evidence: gateFile }) + "\n");
  process.exitCode = gate.passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
