import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateNativeEvidence } from "./g7-native-evidence-helper.js";
import { ensurePrivateDirectory, writePrivateNewFile } from "../dist/review/private-storage.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const driver = path.join(root, "scripts", "verify-g7-windows.mjs");
const helper = path.join(root, "scripts", "g7-windows-helper.ps1");
const bundledNode = "C:\\Users\\suhwa\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\bin\\node.exe";
const fingerprintFiles = ["scripts/verify-g7-windows.mjs", "scripts/g7-windows-helper.ps1", "src/review/private-storage.ts", "src/review/session.ts", "src/review/snapshot.ts", "src/auth/store.ts", "dist/review/private-storage.js", "dist/review/session.js", "dist/review/snapshot.js", "dist/auth/store.js"];
const owned: string[] = [];
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

afterEach(() => { while (owned.length) fs.rmSync(owned.pop()!, { recursive: true, force: true }); });

/**
 * The elevated helper has top-level account and ACL work.  Contract tests load
 * only requested function ASTs into a fresh PowerShell process.
 */
function runHelperFunctions(functionNames: string[], probe: string, env: NodeJS.ProcessEnv = {}) {
  const extraction = String.raw`
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:G7_HELPER, [ref]$tokens, [ref]$errors)
if ($errors.Count) { $errors | ForEach-Object { $_.ToString() }; exit 1 }
$definitions = @{}
foreach ($candidate in $ast.FindAll({ param($node) $node.GetType().FullName -eq 'System.Management.Automation.Language.FunctionDefinitionAst' }, $true)) {
  if ($definitions.ContainsKey($candidate.Name)) { throw "duplicate function: $($candidate.Name)" }
  $definitions[$candidate.Name] = $candidate.Extent.Text
}
foreach ($name in ($env:G7_FUNCTIONS -split ',')) {
  if (-not $definitions.ContainsKey($name)) { throw "missing function: $name" }
  Invoke-Expression $definitions[$name]
}
& ([scriptblock]::Create($env:G7_PROBE))
`;
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", extraction], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...env, G7_HELPER: helper, G7_FUNCTIONS: functionNames.join(","), G7_PROBE: probe },
  });
}

function runHelperReturnExpression(functionName: string, probe: string, env: NodeJS.ProcessEnv = {}) {
  const extraction = String.raw`
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:G7_HELPER, [ref]$tokens, [ref]$errors)
if ($errors.Count) { $errors | ForEach-Object { $_.ToString() }; exit 1 }
$functionAst = @($ast.FindAll({ param($node) $node.GetType().FullName -eq 'System.Management.Automation.Language.FunctionDefinitionAst' -and $node.Name -eq $env:G7_FUNCTION }, $true))
if ($functionAst.Count -ne 1) { throw "missing function: $env:G7_FUNCTION" }
$returns = @($functionAst[0].FindAll({ param($node) $node.GetType().FullName -eq 'System.Management.Automation.Language.ReturnStatementAst' }, $true))
if ($returns.Count -ne 1) { throw "unexpected return count: $($returns.Count)" }
$expression = $returns[0].Pipeline.Extent.Text
& ([scriptblock]::Create($env:G7_PROBE))
`;
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", extraction], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...env, G7_HELPER: helper, G7_FUNCTION: functionName, G7_PROBE: probe },
  });
}

function fixture() {
  const nonce = "0123456789abcdef0123456789abcdef";
  const dir = path.join(root, ".tooling", `g7-native-${nonce}`);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, "private-state", ".c2c-review-private"), { recursive: true }); owned.push(dir);
  const files: Record<string, string> = {};
  for (const name of ["snapshot", "auth", "state", "audit", "lock", "fileSymlink", "legacySymlink", "otherReparse"]) {
    const privateName = { auth: `${"a".repeat(64)}.auth.json`, audit: `${"a".repeat(64)}.audit.jsonl`, lock: `${"b".repeat(64)}.lock`, state: "state-private.txt" }[name as "auth" | "audit" | "lock" | "state"];
    const file = privateName ? path.join(dir, "private-state", ".c2c-review-private", privateName) : path.join(dir, `${name}.txt`);
    fs.writeFileSync(file, name); files[name] = file;
  }
  const manifestArtifacts = {
    snapshot: { path: files.snapshot, sha256: hash(files.snapshot) }, auth: { path: files.auth, sha256: hash(files.auth) }, state: { path: files.state, sha256: hash(files.state) }, audit: { path: files.audit, sha256: hash(files.audit) }, lock: { path: files.lock, sha256: hash(files.lock) },
    outside: { path: files.fileSymlink, sha256: hash(files.fileSymlink) }, ads: { path: files.legacySymlink, sha256: hash(files.legacySymlink) }, longPath: { path: files.otherReparse, sha256: hash(files.otherReparse) }, shortSource: { path: files.otherReparse, sha256: hash(files.otherReparse) },
  };
  const manifest = path.join(dir, "manifest.json");
  const evidenceExpiresAt = Date.now() + 120_000;
  const fingerprints = Object.fromEntries(fingerprintFiles.map((relative) => [relative, hash(path.join(root, ...relative.split("/")))]));
  fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, nonce, root: dir, mode: "run", helperStartExpiresAt: Date.now() + 60_000, evidenceExpiresAt, fingerprints, artifacts: manifestArtifacts }));
  const evidence = {
    schemaVersion: 1 as const, nonce, root: dir, evidenceExpiresAt, manifest, manifestSha256: hash(manifest), helperResult: path.join(dir, "helper-result.json"),
    artifacts: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, { path: file, sha256: hash(file) }])),
    snapshotRejections: { fileSymlink: "SNAPSHOT_ALIAS", legacySymlink: "SNAPSHOT_ALIAS", otherReparse: "SNAPSHOT_ALIAS" },
    helper: { success: true as const, nonce, reparse: { path: files.otherReparse, tag: 0x80000024, attributes: 0x400, isSymbolicLink: false, isJunction: false }, acl: { controls: { usersReadWrite: true as const, everyoneReadWrite: true as const }, denied: { snapshot: "ERROR_ACCESS_DENIED" as const, auth: "ERROR_ACCESS_DENIED" as const, state: "ERROR_ACCESS_DENIED" as const, audit: "ERROR_ACCESS_DENIED" as const, lock: "ERROR_ACCESS_DENIED" as const }, owner: { read: true as const, write: true as const }, token: { users: true as const, everyone: true as const } }, cleanup: { userNotFound: true as const, accountSid: "S-1-5-21-1-2-3-4", receipt: path.join(dir, "cleanup-receipt.json") } },
  };
  fs.writeFileSync(evidence.helperResult, JSON.stringify(evidence.helper)); fs.writeFileSync(evidence.helper.cleanup.receipt, JSON.stringify({ nonce, accountName: `g7n${nonce.slice(0, 16)}`, accountSid: evidence.helper.cleanup.accountSid, createdByHelper: true }));
  return { nonce, evidence };
}

function preflightFixture() {
  const nonce = randomBytes(16).toString("hex");
  const dir = path.join(root, ".tooling", `g7-native-${nonce}`);
  ensurePrivateDirectory(dir); owned.push(dir);
  const privateDir = path.join(dir, "private-state", ".c2c-review-private");
  fs.mkdirSync(path.join(dir, "hardened-repo"), { recursive: true });
  fs.mkdirSync(path.join(dir, "legacy-repo"), { recursive: true });
  fs.mkdirSync(path.join(dir, "outside"), { recursive: true });
  fs.mkdirSync(path.dirname(privateDir), { recursive: true }); ensurePrivateDirectory(privateDir);
  const snapshot = path.join(dir, "private-snapshot.json");
  const auth = path.join(privateDir, `${"a".repeat(64)}.auth.json`);
  const state = path.join(privateDir, "state-private.txt");
  const audit = path.join(privateDir, `${"a".repeat(64)}.audit.jsonl`);
  const lock = path.join(privateDir, `${"b".repeat(64)}.lock`);
  for (const file of [snapshot, auth, state, audit, lock]) writePrivateNewFile(file, path.basename(file));
  const outside = path.join(dir, "outside", "outside.txt"); fs.writeFileSync(outside, "outside");
  const approved = path.join(dir, "hardened-repo", "approved.txt"); fs.writeFileSync(approved, "approved");
  const ads = `${approved}:g7-native-ads`;
  const writeAds = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Set-Content -LiteralPath $env:G7_ADS -Value 'ads' -NoNewline -Encoding ASCII"], { cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, G7_ADS: ads } });
  expect(writeAds.status).toBe(0);
  const parts: string[] = [];
  while (path.join(dir, "hardened-repo", ...parts, "safe.txt").length <= 260) parts.push(`native-long-${String(parts.length).padStart(2, "0")}-${"x".repeat(40)}`);
  const longPath = path.join(dir, "hardened-repo", ...parts, "safe.txt"); fs.mkdirSync(path.dirname(longPath), { recursive: true }); fs.writeFileSync(longPath, "long");
  const shortSource = path.join(dir, "hardened-repo", `native-short-alias-${"x".repeat(56)}.txt`); fs.writeFileSync(shortSource, "short");
  const artifacts = Object.fromEntries(Object.entries({ snapshot, auth, state, audit, lock, outside, ads, longPath, shortSource }).map(([name, file]) => [name, { path: file, sha256: hash(file) }]));
  const manifest = path.join(dir, "manifest.json");
  fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, nonce, root: dir, mode: "run", helperStartExpiresAt: Date.now() + 60_000, evidenceExpiresAt: Date.now() + 120_000, fingerprints: Object.fromEntries(fingerprintFiles.map((relative) => [relative, hash(path.join(root, ...relative.split("/")))])), artifacts }));
  return { dir, manifest, shortSource };
}

function runHelper(manifest: string, ...args: string[]) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-ManifestPath", manifest, ...args], { cwd: root, encoding: "utf8", windowsHide: true });
}

describe("G7 Windows driver boundaries", () => {
  it("has a side-effect-free import and a no-argument scope error", () => {
    const before = fs.readdirSync(path.join(root, ".tooling"), { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith("g7-native-")).map((entry) => entry.name).sort();
    const imported = spawnSync(bundledNode, ["-e", `import(${JSON.stringify(pathToFileURL(driver).href)})`], { cwd: root, encoding: "utf8", windowsHide: true });
    expect(imported.status).toBe(0);
    const result = spawnSync(bundledNode, [driver], { cwd: root, encoding: "utf8", windowsHide: true });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--authorize-elevated-fixtures");
    const after = fs.readdirSync(path.join(root, ".tooling"), { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith("g7-native-")).map((entry) => entry.name).sort();
    expect(after).toEqual(before);
  });

  it("PowerShell parses and retains one-UAC bounded-helper controls", () => {
    const parser = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$t=$null;$e=$null;[Management.Automation.Language.Parser]::ParseFile($env:G7_HELPER,[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|%{$_.ToString()};exit 1}"], { cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, G7_HELPER: helper } });
    expect(parser.status).toBe(0);
    const source = fs.readFileSync(helper, "utf8");
    expect(source).toContain("CreateSymbolicLink");
    expect(source).toContain("NetUserAdd"); expect(source).toContain("NetUserDel");
    expect(source).toContain("LogonUser"); expect(source).toContain("MANIFEST_EXPIRED");
    expect(source).not.toContain("Path]::GetRelativePath");
    expect(source).toContain("ToUInt32('80000024', 16)");
    expect(fs.readFileSync(driver, "utf8")).toContain("-Verb RunAs");
    expect(fs.readFileSync(driver, "utf8")).toContain("-WindowStyle Hidden");
    expect(fs.readFileSync(driver, "utf8")).toContain("-ManifestPath");
    const driverSource = fs.readFileSync(driver, "utf8");
    expect(driverSource.indexOf('node_modules/typescript/bin/tsc", "--noEmit')).toBeLessThan(driverSource.indexOf('await import("../dist/review/private-storage.js")'));
    expect(driverSource).toContain("helperStartExpiresAt");
    expect(driverSource).toContain("evidenceExpiresAt");
    expect(driverSource.indexOf("validateManifest(manifest)")).toBeLessThan(driverSource.indexOf("-Verb RunAs"));
    expect(driverSource).toContain("-ValidateOnly");
  });

  it("runs the full native helper preflight without UAC, including a real >260-character artifact path", () => {
    const { dir, manifest, shortSource } = preflightFixture();
    const validated = runHelper(manifest, "-ValidateOnly");
    expect(validated.status, `${validated.stdout}${validated.stderr}`).toBe(0);
    expect(fs.existsSync(path.join(dir, "helper-result.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "cleanup-receipt.json"))).toBe(false);
    const shortProbe = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class G7Native {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string path, StringBuilder buffer, uint length);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetLongPathName(string path, StringBuilder buffer, uint length);
}
'@
[Console]::Out.Write((Short-Alias $env:G7_SHORT_SOURCE $env:G7_SHORT_ROOT | ConvertTo-Json -Compress))
`;
    const shortAlias = runHelperFunctions(["Fail", "Get-ChildRelative", "Is-Child", "Short-Alias"], shortProbe, { G7_SHORT_SOURCE: shortSource, G7_SHORT_ROOT: path.dirname(shortSource) });
    expect(shortAlias.status).toBe(0);
    const alias = JSON.parse(shortAlias.stdout);
    expect(alias.relative).toContain("~");
    expect(fs.realpathSync.native(alias.path)).toBe(fs.realpathSync.native(shortSource));
    const value = JSON.parse(fs.readFileSync(manifest, "utf8")); value.fingerprints["scripts/g7-windows-helper.ps1"] = "0".repeat(64);
    fs.writeFileSync(manifest, JSON.stringify(value));
    const rejected = runHelper(manifest, "-ValidateOnly");
    expect(rejected.status).not.toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "helper-failure.json"), "utf8"))).toMatchObject({ success: false, error: "G7_HELPER_FINGERPRINT_CHANGED" });
    value.mode = "cleanup";
    fs.writeFileSync(manifest, JSON.stringify(value));
    const cleanupRejected = runHelper(manifest, "-ValidateOnly");
    expect(cleanupRejected.status).not.toBe(0);
    expect(`${cleanupRejected.stdout}${cleanupRejected.stderr}`).toContain("G7_HELPER_VALIDATION_MODE");
  });

  it("uses CmdletBinding for invalid manifests and extra arguments without a StrictMode args failure", () => {
    const dir = path.join(root, ".tooling", `g7-native-${randomBytes(16).toString("hex")}`); fs.mkdirSync(dir, { recursive: true }); owned.push(dir);
    const manifest = path.join(dir, "manifest.json"); fs.writeFileSync(manifest, "{}");
    const invalid = runHelper(manifest);
    expect(invalid.status).not.toBe(0);
    expect(`${invalid.stdout}${invalid.stderr}`).toContain("G7_HELPER_MANIFEST_SCHEMA");
    expect(`${invalid.stdout}${invalid.stderr}`).not.toContain("VariableIsUndefined");
    const extra = runHelper(manifest, "unexpected");
    expect(extra.status).not.toBe(0);
    expect(`${extra.stdout}${extra.stderr}`).toContain("PositionalParameterNotFound");
  });

  it("accepts an omitted Assert-PlainDirectory parent and rejects an explicit outside parent", () => {
    const dir = fs.mkdtempSync(path.join(root, ".tooling", "g7-helper-directory-")); owned.push(dir);
    const probe = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class G7Native {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetFileAttributes(string path);
}
'@
$accepted = Assert-PlainDirectory $env:G7_DIR
try { Assert-PlainDirectory $env:G7_DIR $env:G7_OUTSIDE; $outside = 'accepted' } catch { $outside = $_.Exception.Message }
[Console]::Out.Write((@{ accepted = $accepted; outside = $outside } | ConvertTo-Json -Compress))
`;
    const result = runHelperFunctions(["Fail", "Native-Path", "Get-NativeFileAttributes", "Get-ChildRelative", "Is-Child", "Assert-PlainDirectory"], probe, { G7_DIR: dir, G7_OUTSIDE: `${dir}-outside` });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ accepted: dir, outside: "G7_HELPER_ROOT_ESCAPE" });
  });

  it("hashes a file held open for read/write sharing through the helper's PS5.1 stream contract", () => {
    const dir = fs.mkdtempSync(path.join(root, ".tooling", "g7-helper-hash-")); owned.push(dir);
    const file = path.join(dir, "audit.jsonl"); const content = "shared audit content\n"; fs.writeFileSync(file, content);
    const probe = String.raw`
$writer = [IO.File]::Open($env:G7_FILE, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
try { [Console]::Out.Write((Sha256 $env:G7_FILE)) } finally { $writer.Dispose() }
`;
    const result = runHelperFunctions(["Native-Path", "Sha256"], probe, { G7_FILE: file });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(createHash("sha256").update(content).digest("hex"));
  });

  it("rejects missing and extra properties through the helper's extracted exact-property contract", () => {
    const probe = String.raw`
$expected = @('nonce', 'accountName', 'accountSid', 'createdByHelper')
$valid = [pscustomobject]@{ nonce = 'n'; accountName = 'a'; accountSid = 's'; createdByHelper = $true }
$missing = [pscustomobject]@{ nonce = 'n'; accountName = 'a'; accountSid = 's' }
$extra = [pscustomobject]@{ nonce = 'n'; accountName = 'a'; accountSid = 's'; createdByHelper = $true; injected = $true }
[Console]::Out.Write((@{
  valid = [bool](Exact-Properties $valid $expected)
  missing = [bool](Exact-Properties $missing $expected)
  extra = [bool](Exact-Properties $extra $expected)
} | ConvertTo-Json -Compress))
`;
    const result = runHelperFunctions(["Exact-Properties"], probe);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ valid: true, missing: false, extra: false });
  });

  it("uses a PS5.1-safe uint32 access mask in the extracted helper reparse reader", () => {
    const probe = String.raw`
Add-Type -TypeDefinition @'
using System;
public static class G7Native {
  public static IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template) {
    if (access != 0x80000000) throw new Exception("wrong access mask");
    return new IntPtr(-1);
  }
  public static bool CloseHandle(IntPtr handle) { return true; }
}
'@
try { Reparse-Tag 'unused' } catch { [Console]::Out.Write($_.Exception.Message); exit 0 }
exit 9
`;
    const result = runHelperFunctions(["Fail", "Reparse-Tag"], probe);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^G7_HELPER_REPARSE_OPEN_\d+$/);
  });

  it("validates and hashes a real ADS through the helper's extracted pure contracts", () => {
    const dir = fs.mkdtempSync(path.join(root, ".tooling", "g7-helper-pure-"));
    owned.push(dir);
    const base = path.join(dir, "hardened-repo", "approved.txt");
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.writeFileSync(base, "approved");
    const ads = `${base}:g7-native-ads`;
    const streamData = `${"a".repeat(1025)}b`;
    const createStream = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Set-Content -LiteralPath $env:G7_BASE -Stream g7-native-ads -Value $env:G7_STREAM -NoNewline -Encoding ASCII"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, G7_BASE: base, G7_STREAM: streamData },
    });
    expect(createStream.status).toBe(0);
    const probe = String.raw`
$accepted = Assert-PlainAds $env:G7_ADS $env:G7_PATH_ROOT
$digest = Sha256-Ads $env:G7_ADS
try { Assert-PlainAds ($env:G7_BASE + ':other') $env:G7_PATH_ROOT; $wrongStream = 'accepted' }
catch { $wrongStream = $_.Exception.Message }
try { Assert-PlainAds ((Join-Path $env:G7_PATH_ROOT '..\\outside.txt') + ':g7-native-ads') $env:G7_PATH_ROOT; $escaped = 'accepted' }
catch { $escaped = $_.Exception.Message }
[Console]::Out.Write((@{ accepted = $accepted; digest = $digest; wrongStream = $wrongStream; escaped = $escaped } | ConvertTo-Json -Compress))
`;
    const result = runHelperFunctions(["Fail", "Native-Path", "Get-NativeFileAttributes", "Get-ChildRelative", "Is-Child", "Assert-PlainPath", "Assert-PlainAds", "Sha256-Ads"], probe, { G7_PATH_ROOT: dir, G7_BASE: base, G7_ADS: ads });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ accepted: ads, digest: createHash("sha256").update(streamData.slice(0, 1025)).digest("hex"), wrongStream: "G7_HELPER_ADS_STREAM", escaped: "G7_HELPER_ARTIFACT_ESCAPE" });
  });

  it("runs the independent evidence-reader module string with a PS5.1-safe uint32 access mask", () => {
    const source = fs.readFileSync(path.join(root, "tests", "g7-native-evidence-helper.ts"), "utf8");
    const match = source.match(/const program = String\.raw`([\s\S]*?)`;\s*\n\s*const result/);
    expect(match?.[1]).toBeTruthy();
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", match![1]], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, G7_REPARSE: path.join(root, ".tooling", "g7-missing-reparse") },
    });
    expect(result.status).toBe(2);
  });

  it("writes parseable no-BOM JSON through the extracted helper writer", () => {
    const dir = fs.mkdtempSync(path.join(root, ".tooling", "g7-helper-utf8-"));
    owned.push(dir);
    const json = path.join(dir, "result.json");
    const writer = runHelperFunctions(["Write-JsonEvidence"], "Write-JsonEvidence $env:G7_JSON ([ordered]@{ ok = $true })", { G7_JSON: json });
    expect(writer.status).toBe(0);
    const bytes = fs.readFileSync(json);
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual({ ok: true });
  });

  it("returns the actual reparse path and exact evidence properties from Create-LxFifo's AST return expression", () => {
    const outputPath = path.join(root, ".tooling", "g7-return-expression-path");
    const probe = String.raw`
$Path = $env:G7_REPARSE_PATH
$tag = [Convert]::ToUInt32('80000024', 16)
$item = [pscustomobject]@{ Attributes = [IO.FileAttributes]::ReparsePoint; LinkType = $null }
$value = & ([scriptblock]::Create($expression))
[Console]::Out.Write(($value | ConvertTo-Json -Compress))
`;
    const result = runHelperReturnExpression("Create-LxFifo", probe, { G7_REPARSE_PATH: outputPath });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ path: outputPath, tag: 0x80000024, attributes: 0x400, isSymbolicLink: false, isJunction: false });
  });

  it("bounds the fixture account name to 19 characters and rejects malformed nonces without account work", () => {
    const probe = String.raw`
$valid = Fixture-UserName ('a' * 32)
try { Fixture-UserName ('g' * 32); $invalidAlphabet = 'accepted' } catch { $invalidAlphabet = $_.Exception.Message }
try { Fixture-UserName ('a' * 31); $invalidLength = 'accepted' } catch { $invalidLength = $_.Exception.Message }
[Console]::Out.Write((@{ valid = $valid; length = $valid.Length; invalidAlphabet = $invalidAlphabet; invalidLength = $invalidLength } | ConvertTo-Json -Compress))
`;
    const result = runHelperFunctions(["Fail", "Fixture-UserName"], probe);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ valid: `g7n${"a".repeat(16)}`, length: 19, invalidAlphabet: "G7_HELPER_ACCOUNT_NONCE", invalidLength: "G7_HELPER_ACCOUNT_NONCE" });
  });

  it.each([
    ["stale nonce", (value: any) => { value.nonce = "f".repeat(32); }],
    ["different root", (value: any) => { value.root = path.join(root, ".tooling", "g7-native-" + "f".repeat(32)); }],
    ["wrong reparse tag", (value: any) => { value.helper.reparse.tag = 0xa000000c; }],
    ["false ACL success", (value: any) => { value.helper.acl.controls.everyoneReadWrite = false; }],
    ["missing cleanup", (value: any) => { value.helper.cleanup.userNotFound = false; }],
  ])("rejects %s evidence", (_name, mutate) => {
    const { nonce, evidence } = fixture(); mutate(evidence);
    expect(() => validateNativeEvidence(evidence, nonce)).toThrow(/^G7_NATIVE_EVIDENCE_/);
  });

  it("rejects the malformed empty-artifact/no-fingerprint evidence shape with a bounded validation error", () => {
    const { nonce, evidence } = fixture();
    const manifest = JSON.parse(fs.readFileSync(evidence.manifest, "utf8"));
    manifest.artifacts = {}; delete manifest.fingerprints;
    fs.writeFileSync(evidence.manifest, JSON.stringify(manifest));
    evidence.manifestSha256 = hash(evidence.manifest);
    expect(() => validateNativeEvidence(evidence, nonce)).toThrow(/^G7_NATIVE_EVIDENCE_(?:BINDING|FINGERPRINT|SCHEMA)$/);
  });

  it("rejects a plaintext otherReparse even when helper JSON claims the LX_FIFO tag", () => {
    const { nonce, evidence } = fixture();
    expect(() => validateNativeEvidence(evidence, nonce)).toThrow("G7_NATIVE_EVIDENCE_REPARSE_QUERY");
  });

  it("rejects a nonexistent cleanup receipt before trusting helper cleanup JSON", () => {
    const { nonce, evidence } = fixture();
    fs.unlinkSync(evidence.helper.cleanup.receipt);
    expect(() => validateNativeEvidence(evidence, nonce)).toThrow("G7_NATIVE_EVIDENCE_CLEANUP");
  });

  it("rejects the previously oversized cleanup account name without invoking account operations", () => {
    const { nonce, evidence } = fixture();
    const receipt = JSON.parse(fs.readFileSync(evidence.helper.cleanup.receipt, "utf8"));
    receipt.accountName = `g7n${nonce.slice(0, 20)}`;
    fs.writeFileSync(evidence.helper.cleanup.receipt, JSON.stringify(receipt));
    expect(() => validateNativeEvidence(evidence, nonce)).toThrow("G7_NATIVE_EVIDENCE_CLEANUP");
  });
});
