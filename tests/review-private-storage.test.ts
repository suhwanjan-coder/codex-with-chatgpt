import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as yieldToWorker } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePrivateDirectory, evaluatePrivateAclSddlForTests, verifyPrivateFile, writePrivateNewFile } from "../src/review/private-storage.js";
import { childProcessFailure, cleanup, makeTmpDir } from "./helpers.js";
import type { SpawnSyncReturns } from "node:child_process";
import { vi } from "vitest";
import * as storage from "../src/review/private-storage.js";
import { ReviewSession } from "../src/review/session.js";
import { snapshotDigest, type ReviewSnapshot } from "../src/review/snapshot.js";
import { startBridge } from "../src/bridge/server.js";

type DiagnosticError = Error & { diagnostic: storage.PrivateStorageDiagnostic };

function captureFailure(run: () => unknown): DiagnosticError {
  try { run(); } catch (error) { return error as DiagnosticError; }
  throw new Error("EXPECTED_STORAGE_FAILURE");
}

function helperResponse(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  return { pid: 0, output: [], stdout: "", stderr: "", status: 0, signal: null, ...overrides };
}

afterEach(() => { vi.restoreAllMocks(); });

const dirs: string[] = [];

function tmp(name: string): string {
  const dir = makeTmpDir(name);
  dirs.push(dir);
  return dir;
}

function privateDescriptor(target: string): { protected: boolean; ownerSid: string; sids: string[] } {
  const start = performance.now();
  const result = spawnSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; $item=Get-Item -LiteralPath $env:C2C_PRIVATE_TARGET; $acl=$item.GetAccessControl(); [Console]::Out.Write(([pscustomobject]@{ protected=[bool]$acl.AreAccessRulesProtected; ownerSid=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; sids=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique) } | ConvertTo-Json -Compress))",
  ], { encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true, env: { ...process.env, C2C_PRIVATE_TARGET: target } });
  if (result.error || result.status !== 0) throw childProcessFailure("ACL_READBACK_UNAVAILABLE", start, result);
  return JSON.parse(result.stdout) as { protected: boolean; ownerSid: string; sids: string[] };
}

function currentAllowedSids(): string[] {
  const start = performance.now();
  const result = spawnSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "[Console]::Out.Write(([pscustomobject]@{ sids=@([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544' | Sort-Object -Unique) } | ConvertTo-Json -Compress))",
  ], { encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw childProcessFailure("ACL_READBACK_UNAVAILABLE", start, result);
  return (JSON.parse(result.stdout) as { sids: string[] }).sids;
}

afterEach(async () => { while (dirs.length) cleanup(dirs.pop()!); await yieldToWorker(); });

// The largest ACL case performs eight native create/readback operations, each bounded to ten seconds.
describe("review private storage", { timeout: 80_000 }, () => {
  it.skipIf(process.platform !== "win32")("attaches bounded content-free diagnostics without retrying ambiguous file creation", () => {
    const target = path.join(tmp("private-diagnostic"), "private-path-marker");
    const secret = "synthetic-input-marker-測試";
    const cases: [Partial<SpawnSyncReturns<string>>, storage.PrivateStorageDiagnostic["classification"]][] = [
      [{ status: null, signal: "SIGTERM", error: Object.assign(new Error(secret + target), { code: "ETIMEDOUT", path: target, spawnargs: [secret] }) }, "timeout"],
      [{ stdout: JSON.stringify({ ok: true, code: "OK" }), error: Object.assign(new Error(secret), { code: "ETIMEDOUT" }) }, "timeout"],
      [{ status: null, error: Object.assign(new Error(secret), { code: "ENOENT" }) }, "spawn-error"],
      [{ status: null, signal: "SIGTERM" }, "signal"],
      [{ status: 1, stdout: secret, stderr: target }, "non-zero-exit"],
      [{ stdout: secret }, "bad-json"],
      [{ stdout: JSON.stringify({ ok: false, code: "UNAVAILABLE" }) }, "unavailable-code"],
      [{ stdout: JSON.stringify({ ok: false, code: "EXISTS" }) }, "exists-code"],
      [{ stdout: JSON.stringify({ ok: true, code: "OK", extra: secret }) }, "invalid-response"],
      [{ stdout: "x".repeat(16 * 1024 + 1) }, "output-too-large"],
      [{ status: null, signal: target as NodeJS.Signals, error: Object.assign(new Error(secret), { code: secret }) }, "spawn-error"],
    ];
    for (const [overrides, classification] of cases) {
      const response = helperResponse(overrides);
      const runner = vi.fn(() => response);
      const error = captureFailure(() => writePrivateNewFile(target, secret, runner));
      expect(error.message).toBe(classification === "exists-code" ? "PRIVATE_STORAGE_EXISTS" : "PRIVATE_STORAGE_UNAVAILABLE");
      expect(error.diagnostic).toEqual({ classification, durationMs: expect.any(Number), status: response.status,
        signal: response.signal === target ? "UNKNOWN" : response.signal,
        errorCode: response.error?.code === secret ? "UNKNOWN" : response.error?.code ?? null,
        stdoutBytes: Buffer.byteLength(response.stdout), stderrBytes: Buffer.byteLength(response.stderr) });
      expect(Number.isSafeInteger(error.diagnostic.durationMs)).toBe(true);
      expect(error.diagnostic.durationMs).toBeGreaterThanOrEqual(0);
      expect(Object.isFrozen(error.diagnostic)).toBe(true);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(target);
      expect(JSON.stringify(error).length).toBeLessThan(512);
      expect(error.cause).toBeUndefined();
      expect(runner).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(target)).toBe(false);
    }
  });

  it.skipIf(process.platform !== "win32")("sanitizes thrown runner errors and preserves only trusted diagnostics at boundaries", () => {
    const marker = "synthetic-private-marker";
    const error = captureFailure(() => ensurePrivateDirectory(path.join(tmp("private-thrown"), marker), () => {
      throw Object.assign(new Error(marker), { code: "ETIMEDOUT", path: marker });
    }));
    expect(error.diagnostic).toMatchObject({ classification: "timeout", status: null, signal: null, errorCode: "ETIMEDOUT", stdoutBytes: null, stderrBytes: null });
    const wrapped = storage.privateStorageFailure("AUTH_STORE_UNAVAILABLE", error) as DiagnosticError;
    expect(wrapped.message).toBe("AUTH_STORE_UNAVAILABLE");
    expect(wrapped.diagnostic).toBe(error.diagnostic);
    expect(JSON.stringify(wrapped)).not.toContain(marker);
    const foreign = storage.privateStorageFailure("AUTH_STORE_UNAVAILABLE", Object.assign(new Error(marker), { diagnostic: { path: marker } }));
    expect(JSON.stringify(foreign)).not.toContain(marker);
    expect(foreign.cause).toBeUndefined();
    const aclError = captureFailure(() => evaluatePrivateAclSddlForTests(marker, () => helperResponse({ stdout: marker })));
    expect(aclError.diagnostic.classification).toBe("bad-json");
    expect(JSON.stringify(aclError)).not.toContain(marker);
  });

  it.skipIf(process.platform !== "win32")("preserves an auth-store timeout through ReviewSession cleanup", () => {
    const snapshot: ReviewSnapshot = { version: 1, taskId: "diagnostic", provider: "local-test", model: "mock-reviewer", purpose: "diff-review",
      root: tmp("diagnostic-root"), baseCommit: "a".repeat(40), createdAt: 1000, expiresAt: 901000,
      maxCalls: 30, maxOutputBytes: 524288, files: [{ path: "a.ts", before: "a", after: "b" }] };
    const stateDir = tmp("diagnostic-state");
    const original = storage.writePrivateNewFile;
    let calls = 0;
    vi.spyOn(storage, "writePrivateNewFile").mockImplementation((target, text) => {
      if (++calls === 3) return original(target, text, () => helperResponse({ status: null, signal: "SIGTERM", error: Object.assign(new Error("synthetic-timeout"), { code: "ETIMEDOUT" }) }));
      return original(target, text);
    });
    const error = captureFailure(() => new ReviewSession(snapshot, { approvalDigest: snapshotDigest(snapshot), stateDir, now: () => 1000 }));
    expect(error.message).toBe("AUTH_STORE_UNAVAILABLE");
    expect(error.diagnostic).toMatchObject({ classification: "timeout", errorCode: "ETIMEDOUT" });
    expect(calls).toBe(3);
    expect(fs.readdirSync(path.join(stateDir, ".c2c-review-private")).filter((name) => name.endsWith(".lock"))).toEqual([]);
    expect(JSON.stringify(error)).not.toContain(stateDir);
  });

  it.skipIf(process.platform !== "win32")("preserves bridge create and verify diagnostics before opening a listener", async () => {
    const root = tmp("diagnostic-bridge");
    const file = path.join(root, "synthetic-private");
    const timeout = captureFailure(() => verifyPrivateFile(file, () => helperResponse({ status: null, signal: "SIGTERM", error: Object.assign(new Error("synthetic-timeout"), { code: "ETIMEDOUT" }) })));
    const exists = captureFailure(() => writePrivateNewFile(file, "synthetic", () => helperResponse({ stdout: JSON.stringify({ ok: false, code: "EXISTS" }) })));
    const writer = vi.spyOn(storage, "writePrivateNewFile");
    const verifier = vi.spyOn(storage, "verifyPrivateFile").mockImplementation(() => { throw timeout; });
    const review = { root, isActive: () => true, authStoreFile: file } as unknown as ReviewSession;
    for (const failure of [timeout, exists]) {
      writer.mockImplementation(() => { throw failure; });
      await expect(startBridge({ workspaceRoot: root, review })).rejects.toMatchObject({ message: "REVIEW_AUTH_STORE_UNAVAILABLE", diagnostic: timeout.diagnostic });
    }
    expect(verifier).toHaveBeenCalledTimes(1);
  });

  it("creates a directory and literal new file exclusively", () => {
    const parent = tmp("private-storage");
    const directory = ensurePrivateDirectory(path.join(parent, "private"));
    const file = path.join(directory, "-Command-測試.json");
    writePrivateNewFile(file, "first");
    expect(fs.readFileSync(file, "utf8")).toBe("first");
    expect(() => writePrivateNewFile(file, "second")).toThrow("PRIVATE_STORAGE_EXISTS");
    expect(fs.readFileSync(file, "utf8")).toBe("first");
    verifyPrivateFile(file);
  });

  it("keeps POSIX directory and file modes private", () => {
    if (process.platform === "win32") return;
    const directory = ensurePrivateDirectory(path.join(tmp("private-storage-modes"), "private"));
    const file = path.join(directory, "state.json");
    writePrivateNewFile(file, "{}");
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform !== "win32")("rejects an in-memory foreign owner even when the production DACL predicate passes", () => {
    const allowed = currentAllowedSids();
    const sddl = `O:S-1-5-21-1-2-3-4D:P${allowed.map((sid) => `(A;OICI;FA;;;${sid})`).join("")}`;
    expect(evaluatePrivateAclSddlForTests(sddl)).toEqual({ daclTrusted: true, ownerTrusted: false, trusted: false });
  });

  it.skipIf(process.platform !== "win32")("creates protected Windows DACLs with exactly the allowed SIDs", () => {
    const directory = ensurePrivateDirectory(path.join(tmp("private-storage-acl"), "private"));
    const file = path.join(directory, "state.json");
    writePrivateNewFile(file, "{}");
    for (const target of [directory, file]) {
      const descriptor = privateDescriptor(target);
      expect(descriptor.protected).toBe(true);
      expect(descriptor.sids).toEqual(currentAllowedSids());
      expect(currentAllowedSids()).toContain(descriptor.ownerSid);
    }
  });

  it.skipIf(process.platform !== "win32")("refuses an existing inherited directory without altering it", () => {
    const existing = path.join(tmp("private-storage-existing"), "existing");
    fs.mkdirSync(existing);
    const before = privateDescriptor(existing);
    expect(before.protected).toBe(false);
    expect(() => ensurePrivateDirectory(existing)).toThrow("PRIVATE_STORAGE_UNAVAILABLE");
    expect(privateDescriptor(existing)).toEqual(before);
  });

  it.skipIf(process.platform !== "win32")("fails closed for missing, timed-out, and malformed helper responses", () => {
    const target = path.join(tmp("private-storage-runner"), "private");
    for (const response of [
      { status: null, signal: null, stdout: "", stderr: "", output: [], error: Object.assign(new Error("missing"), { code: "ENOENT" }) },
      { status: null, signal: "SIGTERM", stdout: "", stderr: "", output: [], error: undefined },
      { status: 0, signal: null, stdout: "not-json", stderr: "", output: [], error: undefined },
      { status: 0, signal: null, stdout: JSON.stringify({ ok: true, code: "OK", extra: true }), stderr: "", output: [], error: undefined },
    ]) {
      expect(() => ensurePrivateDirectory(target, (() => response) as never)).toThrow("PRIVATE_STORAGE_UNAVAILABLE");
      expect(fs.existsSync(target)).toBe(false);
    }
  });
});
