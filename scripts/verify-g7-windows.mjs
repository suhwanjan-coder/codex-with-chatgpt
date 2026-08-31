import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundledNode = "C:\\Users\\suhwa\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\bin\\node.exe";
const helper = path.join(root, "scripts", "g7-windows-helper.ps1");
const nonce = () => randomBytes(16).toString("hex");
const hashFile = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const writeNew = (file, value) => fs.writeFileSync(file, value, { encoding: "utf8", flag: "wx" });
const fingerprintFiles = Object.freeze([
  "scripts/verify-g7-windows.mjs", "scripts/g7-windows-helper.ps1",
  "src/review/private-storage.ts", "src/review/session.ts", "src/review/snapshot.ts", "src/auth/store.ts",
  "dist/review/private-storage.js", "dist/review/session.js", "dist/review/snapshot.js", "dist/auth/store.js",
]);

function fail(code) { throw new Error(`G7_WINDOWS_${code}`); }
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function assertPlainDirectory(directory, parent) {
  const resolved = path.resolve(directory);
  if (parent && !inside(parent, resolved)) fail("FIXTURE_ESCAPE");
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(resolved) !== resolved) fail("FIXTURE_REPARSE");
  return resolved;
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true, shell: false, timeout: 180_000, ...options });
  if (result.status !== 0 || result.error) fail(`COMMAND_${path.basename(command)}_${result.error?.code ?? result.status ?? "unknown"}`);
  return result;
}
function validateManifest(manifest) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-ManifestPath", manifest, "-ValidateOnly"], { cwd: root, encoding: "utf8", windowsHide: true, shell: false, timeout: 180_000 });
  if (result.status !== 0 || result.error) {
    process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
    fail(`PREFLIGHT_${result.error?.code ?? result.status ?? "unknown"}`);
  }
}
function runtimeFingerprint() {
  return Object.fromEntries(fingerprintFiles.map((relative) => {
    const file = path.join(root, ...relative.split("/"));
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) fail(`FINGERPRINT_MISSING_${relative.replace(/[^a-z]/gi, "_")}`);
    return [relative, hashFile(file)];
  }));
}
function git(repo, ...args) {
  run("git", args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "g7-fixture", GIT_AUTHOR_EMAIL: "g7-fixture@invalid", GIT_COMMITTER_NAME: "g7-fixture", GIT_COMMITTER_EMAIL: "g7-fixture@invalid", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } });
}
function makeRepo(repo, label) {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  writeNew(path.join(repo, "approved.txt"), `${label} synthetic approved content\n`);
  git(repo, "add", "."); git(repo, "commit", "-m", "synthetic fixture");
  fs.appendFileSync(path.join(repo, "approved.txt"), "working copy synthetic change\n", "utf8");
}
function rejection(createSnapshot, repo, relative) {
  try { createSnapshot(repo, { taskId: "g7-native-reject", paths: [relative], dataClass: "synthetic" }); }
  catch (error) { if (/^SNAPSHOT_[A-Z_]+$/.test(error?.message ?? "")) return error.message; }
  fail("SNAPSHOT_NOT_REJECTED");
}
function longFixture(repo) {
  const parts = [];
  let relative = "safe.txt";
  while (path.join(repo, ...relative.split("/")).length <= 260) {
    parts.push(`native-long-${String(parts.length).padStart(2, "0")}-${"x".repeat(40)}`);
    if (parts.length > 32) fail("LONG_PATH_BOUND");
    relative = [...parts, "safe.txt"].join("/");
  }
  const absolute = path.join(repo, ...relative.split("/"));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  writeNew(absolute, "synthetic long path content\n");
  return { relative, absolute };
}
function longPathOutcome(createSnapshot, repo, relative) {
  try {
    const snapshot = createSnapshot(repo, { taskId: "g7-native-long", paths: [relative], dataClass: "synthetic" });
    if (snapshot.files[0]?.after !== "synthetic long path content\n") fail("LONG_PATH_CAPTURE");
    return "captured";
  } catch (error) { if (/^SNAPSHOT_[A-Z_]+$/.test(error?.message ?? "")) return error.message; throw error; }
}
function removeOwned(rootDir) {
  const tooling = assertPlainDirectory(path.join(root, ".tooling"));
  const resolved = path.resolve(rootDir);
  if (!inside(tooling, resolved) || !/^g7-native-[a-f0-9]{32}$/.test(path.basename(resolved))) fail("CLEANUP_SCOPE");
  fs.rmSync(resolved, { recursive: true, force: false, maxRetries: 2 });
  if (fs.existsSync(resolved)) fail("CLEANUP_INCOMPLETE");
}

export function noArgsResult(argv = process.argv) {
  return argv.length === 2 ? { ok: false, message: "Explicit external approval is required for --authorize-elevated-fixtures. No changes were made." } : null;
}

export async function main(argv = process.argv) {
  if (process.platform !== "win32") fail("WINDOWS_REQUIRED");
  if (argv.length !== 3 || argv[2] !== "--authorize-elevated-fixtures") {
    const result = noArgsResult(argv);
    if (result) { process.stderr.write(`${result.message}\n`); process.exitCode = 2; return; }
    fail("ARGUMENTS");
  }
  if (!fs.existsSync(bundledNode) || !fs.existsSync(helper)) fail("RUNTIME_OR_HELPER_MISSING");
  // Fresh production artifacts are mandatory before any review/session/AuthStore import.
  run(bundledNode, ["node_modules/typescript/bin/tsc", "--noEmit"]);
  run(bundledNode, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]);
  const fingerprints = runtimeFingerprint();
  const { ensurePrivateDirectory, writePrivateNewFile } = await import("../dist/review/private-storage.js");
  const { createSnapshot, snapshotDigest } = await import("../dist/review/snapshot.js");
  const { ReviewSession } = await import("../dist/review/session.js");
  const { AuthStore } = await import("../dist/auth/store.js");
  if (typeof ensurePrivateDirectory !== "function" || typeof writePrivateNewFile !== "function") fail("PRIVATE_STORAGE_EXPORTS");
  const tooling = assertPlainDirectory(path.join(root, ".tooling"));
  const valueNonce = nonce();
  const fixture = path.join(tooling, `g7-native-${valueNonce}`);
  let session;
  let success = false;
  let helperConfirmedComplete = false;
  try {
    // This is intentionally the first fixture operation: no manifest or artifact precedes private-root creation.
    ensurePrivateDirectory(fixture);
    assertPlainDirectory(fixture, tooling);
    const hardened = path.join(fixture, "hardened-repo");
    const legacy = path.join(fixture, "legacy-repo");
    const outside = path.join(fixture, "outside");
    const privateState = path.join(fixture, "private-state");
    for (const directory of [hardened, legacy, outside]) fs.mkdirSync(directory, { recursive: true });
    assertPlainDirectory(hardened, fixture); assertPlainDirectory(legacy, fixture); assertPlainDirectory(outside, fixture);
    makeRepo(hardened, "hardened"); makeRepo(legacy, "legacy");
    writeNew(path.join(outside, "outside.txt"), "outside synthetic target\n");
    const adsPath = `${path.join(hardened, "approved.txt")}:g7-native-ads`;
    writeNew(adsPath, "synthetic ADS content\n");
    if (fs.readFileSync(adsPath, "utf8") !== "synthetic ADS content\n") fail("ADS_READBACK");
    const longPath = longFixture(hardened);
    const shortSource = path.join(hardened, `native-short-alias-${"x".repeat(56)}.txt`);
    writeNew(shortSource, "synthetic short alias content\n");
    const snapshot = createSnapshot(hardened, { taskId: `g7-native-${valueNonce}`, paths: ["approved.txt"], dataClass: "synthetic", ttlMs: 300_000 });
    const snapshotFile = path.join(fixture, "private-snapshot.json");
    writePrivateNewFile(snapshotFile, JSON.stringify(snapshot));
    session = new ReviewSession(snapshot, { approvalDigest: snapshotDigest(snapshot), stateDir: privateState, idleMs: 300_000 });
    if (typeof session.privateStateDir !== "string" || typeof session.authStoreFile !== "string") fail("SESSION_PRIVATE_PATHS");
    const authStore = new AuthStore(`g7-native-${valueNonce}`, { file: session.authStoreFile });
    const client = authStore.registerClient({ clientName: "synthetic-g7", redirectUris: ["http://127.0.0.1/g7"] });
    authStore.issueTokens({ clientId: client.clientId, scopes: ["workspace.read"] });
    const stateFile = path.join(session.privateStateDir, "state-private.txt");
    writePrivateNewFile(stateFile, "synthetic state\n");
    const manifest = path.join(fixture, "manifest.json");
    const helperStartExpiresAt = Date.now() + 120_000;
    const evidenceExpiresAt = Date.now() + 15 * 60_000;
    const artifactEntries = { snapshot: snapshotFile, auth: session.authStoreFile, state: stateFile, audit: session.auditFile, lock: session.lockFile, outside: path.join(outside, "outside.txt"), ads: adsPath, longPath: longPath.absolute, shortSource };
    const artifacts = Object.fromEntries(Object.entries(artifactEntries).map(([name, file]) => [name, { path: file, sha256: hashFile(file) }]));
    writeNew(manifest, JSON.stringify({
      schemaVersion: 1, nonce: valueNonce, root: fixture, mode: "run",
      // UAC must start promptly; this deadline is never consulted by the later test suite.
      helperStartExpiresAt,
      // The unprivileged full suite consumes fresh evidence independently of the UAC window.
      evidenceExpiresAt,
      fingerprints, artifacts,
    }, null, 2) + "\n");
    validateManifest(manifest);
    process.stdout.write("G7 normal-user preflight passed; requesting native UAC helper.\n");
    const elevated = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$a=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File', ('\"{0}\"' -f $env:G7_HELPER_SCRIPT), '-ManifestPath', ('\"{0}\"' -f $env:G7_HELPER_MANIFEST));$p=Start-Process -FilePath powershell.exe -ArgumentList $a -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode"], { cwd: root, encoding: "utf8", windowsHide: true, shell: false, timeout: 300_000, env: { ...process.env, G7_HELPER_SCRIPT: helper, G7_HELPER_MANIFEST: manifest } });
    if (elevated.status !== 0 || elevated.error) {
      const failureFile = path.join(fixture, "helper-failure.json");
      if (fs.existsSync(failureFile)) process.stderr.write(`${fs.readFileSync(failureFile, "utf8")}\n`);
      fail(`HELPER_UNCERTAIN_${elevated.error?.code ?? elevated.status ?? "unknown"}`);
    }
    const helperResult = path.join(fixture, "helper-result.json");
    const helperData = JSON.parse(fs.readFileSync(helperResult, "utf8"));
    if (helperData?.success !== true || helperData?.cleanup?.userNotFound !== true) fail("HELPER_CLEANUP_PROOF");
    for (const name of ["snapshot", "auth", "state", "audit", "lock"]) {
      if (hashFile(artifactEntries[name]) !== artifacts[name].sha256) fail(`ARTIFACT_HASH_CHANGED_${name.toUpperCase()}`);
    }
    helperConfirmedComplete = true;
    const fileSymlink = path.join(hardened, "outside-file-link.txt");
    const legacySymlink = path.join(legacy, "outside-file-link.txt");
    const otherReparse = path.join(hardened, "other-reparse");
    const evidence = {
      schemaVersion: 1, nonce: valueNonce, root: fixture, evidenceExpiresAt, manifest, manifestSha256: hashFile(manifest), helperResult,
      artifacts: { snapshot: artifacts.snapshot, auth: artifacts.auth, state: artifacts.state, audit: artifacts.audit, lock: artifacts.lock, fileSymlink: { path: fileSymlink, sha256: artifacts.outside.sha256 }, legacySymlink: { path: legacySymlink, sha256: artifacts.outside.sha256 }, otherReparse: { path: otherReparse } },
      native: { adsPath, adsSha256: hashFile(adsPath), longPath, longPathOutcome: longPathOutcome(createSnapshot, hardened, longPath.relative), shortSource, shortAlias: helperData.shortAlias, junction: helperData.junction },
      snapshotRejections: { ads: rejection(createSnapshot, hardened, "approved.txt:g7-native-ads"), ancestorJunction: rejection(createSnapshot, hardened, "nested/redirect/outside.txt"), fileSymlink: rejection(createSnapshot, hardened, "outside-file-link.txt"), legacySymlink: rejection(createSnapshot, legacy, "outside-file-link.txt"), shortAlias: rejection(createSnapshot, hardened, helperData.shortAlias.relative), otherReparse: rejection(createSnapshot, hardened, "other-reparse") }, helper: helperData,
    };
    const evidenceFile = path.join(fixture, "native-evidence.json"); writeNew(evidenceFile, JSON.stringify(evidence, null, 2) + "\n");
    const verify = spawnSync(bundledNode, [path.join(root, "scripts", "verify-g7.mjs")], { cwd: root, encoding: "utf8", windowsHide: true, shell: false, timeout: 600_000, env: { ...process.env, C2C_G7_NATIVE_EVIDENCE: evidenceFile, C2C_G7_NATIVE_NONCE: valueNonce } });
    process.stdout.write(verify.stdout ?? ""); process.stderr.write(verify.stderr ?? "");
    if (verify.status !== 0 || verify.error) fail(`VERIFY_${verify.error?.code ?? verify.status ?? "unknown"}`);
    if (JSON.stringify(runtimeFingerprint()) !== JSON.stringify(fingerprints)) fail("RUNTIME_FINGERPRINT_CHANGED");
    success = true;
  } finally {
    if (helperConfirmedComplete) {
      try { session?.close("completed"); } catch { success = false; }
      try { if (fs.existsSync(fixture)) removeOwned(fixture); } catch (error) { success = false; process.stderr.write(`G7 cleanup failed: ${error?.message ?? error}\n`); }
    } else if (fs.existsSync(fixture)) {
      success = false;
      process.stderr.write(`G7 fixture preserved for narrow owned cleanup: ${fixture}\n`);
    }
  }
  if (!success) fail("CLEANUP_OR_VERIFICATION");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { process.stderr.write(`${error?.message ?? error}\n`); process.exitCode = 1; });
