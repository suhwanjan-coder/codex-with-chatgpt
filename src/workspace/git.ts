import { spawnSync } from "node:child_process";
import { IgnoreRules } from "./ignore.js";

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stdoutBytes: Buffer;
  stderr: string;
  code: number | null;
}

export function runGit(root: string, args: string[]): GitCommandResult {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
  const stdoutBytes = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout ?? "", "utf8");
  const stderr = Buffer.isBuffer(result.stderr)
    ? result.stderr.toString("utf8")
    : result.stderr ?? "";
  return {
    ok: result.status === 0,
    stdout: stdoutBytes.toString("utf8"),
    stdoutBytes,
    stderr,
    code: result.status,
  };
}

export interface GitInfo {
  isRepo: boolean;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
}

export function gitInfo(root: string): GitInfo {
  const check = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!check.ok || check.stdout.trim() !== "true") {
    return { isRepo: false, branch: null, commit: null, dirty: false };
  }
  const branch = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = runGit(root, ["rev-parse", "--short", "HEAD"]);
  // Pathspec confines the result to the workspace subtree even when the
  // workspace root sits inside a larger repository.
  const status = runGit(root, ["status", "--porcelain", "--", "."]);
  return {
    isRepo: true,
    branch: branch.ok ? branch.stdout.trim() : null,
    commit: commit.ok ? commit.stdout.trim() : null,
    dirty: status.ok ? status.stdout.trim().length > 0 : false,
  };
}

export interface GitStatusResult {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: { path: string; change: string }[];
  unstaged: { path: string; change: string }[];
  untracked: string[];
  conflicted: string[];
}

export function gitStatus(root: string): GitStatusResult {
  const empty: GitStatusResult = {
    isRepo: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
  const result = runGit(root, ["status", "--porcelain=v2", "-z", "--branch", "--", "."]);
  if (!result.ok) return empty;
  const out: GitStatusResult = { ...empty, isRepo: true };
  const records = result.stdout.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;

    if (record.startsWith("# branch.head ")) {
      out.branch = record.slice("# branch.head ".length).trim();
    } else if (record.startsWith("# branch.upstream ")) {
      out.upstream = record.slice("# branch.upstream ".length).trim();
    } else if (record.startsWith("# branch.ab ")) {
      const m = record.match(/\+(\d+) -(\d+)/);
      if (m) {
        out.ahead = parseInt(m[1], 10);
        out.behind = parseInt(m[2], 10);
      }
    } else if (record.startsWith("1 ")) {
      const parsed = splitPorcelainRecord(record, 8);
      if (!parsed) continue;
      const xy = parsed.fields[1] ?? "";
      const x = xy[0] ?? ".";
      const y = xy[1] ?? ".";
      if (x !== ".") out.staged.push({ path: parsed.path, change: x });
      if (y !== ".") out.unstaged.push({ path: parsed.path, change: y });
    } else if (record.startsWith("2 ")) {
      const parsed = splitPorcelainRecord(record, 9);
      const originalPath = records[index + 1];
      if (!parsed || !originalPath) continue;
      index += 1;
      const xy = parsed.fields[1] ?? "";
      const x = xy[0] ?? ".";
      const y = xy[1] ?? ".";
      const filePath = `${originalPath} -> ${parsed.path}`;
      if (x !== ".") out.staged.push({ path: filePath, change: x });
      if (y !== ".") out.unstaged.push({ path: filePath, change: y });
    } else if (record.startsWith("? ")) {
      out.untracked.push(record.slice(2));
    } else if (record.startsWith("u ")) {
      const parsed = splitPorcelainRecord(record, 10);
      if (parsed) out.conflicted.push(parsed.path);
    }
  }
  return out;
}

function splitPorcelainRecord(
  record: string,
  metadataFieldCount: number
): { fields: string[]; path: string } | null {
  const fields: string[] = [];
  let offset = 0;
  for (let index = 0; index < metadataFieldCount; index += 1) {
    const separator = record.indexOf(" ", offset);
    if (separator < 0) return null;
    fields.push(record.slice(offset, separator));
    offset = separator + 1;
  }
  return { fields, path: record.slice(offset) };
}

export type DiffMode = "unstaged" | "staged" | "head";

export interface GitDiffOptions {
  mode?: DiffMode;
  path?: string;
  offset?: number;
  maxBytes?: number;
}

export interface GitDiffResult {
  isRepo: boolean;
  mode: DiffMode;
  totalBytes: number;
  offset: number;
  returnedBytes: number;
  hasMore: boolean;
  nextOffset: number | null;
  diff: string;
  error?: GitDiffError;
}

export type GitDiffError =
  | "GIT_DIFF_INVENTORY_FAILED"
  | "GIT_DIFF_BATCH_FAILED"
  | "GIT_DIFF_TOO_LARGE"
  | "GIT_DIFF_UNSAFE_METADATA"
  | "GIT_DIFF_INVALID_OFFSET";

export interface WorkspaceLike {
  root: string;
  ignoreRules?: IgnoreRules;
}

export type GitTarget = string | WorkspaceLike;

function getDiffModeArgs(mode: DiffMode): string[] {
  if (mode === "staged") return ["--cached"];
  if (mode === "head") return ["HEAD"];
  return [];
}

function chunkSafePaths(pathGroups: string[][], maxCount = 50, maxBytes = 32 * 1024): string[][] {
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentBytes = 0;

  for (const group of pathGroups) {
    const groupBytes = group.reduce(
      (total, p) => total + Buffer.byteLength(p, "utf8") + 12,
      0
    ); // overhead for ":(literal)"
    if (
      currentBatch.length > 0 &&
      (currentBatch.length + group.length > maxCount || currentBytes + groupBytes > maxBytes)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }
    currentBatch.push(...group);
    currentBytes += groupBytes;
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  return batches;
}

function normalizeScope(scope?: string): string | undefined {
  if (!scope || scope === ".") return scope;
  const slashScope = scope.replace(/\\/g, "/");
  if (slashScope === "./") return ".";
  const withoutLeadingCurrent = slashScope.replace(/^(?:\.\/)+/, "");
  const withoutTrailingSlash = withoutLeadingCurrent.replace(/\/+$/, "");
  return withoutTrailingSlash || slashScope;
}

function isPathInScope(filePath: string, scope?: string): boolean {
  const normalizedScope = normalizeScope(scope);
  if (!normalizedScope || normalizedScope === ".") return true;
  return filePath === normalizedScope || filePath.startsWith(normalizedScope + "/");
}

type GitPatchValidation =
  | { ok: true; patch: string }
  | { ok: false };

const RAW_DIFF_HEADER = /^:[0-7]{6} [0-7]{6} (?:[0-9a-f]{40}|[0-9a-f]{64}) (?:[0-9a-f]{40}|[0-9a-f]{64}) (?:[ADMTUXB]|[RC](?:[0-9]{1,2}|100))$/;

/**
 * Accept only Git's NUL-delimited raw records and return the patch verbatim.
 * The raw records, rather than quoted patch headers, are the authorization source.
 */
export function extractValidatedGitPatch(
  output: string,
  allowedPaths: ReadonlySet<string>,
  isSensitive: (filePath: string) => boolean
): GitPatchValidation {
  let offset = 0;
  let records = 0;

  const readNulToken = (): string | null => {
    const terminator = output.indexOf("\0", offset);
    if (terminator < 0) return null;
    const token = output.slice(offset, terminator);
    offset = terminator + 1;
    return token;
  };

  const validatePath = (filePath: string | null): filePath is string =>
    filePath !== null && filePath.length > 0 && allowedPaths.has(filePath) && !isSensitive(filePath);

  while (output[offset] === ":") {
    const header = readNulToken();
    if (!header || !RAW_DIFF_HEADER.test(header)) return { ok: false };

    const status = header.at(-1)!;
    const oldPath = readNulToken();
    if (!validatePath(oldPath)) return { ok: false };

    if (status >= "0" && status <= "9") {
      const newPath = readNulToken();
      if (!validatePath(newPath)) return { ok: false };
    }
    records += 1;
  }

  // Git emits one NUL separator between the final raw pathname and --patch output.
  if (records === 0 || output[offset] !== "\0") return { ok: false };
  offset += 1;
  if (!output.startsWith("diff --git ", offset)) return { ok: false };
  return { ok: true, patch: output.slice(offset) };
}

function emptyGitDiff(mode: DiffMode, isRepo: boolean, error?: GitDiffError): GitDiffResult {
  return {
    isRepo,
    mode,
    totalBytes: 0,
    offset: 0,
    returnedBytes: 0,
    hasMore: false,
    nextOffset: null,
    diff: "",
    ...(error ? { error } : {}),
  };
}

export function gitDiff(
  target: GitTarget,
  opts: GitDiffOptions = {},
  relPath?: string
): GitDiffResult {
  const root = typeof target === "string" ? target : target.root;
  const ignoreRules =
    typeof target === "object" && target.ignoreRules
      ? target.ignoreRules
      : new IgnoreRules(root);

  const mode = opts.mode ?? "unstaged";
  const rawOffset = opts.offset ?? 0;
  const rawMaxBytes = opts.maxBytes ?? 64 * 1024;
  const scope = relPath ?? opts.path;
  const modeArgs = getDiffModeArgs(mode);

  // 1. Full-workspace inventory using NUL separation and global rename detection
  const listArgs = [
    "diff",
    "--name-status",
    "-z",
    "--find-renames=1%",
    ...modeArgs,
    "--",
    ".",
  ];
  const listResult = runGit(root, listArgs);
  if (!listResult.ok) {
    const check = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
    const isRepo = check.ok && check.stdout.trim() === "true";
    return emptyGitDiff(mode, isRepo, isRepo ? "GIT_DIFF_INVENTORY_FAILED" : undefined);
  }
  if (!Number.isFinite(rawOffset) || !Number.isFinite(rawMaxBytes)) {
    return emptyGitDiff(mode, true, "GIT_DIFF_INVALID_OFFSET");
  }
  const offset = Math.max(0, Math.floor(rawOffset));
  const maxBytes = Math.min(256 * 1024, Math.max(1024, Math.floor(rawMaxBytes)));

  const tokens = listResult.stdout.split("\0");
  const safePathGroups: string[][] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    if (!status) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (oldPath && newPath) {
        // Layer 1: Security - EITHER side sensitive -> completely unsafe
        const isSafe = !ignoreRules.isSensitive(oldPath) && !ignoreRules.isSensitive(newPath);
        // Layer 2: Scope - EITHER side in scope -> relevant
        const isRelevant = isPathInScope(oldPath, scope) || isPathInScope(newPath, scope);
        if (isSafe && isRelevant) {
          safePathGroups.push([oldPath, newPath]);
        }
      }
    } else {
      const filePath = tokens[i++];
      if (filePath) {
        const isSafe = !ignoreRules.isSensitive(filePath);
        const isRelevant = isPathInScope(filePath, scope);
        if (isSafe && isRelevant) {
          safePathGroups.push([filePath]);
        }
      }
    }
  }

  if (safePathGroups.length === 0) {
    return emptyGitDiff(mode, true);
  }

  // 2. Fetch diffs for safe paths in bounded batches (path count + argv bytes)
  const batches = chunkSafePaths(safePathGroups);
  const diffChunks: Buffer[] = [];
  let totalAggregateBytes = 0;
  const MAX_AGGREGATE_DIFF_BYTES = 64 * 1024 * 1024;

  for (const batch of batches) {
    const pathspecs = batch.map((p) => `:(literal)${p}`);
    const diffArgs = [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--submodule=short",
      "--no-abbrev",
      "--raw",
      "-z",
      "--patch",
      "--find-renames=1%",
      ...modeArgs,
      "--",
      ...pathspecs,
    ];
    const diffResult = runGit(root, diffArgs);
    if (!diffResult.ok) {
      // Fail closed on any batch error: never return partial silent success
      return emptyGitDiff(mode, true, "GIT_DIFF_BATCH_FAILED");
    }
    const validated = extractValidatedGitPatch(
      diffResult.stdout,
      new Set(batch),
      (filePath) => ignoreRules.isSensitive(filePath)
    );
    if (!validated.ok) {
      return emptyGitDiff(mode, true, "GIT_DIFF_UNSAFE_METADATA");
    }
    if (validated.patch) {
      const patchBytes = Buffer.from(validated.patch, "utf8");
      const patchOffset = diffResult.stdoutBytes.length - patchBytes.length;
      if (
        patchOffset < 0 ||
        !diffResult.stdoutBytes.subarray(patchOffset).equals(patchBytes)
      ) {
        return emptyGitDiff(mode, true, "GIT_DIFF_UNSAFE_METADATA");
      }
      const chunkBytes = patchBytes.length;
      if (totalAggregateBytes + chunkBytes > MAX_AGGREGATE_DIFF_BYTES) {
        // Fail closed on aggregate cap: do not fake a partial successful diff
        return emptyGitDiff(mode, true, "GIT_DIFF_TOO_LARGE");
      }
      diffChunks.push(patchBytes);
      totalAggregateBytes += chunkBytes;
    }
  }

  const full = Buffer.concat(diffChunks, totalAggregateBytes);
  if (offset < full.length && (full[offset] & 0xc0) === 0x80) {
    return emptyGitDiff(mode, true, "GIT_DIFF_INVALID_OFFSET");
  }
  let end = Math.min(full.length, offset + maxBytes);
  while (end > offset && end < full.length && (full[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  if (end < full.length) {
    const lastNewline = full.lastIndexOf(0x0a, end - 1);
    if (lastNewline >= offset) {
      end = lastNewline + 1;
    }
  }
  const page = full.subarray(offset, end);
  const text = page.toString("utf8");
  const returnedBytes = page.length;
  const hasMore = end < full.length;
  return {
    isRepo: true,
    mode,
    totalBytes: full.length,
    offset,
    returnedBytes,
    hasMore,
    nextOffset: hasMore ? end : null,
    diff: text,
  };
}
