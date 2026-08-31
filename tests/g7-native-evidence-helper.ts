import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const G7_NATIVE_IDS = [
  "NATIVE_ADS", "ANCESTOR_JUNCTION", "FILE_SYMLINK", "LONG_PATH", "SHORT_ALIAS", "OTHER_REPARSE", "ACL_ISOLATION",
] as const;

type G7NativeId = (typeof G7_NATIVE_IDS)[number];
const FINGERPRINT_FILES = ["scripts/verify-g7-windows.mjs", "scripts/g7-windows-helper.ps1", "src/review/private-storage.ts", "src/review/session.ts", "src/review/snapshot.ts", "src/auth/store.ts", "dist/review/private-storage.js", "dist/review/session.js", "dist/review/snapshot.js", "dist/auth/store.js"] as const;
const MANIFEST_ARTIFACTS = ["snapshot", "auth", "state", "audit", "lock", "outside", "ads", "longPath", "shortSource"] as const;
const EVIDENCE_ARTIFACTS = ["snapshot", "auth", "state", "audit", "lock", "fileSymlink", "legacySymlink", "otherReparse"] as const;

export interface NativeEvidence {
  schemaVersion: 1;
  nonce: string;
  root: string;
  evidenceExpiresAt: number;
  manifest: string;
  manifestSha256: string;
  helperResult: string;
  artifacts: Record<string, { path: string; sha256?: string }>;
  snapshotRejections: Record<string, string>;
  helper: {
    success: true;
    nonce: string;
    reparse: { path: string; tag: number; attributes: number; isSymbolicLink: boolean; isJunction: boolean };
    acl: { controls: { usersReadWrite: true; everyoneReadWrite: true }; denied: Record<string, "ERROR_ACCESS_DENIED" | "UnauthorizedAccess">; owner: { read: true; write: true }; token: { users: true; everyone: true } };
    cleanup: { userNotFound: true; accountSid: string; receipt: string };
  };
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function fail(code: string): never { throw new Error(`G7_NATIVE_EVIDENCE_${code}`); }
function exactKeys(value: unknown, expected: readonly string[]): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}
function queryReparseTag(file: string): { tag: number; attributes: number } {
  const program = String.raw`Add-Type @'
using System; using System.Runtime.InteropServices;
public static class G7EvidenceNative { [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateFile(string n,uint a,uint s,IntPtr x,uint c,uint f,IntPtr t); [DllImport("kernel32.dll",SetLastError=true)] public static extern bool DeviceIoControl(IntPtr h,uint c,byte[] i,int il,byte[] o,int ol,out int r,IntPtr p); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h); }
'@; $h=[G7EvidenceNative]::CreateFile($env:G7_REPARSE,[Convert]::ToUInt32('80000000',16),3,[IntPtr]::Zero,3,0x00200000,[IntPtr]::Zero); if($h -eq [IntPtr](-1)){exit 2}; try{$o=New-Object byte[] 16384;[int]$r=0;if(-not [G7EvidenceNative]::DeviceIoControl($h,0x000900A8,$null,0,$o,$o.Length,[ref]$r,[IntPtr]::Zero)-or $r -lt 8){exit 3};$a=[int](Get-Item -LiteralPath $env:G7_REPARSE -Force).Attributes;[Console]::Out.Write((@{tag=[BitConverter]::ToUInt32($o,0);attributes=$a}|ConvertTo-Json -Compress))}finally{[void][G7EvidenceNative]::CloseHandle($h)}`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", program], { encoding: "utf8", windowsHide: true, timeout: 10_000, env: { ...process.env, G7_REPARSE: file } });
  if (result.status !== 0) fail("REPARSE_QUERY");
  try {
    const data = JSON.parse(String(result.stdout));
    if (!data || typeof data.tag !== "number" || typeof data.attributes !== "number") fail("REPARSE_QUERY");
    return data;
  } catch { fail("REPARSE_QUERY"); }
}

/**
 * Validates only a freshly-created driver-owned fixture.  It deliberately does
 * not accept a caller-selected report path or a historical helper result.
 */
export function validateNativeEvidence(input: unknown, expectedNonce: string): NativeEvidence {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("SCHEMA");
  const value = input as Partial<NativeEvidence>;
  if (value.schemaVersion !== 1 || typeof value.nonce !== "string" || value.nonce !== expectedNonce || !/^[a-f0-9]{32}$/.test(expectedNonce)) fail("NONCE");
  if (typeof value.root !== "string" || typeof value.evidenceExpiresAt !== "number" || !Number.isSafeInteger(value.evidenceExpiresAt) || value.evidenceExpiresAt <= Date.now() || typeof value.manifest !== "string" || typeof value.helperResult !== "string" || typeof value.manifestSha256 !== "string") fail("SCHEMA");
  const root = path.resolve(value.root);
  if (root !== value.root || path.basename(root) !== `g7-native-${expectedNonce}` || path.basename(path.dirname(root)) !== ".tooling") fail("ROOT");
  const actualRoot = fs.realpathSync.native(root);
  if (actualRoot !== root || fs.lstatSync(root).isSymbolicLink()) fail("ROOT");
  const manifest = path.resolve(value.manifest);
  const helperResult = path.resolve(value.helperResult);
  if (!isInside(root, manifest) || !isInside(root, helperResult) || sha256(manifest) !== value.manifestSha256) fail("BINDING");
  const manifestValue = JSON.parse(fs.readFileSync(manifest, "utf8")) as Record<string, unknown>;
  if (!exactKeys(manifestValue, ["schemaVersion", "nonce", "root", "mode", "helperStartExpiresAt", "evidenceExpiresAt", "fingerprints", "artifacts"]) || manifestValue.nonce !== expectedNonce || manifestValue.root !== root || manifestValue.evidenceExpiresAt !== value.evidenceExpiresAt || !exactKeys(manifestValue.artifacts, MANIFEST_ARTIFACTS) || !exactKeys(manifestValue.fingerprints, FINGERPRINT_FILES)) fail("BINDING");
  const repoRoot = path.dirname(path.dirname(root));
  for (const relative of FINGERPRINT_FILES) {
    const digest = (manifestValue.fingerprints as Record<string, unknown>)[relative];
    const file = path.join(repoRoot, ...relative.split("/"));
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest) || !fs.existsSync(file) || sha256(file) !== digest) fail("FINGERPRINT");
  }
  if (!exactKeys(value.artifacts, EVIDENCE_ARTIFACTS) || !value.snapshotRejections || typeof value.snapshotRejections !== "object") fail("SCHEMA");
  for (const name of EVIDENCE_ARTIFACTS) {
    const artifact = value.artifacts[name];
    if (!artifact || typeof artifact.path !== "string") fail("ARTIFACT");
    const artifactPath = path.resolve(artifact.path);
    // Node stat returns EACCES for LX_FIFO. Its existence and tag are verified below
    // through an independent OPEN_REPARSE_POINT handle, without following the target.
    if (!isInside(root, artifactPath) || (name !== "otherReparse" && (!fs.existsSync(artifactPath) || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "") || sha256(artifactPath) !== artifact.sha256))) fail("ARTIFACT");
  }
  for (const name of ["snapshot", "auth", "state", "audit", "lock"] as const) {
    const manifestArtifact = (manifestValue.artifacts as Record<string, { path?: unknown; sha256?: unknown }>)[name];
    const evidenceArtifact = value.artifacts[name];
    if (!manifestArtifact || manifestArtifact.path !== evidenceArtifact.path || manifestArtifact.sha256 !== evidenceArtifact.sha256) fail("ARTIFACT_BINDING");
  }
  for (const name of ["fileSymlink", "legacySymlink", "otherReparse"] as const) {
    if (typeof value.snapshotRejections[name] !== "string" || !/^SNAPSHOT_[A-Z_]+$/.test(value.snapshotRejections[name])) fail("REJECTION");
  }
  const helper = value.helper;
  if (!helper || helper.success !== true || helper.nonce !== expectedNonce) fail("HELPER");
  let helperFile: unknown;
  try { helperFile = JSON.parse(fs.readFileSync(helperResult, "utf8")); } catch { fail("HELPER_RESULT"); }
  if (JSON.stringify(helperFile) !== JSON.stringify(helper)) fail("HELPER_BINDING");
  const acl = helper.acl;
  if (!acl || acl.controls?.usersReadWrite !== true || acl.controls?.everyoneReadWrite !== true || acl.owner?.read !== true || acl.owner?.write !== true || acl.token?.users !== true || acl.token?.everyone !== true) fail("ACL");
  for (const name of ["snapshot", "auth", "state", "audit", "lock"] as const) {
    if (acl.denied?.[name] !== "ERROR_ACCESS_DENIED" && acl.denied?.[name] !== "UnauthorizedAccess") fail("ACL");
  }
  if (!helper.cleanup || helper.cleanup.userNotFound !== true || !/^S-1-5-21-/.test(helper.cleanup.accountSid) || typeof helper.cleanup.receipt !== "string" || !isInside(root, path.resolve(helper.cleanup.receipt)) || !fs.existsSync(helper.cleanup.receipt)) fail("CLEANUP");
  try {
    const receipt = JSON.parse(fs.readFileSync(helper.cleanup.receipt, "utf8"));
    if (!exactKeys(receipt, ["nonce", "accountName", "accountSid", "createdByHelper"]) || receipt.nonce !== expectedNonce || receipt.accountName !== `g7n${expectedNonce.slice(0, 16)}` || receipt.accountSid !== helper.cleanup.accountSid || receipt.createdByHelper !== true) fail("CLEANUP");
  } catch (error) { if (error instanceof Error && error.message.startsWith("G7_NATIVE_EVIDENCE_")) throw error; fail("CLEANUP"); }
  const actualReparse = queryReparseTag(value.artifacts.otherReparse.path);
  if (helper.reparse.path !== value.artifacts.otherReparse.path || helper.reparse.tag !== actualReparse.tag || actualReparse.tag !== 0x80000024 || (actualReparse.attributes & 0x400) === 0 || helper.reparse.isSymbolicLink || helper.reparse.isJunction) fail("REPARSE");
  return value as NativeEvidence;
}
