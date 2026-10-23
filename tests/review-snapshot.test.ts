import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createSnapshot, parseSnapshot, snapshotDigest } from "../src/review/snapshot.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const tempDirs: string[] = [];

function repo(): string {
  const dir = makeTmpDir("review-snapshot");
  tempDirs.push(dir);
  makeGitRepo(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) cleanup(tempDirs.pop()!);
});

function expectCode(fn: () => unknown, code: string): void {
  expect(fn).toThrowError(new Error(code));
}

describe("review snapshots", () => {
  it("enforces the aggregate before-plus-after byte cap at preparation and loading", () => {
    const root = repo();
    const paths = Array.from({ length: 5 }, (_, index) => `bounded-${index}.txt`);
    for (const file of paths) write(root, file, "x".repeat(64 * 1024));
    git(root, "add", ".");
    git(root, "commit", "-m", "bounded text");
    const exact = createSnapshot(root, { taskId: "aggregate", paths: paths.slice(0, 4) });
    expect(exact.files.reduce((bytes, file) => bytes + Buffer.byteLength(file.before!) + Buffer.byteLength(file.after!), 0)).toBe(512 * 1024);
    expect(() => createSnapshot(root, { taskId: "aggregate-over", paths })).toThrow("SNAPSHOT_SCHEMA");
    expect(() => parseSnapshot({ ...exact, files: [...exact.files, { path: "extra.txt", before: null, after: "x" }] })).toThrow("SNAPSHOT_SCHEMA");
  });

  it("applies custom ignore rules to snapshot preparation without allowing negation of static denies", () => {
    const root = repo();
    write(root, ".c2cignore", "hello.txt\n!.env.example\n");
    write(root, ".env.example", "ordinary text\n");
    expect(() => createSnapshot(root, { taskId: "custom-ignore", paths: ["hello.txt"] })).toThrow("SNAPSHOT_PATH");
    expect(() => createSnapshot(root, { taskId: "static-ignore", paths: [".env.example"] })).toThrow("SNAPSHOT_PATH");
    expect(createSnapshot(root, { taskId: "positive-control", paths: ["src/index.ts"] }).files).toHaveLength(1);
  });

  it("binds every approval field and fixed protocol budgets into the snapshot digest", () => {
    const root = repo();
    const snapshot = createSnapshot(root, { taskId: "digest-fields", paths: ["hello.txt"], dataClass: "public" });
    expect(snapshot.expiresAt - snapshot.createdAt).toBe(15 * 60_000);
    const digest = snapshotDigest(snapshot);
    const { version, taskId, provider, model, purpose, dataClass, files, ...scope } = snapshot;
    // Independent wire-contract value: changing a protocol budget must require a new approval.
    const bound = { version, taskId, provider, model, purpose, dataClass, ...scope,
      protocolLimits: { maxResponses: 32, maxResponseBytes: 16384, maxTotalBytes: 65536 }, files };
    expect(digest).toBe(createHash("sha256").update(JSON.stringify(bound)).digest("hex"));
    for (const patch of [{ taskId: "other-task" }, { model: "other-model" }, { maxCalls: 29 },
      { maxOutputBytes: snapshot.maxOutputBytes - 1 }, { expiresAt: snapshot.expiresAt - 1 },
      { createdAt: snapshot.createdAt - 1 }, { baseCommit: "b".repeat(40) },
      { files: [{ ...snapshot.files[0], after: "different approved content" }] }]) {
      expect(snapshotDigest({ ...snapshot, ...patch })).not.toBe(digest);
    }
    expect(() => parseSnapshot({ ...snapshot, provider: "external" })).toThrow("SNAPSHOT_SCHEMA");
    expect(() => parseSnapshot({ ...snapshot, purpose: "execute" })).toThrow("SNAPSHOT_SCHEMA");
  }, 9_000);

  it("captures a frozen HEAD/current pair that remains immutable after later live changes", () => {
    const root = repo();
    write(root, "hello.txt", "captured live value\n");

    const snapshot = createSnapshot(root, { taskId: "review-1", paths: ["hello.txt"] });
    write(root, "hello.txt", "later live value\n");

    expect(snapshot.files).toEqual([{ path: "hello.txt", before: "Hello from Codex with ChatGPT!\n", after: "captured live value\n" }]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.files[0])).toBe(true);
    expect(snapshot.model).toBe("mock-reviewer");
    expect(snapshot.dataClass).toBeUndefined();
    expect(snapshot.maxCalls).toBe(30);
    expect(snapshot.maxOutputBytes).toBe(512 * 1024);
  });

  it("preserves new and deleted files as null sides", () => {
    const root = repo();
    write(root, "new.txt", "new content\n");
    fs.unlinkSync(path.join(root, "hello.txt"));

    const snapshot = createSnapshot(root, { taskId: "review-2", paths: ["new.txt", "hello.txt"] });
    expect(snapshot.files).toEqual([
      { path: "new.txt", before: null, after: "new content\n" },
      { path: "hello.txt", before: "Hello from Codex with ChatGPT!\n", after: null },
    ]);
  });

  it("rejects traversal, ADS, UNC, globs, reserved names, agent metadata, and .env.example", () => {
    const root = repo();
    for (const candidate of ["../hello.txt", "a/../hello.txt", "file:stream", "\\\\server\\share", "C:/temp/x", "*.txt", "CON.txt", "dir/.meta/file.txt", ".env.example", ".codex/config.toml", ".agents/memory.txt", "AGENTS.md", "CLAUDE.md", "Council/output.txt"]) {
      expectCode(() => createSnapshot(root, { taskId: "review-path", paths: [candidate] }), "SNAPSHOT_PATH");
    }
  });

  it("rejects hardlinks and junction aliases without skipping the safety check", () => {
    const root = repo();
    fs.linkSync(path.join(root, "hello.txt"), path.join(root, "linked.txt"));
    expectCode(() => createSnapshot(root, { taskId: "review-hardlink", paths: ["linked.txt"] }), "SNAPSHOT_ALIAS");

    const outside = makeTmpDir("review-junction-target");
    tempDirs.push(outside);
    write(outside, "outside.txt", "outside\n");
    const junction = path.join(root, "junction");
    try {
      fs.symlinkSync(outside, junction, "junction");
    } catch {
      throw new Error("junction setup unavailable");
    }
    expectCode(() => createSnapshot(root, { taskId: "review-junction", paths: ["junction/outside.txt"] }), "SNAPSHOT_ALIAS");
  });

  it("rejects a junction root and a case-alias root", () => {
    const root = repo();
    const rootAlias = makeTmpDir("review-root-alias");
    tempDirs.push(rootAlias);
    const junction = path.join(rootAlias, "repo-link");
    try {
      fs.symlinkSync(root, junction, "junction");
    } catch {
      throw new Error("root junction setup unavailable");
    }
    expectCode(() => createSnapshot(junction, { taskId: "review-root-junction", paths: ["hello.txt"] }), "SNAPSHOT_ALIAS");
    expectCode(() => createSnapshot(root.toUpperCase(), { taskId: "review-root-case", paths: ["hello.txt"] }), "SNAPSHOT_ALIAS");
  });

  it("rejects oversized single-line content and hard input caps", () => {
    const root = repo();
    write(root, "huge.txt", "x".repeat(64 * 1024 + 1));
    expectCode(() => createSnapshot(root, { taskId: "review-huge", paths: ["huge.txt"] }), "SNAPSHOT_CONTENT");
    expectCode(() => createSnapshot(root, { taskId: "review-calls", paths: ["hello.txt"], maxCalls: 101 }), "SNAPSHOT_INPUT");
    expectCode(() => createSnapshot(root, { taskId: "review-output", paths: ["hello.txt"], maxOutputBytes: 2 * 1024 * 1024 + 1 }), "SNAPSHOT_INPUT");
    expectCode(() => createSnapshot(root, { taskId: "review-paths", paths: Array.from({ length: 21 }, () => "hello.txt") }), "SNAPSHOT_INPUT");
    expectCode(() => createSnapshot(root, { taskId: "not valid", paths: ["hello.txt"] }), "SNAPSHOT_INPUT");
    expectCode(() => createSnapshot(root, { taskId: "review-model", model: "model with spaces", paths: ["hello.txt"] }), "SNAPSHOT_INPUT");
  });

  it("binds data classification into the digest and rejects invalid values", () => {
    const root = repo();
    const snapshot = createSnapshot(root, { taskId: "review-class", dataClass: "public", paths: ["hello.txt"] });
    const tampered = { ...snapshot, dataClass: "synthetic" as const };

    expect(snapshotDigest(tampered)).not.toBe(snapshotDigest(snapshot));
    expectCode(() => parseSnapshot({ ...snapshot, dataClass: "confidential" }), "SNAPSHOT_SCHEMA");
    expectCode(() => createSnapshot(root, { taskId: "review-invalid-class", dataClass: "confidential" as never, paths: ["hello.txt"] }), "SNAPSHOT_INPUT");
  });

  it("normalizes a legacy v1 snapshot without classification to unclassified", () => {
    const root = repo();
    const current = createSnapshot(root, { taskId: "review-legacy", dataClass: "public", paths: ["hello.txt"] });
    const legacy: Record<string, unknown> = { ...current };
    delete legacy.dataClass;

    const parsed = parseSnapshot(legacy);
    expect(parsed.dataClass).toBeUndefined();
    expect(parsed.dataClass ?? "unclassified").toBe("unclassified");
    expect(parsed.dataClass).not.toBe("synthetic");
  });

  it("does not execute a Git executable supplied by the reviewed repository", () => {
    const root = repo();
    write(root, "git.exe", "not an executable");
    write(root, "git", "not an executable");
    const previous = process.env.PATH;
    process.env.PATH = root + path.delimiter + previous;
    try {
      expect(createSnapshot(root, { taskId: "trusted-git", paths: ["hello.txt"] }).files[0].path).toBe("hello.txt");
    } finally { process.env.PATH = previous; }
  });

  it("rejects credential signatures in HEAD and in a deleted current file", () => {
    const root = repo();
    write(root, "base-secret.txt", "token=really-secret-value\n");
    git(root, "add", "base-secret.txt");
    git(root, "commit", "-m", "secret base");
    expectCode(() => createSnapshot(root, { taskId: "review-base-secret", paths: ["base-secret.txt"] }), "SNAPSHOT_CONTENT");

    write(root, "removed-secret.txt", "-----BEGIN PRIVATE KEY-----\nunsafe\n");
    git(root, "add", "removed-secret.txt");
    git(root, "commit", "-m", "secret deleted");
    fs.unlinkSync(path.join(root, "removed-secret.txt"));
    expectCode(() => createSnapshot(root, { taskId: "review-deleted-secret", paths: ["removed-secret.txt"] }), "SNAPSHOT_CONTENT");

    write(root, "multiple-values.txt", "token=placeholder\npassword=actually-secret\n");
    expectCode(() => createSnapshot(root, { taskId: "review-multiple-secret", paths: ["multiple-values.txt"] }), "SNAPSHOT_CONTENT");
  });

  it("rejects invalid UTF-8 and NUL-containing working content", () => {
    const root = repo();
    fs.writeFileSync(path.join(root, "hello.txt"), Buffer.from([0xc3, 0x28]));
    expectCode(() => createSnapshot(root, { taskId: "review-binary", paths: ["hello.txt"] }), "SNAPSHOT_CONTENT");
    fs.writeFileSync(path.join(root, "hello.txt"), Buffer.from("safe\0unsafe", "utf8"));
    expectCode(() => createSnapshot(root, { taskId: "review-nul", paths: ["hello.txt"] }), "SNAPSHOT_CONTENT");
  });

  it("canonicalizes digest input and rejects schema tampering or sensitive loaded data", () => {
    const root = repo();
    const snapshot = createSnapshot(root, { taskId: "review-digest", paths: ["hello.txt"] });
    const reordered = {
      files: snapshot.files.map((file) => ({ after: file.after, path: file.path, before: file.before })),
      maxOutputBytes: snapshot.maxOutputBytes,
      maxCalls: snapshot.maxCalls,
      expiresAt: snapshot.expiresAt,
      createdAt: snapshot.createdAt,
      baseCommit: snapshot.baseCommit,
      root: snapshot.root,
      purpose: snapshot.purpose,
      model: snapshot.model,
      provider: snapshot.provider,
      taskId: snapshot.taskId,
      version: snapshot.version,
    };
    expect(snapshotDigest(reordered)).toBe(snapshotDigest(snapshot));
    expect(parseSnapshot(reordered)).toEqual(snapshot);

    expectCode(() => parseSnapshot({ ...reordered, maxCalls: 101 }), "SNAPSHOT_SCHEMA");
    expectCode(() => parseSnapshot({ ...reordered, unknown: true }), "SNAPSHOT_SCHEMA");
    expectCode(() => parseSnapshot({ ...reordered, files: [{ path: "hello.txt", before: "token=leaked", after: null }] }), "SNAPSHOT_CONTENT");
    expectCode(() => parseSnapshot({ ...reordered, files: [{ path: "hello.txt", before: '{"password": "leaked"}', after: null }] }), "SNAPSHOT_CONTENT");
    for (const filePath of ["private.pem", ".npmrc", "secrets.json", "ai-council/advisors/result.md", "SESSION_MEMORY_2026-08-30.md", "HANDOFF_2026-08-30.md", ".c2c.json"]) {
      expectCode(() => parseSnapshot({ ...reordered, files: [{ path: filePath, before: "ordinary text", after: null }] }), "SNAPSHOT_PATH");
    }
    expectCode(() => parseSnapshot({ ...reordered, root: "\\\\server\\share\\repo" }), "SNAPSHOT_ROOT");
    expectCode(() => parseSnapshot({ ...reordered, files: [
      { path: "hello.txt", before: "a", after: "b" }, { path: "HELLO.txt", before: "c", after: "d" },
    ] }), "SNAPSHOT_SCHEMA");
  });
});
