import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { parseSnapshot, snapshotDigest, REVIEW_PROTOCOL_LIMITS, type ReviewSnapshot } from "./snapshot.js";
import { ensurePrivateDirectory, privateStorageFailure, writePrivateNewFile } from "./private-storage.js";

export type ReviewTool = "review_info" | "read_file" | "review_diff" | "review_complete";
export type ReviewResult = { content: { type: "text"; text: string }[]; isError?: boolean };
export interface SessionOptions {
  approvalDigest: string;
  stateDir: string;
  idleMs?: number;
  now?: () => number;
}

export interface RemoteReviewAuditMetadata {
  resource: string;
  redirectUri: string;
  model: string;
  permitDigest: string;
}

function result(data: unknown, isError = false): ReviewResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], ...(isError ? { isError } : {}) };
}

function writeAll(fd: number, text: string): void {
  const buffer = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (!Number.isInteger(written) || written <= 0 || written > buffer.length - offset) throw new Error("INCOMPLETE_WRITE");
    offset += written;
  }
}

function safeStateDirectory(dir: string, root: string): string {
  const target = path.resolve(dir);
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("STATE_INSIDE_REVIEW_ROOT");
  }
  let current = target;
  while (path.dirname(current) !== current) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("LINKED_STATE_DIRECTORY");
    current = path.dirname(current);
  }
  if (!fs.existsSync(target)) {
    try { ensurePrivateDirectory(target); } catch (error) { throw privateStorageFailure("STATE_DIRECTORY_UNAVAILABLE", error); }
  }
  if (!fs.lstatSync(target).isDirectory()) throw new Error("STATE_DIRECTORY_UNAVAILABLE");
  if (fs.realpathSync.native(target).toLowerCase() !== target.toLowerCase()) throw new Error("LINKED_STATE_DIRECTORY");
  return target;
}

function refuseLegacyStateArtifacts(stateDir: string): void {
  try {
    for (const entry of fs.readdirSync(stateDir)) {
      if (/(?:\.lock|\.audit\.jsonl|\.auth\.json)$/i.test(entry)) throw new Error("LEGACY_REVIEW_STATE_LAYOUT");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "LEGACY_REVIEW_STATE_LAYOUT") throw error;
    throw new Error("STATE_DIRECTORY_UNAVAILABLE");
  }
}

/** A single approved, immutable review. No tool reads the live repository. */
export class ReviewSession {
  readonly digest: string;
  readonly root: string;
  readonly expiresAt: number;
  readonly privateStateDir: string;
  readonly authStoreFile: string;
  readonly auditFile: string;
  private readonly snapshot: ReviewSnapshot;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly auditFd: number;
  private readonly lockFile: string;
  private readonly lockFd: number;
  private closed = false;
  private auditClosed = false;
  private calls = 0;
  private outputBytes = 0;
  private suppress = false;
  private protocolResponses = 0;
  private protocolBytes = 0;
  private lastActivity: number;
  private listeners: (() => void)[] = [];
  private remoteReview?: Readonly<RemoteReviewAuditMetadata>;

  constructor(input: unknown, opts: SessionOptions) {
    this.snapshot = parseSnapshot(input);
    this.digest = snapshotDigest(this.snapshot);
    if (!/^[a-f0-9]{64}$/.test(opts.approvalDigest) ||
        !timingSafeEqual(Buffer.from(this.digest), Buffer.from(opts.approvalDigest))) {
      throw new Error("APPROVAL_MISMATCH");
    }
    this.root = this.snapshot.root;
    this.expiresAt = this.snapshot.expiresAt;
    this.now = opts.now ?? Date.now;
    this.lastActivity = this.now();
    this.idleMs = opts.idleMs ?? 120_000;
    if (!Number.isSafeInteger(this.idleMs) || this.idleMs < 1 || this.idleMs > 300_000) throw new Error("INVALID_IDLE_LIMIT");
    if (this.lastActivity < this.snapshot.createdAt || this.lastActivity >= this.expiresAt) throw new Error("SNAPSHOT_EXPIRED");
    const state = safeStateDirectory(opts.stateDir, this.root);
    refuseLegacyStateArtifacts(state);
    try { this.privateStateDir = ensurePrivateDirectory(path.join(state, ".c2c-review-private")); }
    catch (error) { throw privateStorageFailure("PRIVATE_STATE_UNAVAILABLE", error); }
    this.authStoreFile = path.join(this.privateStateDir, `${this.digest}.auth.json`);
    this.lockFile = path.join(this.privateStateDir, `${createHash("sha256").update(this.root.toLowerCase()).digest("hex")}.lock`);
    let acquiredLock: number | undefined;
    try {
      writePrivateNewFile(this.lockFile, JSON.stringify({ pid: process.pid, digest: this.digest }));
      acquiredLock = fs.openSync(this.lockFile, "r+");
      fs.fsyncSync(acquiredLock);
    } catch (error) {
      if (acquiredLock !== undefined) {
        try {
          const opened = fs.fstatSync(acquiredLock);
          const current = fs.lstatSync(this.lockFile);
          if (!current.isSymbolicLink() && current.ino === opened.ino && current.dev === opened.dev) fs.unlinkSync(this.lockFile);
        } catch { /* Keep an uncertain lock for explicit local inspection. */ }
        try { fs.closeSync(acquiredLock); } catch { /* Preserve the original failure. */ }
      }
      throw privateStorageFailure("WORKSPACE_LOCKED_OR_STATE_UNAVAILABLE", error);
    }
    this.lockFd = acquiredLock;
    // Exclusive creation doubles as a durable, single-use approval receipt.
    this.auditFile = path.join(this.privateStateDir, `${this.digest}.audit.jsonl`);
    try {
      writePrivateNewFile(this.auditFile, "");
      this.auditFd = fs.openSync(this.auditFile, "a");
    } catch (error) {
      try { this.releaseLock(); } catch { /* Preserve the original failure. */ }
      throw privateStorageFailure("APPROVAL_USED_OR_AUDIT_UNAVAILABLE", error);
    }
    try {
      writePrivateNewFile(this.authStoreFile, JSON.stringify({ clients: [], tokens: [] }));
    } catch (error) {
      try { fs.closeSync(this.auditFd); } catch { /* Still release the lock. */ }
      try { this.releaseLock(); } catch { /* Preserve the original failure. */ }
      throw privateStorageFailure("AUTH_STORE_UNAVAILABLE", error);
    }
    try {
      this.audit("session_start", [], 0, "approved");
    } catch (error) {
      this.closed = true;
      try { fs.closeSync(this.auditFd); } catch { /* Still release the lock. */ }
      this.auditClosed = true;
      try { this.releaseLock(); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  private releaseLock(): void {
    try {
      const opened = fs.fstatSync(this.lockFd);
      const current = fs.lstatSync(this.lockFile);
      if (current.ino === opened.ino && current.dev === opened.dev && !current.isSymbolicLink()) fs.unlinkSync(this.lockFile);
    } finally {
      fs.closeSync(this.lockFd);
    }
  }

  onClose(listener: () => void): void {
    if (this.closed) listener();
    else this.listeners.push(listener);
  }

  get suppressResponse(): boolean { return this.suppress; }

  accountProtocol(bytes: number): boolean {
    if (!this.isActive()) return false;
    this.protocolResponses++;
    const over = !Number.isSafeInteger(bytes) || bytes < 0 || bytes > REVIEW_PROTOCOL_LIMITS.maxResponseBytes ||
      this.protocolResponses > REVIEW_PROTOCOL_LIMITS.maxResponses || this.protocolBytes + bytes > REVIEW_PROTOCOL_LIMITS.maxTotalBytes;
    try { this.audit("protocol", [], over ? 0 : bytes, over ? "PROTOCOL_BUDGET_EXCEEDED" : "ok"); }
    catch { this.close("audit_failure"); return false; }
    if (over) { this.close("budget"); return false; }
    this.protocolBytes += bytes;
    return true;
  }

  isActive(): boolean {
    if (!this.closed && (this.now() >= this.expiresAt || this.now() - this.lastActivity >= this.idleMs)) this.close("expired");
    return !this.closed;
  }

  /** Records the approved remote destination before the bridge can expose review data. */
  recordRemoteReview(metadata: RemoteReviewAuditMetadata): void {
    if (!this.isActive()) throw new Error("SESSION_CLOSED");
    if (this.remoteReview) throw new Error("REMOTE_REVIEW_ALREADY_RECORDED");
    const value = Object.freeze({ ...metadata });
    this.audit("remote_review", [], 0, "approved", value);
    this.remoteReview = value;
  }

  private audit(tool: string, paths: string[], bytes: number, outcome: string, metadata?: Readonly<RemoteReviewAuditMetadata>): void {
    try {
      if (this.auditClosed || fs.fstatSync(this.auditFd).nlink !== 1) throw new Error();
      writeAll(this.auditFd, JSON.stringify({
        timestamp: new Date(this.now()).toISOString(), requestId: randomUUID(),
        session: this.digest, tool, paths, bytes, outcome, ...(metadata ? { metadata } : {}),
      }) + "\n");
      fs.fsyncSync(this.auditFd);
    } catch {
      throw new Error("AUDIT_UNAVAILABLE");
    }
  }

  close(reason = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.audit("session_end", [], 0, ["completed", "expired", "budget", "audit_failure"].includes(reason) ? reason : "closed");
    } catch {
      // Access is already revoked; failure must not prevent socket/token cleanup.
    } finally {
      if (!this.auditClosed) { try { fs.closeSync(this.auditFd); } catch { /* Continue revocation callbacks. */ } }
      this.auditClosed = true;
      try { this.releaseLock(); } catch { /* A stale lock is fail-closed and needs local inspection. */ }
      for (const listener of this.listeners.splice(0)) { try { listener(); } catch { /* Run every cleanup callback. */ } }
    }
  }

  invoke(tool: string, input: unknown, scopes: string[] = [], envelope?: (response: ReviewResult) => unknown): ReviewResult {
    if (!this.isActive()) { this.suppress = true; return result({ error: "SESSION_CLOSED" }, true); }
    const auditPaths: string[] = [];
    let code: string | undefined;
    let data: unknown;
    const knownTool = ["review_info", "read_file", "review_diff", "review_complete"].includes(tool);
    const auditTool = knownTool ? tool : "unknown_tool";
    const finish = (response: ReviewResult, outcome: string, closeReason?: string): ReviewResult => {
      const bytes = Buffer.byteLength(JSON.stringify(envelope ? envelope(response) : response));
      if (this.outputBytes + bytes > this.snapshot.maxOutputBytes) {
        this.suppress = true;
        try { this.audit(auditTool, auditPaths, 0, "OUTPUT_BUDGET_EXCEEDED"); } catch { /* Fail closed below. */ }
        this.close("budget");
        return result({ error: "OUTPUT_BUDGET_EXCEEDED" }, true);
      }
      try { this.audit(auditTool, auditPaths, bytes, outcome); }
      catch {
        this.suppress = true;
        this.close("audit_failure");
        return result({ error: "AUDIT_UNAVAILABLE" }, true);
      }
      this.outputBytes += bytes;
      this.lastActivity = this.now();
      if (closeReason) this.close(closeReason);
      return response;
    };
    const args = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    if (!input || typeof input !== "object" || Array.isArray(input)) code = "INVALID_ARGUMENTS";
    if (!knownTool) code = "UNKNOWN_TOOL";
    const required = tool === "review_diff" ? "git.read" : "workspace.read";
    this.calls++;
    if (this.calls > this.snapshot.maxCalls) {
      return finish(result({ error: "CALL_BUDGET_EXCEEDED" }, true), "CALL_BUDGET_EXCEEDED", "budget");
    }
    if (!scopes.includes(required)) code = "INSUFFICIENT_SCOPE";
    const keys = Object.keys(args);
    if (!code && tool === "read_file") {
      if (keys.some((key) => key !== "path" && key !== "version") || typeof args.path !== "string" ||
          (args.version !== undefined && args.version !== "before" && args.version !== "after")) code = "INVALID_ARGUMENTS";
      else {
        const file = this.snapshot.files.find((item) => item.path === args.path);
        if (!file) code = "PATH_NOT_APPROVED";
        else {
          auditPaths.push(file.path);
          const version = args.version === "before" ? "before" : "after";
          data = { path: file.path, version, content: file[version], snapshot: this.digest };
        }
      }
    } else if (!code && tool === "review_diff") {
      if (keys.length !== 1 || typeof args.path !== "string") code = "INVALID_ARGUMENTS";
      else {
        const file = this.snapshot.files.find((item) => item.path === args.path);
        if (!file) code = "PATH_NOT_APPROVED";
        else {
          auditPaths.push(file.path);
          data = { ...file, baseCommit: this.snapshot.baseCommit, snapshot: this.digest, format: "before-after" };
        }
      }
    } else if (!code && (tool === "review_info" || tool === "review_complete")) {
      if (keys.length) code = "INVALID_ARGUMENTS";
      else if (tool === "review_complete") data = { completed: true, snapshot: this.digest };
      else data = {
        taskId: this.snapshot.taskId, provider: this.snapshot.provider, model: this.snapshot.model,
        purpose: this.snapshot.purpose, snapshot: this.digest, baseCommit: this.snapshot.baseCommit,
        expiresAt: this.expiresAt, files: this.snapshot.files.map((file) => ({
          path: file.path, beforeBytes: Buffer.byteLength(file.before ?? ""), afterBytes: Buffer.byteLength(file.after ?? ""),
        })), callsRemaining: this.snapshot.maxCalls - this.calls,
        outputBytesRemaining: this.snapshot.maxOutputBytes - this.outputBytes,
        protocolLimits: REVIEW_PROTOCOL_LIMITS,
        ...(this.remoteReview ? { remoteReview: this.remoteReview } : {}),
      };
    } else if (!code) code = "UNKNOWN_TOOL";
    const response = result(code ? { error: code } : data, !!code);
    return finish(response, code ?? "ok", !code && tool === "review_complete" ? "completed" : undefined);
  }
}
