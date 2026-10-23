import { execFile, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runCliProcess } from "./cli-process.js";

describe("CLI fixture process lifecycle", () => {
  it("preserves expected nonzero exit output while yielding to the worker event loop", async () => {
    let yielded = false;
    setImmediate(() => { yielded = true; });
    const result = await runCliProcess(["-e", 'process.stdout.write("fixture-out"); process.stderr.write("fixture-error"); process.exitCode = 7;'], { timeoutMs: 10_000 });
    expect(yielded).toBe(true);
    expect(result).toEqual({ stdout: "fixture-out", stderr: "fixture-error", status: 7, signal: null });
  });

  it("waits for an owned timed-out child to exit before rejecting without its output", async () => {
    let child: ChildProcess | undefined;
    let exited = false;
    const execute = ((...args: Parameters<typeof execFile>) => {
      child = Reflect.apply(execFile, undefined, args);
      child!.once("exit", () => { exited = true; });
      return child;
    }) as typeof execFile;
    const error = await runCliProcess(["-e", 'process.stdout.write("synthetic-secret"); setInterval(() => {}, 1000);'], { timeoutMs: 150 }, execute)
      .then(() => { throw new Error("EXPECTED_TIMEOUT"); }, failure => failure);
    expect(error.message).toBe("CLI_TIMEOUT");
    expect(error.childProcess).toMatchObject({ classification: "timeout", errorCode: "ETIMEDOUT" });
    expect(exited).toBe(true);
    expect(child!.signalCode).toBe("SIGKILL");
    expect(JSON.stringify(error)).not.toContain("synthetic-secret");
  });

  it("recognizes a marker across chunks and waits for the marked child to terminate", async () => {
    const result = await runCliProcess(["-e", 'process.stdout.write("FIXTURE_"); setTimeout(() => process.stdout.write("READY"), 10); setInterval(() => {}, 1000);'],
      { timeoutMs: 10_000, marker: "FIXTURE_READY" });
    expect(result.stdout).toBe("FIXTURE_READY");
    expect(result.signal).toBe("SIGINT");
  });
});
