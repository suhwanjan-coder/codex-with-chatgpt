import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PREFLIGHT_SCOPE = "environment preflight only, not G7 acceptance";
export const PREFLIGHT_ACCEPTANCE = "NOT_EVALUATED";
export const REMAINING_ACCEPTANCE = ["OTHER_REPARSE", "ACL_ISOLATION"];

function check(id, status, detail) {
  return { id, status, detail };
}

export function evaluatePreflight({ nodeMajor, platform, git, symlink, cleanup }) {
  const checks = [
    check("NODE_20", nodeMajor >= 20 ? "PASS" : "UNAVAILABLE", `major=${nodeMajor}`),
    check("WINDOWS", platform === "win32" ? "PASS" : "UNAVAILABLE", platform),
    check("GIT_VERSION", git.status, git.detail),
    check("FILE_SYMLINK", symlink.status, symlink.detail),
    check("FIXTURE_CLEANUP", cleanup.status, cleanup.detail),
  ];
  const statuses = checks.map((item) => item.status);
  return {
    checks,
    exitCode: statuses.includes("ERROR") ? 1 : statuses.some((status) => status !== "PASS") ? 2 : 0,
  };
}

function run(command, args) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
    windowsHide: true,
  });
}

function gitCheck() {
  const result = run("git", ["--version"]);
  if (result.error) {
    return { status: "UNKNOWN", detail: `error=${result.error.code ?? result.error.message}` };
  }
  if (result.status === 0 && /^git version\s+\S+/.test(result.stdout.trim())) {
    return { status: "PASS", detail: result.stdout.trim() };
  }
  return { status: "UNAVAILABLE", detail: `exit=${result.status ?? "null"}` };
}

function cleanFixture(runDir, target, link) {
  const failures = [];
  for (const file of [link, target]) {
    try {
      if (fs.lstatSync(file, { throwIfNoEntry: false })) fs.unlinkSync(file);
    } catch (error) {
      failures.push(`${path.basename(file)}:${error.code ?? error.name}`);
    }
  }
  try {
    fs.rmdirSync(runDir);
  } catch (error) {
    failures.push(`rmdir:${error.code ?? error.name}`);
  }
  const exactClean = !fs.existsSync(target) && !fs.existsSync(link) && !fs.existsSync(runDir);
  return failures.length === 0 && exactClean
    ? { status: "PASS", detail: "exact files removed and fixture directory removed" }
    : { status: "ERROR", detail: failures.join(",") || "fixture still exists" };
}

function prepareFixtureRoot(fixtureRoot) {
  const canonicalRoot = fs.realpathSync(root);
  for (const directory of [path.join(root, ".tooling"), fixtureRoot]) {
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw Object.assign(new Error(`linked fixture ancestor: ${directory}`), { code: "LINKED_FIXTURE_PATH" });
  }
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const canonicalFixtureRoot = fs.realpathSync(fixtureRoot);
  const relative = path.relative(canonicalRoot, canonicalFixtureRoot);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Object.assign(new Error("fixture path escapes canonical repository root"), { code: "FIXTURE_OUTSIDE_ROOT" });
  }
}

function symlinkCheck() {
  const fixtureRoot = path.join(root, ".tooling", "g7-preflight");
  let runDir;
  let target;
  let link;
  let symlink = { status: "UNKNOWN", detail: "not attempted" };
  try {
    prepareFixtureRoot(fixtureRoot);
    runDir = fs.mkdtempSync(path.join(fixtureRoot, "run-"));
    target = path.join(runDir, "target.txt");
    link = path.join(runDir, "link.txt");
    fs.writeFileSync(target, "g7-preflight\n", { flag: "wx" });
  } catch (error) {
    symlink = { status: "ERROR", detail: `${error?.code ?? error?.name ?? "unknown"} while preparing fixture` };
    return { symlink, cleanup: runDir ? cleanFixture(runDir, target, link) : { status: "ERROR", detail: "fixture directory was not created" } };
  }
  try {
    fs.symlinkSync(target, link, "file");
  } catch (error) {
    symlink = error?.code === "EPERM"
      ? { status: "UNAVAILABLE", detail: "EPERM while creating file symlink" }
      : { status: "ERROR", detail: `${error?.code ?? error?.name ?? "unknown"} while creating file symlink` };
    return { symlink, cleanup: cleanFixture(runDir, target, link) };
  }
  try {
    const linked = fs.lstatSync(link).isSymbolicLink() && fs.realpathSync(link) === fs.realpathSync(target);
    symlink = linked
      ? { status: "PASS", detail: "actual file symlink resolved to target" }
      : { status: "ERROR", detail: "created link did not resolve to target" };
  } catch (error) {
    symlink = { status: "ERROR", detail: `${error?.code ?? error?.name ?? "unknown"} while verifying file symlink` };
  }
  return { symlink, cleanup: runDir ? cleanFixture(runDir, target, link) : { status: "ERROR", detail: "fixture directory was not created" } };
}

function hostDiagnostics(platform) {
  if (platform !== "win32") return { status: "NOT_RUN", sandboxHostSupport: "UNKNOWN" };
  const script = "$found=@{}; 'WindowsSandbox.exe','wsb.exe','Get-VM','VBoxManage.exe','vmrun.exe' | % { $found[$_]=[bool](Get-Command $_ -ErrorAction SilentlyContinue) }; $cv=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' -ErrorAction SilentlyContinue; try { $feature=Get-CimInstance -ClassName Win32_OptionalFeature -Filter \"Name='Containers-DisposableClientVM'\" -ErrorAction Stop | Select-Object -First 1 -ExpandProperty InstallState } catch { $feature='UNKNOWN' }; [pscustomobject]@{commands=$found;editionId=$cv.EditionID;build=$cv.CurrentBuildNumber;containersDisposableClientVm=if($null -eq $feature){'UNKNOWN'}else{$feature}} | ConvertTo-Json -Compress";
  const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (result.error || result.status !== 0) return { status: "UNKNOWN", sandboxHostSupport: "UNKNOWN" };
  try {
    const data = JSON.parse(result.stdout);
    return {
      status: "PASS",
      ...data,
      sandboxHostSupport: data.editionId === "Core" ? "unsupported-home" : "UNKNOWN",
    };
  } catch {
    return { status: "UNKNOWN", sandboxHostSupport: "UNKNOWN" };
  }
}

function output(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function main() {
  if (process.argv.length !== 2) throw new Error("preflight accepts no file arguments");
  const platform = process.platform;
  const fixture = symlinkCheck();
  const evaluation = evaluatePreflight({
    nodeMajor: Number(process.versions.node.split(".")[0]),
    platform,
    git: gitCheck(),
    ...fixture,
  });
  output({
    timestamp: new Date().toISOString(), platform, node: process.version, checks: evaluation.checks,
    scope: PREFLIGHT_SCOPE, acceptance: PREFLIGHT_ACCEPTANCE, remainingAcceptance: REMAINING_ACCEPTANCE, hostDiagnostics: hostDiagnostics(platform),
  });
  process.exitCode = evaluation.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    output({ timestamp: new Date().toISOString(), platform: process.platform, node: process.version, checks: [check("PREFLIGHT", "ERROR", error.message)], scope: PREFLIGHT_SCOPE, acceptance: PREFLIGHT_ACCEPTANCE, remainingAcceptance: REMAINING_ACCEPTANCE });
    process.exitCode = 1;
  }
}
