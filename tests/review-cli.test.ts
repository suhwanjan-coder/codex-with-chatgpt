import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { remoteReviewDigest, type RemoteReviewPermit } from "../src/review/remote-permit.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];

function tmp(name: string): string {
  const dir = makeTmpDir(name);
  dirs.push(dir);
  return dir;
}

function runCli(args: string[], stateDir: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, C2C_STATE_DIR: stateDir, GIT_TERMINAL_PROMPT: "0" },
  });
}

function output(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function runCliUntilMarker(args: string[], stateDir: string, marker: string): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...args], {
      cwd: projectRoot,
      env: { ...process.env, C2C_STATE_DIR: stateDir, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stopping = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (!stopping) child.kill();
      if (!settled) { settled = true; reject(new Error(`CLI_TIMEOUT: ${stdout}${stderr}`)); }
    }, 20_000);
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      child.kill("SIGINT");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes(marker)) stop();
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, status });
    });
  });
}

const remoteTarget = {
  model: "test-reviewer",
  resource: "https://synthetic-pilot.trycloudflare.com/mcp",
  redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
};

afterEach(() => {
  for (const dir of dirs.splice(0)) cleanup(dir);
});

describe("review-only CLI security boundary", () => {
  it.each(["inside root", "existing output"])("refuses snapshot output in an %s without overwriting data or creating state", location => {
    const root = tmp("cli-output-boundary");
    makeGitRepo(root);
    const stateDir = path.join(tmp("cli-output-state"), "absent-state");
    const outputFile = path.join(location === "inside root" ? root : tmp("cli-output-existing"), "snapshot.json");
    if (location === "existing output") fs.writeFileSync(outputFile, "preserve-existing-output");
    const result = runCli(["review", "prepare", "--workspace", root, "--task", "output-boundary",
      "--files", "hello.txt", "--data-class", "public", "--output", outputFile], stateDir);
    expect(result.status).not.toBe(0);
    if (location === "existing output") expect(fs.readFileSync(outputFile, "utf8")).toBe("preserve-existing-output");
    else expect(fs.existsSync(outputFile)).toBe(false);
    expect(fs.existsSync(stateDir)).toBe(false);
  }, 9_000);

  it("exposes C2C run help without starting state and requires explicit external authorization", () => {
    const state = path.join(tmp("cli-real-help"), "state");
    const help = runCli(["review", "run", "--help"], state);
    expect(help.status, output(help)).toBe(0);
    expect(output(help)).toContain("--reviewed-snapshot");
    expect(output(help)).toContain("--authorize-external-review");
    const denied = runCli(["review", "run", "--snapshot", "not-read.json", "--model", "test-reviewer", "--state-dir", state, "--reviewed-snapshot", "a".repeat(64)], state);
    expect(denied.status).toBe(1);
    expect(output(denied)).toContain("--authorize-external-review");
    expect(fs.existsSync(state)).toBe(false);
  });

  it("rejects legacy commands before state, global configuration, or network side effects", () => {
    const workspace = tmp("cli-legacy-workspace");
    makeGitRepo(workspace);
    const helpState = path.join(tmp("cli-help-state-parent"), "state");
    const help = runCli(["--help"], helpState);
    expect(help.status).toBe(0);
    expect(output(help)).toMatch(/^\s+review\s+Approved, single-use snapshot review/m);
    expect(output(help)).not.toMatch(/^\s+(?:serve|start|setup|stop|restart|status|doctor|pair|unpair|logs|workspace|sandbox-allow|update-check|session|record)\b/m);
    expect(fs.existsSync(helpState)).toBe(false);
    const commands = [
      ["setup", "--no-tunnel"],
      ["start"],
      ["serve", "--workspace", workspace],
      ["doctor", "--no-fix"],
      ["sandbox-allow"],
      ["update-check"],
    ];
    for (const args of commands) {
      const stateDir = path.join(tmp("cli-legacy-state-parent"), "state");
      const result = runCli(args, stateDir);
      expect(result.status, `${args.join(" ")} output: ${output(result)}`).toBe(1);
      expect(output(result)).toContain("LEGACY_COMMAND_DISABLED");
      expect(fs.existsSync(stateDir)).toBe(false);
    }
  });

  it("prepares public, synthetic, or non-sensitive unapproved snapshots outside the reviewed root and inspects their exact digest", () => {
    const root = tmp("cli-review-root");
    makeGitRepo(root);
    write(root, "src/index.ts", "export const answer = 43;\n");
    for (const dataClass of ["public", "synthetic", "non-sensitive"]) {
      const outputFile = path.join(tmp("cli-review-output"), `${dataClass}.snapshot.json`);
      const stateDir = path.join(tmp("cli-review-state-parent"), "state");
      const prepared = runCli([
        "review", "prepare",
        "--workspace", root,
        "--task", `review-${dataClass}`,
        "--files", "src/index.ts",
        "--data-class", dataClass,
        "--output", outputFile,
      ], stateDir);
      expect(prepared.status, output(prepared)).toBe(0);
      const preparedBody = JSON.parse(output(prepared)) as { snapshot: string; digest: string; dataClass: string; approved: boolean; files: string[] };
      expect(preparedBody).toMatchObject({ snapshot: path.resolve(outputFile), dataClass, approved: false, files: ["src/index.ts"] });
      expect(path.relative(root, outputFile).startsWith("..")).toBe(true);
      expect(fs.existsSync(outputFile)).toBe(true);
      expect((JSON.parse(fs.readFileSync(outputFile, "utf8")) as { dataClass: string }).dataClass).toBe(dataClass);

      const inspected = runCli(["review", "inspect", "--snapshot", outputFile], stateDir);
      expect(inspected.status, output(inspected)).toBe(0);
      expect((JSON.parse(output(inspected)) as { digest: string; snapshot: { dataClass: string } }).digest).toBe(preparedBody.digest);
      expect((JSON.parse(output(inspected)) as { snapshot: { dataClass: string } }).snapshot.dataClass).toBe(dataClass);
      expect(JSON.parse(output(inspected)).protocolLimits).toEqual({ maxResponses: 32, maxResponseBytes: 16384, maxTotalBytes: 65536 });
    }
  });

  it("rejects a forbidden data class without creating a snapshot", () => {
    const root = tmp("cli-forbidden-root");
    makeGitRepo(root);
    const outputFile = path.join(tmp("cli-forbidden-output"), "forbidden.json");
    const stateDir = path.join(tmp("cli-forbidden-state-parent"), "state");
    const result = runCli([
      "review", "prepare",
      "--workspace", root,
      "--task", "forbidden-data",
      "--files", "src/index.ts",
      "--data-class", "confidential",
      "--output", outputFile,
    ], stateDir);
    expect(result.status).toBe(1);
    expect(output(result)).toContain("DATA_CLASS_NOT_ALLOWED");
    expect(fs.existsSync(outputFile)).toBe(false);
    expect(fs.existsSync(stateDir)).toBe(false);
  });

  it("passes an explicit base commit to review prepare", () => {
    const root = tmp("cli-base-review-root");
    makeGitRepo(root);
    const historical = git(root, "rev-parse", "HEAD").trim();
    write(root, "src/index.ts", "export const answer = 43;\n");
    const snapshotFile = path.join(tmp("cli-base-review-output"), "review.json");
    const result = runCli([
      "review", "prepare",
      "--workspace", root,
      "--task", "cli-base-review",
      "--files", "src/index.ts",
      "--data-class", "non-sensitive",
      "--base", historical,
      "--output", snapshotFile,
    ], path.join(tmp("cli-base-review-state-parent"), "state"));
    expect(result.status, output(result)).toBe(0);
    const prepared = JSON.parse(fs.readFileSync(snapshotFile, "utf8")) as { baseCommit: string; files: Array<{ before: string | null; after: string | null }> };
    expect(prepared).toMatchObject({
      baseCommit: historical,
      files: [{ before: "export const answer = 42;\n", after: "export const answer = 43;\n" }],
    });
  });

  it("creates an unapproved synthetic remote permit with exact persistence and no overwrite", () => {
    const root = tmp("cli-remote-plan-root");
    makeGitRepo(root);
    write(root, "src/index.ts", "export const answer = 43;\n");
    const snapshotFile = path.join(tmp("cli-remote-plan-snapshot"), "review.json");
    const prepared = runCli([
      "review", "prepare",
      "--workspace", root,
      "--task", "remote-plan-review",
      "--files", "src/index.ts",
      "--data-class", "synthetic",
      "--output", snapshotFile,
    ], path.join(tmp("cli-remote-plan-prepare-state"), "state"));
    expect(prepared.status, output(prepared)).toBe(0);
    const preparedBody = JSON.parse(output(prepared)) as { digest: string };
    const permitFile = path.join(tmp("cli-remote-plan-output"), "permit.json");
    const stateDir = path.join(tmp("cli-remote-plan-state-parent"), "state");
    const args = [
      "review", "remote-plan",
      "--snapshot", snapshotFile,
      "--model", remoteTarget.model,
      "--resource", remoteTarget.resource,
      "--redirect-uri", remoteTarget.redirectUri,
      "--output", permitFile,
    ];

    const planned = runCli(args, stateDir);
    expect(planned.status, output(planned)).toBe(0);
    const body = JSON.parse(output(planned)) as { permit: string; digest: string; target: typeof remoteTarget; approved: boolean };
    expect(body).toMatchObject({ permit: path.resolve(permitFile), target: remoteTarget, approved: false });
    const permitText = fs.readFileSync(permitFile, "utf8");
    const permit = JSON.parse(permitText) as RemoteReviewPermit;
    expect(permit).toMatchObject({ ...remoteTarget, dataClass: "synthetic", snapshotDigest: preparedBody.digest });
    expect(remoteReviewDigest(permit)).toBe(body.digest);
    expect(fs.existsSync(stateDir)).toBe(false);

    const repeated = runCli(args, stateDir);
    expect(repeated.status).toBe(1);
    expect(fs.readFileSync(permitFile, "utf8")).toBe(permitText);
    expect(fs.existsSync(stateDir)).toBe(false);
  });

  it.each(["public", "unclassified"] as const)("rejects %s data from remote-plan before writing a permit", (dataClass) => {
    const root = tmp(`cli-remote-reject-${dataClass}`);
    makeGitRepo(root);
    write(root, "src/index.ts", "export const answer = 43;\n");
    const snapshotFile = path.join(tmp(`cli-remote-reject-${dataClass}-snapshot`), "review.json");
    const prepareArgs = [
      "review", "prepare",
      "--workspace", root,
      "--task", `remote-reject-${dataClass}`,
      "--files", "src/index.ts",
      "--data-class", dataClass === "unclassified" ? "synthetic" : dataClass,
      "--output", snapshotFile,
    ];
    const prepared = runCli(prepareArgs, path.join(tmp(`cli-remote-reject-${dataClass}-prepare-state`), "state"));
    expect(prepared.status, output(prepared)).toBe(0);
    if (dataClass === "unclassified") {
      const legacy = JSON.parse(fs.readFileSync(snapshotFile, "utf8")) as Record<string, unknown>;
      delete legacy.dataClass;
      fs.writeFileSync(snapshotFile, JSON.stringify(legacy, null, 2));
    }
    const permitFile = path.join(tmp(`cli-remote-reject-${dataClass}-permit`), "permit.json");
    const stateDir = path.join(tmp(`cli-remote-reject-${dataClass}-state-parent`), "state");
    const result = runCli([
      "review", "remote-plan",
      "--snapshot", snapshotFile,
      "--model", remoteTarget.model,
      "--resource", remoteTarget.resource,
      "--redirect-uri", remoteTarget.redirectUri,
      "--output", permitFile,
    ], stateDir);
    expect(result.status, output(result)).toBe(1);
    expect(output(result)).toContain(dataClass === "public" ? "REMOTE_REVIEW_ATTESTATION_REQUIRED" : "REMOTE_PILOT_SYNTHETIC_ONLY");
    expect(fs.existsSync(permitFile)).toBe(false);
    expect(fs.existsSync(stateDir)).toBe(false);
  });

  it("rejects a wrong remote permit digest before creating state or opening a listener", () => {
    const root = tmp("cli-remote-approval-root");
    makeGitRepo(root);
    write(root, "src/index.ts", "export const answer = 43;\n");
    const snapshotFile = path.join(tmp("cli-remote-approval-snapshot"), "review.json");
    const prepared = runCli([
      "review", "prepare",
      "--workspace", root,
      "--task", "remote-approval-review",
      "--files", "src/index.ts",
      "--data-class", "synthetic",
      "--output", snapshotFile,
    ], path.join(tmp("cli-remote-approval-prepare-state"), "state"));
    expect(prepared.status, output(prepared)).toBe(0);
    const permitFile = path.join(tmp("cli-remote-approval-permit"), "permit.json");
    const planned = runCli([
      "review", "remote-plan",
      "--snapshot", snapshotFile,
      "--model", remoteTarget.model,
      "--resource", remoteTarget.resource,
      "--redirect-uri", remoteTarget.redirectUri,
      "--output", permitFile,
    ], path.join(tmp("cli-remote-approval-plan-state"), "state"));
    expect(planned.status, output(planned)).toBe(0);
    const stateDir = path.join(tmp("cli-remote-approval-state-parent"), "state");
    const result = runCli([
      "review", "serve-remote",
      "--snapshot", snapshotFile,
      "--permit", permitFile,
      "--approval", "0".repeat(64),
      "--state-dir", stateDir,
      "--port", "0",
    ], stateDir);
    expect(result.status, output(result)).toBe(1);
    expect(output(result)).toContain("REMOTE_APPROVAL_MISMATCH");
    expect(output(result)).not.toContain("SYNTHETIC_REMOTE_PILOT");
    expect(fs.existsSync(stateDir)).toBe(false);
  });

  it("serves an approved synthetic remote pilot on loopback with the exact resource and permit digest", async () => {
    const root = tmp("cli-remote-serve-root");
    makeGitRepo(root);
    write(root, "src/index.ts", "export const answer = 43;\n");
    const snapshotFile = path.join(tmp("cli-remote-serve-snapshot"), "review.json");
    const prepared = runCli([
      "review", "prepare",
      "--workspace", root,
      "--task", "remote-serve-review",
      "--files", "src/index.ts",
      "--data-class", "synthetic",
      "--output", snapshotFile,
    ], path.join(tmp("cli-remote-serve-prepare-state"), "state"));
    expect(prepared.status, output(prepared)).toBe(0);
    const permitFile = path.join(tmp("cli-remote-serve-permit"), "permit.json");
    const planned = runCli([
      "review", "remote-plan",
      "--snapshot", snapshotFile,
      "--model", remoteTarget.model,
      "--resource", remoteTarget.resource,
      "--redirect-uri", remoteTarget.redirectUri,
      "--output", permitFile,
    ], path.join(tmp("cli-remote-serve-plan-state"), "state"));
    expect(planned.status, output(planned)).toBe(0);
    const plannedBody = JSON.parse(output(planned)) as { digest: string };
    const permit = JSON.parse(fs.readFileSync(permitFile, "utf8")) as RemoteReviewPermit;
    const stateDir = path.join(tmp("cli-remote-serve-state-parent"), "state");
    const served = await runCliUntilMarker([
      "review", "serve-remote",
      "--snapshot", snapshotFile,
      "--permit", permitFile,
      "--approval", plannedBody.digest,
      "--state-dir", stateDir,
      "--port", "0",
    ], stateDir, "SYNTHETIC_REMOTE_PILOT");
    expect(served.stdout, served.stderr).toContain("SYNTHETIC_REMOTE_PILOT");
    const response = JSON.parse(served.stdout.trim().split(/\r?\n/).find((line) => line.includes("SYNTHETIC_REMOTE_PILOT"))!) as {
      mode: string;
      url: string;
      resource: string;
      digest: string;
      pairingCode: string;
      expiresAt: number;
    };
    expect(response).toMatchObject({ mode: "SYNTHETIC_REMOTE_PILOT", resource: remoteTarget.resource, digest: plannedBody.digest, expiresAt: permit.expiresAt });
    expect(response.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(response.pairingCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("plans and serves an explicitly reviewed non-sensitive snapshot with the bounded review mode", async () => {
    const root = tmp("cli-bounded-review-root");
    makeGitRepo(root);
    write(root, "src/index.ts", "export const answer = 43;\n");
    const snapshotFile = path.join(tmp("cli-bounded-review-snapshot"), "review.json");
    const prepared = runCli([
      "review", "prepare",
      "--workspace", root,
      "--task", "bounded-review",
      "--files", "src/index.ts",
      "--data-class", "non-sensitive",
      "--output", snapshotFile,
    ], path.join(tmp("cli-bounded-review-prepare-state"), "state"));
    expect(prepared.status, output(prepared)).toBe(0);
    const preparedBody = JSON.parse(output(prepared)) as { digest: string };
    const permitFile = path.join(tmp("cli-bounded-review-permit"), "permit.json");
    const planned = runCli([
      "review", "remote-plan",
      "--snapshot", snapshotFile,
      "--model", remoteTarget.model,
      "--resource", remoteTarget.resource,
      "--redirect-uri", remoteTarget.redirectUri,
      "--reviewed-snapshot", preparedBody.digest,
      "--output", permitFile,
    ], path.join(tmp("cli-bounded-review-plan-state"), "state"));
    expect(planned.status, output(planned)).toBe(0);
    const plannedBody = JSON.parse(output(planned)) as { digest: string };
    const permit = JSON.parse(fs.readFileSync(permitFile, "utf8")) as RemoteReviewPermit;
    expect(permit).toMatchObject({ dataClass: "non-sensitive", snapshotDigest: preparedBody.digest, reviewedSnapshotDigest: preparedBody.digest });

    const stateDir = path.join(tmp("cli-bounded-review-state-parent"), "state");
    const served = await runCliUntilMarker([
      "review", "serve-remote",
      "--snapshot", snapshotFile,
      "--permit", permitFile,
      "--approval", plannedBody.digest,
      "--state-dir", stateDir,
      "--port", "0",
    ], stateDir, "BOUNDED_REMOTE_REVIEW");
    expect(served.stdout, served.stderr).toContain("BOUNDED_REMOTE_REVIEW");
    const response = JSON.parse(served.stdout.trim().split(/\r?\n/).find((line) => line.includes("BOUNDED_REMOTE_REVIEW"))!) as {
      mode: string;
      resource: string;
      digest: string;
      expiresAt: number;
    };
    expect(response).toMatchObject({ mode: "BOUNDED_REMOTE_REVIEW", resource: remoteTarget.resource, digest: plannedBody.digest, expiresAt: permit.expiresAt });
  });

  it("requires a review serve approval and rejects a bad digest before opening state or a listener", () => {
    const root = tmp("cli-serve-root");
    makeGitRepo(root);
    const snapshotFile = path.join(tmp("cli-serve-output"), "review.json");
    const prepareState = path.join(tmp("cli-serve-prepare-state-parent"), "state");
    const prepared = runCli([
      "review", "prepare",
      "--workspace", root,
      "--task", "serve-review",
      "--files", "src/index.ts",
      "--data-class", "synthetic",
      "--output", snapshotFile,
    ], prepareState);
    expect(prepared.status, output(prepared)).toBe(0);

    const missingState = path.join(tmp("cli-serve-missing-state-parent"), "state");
    const missing = runCli(["review", "serve", "--snapshot", snapshotFile, "--state-dir", missingState], missingState);
    expect(missing.status).toBe(1);
    expect(output(missing)).toMatch(/required option '--approval <sha256>' not specified/i);
    expect(fs.existsSync(missingState)).toBe(false);

    const badState = path.join(tmp("cli-serve-bad-state-parent"), "state");
    const bad = runCli([
      "review", "serve",
      "--snapshot", snapshotFile,
      "--approval", "0".repeat(64),
      "--state-dir", badState,
    ], badState);
    expect(bad.status, output(bad)).toBe(1);
    expect(output(bad)).toContain("APPROVAL_MISMATCH");
    expect(output(bad)).not.toContain("LOCAL_MOCK_ONLY");
    expect(fs.existsSync(badState)).toBe(false);
  });
});
