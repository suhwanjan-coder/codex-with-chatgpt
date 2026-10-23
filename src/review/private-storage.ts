import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import { constants } from "node:os";
import path from "node:path";

const WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
// Allow measured Windows contention headroom without retrying ambiguous CreateNew operations.
const POWERSHELL_TIMEOUT_MS = 10_000;
const POWERSHELL_MAX_BUFFER = 16 * 1024;

type PrivateStorageRunner = (input: string) => SpawnSyncReturns<string>;

export interface PrivateStorageDiagnostic {
  classification: "timeout" | "spawn-error" | "signal" | "non-zero-exit" | "bad-json" | "invalid-response" | "output-too-large" | "unavailable-code" | "exists-code";
  durationMs: number;
  status: number | null;
  signal: string | null;
  errorCode: string | null;
  stdoutBytes: number | null;
  stderrBytes: number | null;
}

class PrivateStorageError extends Error {
  constructor(code: string, readonly diagnostic?: Readonly<PrivateStorageDiagnostic>) { super(code); }
}

export interface PrivateAclEvaluation {
  daclTrusted: boolean;
  ownerTrusted: boolean;
  trusted: boolean;
}

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Emit([bool]$ok, [string]$code) { [Console]::Out.Write(([pscustomobject]@{ ok = $ok; code = $code } | ConvertTo-Json -Compress)) }
function Get-AllowedSids {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  if ($null -eq $identity -or $null -eq $identity.User) { throw 'NO_CURRENT_SID' }
  return @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544')
}
function Assert-SafeTarget([string]$candidate) {
  if ([string]::IsNullOrWhiteSpace($candidate) -or $candidate.StartsWith('\\') -or $candidate.StartsWith('//')) { throw 'UNSAFE_PATH' }
  $full = [System.IO.Path]::GetFullPath($candidate)
  if ($full -notmatch '^[A-Za-z]:\\') { throw 'UNSAFE_PATH' }
  $root = [System.IO.Path]::GetPathRoot($full)
  if ($root -notmatch '^[A-Za-z]:\\$') { throw 'UNSAFE_PATH' }
  $current = $root
  foreach ($part in $full.Substring($root.Length).Split([char]'\', [System.StringSplitOptions]::RemoveEmptyEntries)) {
    $current = [System.IO.Path]::Combine($current, $part)
    if ([System.IO.File]::Exists($current) -or [System.IO.Directory]::Exists($current)) {
      if (([System.IO.File]::GetAttributes($current) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'REPARSE_POINT' }
    }
  }
  return $full
}
function New-PrivateSecurity([bool]$directory) {
  $security = if ($directory) { New-Object System.Security.AccessControl.DirectorySecurity } else { New-Object System.Security.AccessControl.FileSecurity }
  $security.SetAccessRuleProtection($true, $false)
  $inheritance = if ($directory) { ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) } else { [System.Security.AccessControl.InheritanceFlags]::None }
  foreach ($sid in Get-AllowedSids) {
    $identity = New-Object System.Security.Principal.SecurityIdentifier($sid)
    $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)))
  }
  return $security
}
function Test-PrivateDacl([System.Security.AccessControl.ObjectSecurity]$security) {
  if (-not $security.AreAccessRulesProtected) { return $false }
  $allowed = @(Get-AllowedSids | Sort-Object -Unique)
  $seen = @{}
  foreach ($rule in $security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.IsInherited -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { return $false }
    $sid = $rule.IdentityReference.Value
    if ($allowed -notcontains $sid -or (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl)) { return $false }
    $seen[$sid] = $true
  }
  return (($seen.Keys | Sort-Object) -join ',') -eq ($allowed -join ',')
}
function Test-PrivateAcl([System.Security.AccessControl.ObjectSecurity]$security) {
  if (-not (Test-PrivateDacl $security)) { return $false }
  $owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])
  return $null -ne $owner -and ((Get-AllowedSids) -contains $owner.Value)
}
function Test-PrivateTarget([string]$target, [bool]$directory) {
  $security = if ($directory) { (New-Object System.IO.DirectoryInfo($target)).GetAccessControl() } else { (New-Object System.IO.FileInfo($target)).GetAccessControl() }
  return Test-PrivateAcl $security
}
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($null -eq $request -or @($request.PSObject.Properties.Name) -notcontains 'action') { throw 'INVALID_REQUEST' }
  if ($request.action -eq 'test-acl-sddl') {
    if (@($request.PSObject.Properties.Name) -notcontains 'sddl' -or [string]::IsNullOrEmpty([string]$request.sddl)) { throw 'INVALID_REQUEST' }
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetSecurityDescriptorSddlForm([string]$request.sddl)
    $owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])
    [Console]::Out.Write(([pscustomobject]@{
      ok = $true; code = 'OK'; daclTrusted = [bool](Test-PrivateDacl $security)
      ownerTrusted = [bool]($null -ne $owner -and ((Get-AllowedSids) -contains $owner.Value))
      trusted = [bool](Test-PrivateAcl $security)
    } | ConvertTo-Json -Compress))
    exit 0
  }
  if (@($request.PSObject.Properties.Name) -notcontains 'target') { throw 'INVALID_REQUEST' }
  $target = Assert-SafeTarget ([string]$request.target)
  if ($request.action -eq 'directory') {
    if ([System.IO.File]::Exists($target)) { Emit $false 'UNAVAILABLE'; exit 0 }
    if ([System.IO.Directory]::Exists($target)) { if (Test-PrivateTarget $target $true) { Emit $true 'OK' } else { Emit $false 'UNAVAILABLE' }; exit 0 }
    $parent = [System.IO.Path]::GetDirectoryName($target)
    if (-not [System.IO.Directory]::Exists($parent)) { throw 'PARENT_MISSING' }
    (New-Object System.IO.DirectoryInfo($target)).Create((New-PrivateSecurity $true))
    if (Test-PrivateTarget $target $true) { Emit $true 'OK' } else { Emit $false 'UNAVAILABLE' }
    exit 0
  }
  if ($request.action -eq 'file') {
    if ($request.PSObject.Properties.Name -notcontains 'text' -or [System.IO.File]::Exists($target) -or [System.IO.Directory]::Exists($target)) { Emit $false 'EXISTS'; exit 0 }
    $parent = [System.IO.Path]::GetDirectoryName($target)
    if (-not [System.IO.Directory]::Exists($parent)) { throw 'PARENT_MISSING' }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$request.text)
    $stream = New-Object System.IO.FileStream($target, [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::WriteData, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::WriteThrough, (New-PrivateSecurity $false))
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    if (Test-PrivateTarget $target $false) { Emit $true 'OK' } else { Emit $false 'UNAVAILABLE' }
    exit 0
  }
  if ($request.action -eq 'verify-file') {
    if (-not [System.IO.File]::Exists($target)) { Emit $false 'UNAVAILABLE'; exit 0 }
    if (Test-PrivateTarget $target $false) { Emit $true 'OK' } else { Emit $false 'UNAVAILABLE' }
    exit 0
  }
  throw 'INVALID_ACTION'
} catch { Emit $false 'UNAVAILABLE'; exit 1 }`;

function storageError(code: string, diagnostic?: PrivateStorageDiagnostic): Error {
  return new PrivateStorageError(code, diagnostic && Object.freeze(diagnostic));
}

/** Carry only our sanitized metadata across error boundaries, never a raw process/fs error. */
export function privateStorageFailure(code: string, error: unknown): Error {
  return storageError(code, error instanceof PrivateStorageError ? error.diagnostic : undefined);
}

/** A bounded diagnostic line for local CLI/runner errors; never include raw causes or output. */
export function privateStorageDiagnosticLine(error: unknown): string {
  const diagnostic = error instanceof PrivateStorageError ? error.diagnostic : undefined;
  return diagnostic ? `C2C_PRIVATE_STORAGE_DIAGNOSTIC ${JSON.stringify(diagnostic)}\n` : "";
}

function processDiagnostic(start: number, response?: SpawnSyncReturns<string>, error: unknown = response?.error): PrivateStorageDiagnostic {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const errorCode = typeof code === "string" && Object.hasOwn(constants.errno, code) ? code : error ? "UNKNOWN" : null;
  const signal = response?.signal;
  const bytes = (value: unknown): number | null => typeof value === "string" ? Buffer.byteLength(value, "utf8") : Buffer.isBuffer(value) ? value.length : null;
  return {
    classification: errorCode === "ETIMEDOUT" ? "timeout" : error ? "spawn-error" : signal ? "signal" : "non-zero-exit",
    durationMs: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(performance.now() - start))),
    status: Number.isSafeInteger(response?.status) ? response!.status : null,
    signal: typeof signal === "string" ? Object.hasOwn(constants.signals, signal) ? signal : "UNKNOWN" : null,
    errorCode, stdoutBytes: bytes(response?.stdout), stderrBytes: bytes(response?.stderr),
  };
}

function normalizeTarget(target: string): string {
  if (typeof target !== "string" || target.length === 0 || target.length > 30_000) throw storageError("PRIVATE_STORAGE_UNAVAILABLE");
  if (process.platform === "win32" && /^(?:\\\\|\/\/)/.test(target)) throw storageError("PRIVATE_STORAGE_UNAVAILABLE");
  const resolved = path.resolve(target);
  if (process.platform === "win32" && !/^[A-Za-z]:\\/.test(resolved)) throw storageError("PRIVATE_STORAGE_UNAVAILABLE");
  return resolved;
}

function assertNoLinkedAncestor(target: string, includeTarget: boolean): void {
  let current = includeTarget ? target : path.dirname(target);
  while (path.dirname(current) !== current) {
    try {
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw storageError("PRIVATE_STORAGE_UNAVAILABLE");
    } catch (error) {
      if (error instanceof Error && error.message === "PRIVATE_STORAGE_UNAVAILABLE") throw error;
      throw storageError("PRIVATE_STORAGE_UNAVAILABLE");
    }
    current = path.dirname(current);
  }
}

function runPowerShell(input: string): SpawnSyncReturns<string> {
  return spawnSync(WINDOWS_POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SCRIPT], {
    input, encoding: "utf8", timeout: POWERSHELL_TIMEOUT_MS, maxBuffer: POWERSHELL_MAX_BUFFER, windowsHide: true,
  });
}

function windowsResponse(request: Record<string, string>, runner: PrivateStorageRunner): { parsed: unknown; diagnostic: PrivateStorageDiagnostic } {
  const start = performance.now();
  let response: SpawnSyncReturns<string>;
  try { response = runner(JSON.stringify(request)); }
  catch (error) {
    const diagnostic = processDiagnostic(start, undefined, error);
    throw storageError("PRIVATE_STORAGE_UNAVAILABLE", { ...diagnostic, classification: diagnostic.errorCode === "ETIMEDOUT" ? "timeout" : "spawn-error" });
  }
  const diagnostic = processDiagnostic(start, response);
  if (response.error || response.signal || response.status !== 0) throw storageError("PRIVATE_STORAGE_UNAVAILABLE", diagnostic);
  if (typeof response.stdout !== "string") throw storageError("PRIVATE_STORAGE_UNAVAILABLE", { ...diagnostic, classification: "invalid-response" });
  if (response.stdout.length > POWERSHELL_MAX_BUFFER) throw storageError("PRIVATE_STORAGE_UNAVAILABLE", { ...diagnostic, classification: "output-too-large" });
  let parsed: unknown;
  try { parsed = JSON.parse(response.stdout.trim()); }
  catch { throw storageError("PRIVATE_STORAGE_UNAVAILABLE", { ...diagnostic, classification: "bad-json" }); }
  return { parsed, diagnostic };
}

function runWindowsRequest(request: Record<string, string>, runner: PrivateStorageRunner): void {
  const { parsed, diagnostic } = windowsResponse(request, runner);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 2 ||
      (parsed as { ok?: unknown }).ok !== true || (parsed as { code?: unknown }).code !== "OK") {
    if ((parsed as { code?: unknown } | null)?.code === "EXISTS") throw storageError("PRIVATE_STORAGE_EXISTS", { ...diagnostic, classification: "exists-code" });
    throw storageError("PRIVATE_STORAGE_UNAVAILABLE", { ...diagnostic,
      classification: (parsed as { code?: unknown } | null)?.code === "UNAVAILABLE" ? "unavailable-code" : "invalid-response" });
  }
}

/** Test-only, no-mutation evaluation of the exact Windows reuse predicate against an in-memory SDDL descriptor. */
export function evaluatePrivateAclSddlForTests(sddl: string, runner: PrivateStorageRunner = runPowerShell): PrivateAclEvaluation {
  if (process.platform !== "win32" || typeof sddl !== "string" || sddl.length === 0 || sddl.length > 16 * 1024) throw storageError("PRIVATE_STORAGE_UNAVAILABLE");
  const { parsed, diagnostic } = windowsResponse({ action: "test-acl-sddl", sddl }, runner);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 5 ||
      (parsed as { ok?: unknown }).ok !== true || (parsed as { code?: unknown }).code !== "OK" ||
      typeof (parsed as { daclTrusted?: unknown }).daclTrusted !== "boolean" ||
      typeof (parsed as { ownerTrusted?: unknown }).ownerTrusted !== "boolean" ||
      typeof (parsed as { trusted?: unknown }).trusted !== "boolean") throw storageError("PRIVATE_STORAGE_UNAVAILABLE", { ...diagnostic, classification: "invalid-response" });
  const evaluation = parsed as PrivateAclEvaluation & { ok: true; code: "OK" };
  return {
    daclTrusted: evaluation.daclTrusted,
    ownerTrusted: evaluation.ownerTrusted,
    trusted: evaluation.trusted,
  };
}

/** Creates a new private directory or verifies an existing private directory without altering it. */
export function ensurePrivateDirectory(target: string, runner: PrivateStorageRunner = runPowerShell): string {
  const resolved = normalizeTarget(target);
  assertNoLinkedAncestor(resolved, true);
  if (process.platform !== "win32") {
    try { fs.mkdirSync(resolved, { recursive: false, mode: 0o700 }); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST")) throw storageError("PRIVATE_STORAGE_UNAVAILABLE");
    }
    assertNoLinkedAncestor(resolved, true);
    try { if (!fs.lstatSync(resolved).isDirectory()) throw storageError("PRIVATE_STORAGE_UNAVAILABLE"); fs.chmodSync(resolved, 0o700); }
    catch { throw storageError("PRIVATE_STORAGE_UNAVAILABLE"); }
    return resolved;
  }
  runWindowsRequest({ action: "directory", target: resolved }, runner);
  return resolved;
}

/** Creates and writes a new private file. Existing files are never overwritten. */
export function writePrivateNewFile(target: string, text: string, runner: PrivateStorageRunner = runPowerShell): void {
  const resolved = normalizeTarget(target);
  if (typeof text !== "string") throw storageError("PRIVATE_STORAGE_UNAVAILABLE");
  assertNoLinkedAncestor(resolved, false);
  if (process.platform !== "win32") {
    let fd: number | undefined;
    try { fd = fs.openSync(resolved, "wx", 0o600); fs.writeFileSync(fd, text, "utf8"); fs.fsyncSync(fd); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST") throw storageError("PRIVATE_STORAGE_EXISTS");
      throw storageError("PRIVATE_STORAGE_UNAVAILABLE");
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    return;
  }
  runWindowsRequest({ action: "file", target: resolved, text }, runner);
}

/** Verifies an existing private file before the review bridge reuses it. */
export function verifyPrivateFile(target: string, runner: PrivateStorageRunner = runPowerShell): void {
  const resolved = normalizeTarget(target);
  assertNoLinkedAncestor(resolved, true);
  if (process.platform !== "win32") {
    try { const stat = fs.lstatSync(resolved); if (!stat.isFile() || stat.isSymbolicLink()) throw storageError("PRIVATE_STORAGE_UNAVAILABLE"); }
    catch { throw storageError("PRIVATE_STORAGE_UNAVAILABLE"); }
    return;
  }
  runWindowsRequest({ action: "verify-file", target: resolved }, runner);
}
