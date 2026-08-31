import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePrivateDirectory, evaluatePrivateAclSddlForTests, verifyPrivateFile, writePrivateNewFile } from "../src/review/private-storage.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const dirs: string[] = [];

function tmp(name: string): string {
  const dir = makeTmpDir(name);
  dirs.push(dir);
  return dir;
}

function privateDescriptor(target: string): { protected: boolean; ownerSid: string; sids: string[] } {
  const result = spawnSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; $item=Get-Item -LiteralPath $env:C2C_PRIVATE_TARGET; $acl=$item.GetAccessControl(); [Console]::Out.Write(([pscustomobject]@{ protected=[bool]$acl.AreAccessRulesProtected; ownerSid=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; sids=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique) } | ConvertTo-Json -Compress))",
  ], { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024, windowsHide: true, env: { ...process.env, C2C_PRIVATE_TARGET: target } });
  if (result.error || result.status !== 0) throw new Error("ACL_READBACK_UNAVAILABLE");
  return JSON.parse(result.stdout) as { protected: boolean; ownerSid: string; sids: string[] };
}

function currentAllowedSids(): string[] {
  const result = spawnSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "[Console]::Out.Write(([pscustomobject]@{ sids=@([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544' | Sort-Object -Unique) } | ConvertTo-Json -Compress))",
  ], { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error("ACL_READBACK_UNAVAILABLE");
  return (JSON.parse(result.stdout) as { sids: string[] }).sids;
}

afterEach(() => { while (dirs.length) cleanup(dirs.pop()!); });

describe("review private storage", () => {
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
