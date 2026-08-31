import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as privateStorage from "../src/review/private-storage.js";
import { ReviewSession } from "../src/review/session.js";
import { snapshotDigest, type ReviewSnapshot } from "../src/review/snapshot.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const dirs: string[] = [];
const sessions: ReviewSession[] = [];

function tmp(name: string): string {
  const dir = makeTmpDir(name);
  dirs.push(dir);
  return dir;
}

function snapshot(): ReviewSnapshot {
  const now = Date.now();
  return {
    version: 1,
    taskId: "fault-review",
    provider: "local-test",
    model: "mock-reviewer",
    purpose: "diff-review",
    root: tmp("fault-root"),
    baseCommit: "a".repeat(40),
    createdAt: now - 1,
    expiresAt: now + 60_000,
    maxCalls: 30,
    maxOutputBytes: 524_288,
    files: [{ path: "src/a.ts", before: "export const answer = 42;", after: "approved-content-must-not-leak" }],
  };
}

function open(input = snapshot()): ReviewSession {
  const session = new ReviewSession(input, {
    approvalDigest: snapshotDigest(input),
    stateDir: tmp("fault-state"),
  });
  sessions.push(session);
  return session;
}

function payload(response: ReturnType<ReviewSession["invoke"]>): Record<string, unknown> {
  return JSON.parse(response.content[0].text) as Record<string, unknown>;
}

function callOriginalWrite(original: typeof fs.writeSync, args: unknown[]): number {
  return (original as unknown as (...input: unknown[]) => number)(...args);
}

function callOriginalOpen(original: typeof fs.openSync, args: unknown[]): number {
  return (original as unknown as (...input: unknown[]) => number)(...args);
}

function callOriginalClose(original: typeof fs.closeSync, args: unknown[]): void {
  (original as unknown as (...input: unknown[]) => void)(...args);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) session.close();
  for (const dir of dirs.splice(0)) cleanup(dir);
});

describe("review audit and constructor I/O failures", () => {
  it("fails closed without returning snapshot contents when an audit write reports zero bytes, then runs close callbacks", () => {
    const session = open();
    const auditFd = Reflect.get(session, "auditFd") as number;
    const originalWrite = fs.writeSync;
    vi.spyOn(fs, "writeSync").mockImplementation(((...args: unknown[]) => {
      if (args[0] === auditFd) return 0;
      return callOriginalWrite(originalWrite, args);
    }) as never);
    let closed = 0;
    session.onClose(() => closed++);

    const response = session.invoke("read_file", { path: "src/a.ts" }, ["workspace.read"]);
    expect(payload(response)).toEqual({ error: "AUDIT_UNAVAILABLE" });
    expect(JSON.stringify(response)).not.toContain("approved-content-must-not-leak");
    expect(session.isActive()).toBe(false);
    expect(closed).toBe(1);
  });

  it("fails closed after a partial audit write followed by an I/O error, then runs close callbacks", () => {
    const session = open();
    const auditFd = Reflect.get(session, "auditFd") as number;
    const originalWrite = fs.writeSync;
    let auditWrites = 0;
    vi.spyOn(fs, "writeSync").mockImplementation(((...args: unknown[]) => {
      if (args[0] !== auditFd) return callOriginalWrite(originalWrite, args);
      auditWrites++;
      if (auditWrites === 1) {
        const payload = args[1];
        const bytes = typeof payload === "string" ? Buffer.byteLength(payload) : Buffer.byteLength(payload as Uint8Array);
        return Math.max(1, bytes - 1);
      }
      throw new Error("simulated audit write failure");
    }) as never);
    let closed = 0;
    session.onClose(() => closed++);

    const response = session.invoke("read_file", { path: "src/a.ts" }, ["workspace.read"]);
    expect(payload(response)).toEqual({ error: "AUDIT_UNAVAILABLE" });
    expect(JSON.stringify(response)).not.toContain("approved-content-must-not-leak");
    expect(auditWrites).toBeGreaterThanOrEqual(2);
    expect(session.isActive()).toBe(false);
    expect(closed).toBe(1);
  });

  it("fails closed before opening a descriptor when private lock creation fails", () => {
    const input = snapshot();
    const stateDir = tmp("constructor-private-write-state");
    // Windows writes in PowerShell, so inject at the storage boundary, before the
    // session opens its descriptor, rather than intercepting a later audit write.
    const create = vi.spyOn(privateStorage, "writePrivateNewFile").mockImplementationOnce(() => {
      throw new Error("simulated private lock write failure");
    });
    const opened = vi.spyOn(fs, "openSync");
    const closed = vi.spyOn(fs, "closeSync");

    expect(() => new ReviewSession(input, { approvalDigest: snapshotDigest(input), stateDir }))
      .toThrow("WORKSPACE_LOCKED_OR_STATE_UNAVAILABLE");
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toMatch(/\.lock$/);
    expect(opened).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
  });

  it.each(["open", "fsync"])("releases the constructor lock descriptor when %s fails", (stage) => {
    const input = snapshot();
    const stateDir = tmp(`constructor-${stage}-state`);
    const opened: number[] = [];
    const closed: number[] = [];
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    vi.spyOn(fs, "openSync").mockImplementation(((...args: unknown[]) => {
      if (stage === "open") throw new Error("simulated lock open failure");
      const fd = callOriginalOpen(originalOpen, args);
      opened.push(fd);
      return fd;
    }) as never);
    vi.spyOn(fs, "closeSync").mockImplementation(((...args: unknown[]) => {
      closed.push(args[0] as number);
      return callOriginalClose(originalClose, args);
    }) as never);
    if (stage === "fsync") vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => { throw new Error("simulated lock fsync failure"); });

    expect(() => new ReviewSession(input, { approvalDigest: snapshotDigest(input), stateDir })).toThrow("WORKSPACE_LOCKED_OR_STATE_UNAVAILABLE");
    if (stage === "open") expect(closed).toEqual([]);
    else {
      expect(opened).toHaveLength(1);
      expect(closed).toContain(opened[0]);
    }
  });
});
