import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import StorageStressReporter, { failureEvidence, windowsLoadCommand } from "../scripts/stress-private-storage.mjs";
import { childProcessFailure, cleanup, makeTmpDir } from "./helpers.js";

describe("storage stress evidence", () => {
  it("retains complete timeout text and code locations without arbitrary payloads", () => {
    const message = 'Test timed out in 30000ms.\nIf this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".';
    const evidence = failureEvidence({ message, stack: `${message}\n    at ${path.resolve("tests/review-cli.test.ts")}:42:7` });
    expect(evidence).toEqual({ message, stack: `${message}\n    at tests/review-cli.test.ts:42:7` });
    const secret = "synthetic-content-must-not-be-recorded";
    expect(JSON.stringify(failureEvidence({ message: secret, stack: `${secret}\n    at C:/user-data/${secret}:1:2` }))).not.toContain(secret);
    expect(failureEvidence({ message: "expected null to be +0 // Object.is equality" }).message).toBe("expected null to be +0 // Object.is equality");
  });
  it("keeps child-process timeout evidence separate and content-free", () => {
    const secret = "synthetic-content-must-not-be-recorded";
    const error = childProcessFailure("CLI_CHILD_PROCESS_FAILED", performance.now(), {
      error: Object.assign(new Error(secret), { code: "ETIMEDOUT", path: secret }),
      status: null, signal: "SIGTERM", stdout: secret, stderr: secret,
    }) as Error & { childProcess: unknown };
    expect(error.message).toBe("CLI_CHILD_PROCESS_FAILED");
    expect(error.childProcess).toEqual({ classification: "timeout", durationMs: expect.any(Number),
      status: null, signal: "SIGTERM", errorCode: "ETIMEDOUT", stdoutBytes: Buffer.byteLength(secret), stderrBytes: Buffer.byteLength(secret) });
    expect(JSON.stringify(error)).not.toContain(secret);
  });
  it("checkpoints pending, failed and unhandled work before final completion", () => {
    const dir = makeTmpDir("stress-reporter");
    const previous = process.env.C2C_STORAGE_STRESS_RESULT;
    const file = path.join(dir, "result.json");
    process.env.C2C_STORAGE_STRESS_RESULT = file;
    try {
      const suites = [{ name: "tests/fixture.test.ts", tasks: [
        { type: "test", name: "pending" },
        { type: "test", name: "failed", result: { state: "fail", duration: 15_001, errors: [childProcessFailure("CLI_CHILD_PROCESS_FAILED", performance.now(), {
          error: Object.assign(new Error(), { code: "ETIMEDOUT" }), status: null, signal: "SIGTERM", stdout: "", stderr: "",
        })] } },
      ] }];
      const errors = [new Error('[vitest-worker]: Timeout calling "onTaskUpdate"')];
      const reporter = new StorageStressReporter();
      reporter.onInit({ state: { getFiles: () => suites, getUnhandledErrors: () => errors } });
      reporter.onTaskUpdate();
      const checkpoint = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(checkpoint).toMatchObject({ complete: false, passed: 0, failed: 1, skipped: 0, pending: 1, unhandledErrors: 1, diagnostics: [] });
      expect(checkpoint.failureDetails[0].childDiagnostics).toMatchObject([{ classification: "timeout", errorCode: "ETIMEDOUT" }]);
      expect(checkpoint.failureDetails[1].message).toBe(errors[0].message);
      reporter.onFinished(suites, errors);
      expect(JSON.parse(fs.readFileSync(file, "utf8")).complete).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.C2C_STORAGE_STRESS_RESULT;
      else process.env.C2C_STORAGE_STRESS_RESULT = previous;
      cleanup(dir);
    }
  });
  if (process.platform === "win32") it("runs the actual bounded load helper even when inherited process policy is Restricted", () => {
    const { command, args } = windowsLoadCommand();
    const inheritedPolicy = process.env.PSExecutionPolicyPreference;
    // Windows env names are case-insensitive, but a worker's copied env may hold several casings.
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => key.toLowerCase() !== "psexecutionpolicypreference"));
    env.PSExecutionPolicyPreference = "Restricted";
    const blockedArgs = args.filter((argument: string) => !["-ExecutionPolicy", "Bypass"].includes(argument));
    const blocked = spawnSync(command, blockedArgs, { env, windowsHide: true, encoding: "utf8", timeout: 15_000 });
    expect(blocked.error).toBeUndefined();
    expect(blocked.status).not.toBe(0);
    const start = performance.now();
    const allowed = spawnSync(command, args, { env, windowsHide: true, encoding: "utf8", timeout: 15_000 });
    expect(allowed.error).toBeUndefined();
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toBe("");
    expect(allowed.stderr).toBe("");
    expect(performance.now() - start).toBeGreaterThanOrEqual(500);
    expect(fs.readFileSync(args.at(-1)!).subarray(0, 3)).toEqual(Buffer.from([239, 187, 191]));
    expect(process.env.PSExecutionPolicyPreference).toBe(inheritedPolicy);
  }, 35_000);
});
