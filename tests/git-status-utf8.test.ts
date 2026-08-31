import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitDiff, gitStatus } from "../src/workspace/git.js";

const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "git-status-utf8-test",
  GIT_AUTHOR_EMAIL: "git-status-utf8-test@example.invalid",
  GIT_COMMITTER_NAME: "git-status-utf8-test",
  GIT_COMMITTER_EMAIL: "git-status-utf8-test@example.invalid",
};

function git(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=", "-c", "core.fsmonitor=false", ...args],
    { cwd: root, encoding: "utf8", env: gitEnvironment, windowsHide: true }
  );
}

function write(root: string, relativePath: string, contents: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function withRepo<T>(files: Record<string, string>, callback: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-git-status-utf8-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "core.quotePath", "true");
  for (const [relativePath, contents] of Object.entries(files)) write(root, relativePath, contents);
  git(root, "add", ".");
  git(root, "commit", "-qm", "synthetic baseline");
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("gitStatus porcelain-v2 UTF-8 records", () => {
  it("preserves Unicode and spaces and renders a staged rename old -> new", () => {
    withRepo(
      {
        "舊 名稱.txt": "rename baseline\n",
        "tracked space.txt": "tracked baseline\n",
      },
      (root) => {
        git(root, "mv", "舊 名稱.txt", "新 名稱.txt");
        write(root, "tracked space.txt", "tracked changed\n");
        git(root, "add", "tracked space.txt");
        write(root, "未追蹤 space.txt", "untracked\n");

        const result = gitStatus(root);

        expect(result.staged).toContainEqual({
          path: "舊 名稱.txt -> 新 名稱.txt",
          change: "R",
        });
        expect(result.staged).toContainEqual({ path: "tracked space.txt", change: "M" });
        expect(result.untracked).toContain("未追蹤 space.txt");
        expect(result.untracked.some((filePath) => filePath.includes("\\"))).toBe(false);
      }
    );
  });

  it("extracts a Unicode conflict pathname after porcelain-v2 field ten", () => {
    withRepo({ "衝突 file.txt": "base\n" }, (root) => {
      git(root, "checkout", "-qb", "side");
      write(root, "衝突 file.txt", "side\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "side change");
      git(root, "checkout", "-q", "main");
      write(root, "衝突 file.txt", "main\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "main change");

      const merge = spawnSync("git", ["merge", "--no-edit", "side"], {
        cwd: root,
        encoding: "utf8",
        env: gitEnvironment,
        windowsHide: true,
      });
      expect(merge.status).not.toBe(0);

      expect(gitStatus(root).conflicted).toEqual(["衝突 file.txt"]);
    });
  });
});

describe("gitDiff UTF-8 pagination contract", () => {
  it("joins actual Git pages without replacement characters or byte drift", () => {
    withRepo({ "unicode-long-line.txt": "baseline\n" }, (root) => {
      const prefix = "p".repeat(1600);
      const suffix = "a".repeat(2048);
      write(root, "unicode-long-line.txt", `${prefix}é\n${suffix}\n`);

      const fullResult = gitDiff(root, { mode: "unstaged", maxBytes: 256 * 1024 });
      const fullBytes = Buffer.from(fullResult.diff, "utf8");
      const characterStart = fullBytes.indexOf(Buffer.from("é", "utf8"));
      expect(characterStart).toBeGreaterThan(1023);

      const boundaryOffset = characterStart - 1023;
      const boundary = gitDiff(root, {
        mode: "unstaged",
        offset: boundaryOffset,
        maxBytes: 1024,
      });
      expect(boundary.error).toBeUndefined();
      expect(boundary.diff).not.toContain("\uFFFD");
      expect(boundary.returnedBytes).toBeLessThanOrEqual(1024);
      expect(boundary.returnedBytes).toBe(Buffer.byteLength(boundary.diff, "utf8"));
      expect(boundary.nextOffset).toBe(boundary.offset + boundary.returnedBytes);
      expect(boundary.nextOffset).toBe(characterStart);

      const inside = gitDiff(root, {
        mode: "unstaged",
        offset: characterStart + 1,
        maxBytes: 1024,
      });
      expect(inside).toMatchObject({
        isRepo: true,
        diff: "",
        returnedBytes: 0,
        hasMore: false,
        nextOffset: null,
        error: "GIT_DIFF_INVALID_OFFSET",
      });

      let offset = 0;
      let assembled = "";
      for (let pageCount = 0; pageCount < 100; pageCount += 1) {
        const page = gitDiff(root, { mode: "unstaged", offset, maxBytes: 1024 });
        expect(page.error).toBeUndefined();
        expect(page.returnedBytes).toBeLessThanOrEqual(1024);
        expect(page.returnedBytes).toBe(Buffer.byteLength(page.diff, "utf8"));
        expect(page.offset).toBe(offset);
        assembled += page.diff;
        if (!page.hasMore) {
          expect(page.nextOffset).toBeNull();
          break;
        }
        expect(page.nextOffset).toBe(offset + page.returnedBytes);
        expect(page.nextOffset).toBeGreaterThan(offset);
        offset = page.nextOffset!;
        if (pageCount === 99) throw new Error("pagination did not reach EOF");
      }
      expect(assembled).toBe(fullResult.diff);

      const beyondEof = gitDiff(root, {
        mode: "unstaged",
        offset: fullResult.totalBytes + 10,
        maxBytes: 1024,
      });
      expect(beyondEof).toMatchObject({
        isRepo: true,
        totalBytes: fullResult.totalBytes,
        offset: fullResult.totalBytes + 10,
        diff: "",
        returnedBytes: 0,
        hasMore: false,
        nextOffset: null,
      });
    });
  });

  it("rejects nonfinite pagination values while retaining finite clamps", () => {
    withRepo({ "unicode-options.txt": "baseline\n" }, (root) => {
      write(root, "unicode-options.txt", `${"x".repeat(1800)}é\n`);

      for (const options of [
        { offset: Number.NaN },
        { offset: Number.POSITIVE_INFINITY },
        { maxBytes: Number.NaN },
        { maxBytes: Number.POSITIVE_INFINITY },
      ]) {
        expect(gitDiff(root, options)).toMatchObject({
          isRepo: true,
          diff: "",
          returnedBytes: 0,
          error: "GIT_DIFF_INVALID_OFFSET",
        });
      }

      const clamped = gitDiff(root, { maxBytes: 1024 });
      const belowMinimum = gitDiff(root, { maxBytes: 1 });
      expect(belowMinimum).toMatchObject({
        offset: 0,
        diff: clamped.diff,
        returnedBytes: clamped.returnedBytes,
        nextOffset: clamped.nextOffset,
      });
      expect(gitDiff(root, { offset: 0.9, maxBytes: 1024 }).offset).toBe(0);
    });
  });
});
