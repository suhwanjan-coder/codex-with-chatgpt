import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createSnapshot, type ReviewSnapshot } from "../src/review/snapshot.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pilotOutputRoot = path.join(repoRoot, ".tooling", "c2c-pilot");

interface PilotManifest {
  workspace: string;
  baseCommit: string;
  reviewPaths: string[];
  tasks: Array<{
    workspace: string;
    dataClass: string;
    approvedPaths: string[];
    baseline: { exitCode: number };
    injected: { exitCode: number };
  }>;
}

interface GeneratedPilot {
  manifest: string;
  tasks: number;
  baselinePasses: number;
  reproducedDefects: number;
  realAdvisorTested: false;
  externalTransmissionAuthorized: false;
}

interface PilotModule {
  assertKnownPilotSnapshot(snapshot: ReviewSnapshot): void;
}

let assertKnownPilotSnapshot: PilotModule["assertKnownPilotSnapshot"];
let fixture: { generated: GeneratedPilot; manifest: PilotManifest; snapshot: ReviewSnapshot };

function cloneSnapshot(snapshot: ReviewSnapshot): ReviewSnapshot {
  return { ...snapshot, files: snapshot.files.map(file => ({ ...file })) };
}

function expectPilotMismatch(snapshot: ReviewSnapshot): void {
  expect(() => assertKnownPilotSnapshot(snapshot)).toThrow("PILOT_CONTENT_MISMATCH");
}

function importProbeScript(): string {
  const moduleUrl = pathToFileURL(path.join(repoRoot, "scripts", "prepare-c2c-pilot.mjs")).href;
  return `
import fs from "node:fs";
const parent = ${JSON.stringify(pilotOutputRoot)};
const trials = () => fs.existsSync(parent)
  ? fs.readdirSync(parent).filter(name => name.startsWith("trial-")).sort()
  : [];
const before = trials();
await import(${JSON.stringify(moduleUrl)});
const after = trials();
if (JSON.stringify(before) !== JSON.stringify(after)) {
  console.error(JSON.stringify({ before, after }));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ before, after }));
`;
}

beforeAll(async () => {
  const pilotModule = await import("../scripts/prepare-c2c-pilot.mjs") as PilotModule;
  assertKnownPilotSnapshot = pilotModule.assertKnownPilotSnapshot;

  const generatedRun = spawnSync(process.execPath, ["scripts/prepare-c2c-pilot.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  expect(generatedRun.error).toBeUndefined();
  expect(generatedRun.status).toBe(0);
  const generated = JSON.parse(generatedRun.stdout.trim()) as GeneratedPilot;
  const manifest = JSON.parse(fs.readFileSync(generated.manifest, "utf8")) as PilotManifest;
  expect(fs.statSync(path.join(manifest.workspace, ".git")).isDirectory()).toBe(true);
  const snapshot = createSnapshot(manifest.workspace, {
    taskId: "pilot-fixtures-regression",
    dataClass: "synthetic",
    paths: manifest.reviewPaths,
  });
  fixture = { generated, manifest, snapshot };
});

describe("C2C pilot fixture guard", () => {
  it("runs the generator once for one Git repo and accepts its exact synthetic snapshot", () => {
    expect(fixture.generated).toMatchObject({
      tasks: 3,
      baselinePasses: 3,
      reproducedDefects: 3,
      realAdvisorTested: false,
      externalTransmissionAuthorized: false,
    });
    expect(fixture.manifest.reviewPaths).toHaveLength(6);
    expect(new Set(fixture.manifest.tasks.map(task => task.workspace))).toEqual(new Set([fixture.manifest.workspace]));
    expect(fixture.manifest.tasks.every(task => task.dataClass === "synthetic")).toBe(true);
    expect(fixture.manifest.tasks.every(task => task.baseline.exitCode === 0)).toBe(true);
    expect(fixture.manifest.tasks.every(task => task.injected.exitCode === 1)).toBe(true);
    expect(fixture.snapshot.baseCommit).toBe(fixture.manifest.baseCommit);
    expect(() => assertKnownPilotSnapshot(fixture.snapshot)).not.toThrow();
  });

  it("rejects changed after bytes while path and HEAD remain unchanged", () => {
    const changed = cloneSnapshot(fixture.snapshot);
    changed.files[0].after = `${changed.files[0].after}tampered`;

    expect(changed.files[0].path).toBe(fixture.snapshot.files[0].path);
    expect(changed.baseCommit).toBe(fixture.snapshot.baseCommit);
    expectPilotMismatch(changed);
  });

  it("rejects altered before bytes and test contents", () => {
    const beforeChanged = cloneSnapshot(fixture.snapshot);
    beforeChanged.files[0].before = `${beforeChanged.files[0].before}tampered`;
    expectPilotMismatch(beforeChanged);

    const testChanged = cloneSnapshot(fixture.snapshot);
    const testFile = testChanged.files.find(file => file.path.endsWith("/test.mjs"));
    if (!testFile) throw new Error("PILOT_TEST_FIXTURE_MISSING");
    testFile.after = `${testFile.after}tampered`;
    expectPilotMismatch(testChanged);
  });

  it("rejects duplicate, missing, and additional paths", () => {
    const duplicate = cloneSnapshot(fixture.snapshot);
    duplicate.files.push({ ...duplicate.files[0] });
    expectPilotMismatch(duplicate);

    const missing = cloneSnapshot(fixture.snapshot);
    missing.files.shift();
    expectPilotMismatch(missing);

    const additional = cloneSnapshot(fixture.snapshot);
    additional.files[0] = { ...additional.files[0], path: "additional.txt" };
    expectPilotMismatch(additional);
  });

  it("rejects a non-synthetic classification", () => {
    const classifiedAsPublic = { ...fixture.snapshot, dataClass: "public" as const };
    expectPilotMismatch(classifiedAsPublic);
  });

  it("imports the generator without creating a fixture directory", () => {
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", importProbeScript()], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
    });

    expect(probe.error).toBeUndefined();
    expect(probe.status).toBe(0);
    const observed = JSON.parse(probe.stdout) as { before: string[]; after: string[] };
    expect(observed.after).toEqual(observed.before);
  });

  it("rejects the actual runner with no arguments before the external trial", () => {
    const runner = spawnSync(process.execPath, ["scripts/run-c2c-pilot.mjs"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
    });

    expect(runner.error).toBeUndefined();
    expect(runner.status).toBe(1);
    expect(runner.stdout).toBe("");
    expect(runner.stderr).toContain("Usage: run-c2c-pilot.mjs");
    expect(runner.stderr).toContain("--authorize-external-trial");
  });
});
