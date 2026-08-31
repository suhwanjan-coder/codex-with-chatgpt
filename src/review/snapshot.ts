import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import ignore from "ignore";
import { IgnoreRules, NOISE_PATTERNS, SENSITIVE_PATTERNS } from "../workspace/ignore.js";
import { assertSafeReviewContent } from "./content-safety.js";

const MAX_PATHS = 20;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_CONTENT_BYTES = 512 * 1024;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_CALLS = 30;
const HARD_MAX_CALLS = 100;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;
const HARD_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_BYTES = 4 * 1024;
export const REVIEW_PROTOCOL_LIMITS = Object.freeze({ maxResponses: 32, maxResponseBytes: 16 * 1024, maxTotalBytes: 64 * 1024 });
const GIT_NULL_DEVICE = process.platform === "win32" ? "NUL" : os.devNull;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const STATIC_DENY = ignore().add([...SENSITIVE_PATTERNS, ...NOISE_PATTERNS]);
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const BLOCKED_METADATA_NAMES = new Set([
  ".git",
  ".codex",
  ".agents",
  ".claude",
  "agents.md",
  "claude.md",
  "memory.md",
  "council.md",
  "memory",
  "memories",
  "council",
  "council-output",
  "council_output",
  "ai-council",
  "advisors",
  ".c2c.json",
  ".c2cignore",
]);
const SNAPSHOT_KEYS = ["version", "taskId", "provider", "model", "purpose", "dataClass", "root", "baseCommit", "createdAt", "expiresAt", "maxCalls", "maxOutputBytes", "files"] as const;
const LEGACY_SNAPSHOT_KEYS = SNAPSHOT_KEYS.filter((key) => key !== "dataClass");

export type ReviewDataClass = "public" | "synthetic" | "non-sensitive";

export interface ReviewSnapshot {
  version: 1;
  taskId: string;
  provider: "local-test";
  model: string;
  purpose: "diff-review";
  dataClass?: ReviewDataClass;
  root: string;
  baseCommit: string;
  createdAt: number;
  expiresAt: number;
  maxCalls: number;
  maxOutputBytes: number;
  files: Array<{ path: string; before: string | null; after: string | null }>;
}

export interface CreateSnapshotInput {
  taskId: string;
  provider?: "local-test";
  model?: string;
  dataClass?: ReviewDataClass;
  baseCommit?: string;
  paths: string[];
  ttlMs?: number;
  maxCalls?: number;
  maxOutputBytes?: number;
}

function fail(code: string): never {
  throw new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSafeInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function assertSafeText(value: unknown, min: number, max: number, code: string): asserts value is string {
  if (typeof value !== "string" || value.length < min || Buffer.byteLength(value, "utf8") > max || /[\0-\x1f\x7f]/.test(value)) {
    fail(code);
  }
}

function assertIdentifier(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) fail(code);
}

function validateRelativePath(value: unknown, ignoreRules?: IgnoreRules): string {
  assertSafeText(value, 1, 1024, "SNAPSHOT_PATH");
  const rel = value as string;
  if (
    rel.includes("\\") ||
    rel.startsWith("/") ||
    rel.startsWith("//") ||
    /^[A-Za-z]:/.test(rel) ||
    rel.includes(":") ||
    /[*?\[\]{}!]/.test(rel) ||
    path.posix.normalize(rel) !== rel ||
    rel.endsWith("/")
  ) {
    fail("SNAPSHOT_PATH");
  }
  const parts = rel.split("/");
  if (
    parts.some((part) =>
      part.length === 0 ||
      part === "." ||
      part === ".." ||
      /[. ]$/.test(part) ||
      RESERVED_WINDOWS_NAMES.test(part)
    ) ||
    parts.slice(0, -1).some((part) => part.startsWith(".")) ||
    parts.some((part) => BLOCKED_METADATA_NAMES.has(part.toLowerCase())) ||
    /^(?:session[_-]memory|handoff|council[_-](?:report|response|decision))[._-]/i.test(parts[parts.length - 1]) ||
    STATIC_DENY.ignores(rel) ||
    ignoreRules?.isHidden(rel)
  ) {
    fail("SNAPSHOT_PATH");
  }
  // The MVP deliberately rejects .env.example too: this review surface never carries env files.
  if (parts[parts.length - 1].toLowerCase().startsWith(".env")) fail("SNAPSHOT_PATH");
  return rel;
}

function assertCanonicalRoot(value: unknown): string {
  assertSafeText(value, 1, MAX_METADATA_BYTES, "SNAPSHOT_ROOT");
  const root = value as string;
  if (/^(?:\\\\|\/\/)/.test(root) || (process.platform === "win32" && !/^[A-Za-z]:\\/.test(root))) fail("SNAPSHOT_ROOT");
  if (!path.isAbsolute(root) || path.resolve(root) !== root || path.normalize(root) !== root) {
    fail("SNAPSHOT_ROOT");
  }
  const parsed = path.parse(root);
  if (root.length > parsed.root.length && /[\\/]$/.test(root)) fail("SNAPSHOT_ROOT");
  return root;
}

function assertStatIdentity(lstat: fs.Stats, stat: fs.Stats, type: "file" | "directory"): void {
  if (
    lstat.isSymbolicLink() ||
    (type === "file" ? !lstat.isFile() : !lstat.isDirectory()) ||
    lstat.dev !== stat.dev ||
    lstat.ino !== stat.ino ||
    (type === "file" && (lstat.nlink > 1 || stat.nlink > 1))
  ) {
    fail("SNAPSHOT_ALIAS");
  }
}

function assertDirectoryChain(root: string, rel?: string): void {
  const parts = rel ? rel.split("/").slice(0, -1) : [];
  let current = root;
  for (const part of ["", ...parts]) {
    if (part) current = path.join(current, part);
    let lstat: fs.Stats;
    let stat: fs.Stats;
    let real: string;
    try {
      lstat = fs.lstatSync(current);
      stat = fs.statSync(current);
      real = fs.realpathSync.native(current);
    } catch {
      fail("SNAPSHOT_ALIAS");
    }
    assertStatIdentity(lstat, stat, "directory");
    if (real !== current) fail("SNAPSHOT_ALIAS");
  }
}

function readCurrentFile(root: string, rel: string): string | null {
  assertDirectoryChain(root, rel);
  const target = path.join(root, ...rel.split("/"));
  let beforeLstat: fs.Stats;
  try {
    beforeLstat = fs.lstatSync(target);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    fail("SNAPSHOT_FILE");
  }
  let beforeStat: fs.Stats;
  let beforeReal: string;
  try {
    beforeStat = fs.statSync(target);
    beforeReal = fs.realpathSync.native(target);
  } catch {
    fail("SNAPSHOT_FILE");
  }
  assertStatIdentity(beforeLstat, beforeStat, "file");
  if (beforeReal !== target) fail("SNAPSHOT_ALIAS");

  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    assertStatIdentity(beforeLstat, opened, "file");
    const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    const afterOpen = fs.fstatSync(descriptor);
    assertStatIdentity(opened, afterOpen, "file");
    if (offset > MAX_FILE_BYTES) fail("SNAPSHOT_CONTENT");
    let afterLstat: fs.Stats;
    let afterReal: string;
    try {
      afterLstat = fs.lstatSync(target);
      afterReal = fs.realpathSync.native(target);
    } catch {
      fail("SNAPSHOT_FILE");
    }
    assertStatIdentity(afterLstat, afterOpen, "file");
    if (afterReal !== beforeReal || afterLstat.size !== beforeLstat.size) fail("SNAPSHOT_ALIAS");
    let content: string;
    try {
      content = UTF8.decode(buffer.subarray(0, offset));
    } catch {
      fail("SNAPSHOT_CONTENT");
    }
    assertSafeReviewContent(content, rel);
    return content;
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("SNAPSHOT_")) throw error;
    fail("SNAPSHOT_FILE");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  fail("SNAPSHOT_FILE");
}

function safeGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = GIT_NULL_DEVICE;
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function trustedGit(root: string): string {
  const executable = process.platform === "win32" ? "git.exe" : "git";
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    try {
      const candidate = fs.realpathSync.native(path.join(directory, executable));
      const relative = path.relative(root, candidate);
      if (relative !== "" && (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) && fs.statSync(candidate).isFile()) return candidate;
    } catch { /* Continue through the trusted launcher's absolute PATH entries. */ }
  }
  fail("SNAPSHOT_GIT");
}

function runGit(root: string, args: string[], maxBuffer = 128 * 1024): Buffer {
  const result = spawnSync(trustedGit(root), ["--no-replace-objects", "-c", `core.hooksPath=${GIT_NULL_DEVICE}`, "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", ...args], {
    cwd: root,
    env: safeGitEnv(),
    encoding: "buffer",
    maxBuffer,
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error || !Buffer.isBuffer(result.stdout)) fail("SNAPSHOT_GIT");
  return result.stdout;
}

function readHead(root: string): string {
  const head = runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"], 1024).toString("ascii").trim();
  if (!/^[0-9a-f]{40,64}$/.test(head)) fail("SNAPSHOT_GIT");
  return head;
}

function isCommitOid(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function verifyCommit(root: string, commit: string): string {
  const type = runGit(root, ["cat-file", "-t", commit], MAX_METADATA_BYTES).toString("ascii").trim();
  if (type !== "commit") fail("SNAPSHOT_GIT");
  return commit;
}

function assertRepositoryRoot(root: string): void {
  assertDirectoryChain(root);
  const gitDir = path.join(root, ".git");
  try {
    const lstat = fs.lstatSync(gitDir);
    const stat = fs.statSync(gitDir);
    assertStatIdentity(lstat, stat, "directory");
    if (fs.realpathSync.native(gitDir) !== gitDir) fail("SNAPSHOT_ALIAS");
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("SNAPSHOT_")) throw error;
    fail("SNAPSHOT_ROOT");
  }
  const topLevel = runGit(root, ["rev-parse", "--show-toplevel"], MAX_METADATA_BYTES).toString("utf8").trim();
  // Git for Windows emits forward slashes even when the canonical native root uses backslashes.
  if (path.resolve(topLevel) !== root) fail("SNAPSHOT_ROOT");
}

function readBaseFile(root: string, commit: string, rel: string): string | null {
  const listing = runGit(root, ["ls-tree", "-z", "--full-tree", commit, "--", rel], 8 * 1024);
  if (listing.length === 0) return null;
  const entries = listing.toString("utf8").split("\0");
  if (entries.length !== 2 || entries[1] !== "") fail("SNAPSHOT_GIT");
  const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/.exec(entries[0]);
  if (!match || match[3] !== rel) fail("SNAPSHOT_GIT");
  const blob = runGit(root, ["cat-file", "blob", match[2]], MAX_FILE_BYTES + 1);
  if (blob.length > MAX_FILE_BYTES) fail("SNAPSHOT_CONTENT");
  let content: string;
  try {
    content = UTF8.decode(blob);
  } catch {
    fail("SNAPSHOT_CONTENT");
  }
  assertSafeReviewContent(content, rel);
  return content;
}

function freezeSnapshot(snapshot: ReviewSnapshot): ReviewSnapshot {
  for (const file of snapshot.files) Object.freeze(file);
  Object.freeze(snapshot.files);
  return Object.freeze(snapshot);
}

function validateLoadedContent(value: unknown, filePath: string): string | null {
  if (value !== null && typeof value !== "string") fail("SNAPSHOT_SCHEMA");
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_FILE_BYTES) fail("SNAPSHOT_SCHEMA");
    assertSafeReviewContent(value, filePath);
  }
  return value;
}

function validateSnapshot(data: unknown): ReviewSnapshot {
  if (!isRecord(data) || (!hasExactKeys(data, SNAPSHOT_KEYS) && !hasExactKeys(data, LEGACY_SNAPSHOT_KEYS))) {
    fail("SNAPSHOT_SCHEMA");
  }
  if (data.version !== 1 || data.provider !== "local-test" || data.purpose !== "diff-review") fail("SNAPSHOT_SCHEMA");
  assertIdentifier(data.taskId, "SNAPSHOT_SCHEMA");
  assertIdentifier(data.model, "SNAPSHOT_SCHEMA");
  const dataClass = Object.prototype.hasOwnProperty.call(data, "dataClass") ? data.dataClass : undefined;
  if (dataClass !== undefined && dataClass !== "public" && dataClass !== "synthetic" && dataClass !== "non-sensitive") fail("SNAPSHOT_SCHEMA");
  const root = assertCanonicalRoot(data.root);
  if (typeof data.baseCommit !== "string" || !/^[0-9a-f]{40,64}$/.test(data.baseCommit)) fail("SNAPSHOT_SCHEMA");
  if (!isSafeInteger(data.createdAt, 0, Number.MAX_SAFE_INTEGER) || !isSafeInteger(data.expiresAt, 1, Number.MAX_SAFE_INTEGER) || data.expiresAt <= data.createdAt || data.expiresAt - data.createdAt > MAX_TTL_MS) {
    fail("SNAPSHOT_SCHEMA");
  }
  if (!isSafeInteger(data.maxCalls, 1, HARD_MAX_CALLS) || !isSafeInteger(data.maxOutputBytes, 1, HARD_MAX_OUTPUT_BYTES) || !Array.isArray(data.files) || data.files.length === 0 || data.files.length > MAX_PATHS) {
    fail("SNAPSHOT_SCHEMA");
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  const files = data.files.map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ["path", "before", "after"])) fail("SNAPSHOT_SCHEMA");
    const filePath = validateRelativePath(entry.path);
    if (paths.has(filePath.toLowerCase())) fail("SNAPSHOT_SCHEMA");
    paths.add(filePath.toLowerCase());
    const before = validateLoadedContent(entry.before, filePath);
    const after = validateLoadedContent(entry.after, filePath);
    totalBytes += (before === null ? 0 : Buffer.byteLength(before, "utf8"));
    totalBytes += (after === null ? 0 : Buffer.byteLength(after, "utf8"));
    if (before === null && after === null) fail("SNAPSHOT_SCHEMA");
    return { path: filePath, before, after };
  });
  if (totalBytes > MAX_CONTENT_BYTES) fail("SNAPSHOT_SCHEMA");
  const snapshot: ReviewSnapshot = {
    version: 1,
    taskId: data.taskId,
    provider: "local-test",
    model: data.model,
    purpose: "diff-review",
    root,
    baseCommit: data.baseCommit,
    createdAt: data.createdAt,
    expiresAt: data.expiresAt,
    maxCalls: data.maxCalls,
    maxOutputBytes: data.maxOutputBytes,
    files,
  };
  if (dataClass !== undefined) snapshot.dataClass = dataClass;
  return freezeSnapshot(snapshot);
}

/** Captures reviewable content from a pinned Git HEAD and current safe working files. */
export function createSnapshot(root: string, input: CreateSnapshotInput): ReviewSnapshot {
  const canonicalRoot = assertCanonicalRoot(path.resolve(root));
  if (!isRecord(input)) fail("SNAPSHOT_INPUT");
  assertRepositoryRoot(canonicalRoot);
  const ignoreRules = new IgnoreRules(canonicalRoot);
  assertIdentifier(input.taskId, "SNAPSHOT_INPUT");
  const model = input.model ?? "mock-reviewer";
  assertIdentifier(model, "SNAPSHOT_INPUT");
  if (input.provider !== undefined && input.provider !== "local-test") fail("SNAPSHOT_INPUT");
  if (input.dataClass !== undefined && input.dataClass !== "public" && input.dataClass !== "synthetic" && input.dataClass !== "non-sensitive") fail("SNAPSHOT_INPUT");
  if (input.baseCommit !== undefined && !isCommitOid(input.baseCommit)) fail("SNAPSHOT_INPUT");
  if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > MAX_PATHS) fail("SNAPSHOT_INPUT");
  const paths = input.paths.map((entry) => validateRelativePath(entry, ignoreRules));
  if (new Set(paths.map((filePath) => filePath.toLowerCase())).size !== paths.length) fail("SNAPSHOT_INPUT");
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const maxCalls = input.maxCalls ?? DEFAULT_MAX_CALLS;
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!isSafeInteger(ttlMs, 1, MAX_TTL_MS) || !isSafeInteger(maxCalls, 1, HARD_MAX_CALLS) || !isSafeInteger(maxOutputBytes, 1, HARD_MAX_OUTPUT_BYTES)) {
    fail("SNAPSHOT_INPUT");
  }

  const headAtStart = readHead(canonicalRoot);
  const baseCommit = input.baseCommit === undefined ? headAtStart : verifyCommit(canonicalRoot, input.baseCommit);
  const files = paths.map((filePath) => ({
    path: filePath,
    before: readBaseFile(canonicalRoot, baseCommit, filePath),
    after: readCurrentFile(canonicalRoot, filePath),
  }));
  if (readHead(canonicalRoot) !== headAtStart) fail("SNAPSHOT_GIT");
  const createdAt = Date.now();
  return validateSnapshot({
    version: 1,
    taskId: input.taskId,
    provider: "local-test",
    model,
    purpose: "diff-review",
    ...(input.dataClass === undefined ? {} : { dataClass: input.dataClass }),
    root: canonicalRoot,
    baseCommit,
    createdAt,
    expiresAt: createdAt + ttlMs,
    maxCalls,
    maxOutputBytes,
    files,
  });
}

/** Strictly accepts only canonical, bounded, non-sensitive serialized snapshot data. */
export function parseSnapshot(data: unknown): ReviewSnapshot {
  return validateSnapshot(data);
}

/** Stable SHA-256 for a schema-validated snapshot, independent of input key order. */
export function snapshotDigest(snapshot: ReviewSnapshot): string {
  const validated = parseSnapshot(snapshot);
  const canonical = JSON.stringify({
    version: validated.version,
    taskId: validated.taskId,
    provider: validated.provider,
    model: validated.model,
    purpose: validated.purpose,
    ...(validated.dataClass === undefined ? {} : { dataClass: validated.dataClass }),
    root: validated.root,
    baseCommit: validated.baseCommit,
    createdAt: validated.createdAt,
    expiresAt: validated.expiresAt,
    maxCalls: validated.maxCalls,
    maxOutputBytes: validated.maxOutputBytes,
    protocolLimits: REVIEW_PROTOCOL_LIMITS,
    files: validated.files.map((file) => ({ path: file.path, before: file.before, after: file.after })),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
