import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateStorageDiagnosticLine, privateStorageFailure, writePrivateNewFile } from "../src/review/private-storage.js";
import * as builtStorage from "../dist/review/private-storage.js";
import { snapshotDigest, type ReviewSnapshot } from "../src/review/snapshot.js";
import { runC2c } from "../scripts/run-c2c.mjs";
import { failureEvidence, textDiagnostics } from "../scripts/stress-private-storage.mjs";
import { childProcessFailure, cleanup, makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];
function tmp(name: string): string { const dir = makeTmpDir(name); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) cleanup(dir); });

function snapshot(dataClass: "public" | "synthetic"): ReviewSnapshot {
  const now = Date.now();
  return { version: 1, taskId: "diagnostic-boundary", provider: "local-test", model: "mock-reviewer", purpose: "diff-review", dataClass,
    root: tmp("diagnostic-root"), baseCommit: "a".repeat(40), createdAt: now, expiresAt: now + 600_000,
    maxCalls: 30, maxOutputBytes: 524288, files: [{ path: "example.txt", before: null, after: "synthetic fixture" }] };
}

function timeoutFailure(create = writePrivateNewFile): Error {
  try {
    create(path.join(tmp("diagnostic-error"), "not-created"), "synthetic-input-secret", () => ({
      pid: 0, output: [], stdout: "synthetic-output-secret", stderr: "synthetic-stderr-secret", status: null, signal: "SIGTERM",
      error: Object.assign(new Error("synthetic-cause-secret"), { code: "ETIMEDOUT", path: "synthetic-path-secret" }),
    }));
  } catch (error) { return error as Error; }
  throw new Error("EXPECTED_STORAGE_FAILURE");
}

describe.skipIf(process.platform !== "win32")("private storage diagnostic boundaries", () => {
  it("formats only trusted metadata and rejects foreign diagnostic objects", () => {
    const error = privateStorageFailure("AUTH_STORE_UNAVAILABLE", timeoutFailure());
    const line = privateStorageDiagnosticLine(error);
    expect(textDiagnostics(line)).toMatchObject([{ classification: "timeout", status: null, signal: "SIGTERM", errorCode: "ETIMEDOUT" }]);
    expect(line.length).toBeLessThan(512);
    expect(line).not.toContain("secret");
    expect(privateStorageDiagnosticLine({ diagnostic: { classification: "timeout" } })).toBe("");
    expect(privateStorageDiagnosticLine(new Error("synthetic-cause-secret"))).toBe("");
    const message = `Error: AUTH_STORE_UNAVAILABLE\n${line}: expected false to be true // Object.is equality`;
    expect(failureEvidence({ message }).message).toBe(message);
  });

  it("propagates an injected timeout through the actual CLI child without raw process content", () => {
    const state = tmp("diagnostic-cli");
    const input = write(state, "snapshot.json", JSON.stringify(snapshot("synthetic")));
    const output = path.join(state, "permit.json");
    const probe = write(state, "inject.mjs", `import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const original = cp.spawnSync;
cp.spawnSync = (command, ...args) => String(command).endsWith("powershell.exe") ? {
  pid: 0, output: [], status: null, signal: "SIGTERM", stdout: "synthetic-output-secret", stderr: "synthetic-stderr-secret",
  error: Object.assign(new Error("synthetic-cause-secret"), { code: "ETIMEDOUT", path: "synthetic-path-secret" })
} : original(command, ...args);
syncBuiltinESMExports();\n`);
    const start = performance.now();
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(probe).href, "--import", "tsx", "src/cli/index.ts",
      "review", "remote-plan", "--snapshot", input, "--model", "mock-reviewer", "--resource", "https://diagnostic-test.trycloudflare.com/mcp",
      "--redirect-uri", "https://chatgpt.com/connector_platform_oauth_redirect", "--output", output], {
      encoding: "utf8", windowsHide: true, timeout: 30_000, env: { ...process.env, C2C_STATE_DIR: state },
    });
    if (result.error) throw childProcessFailure("CLI_CHILD_PROCESS_FAILED", start, result);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("PRIVATE_STORAGE_UNAVAILABLE");
    expect(textDiagnostics(result.stderr)).toMatchObject([{ classification: "timeout", errorCode: "ETIMEDOUT", stdoutBytes: 23, stderrBytes: 23 }]);
    expect(result.stderr).not.toContain("secret");
    expect(result.stderr).not.toContain(state);
    expect(fs.existsSync(output)).toBe(false);
  }, 40_000);

  it("propagates a startup storage timeout through runner cleanup and the assertion reporter", async () => {
    const input = snapshot("public");
    const state = tmp("diagnostic-runner");
    const file = write(state, "snapshot.json", JSON.stringify(input));
    const errors: string[] = [];
    const processRef = new EventEmitter() as EventEmitter & { exitCode?: number };
    const stop = vi.fn(async () => {});
    const startBridge = vi.fn();
    const terminal = { closed: false, close() { this.closed = true; } };
    const failure = builtStorage.privateStorageFailure("AUTH_STORE_UNAVAILABLE", timeoutFailure(builtStorage.writePrivateNewFile));
    const runner = await runC2c({ snapshotFile: file, model: "mock-reviewer", stateDir: path.join(state, "state"),
      authorizeExternalReview: true, reviewedSnapshot: snapshotDigest(input) }, {
      assertPinnedTunnelBinary: () => {},
      ensurePrivateDirectory: (target: string) => { fs.mkdirSync(target, { recursive: true }); return target; },
      writePrivateNewFile: (target: string, text: string) => fs.writeFileSync(target, text, { flag: "wx" }),
      createTunnel: () => ({ start: async () => "https://diagnostic-test.trycloudflare.com", stop }),
      createTerminal: () => terminal,
      createInput: ({ expectedDigest }: { expectedDigest: string }) => ({ approval: Promise.resolve(expectedDigest) }),
      createSession: () => { throw failure; },
      startBridge, processRef, writeOutput: () => {}, writeError: (text: string) => errors.push(text),
    });
    await runner.closed;
    expect(runner.started).toBe(false);
    expect(startBridge).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(processRef.exitCode).toBe(1);
    expect(processRef.listenerCount("SIGINT")).toBe(0);
    expect(processRef.listenerCount("SIGTERM")).toBe(0);
    expect(textDiagnostics(errors.join("\n"))).toMatchObject([{ classification: "timeout", errorCode: "ETIMEDOUT" }]);
    expect(errors.join("\n")).not.toContain("secret");
  });
});
