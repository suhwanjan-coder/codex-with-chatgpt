import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { cleanup, makeGitRepo, makeTmpDir, write } from "./helpers.js";
import { runCliProcess } from "./cli-process.js";
import { createSnapshot, snapshotDigest } from "../src/review/snapshot.js";

// Leave room for seven native startup requests before checking real absolute expiry.
const CLI_SMOKE_TTL_MS = 90_000;
const CLI_SMOKE_TIMEOUT_MS = CLI_SMOKE_TTL_MS + 10_000;

it("loads built CLI modules through a file URL, including Windows paths and spaces", () => {
  const root = makeTmpDir("bin fixture space");
  try {
    write(root, "package.json", '{"type":"module"}');
    write(root, "dist/cli/index.js", 'process.stdout.write("compiled-entry-ok");');
    fs.mkdirSync(path.join(root, "bin"));
    fs.copyFileSync(fileURLToPath(new URL("../bin/c2c.js", import.meta.url)), path.join(root, "bin/c2c.js"));
    const run = spawnSync(process.execPath, [path.join(root, "bin/c2c.js")], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("compiled-entry-ok");
  } finally { cleanup(root); }
});

it("starts the actual CLI for a synthetic approval and exits after its bounded lifetime", async () => {
  const root = makeTmpDir("bin-review-root");
  const state = makeTmpDir("bin-review-state");
  try {
    makeGitRepo(root);
    const snapshot = createSnapshot(root, { taskId: "synthetic-cli-smoke", paths: ["hello.txt"], ttlMs: CLI_SMOKE_TTL_MS });
    write(state, "snapshot.json", JSON.stringify(snapshot));
    const entry = fileURLToPath(new URL("../bin/c2c.js", import.meta.url));
    const run = await runCliProcess([entry, "review", "serve", "--snapshot", path.join(state, "snapshot.json"),
      "--approval", snapshotDigest(snapshot), "--state-dir", path.join(state, "session")],
      { timeoutMs: CLI_SMOKE_TIMEOUT_MS });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).mode).toBe("LOCAL_MOCK_ONLY");
    const privateState = path.join(state, "session", ".c2c-review-private");
    const audit = fs.readFileSync(path.join(privateState, `${snapshotDigest(snapshot)}.audit.jsonl`), "utf8");
    expect(audit).toContain('"outcome":"expired"');
    expect(fs.readdirSync(privateState).some((name) => name.endsWith(".lock"))).toBe(false);
  } finally { cleanup(root); cleanup(state); }
}, CLI_SMOKE_TIMEOUT_MS + 30_000);
