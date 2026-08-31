import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractValidatedGitPatch, gitDiff } from "../src/workspace/git.js";

const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "git-diff-metadata-test",
  GIT_AUTHOR_EMAIL: "git-diff-metadata-test@example.invalid",
  GIT_COMMITTER_NAME: "git-diff-metadata-test",
  GIT_COMMITTER_EMAIL: "git-diff-metadata-test@example.invalid",
};

function git(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=", "-c", "core.fsmonitor=false", ...args],
    { cwd: root, encoding: "utf8", env: gitEnvironment, windowsHide: true }
  );
}

function write(root: string, relPath: string, contents: string): void {
  const filePath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function withRepo<T>(files: Record<string, string>, callback: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-git-diff-metadata-"));
  git(root, "init", "-q", "-b", "main");
  for (const [relPath, contents] of Object.entries(files)) write(root, relPath, contents);
  git(root, "add", ".");
  git(root, "commit", "-qm", "synthetic baseline");
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function stageFileToDirectory(root: string, filePath: string, secret: string): void {
  fs.rmSync(path.join(root, filePath));
  write(root, `${filePath}/.env`, secret);
  git(root, "add", "-A");
}

describe("gitDiff raw metadata validation", () => {
  it("distinguishes a valid repository with no HEAD from a non-repository", () => {
    withRepo({ "safe.txt": "baseline\n" }, (root) => {
      git(root, "symbolic-ref", "HEAD", "refs/heads/unborn");
      expect(gitDiff(root, { mode: "head" })).toMatchObject({
        isRepo: true, diff: "", error: "GIT_DIFF_INVENTORY_FAILED",
      });
    });
  });

  it("withholds a staged file-to-directory descendant leak that legacy literal pathspec output exposes", () => {
    const secret = "SYNTHETIC_FILE_TO_DIRECTORY_SECRET";
    withRepo({ public: "public baseline\n" }, (root) => {
      stageFileToDirectory(root, "public", `${secret}\n`);

      const legacy = git(root, "diff", "--cached", "--", ":(literal)public");
      expect(legacy).toContain(secret);

      const result = gitDiff({ root }, { mode: "staged" });
      expect(result).toMatchObject({ isRepo: true, diff: "", error: "GIT_DIFF_UNSAFE_METADATA" });
      expect(result.diff).not.toContain(secret);
    });
  });

  it("withholds the sensitive deletion when a directory becomes a regular file", () => {
    const secret = "SYNTHETIC_DIRECTORY_TO_FILE_SECRET";
    withRepo({ "public/.env": `${secret}\n` }, (root) => {
      fs.rmSync(path.join(root, "public"), { recursive: true, force: true });
      write(root, "public", "public replacement\n");
      git(root, "add", "-A");

      const legacy = git(root, "diff", "--cached", "--", ":(literal)public");
      expect(legacy).toContain(secret);

      const result = gitDiff({ root }, { mode: "staged" });
      expect(result).toMatchObject({ isRepo: true, diff: "", error: "GIT_DIFF_UNSAFE_METADATA" });
      expect(result.diff).not.toContain(secret);
    });
  });

  it("preserves a rename when both raw metadata endpoints are allowed", () => {
    withRepo({ "before name.txt": "unchanged rename content\n" }, (root) => {
      git(root, "mv", "before name.txt", "after name.txt");

      const result = gitDiff({ root }, { mode: "staged" });
      expect(result.error).toBeUndefined();
      expect(result.diff).toContain("rename from before name.txt");
      expect(result.diff).toContain("rename to after name.txt");
    });
  });

  it("handles an unusual path through the literal pathspec and raw metadata", () => {
    const unusualPath = "odd names/-- [literal] % path.txt";
    withRepo({ [unusualPath]: "before unusual\n" }, (root) => {
      write(root, unusualPath, "after unusual sentinel\n");
      git(root, "add", "--", unusualPath);

      const result = gitDiff({ root }, { mode: "staged" });
      expect(result.error).toBeUndefined();
      expect(result.diff).toContain("after unusual sentinel");
    });
  });

  it("rejects malformed and unknown raw metadata before returning a patch", () => {
    const patch = "diff --git a/safe.txt b/safe.txt\n";
    const allowedPaths = new Set(["safe.txt"]);
    for (const header of [
      ":not-a-git-raw-header",
      ":100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 Q",
      ":100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 R",
      ":100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 R999",
      ":100644 100644 11111111111111111111111111111111111111111 2222222222222222222222222222222222222222 M",
    ]) {
      const output = `${header}\0safe.txt\0\0${patch}`;
      expect(extractValidatedGitPatch(output, allowedPaths, () => false)).toEqual({ ok: false });
    }
  });

  it("does not expand submodule contents because of a local Git output setting", () => {
    withRepo({ "root.txt": "root baseline\n" }, (root) => {
      const sub = path.join(root, "sub");
      fs.mkdirSync(sub);
      git(sub, "init", "-q", "-b", "main");
      write(sub, "nested.txt", "nested baseline\n");
      git(sub, "add", ".");
      git(sub, "commit", "-qm", "nested baseline");
      git(root, "add", "sub");
      git(root, "commit", "-qm", "gitlink baseline");
      write(sub, "nested.txt", "SYNTHETIC_NESTED_CONTENT\n");
      git(sub, "add", ".");
      git(sub, "commit", "-qm", "nested change");
      git(root, "add", "sub");
      git(root, "config", "diff.submodule", "diff");
      expect(git(root, "diff", "--cached")).toContain("SYNTHETIC_NESTED_CONTENT");
      const result = gitDiff({ root }, { mode: "staged" });
      expect(result.error).toBeUndefined();
      expect(result.diff).toContain("Subproject commit");
      expect(result.diff).not.toContain("SYNTHETIC_NESTED_CONTENT");
    });
  });

  it("returns no earlier batch when a later batch contains unapproved metadata", () => {
    const files: Record<string, string> = { "zz-public": "public baseline\n" };
    for (let index = 0; index < 50; index += 1) {
      files[`safe/${String(index).padStart(2, "0")}.txt`] = "safe baseline\n";
    }
    withRepo(files, (root) => {
      for (let index = 0; index < 50; index += 1) {
        write(root, `safe/${String(index).padStart(2, "0")}.txt`, "SAFE_EARLY_BATCH_SENTINEL\n");
      }
      stageFileToDirectory(root, "zz-public", "SYNTHETIC_LATE_BATCH_SECRET\n");
      const inventory = git(root, "diff", "--cached", "--name-only", "-z").split("\0");
      expect(inventory.indexOf("zz-public")).toBeGreaterThanOrEqual(50);

      const result = gitDiff({ root }, { mode: "staged" });
      expect(result).toMatchObject({ isRepo: true, diff: "", error: "GIT_DIFF_UNSAFE_METADATA" });
      expect(result.diff).not.toContain("SAFE_EARLY_BATCH_SENTINEL");
    });
  });
});
