import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitDiff } from "../src/workspace/git.js";

const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "git-diff-scope-test",
  GIT_AUTHOR_EMAIL: "git-diff-scope-test@example.invalid",
  GIT_COMMITTER_NAME: "git-diff-scope-test",
  GIT_COMMITTER_EMAIL: "git-diff-scope-test@example.invalid",
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

function makeRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-git-diff-scope-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "git-diff-scope-test@example.invalid");
  git(root, "config", "user.name", "git-diff-scope-test");
  for (const [relPath, contents] of Object.entries(files)) write(root, relPath, contents);
  git(root, "add", ".");
  git(root, "commit", "-qm", "synthetic baseline");
  return root;
}

function withRepo<T>(files: Record<string, string>, callback: (root: string) => T): T {
  const root = makeRepo(files);
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("gitDiff scope and rename batching", () => {
  it("uses the options path when it is the only scope", () => {
    withRepo(
      {
        "scoped/in-scope.txt": "synthetic before scoped\n",
        "outside/out-of-scope.txt": "synthetic before outside\n",
      },
      (root) => {
        write(root, "scoped/in-scope.txt", "synthetic after scoped\n");
        write(root, "outside/out-of-scope.txt", "synthetic after outside\n");
        git(root, "add", ".");

        const result = gitDiff({ root }, { mode: "staged", path: "scoped" });

        expect(result.diff).toContain("scoped/in-scope.txt");
        expect(result.diff).toContain("synthetic after scoped");
        expect(result.diff).not.toContain("outside/out-of-scope.txt");
        expect(result.diff).not.toContain("synthetic after outside");
      }
    );
  });

  it("gives the third relPath argument precedence over options.path", () => {
    withRepo(
      {
        "scoped/ignored-by-third-argument.txt": "synthetic scoped before\n",
        "selected/selected.txt": "synthetic selected before\n",
        "outside/ignored.txt": "synthetic outside before\n",
      },
      (root) => {
        write(root, "scoped/ignored-by-third-argument.txt", "synthetic scoped after\n");
        write(root, "selected/selected.txt", "synthetic selected after\n");
        write(root, "outside/ignored.txt", "synthetic outside after\n");
        git(root, "add", ".");

        const result = gitDiff(
          { root },
          { mode: "staged", path: "scoped" },
          "selected"
        );

        expect(result.diff).toContain("selected/selected.txt");
        expect(result.diff).toContain("synthetic selected after");
        expect(result.diff).not.toContain("scoped/ignored-by-third-argument.txt");
        expect(result.diff).not.toContain("outside/ignored.txt");
      }
    );
  });

  it("normalizes options path spellings without widening to sibling paths", () => {
    withRepo(
      {
        "src/in-scope.ts": "synthetic src before\n",
        "src-named/out-of-scope.ts": "synthetic sibling before\n",
        "outside/out-of-scope.ts": "synthetic outside before\n",
      },
      (root) => {
        write(root, "src/in-scope.ts", "synthetic src after\n");
        write(root, "src-named/out-of-scope.ts", "synthetic sibling after\n");
        write(root, "outside/out-of-scope.ts", "synthetic outside after\n");
        git(root, "add", ".");

        for (const scope of ["src/", "./src"]) {
          const result = gitDiff({ root }, { mode: "staged", path: scope });

          expect(result.diff).toContain("src/in-scope.ts");
          expect(result.diff).toContain("synthetic src after");
          expect(result.diff).not.toContain("src-named/out-of-scope.ts");
          expect(result.diff).not.toContain("outside/out-of-scope.ts");
        }
      }
    );
  });

  it("normalizes third-argument scope spellings without widening to sibling paths", () => {
    withRepo(
      {
        "src/in-scope.ts": "synthetic src before\n",
        "src-named/out-of-scope.ts": "synthetic sibling before\n",
        "outside/out-of-scope.ts": "synthetic outside before\n",
      },
      (root) => {
        write(root, "src/in-scope.ts", "synthetic src after\n");
        write(root, "src-named/out-of-scope.ts", "synthetic sibling after\n");
        write(root, "outside/out-of-scope.ts", "synthetic outside after\n");
        git(root, "add", ".");

        for (const scope of ["src/", "./src"]) {
          const result = gitDiff({ root }, { mode: "staged" }, scope);

          expect(result.diff).toContain("src/in-scope.ts");
          expect(result.diff).toContain("synthetic src after");
          expect(result.diff).not.toContain("src-named/out-of-scope.ts");
          expect(result.diff).not.toContain("outside/out-of-scope.ts");
        }
      }
    );
  });

  it("keeps default and explicit root scopes equivalent", () => {
    withRepo(
      {
        "root-a.txt": "synthetic root a before\n",
        "nested/root-b.txt": "synthetic root b before\n",
      },
      (root) => {
        write(root, "root-a.txt", "synthetic root a after\n");
        write(root, "nested/root-b.txt", "synthetic root b after\n");
        git(root, "add", ".");

        const defaultScope = gitDiff({ root }, { mode: "staged" });
        const explicitRoot = gitDiff({ root }, { mode: "staged", path: "." });

        expect(defaultScope.diff).toContain("root-a.txt");
        expect(defaultScope.diff).toContain("nested/root-b.txt");
        expect(explicitRoot.diff).toBe(defaultScope.diff);
      }
    );
  });

  it("keeps a cross-boundary rename pair together at the 50-path batch boundary", () => {
    const files: Record<string, string> = { "scoped/rename.txt": "synthetic rename payload\n" };
    for (let index = 0; index < 49; index += 1) {
      files[`files/${String(index).padStart(2, "0")}.txt`] = "synthetic before\n";
    }

    withRepo(files, (root) => {
      for (let index = 0; index < 49; index += 1) {
        write(root, `files/${String(index).padStart(2, "0")}.txt`, "synthetic after\n");
      }
      fs.mkdirSync(path.join(root, "outside"), { recursive: true });
      git(root, "mv", "scoped/rename.txt", "outside/rename.txt");
      git(root, "add", ".");

      const result = gitDiff({ root }, { mode: "staged" });

      expect(result.diff).toContain("rename from scoped/rename.txt");
      expect(result.diff).toContain("rename to outside/rename.txt");
      expect(result.diff).toContain("synthetic after");
    });
  });

  it("withholds both sensitive rename endpoints under a scoped diff", () => {
    withRepo({ ".env": "SYNTHETIC_SECRET_OLD_SIDE_ONLY_TEST\n" }, (root) => {
      fs.mkdirSync(path.join(root, "scoped"), { recursive: true });
      git(root, "mv", ".env", "scoped/old-sensitive-renamed.txt");

      const result = gitDiff({ root }, { mode: "staged", path: "scoped" });

      expect(result.diff).toBe("");
      expect(result.diff).not.toContain("SYNTHETIC_SECRET_OLD_SIDE_ONLY_TEST");
    });

    withRepo({ "scoped/new-sensitive-source.txt": "SYNTHETIC_SECRET_NEW_SIDE_ONLY_TEST\n" }, (root) => {
      git(root, "mv", "scoped/new-sensitive-source.txt", "scoped/.env.renamed");

      const result = gitDiff({ root }, { mode: "staged", path: "scoped" });

      expect(result.diff).toBe("");
      expect(result.diff).not.toContain("SYNTHETIC_SECRET_NEW_SIDE_ONLY_TEST");
    });
  });
});
