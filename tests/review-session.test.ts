import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewSession } from "../src/review/session.js";
import { snapshotDigest, type ReviewSnapshot } from "../src/review/snapshot.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const dirs: string[] = [];
const sessions: ReviewSession[] = [];
function tmp(name: string): string { const dir = makeTmpDir(name); dirs.push(dir); return dir; }
function sample(overrides: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  return { version: 1, taskId: "test", provider: "local-test", model: "mock-reviewer", purpose: "diff-review",
    root: tmp("session-root"), baseCommit: "a".repeat(40), createdAt: 1000, expiresAt: 901000,
    maxCalls: 30, maxOutputBytes: 524288,
    files: [{ path: "src/a.ts", before: "export const a = 1;", after: "export const a = 2;" }], ...overrides };
}
function open(snapshot = sample(), opts: { now?: () => number; stateDir?: string; idleMs?: number } = {}): ReviewSession {
  const session = new ReviewSession(snapshot, { approvalDigest: snapshotDigest(snapshot), stateDir: tmp("session-state"), now: () => 1000, ...opts });
  sessions.push(session);
  return session;
}
function payload(response: ReturnType<ReviewSession["invoke"]>): Record<string, unknown> {
  return JSON.parse(response.content[0].text);
}
afterEach(() => { for (const session of sessions.splice(0)) session.close(); for (const dir of dirs.splice(0)) cleanup(dir); });

describe("single-use review approval and audit", () => {
  it("rejects a changed snapshot or wrong approval", () => {
    const original = sample();
    const digest = snapshotDigest(original);
    original.files[0].after = "changed after approval";
    expect(() => new ReviewSession(original, { approvalDigest: digest, stateDir: tmp("mismatch"), now: () => 1000 })).toThrow("APPROVAL_MISMATCH");
  });
  it("detaches the approved snapshot from caller mutation", () => {
    const snapshot = sample();
    const session = open(snapshot);
    snapshot.files[0].after = "not approved";
    expect(payload(session.invoke("read_file", { path: "src/a.ts" }, ["workspace.read"])).content).toBe("export const a = 2;");
  });
  it("refuses missing scopes, outside paths, and unapproved arguments without leaking input", () => {
    const session = open();
    expect(payload(session.invoke("read_file", { path: "src/a.ts" }))).toEqual({ error: "INSUFFICIENT_SCOPE" });
    expect(payload(session.invoke("read_file", { path: "private-marker" }, ["workspace.read"]))).toEqual({ error: "PATH_NOT_APPROVED" });
    expect(payload(session.invoke("review_info", { query: "private-marker" }, ["workspace.read"]))).toEqual({ error: "INVALID_ARGUMENTS" });
    const audit = fs.readFileSync(session.auditFile, "utf8");
    expect(audit).not.toContain("private-marker");
    expect(audit).not.toContain("export const");
    expect(audit).not.toContain(session.root);
  });
  it("logs unique request ids, approved paths, serialized byte counts, results, and time", () => {
    const session = open();
    const response = session.invoke("review_diff", { path: "src/a.ts" }, ["git.read"]);
    const entries = fs.readFileSync(session.auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.at(-1)).toMatchObject({ tool: "review_diff", paths: ["src/a.ts"], bytes: Buffer.byteLength(JSON.stringify(response)), outcome: "ok" });
    expect(new Set(entries.map((entry) => entry.requestId)).size).toBe(entries.length);
  });
  it("completes once, fires cleanup once, and refuses reuse after restart", () => {
    const snapshot = sample();
    const stateDir = tmp("replay");
    const session = open(snapshot, { stateDir });
    let closed = 0;
    session.onClose(() => closed++);
    expect(payload(session.invoke("review_complete", {}, ["workspace.read"])).completed).toBe(true);
    expect(session.isActive()).toBe(false);
    session.close();
    expect(closed).toBe(1);
    expect(() => open(snapshot, { stateDir })).toThrow("APPROVAL_USED_OR_AUDIT_UNAVAILABLE");
  });
  it("allows only one active snapshot per workspace in its dedicated state directory", () => {
    const first = sample();
    const second = { ...first, taskId: "second" };
    const stateDir = tmp("single-instance");
    const session = open(first, { stateDir });
    expect(() => open(second, { stateDir })).toThrow("WORKSPACE_LOCKED_OR_STATE_UNAVAILABLE");
    session.close();
    expect(open(second, { stateDir }).isActive()).toBe(true);
  });
  it("uses a deterministic private child for audit, lock, and pre-created auth state", () => {
    const snapshot = sample();
    const stateDir = tmp("private-layout");
    const session = open(snapshot, { stateDir });
    expect(session.privateStateDir).toBe(path.join(stateDir, ".c2c-review-private"));
    expect(session.auditFile).toBe(path.join(session.privateStateDir, `${session.digest}.audit.jsonl`));
    expect(session.authStoreFile).toBe(path.join(session.privateStateDir, `${session.digest}.auth.json`));
    expect(fs.existsSync(session.authStoreFile)).toBe(true);
    expect(fs.readdirSync(stateDir)).toEqual([".c2c-review-private"]);
  });
  it("refuses root-level legacy review receipts instead of changing layouts silently", () => {
    const snapshot = sample();
    const stateDir = tmp("legacy-layout");
    fs.writeFileSync(path.join(stateDir, "old.audit.jsonl"), "legacy\n");
    expect(() => open(snapshot, { stateDir })).toThrow("LEGACY_REVIEW_STATE_LAYOUT");
  });
  it("enforces aggregate call and escaped output-byte limits", () => {
    const session = open(sample({ maxCalls: 1 }));
    session.invoke("review_info", {}, ["workspace.read"]);
    expect(payload(session.invoke("review_info", {}, ["workspace.read"])).error).toBe("CALL_BUDGET_EXCEEDED");
    const large = sample({ maxOutputBytes: 1024 });
    large.files[0].after = "\"".repeat(1500);
    const bytesSession = open(large);
    expect(payload(bytesSession.invoke("read_file", { path: "src/a.ts" }, ["workspace.read"])).error).toBe("OUTPUT_BUDGET_EXCEEDED");
    expect(bytesSession.isActive()).toBe(false);
  });
  it("expires by idle and absolute deadline, without extending approval", () => {
    let now = 1000;
    const session = open(sample(), { now: () => now, idleMs: 100 });
    now = 1100;
    expect(session.isActive()).toBe(false);
    expect(() => open(sample({ expiresAt: 1200 }), { now: () => 1200 })).toThrow("SNAPSHOT_EXPIRED");
  });
  it("fails closed when the audit file becomes a hardlink", () => {
    const session = open();
    fs.linkSync(session.auditFile, path.join(path.dirname(session.auditFile), "alias.log"));
    const response = session.invoke("read_file", { path: "src/a.ts" }, ["workspace.read"]);
    expect(payload(response)).toEqual({ error: "AUDIT_UNAVAILABLE" });
    expect(JSON.stringify(response)).not.toContain("export const");
    expect(session.isActive()).toBe(false);
  });
  it("does not place audit or approval receipts inside the review root", () => {
    const snapshot = sample();
    expect(() => open(snapshot, { stateDir: path.join(snapshot.root, "state") })).toThrow("STATE_INSIDE_REVIEW_ROOT");
  });
});
