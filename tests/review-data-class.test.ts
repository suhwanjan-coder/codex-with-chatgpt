import { afterEach, describe, expect, it } from "vitest";
import { createSnapshot, parseSnapshot, snapshotDigest, type ReviewDataClass } from "../src/review/snapshot.js";
import { prepareRemoteReview } from "../src/review/remote-permit.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];
const target = {
  model: "test-reviewer",
  resource: "https://synthetic-pilot.trycloudflare.com/mcp",
  redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
};

function snapshot(dataClass?: ReviewDataClass) {
  const root = makeTmpDir("review-data-class");
  dirs.push(root);
  makeGitRepo(root);
  return createSnapshot(root, { taskId: "data-class", paths: ["src/index.ts"], dataClass });
}

afterEach(() => { for (const dir of dirs.splice(0)) cleanup(dir); });

describe("review data classes", () => {
  it("accepts public, synthetic, and non-sensitive without collapsing their labels", () => {
    for (const dataClass of ["public", "synthetic", "non-sensitive"] as const) {
      const current = snapshot(dataClass);
      expect(current.dataClass).toBe(dataClass);
      expect(snapshotDigest(current)).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("keeps omitted legacy data class snapshots locally parseable but remote-ineligible", () => {
    const current = snapshot("public");
    const legacy = structuredClone(current) as Record<string, unknown>;
    delete legacy.dataClass;

    const parsed = parseSnapshot(legacy);
    expect(parsed.dataClass).toBeUndefined();
    expect(() => prepareRemoteReview(parsed, target)).toThrow("REMOTE_PILOT_SYNTHETIC_ONLY");
  });

  it("rejects unknown data classes at the snapshot boundary", () => {
    const current = snapshot("public");
    expect(() => parseSnapshot({ ...current, dataClass: "confidential" })).toThrow("SNAPSHOT_SCHEMA");
  });

  it("uses an explicit historical commit for before and the current worktree for after", () => {
    const root = makeTmpDir("review-base-commit");
    dirs.push(root);
    makeGitRepo(root);
    const historical = git(root, "rev-parse", "HEAD").trim();
    write(root, "src/index.ts", "export const answer = 43;\n");
    git(root, "add", "src/index.ts");
    git(root, "commit", "-m", "middle commit");
    write(root, "src/index.ts", "export const answer = 44;\n");

    const current = createSnapshot(root, {
      taskId: "historical-review",
      dataClass: "non-sensitive",
      baseCommit: historical,
      paths: ["src/index.ts"],
    });
    expect(current.baseCommit).toBe(historical);
    expect(current.files[0]).toEqual({
      path: "src/index.ts",
      before: "export const answer = 42;\n",
      after: "export const answer = 44;\n",
    });
  });

  it("rejects malformed, ref, and revision-expression base inputs", () => {
    const root = makeTmpDir("review-base-invalid");
    dirs.push(root);
    makeGitRepo(root);
    for (const baseCommit of ["HEAD", "HEAD~1", "a".repeat(39), "a".repeat(41), "A".repeat(40)]) {
      expect(() => createSnapshot(root, { taskId: "invalid-base", baseCommit, paths: ["src/index.ts"] })).toThrow("SNAPSHOT_INPUT");
    }
  });

  it("rejects a non-commit object and does not bypass content screening", () => {
    const root = makeTmpDir("review-base-object");
    dirs.push(root);
    makeGitRepo(root);
    const tree = git(root, "rev-parse", "HEAD^{tree}").trim();
    expect(() => createSnapshot(root, { taskId: "tree-base", baseCommit: tree, paths: ["src/index.ts"] })).toThrow("SNAPSHOT_GIT");

    const historical = git(root, "rev-parse", "HEAD").trim();
    write(root, "secret.txt", "token=really-secret-value\n");
    git(root, "add", "secret.txt");
    git(root, "commit", "-m", "secret base");
    const secretBase = git(root, "rev-parse", "HEAD").trim();
    write(root, "secret.txt", "safe current content\n");
    expect(() => createSnapshot(root, { taskId: "screened-base", baseCommit: secretBase, paths: ["secret.txt"] })).toThrow("SNAPSHOT_CONTENT");
    expect(historical).toMatch(/^[a-f0-9]{40}$/);
  });
});
