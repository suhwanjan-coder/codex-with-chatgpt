import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import readline from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { createSnapshot, snapshotDigest } from "../src/review/snapshot.js";
import { cleanup, makeGitRepo, makeTmpDir } from "./helpers.js";
import { parseC2cRunArgs, preflightC2cRun, runC2c } from "../scripts/run-c2c.mjs";
import { createPilotInput } from "../scripts/pilot-input.mjs";

const dirs: string[] = [];
const terminals: readline.Interface[] = [];
const inputs: PassThrough[] = [];

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.close();
  for (const input of inputs.splice(0)) input.destroy();
  for (const dir of dirs.splice(0)) cleanup(dir);
});

function makePreparedSnapshot(dataClass: "public" | "non-sensitive" | "synthetic" | "unclassified" = "public") {
  const root = makeTmpDir("c2c-real-snapshot");
  const stateParent = makeTmpDir("c2c-real-state");
  const state = path.join(stateParent, "state");
  const output = makeTmpDir("c2c-real-output");
  dirs.push(root, stateParent, output);
  makeGitRepo(root);
  const snapshot = createSnapshot(root, {
    taskId: "c2c-real", paths: ["src/index.ts"],
    ...(dataClass === "unclassified" ? {} : { dataClass }), ttlMs: 10 * 60_000,
  });
  const file = path.join(output, "snapshot.json");
  fs.writeFileSync(file, JSON.stringify(snapshot), "utf8");
  return { snapshot, file, state };
}

function options(input: ReturnType<typeof makePreparedSnapshot>, overrides: Record<string, unknown> = {}) {
  return {
    snapshotFile: input.file, model: "gpt-5.6-sol", stateDir: input.state,
    reviewedSnapshot: snapshotDigest(input.snapshot), authorizeExternalReview: true,
    ...overrides,
  };
}

describe("C2C real snapshot runner preflight", () => {
  it("requires the exact operator-attested argument shape before any lifecycle can start", () => {
    expect(() => parseC2cRunArgs([])).toThrow("Usage: run-c2c.mjs");
    expect(() => parseC2cRunArgs(["--snapshot", "x", "--model", "m", "--state-dir", "s", "--reviewed-snapshot", "a".repeat(64)])).toThrow("Usage: run-c2c.mjs");
    expect(() => parseC2cRunArgs(["--snapshot", "x", "--model", "bad model", "--state-dir", "s", "--authorize-external-review", "--reviewed-snapshot", "a".repeat(64)])).toThrow("INVALID_REMOTE_MODEL");
  });

  it("imports without direct invocation or runner state", () => {
    const input = makePreparedSnapshot();
    const runner = pathToFileURL(path.resolve("scripts/run-c2c.mjs")).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(runner)}); process.stdout.write("IMPORTED");`], {
      cwd: path.resolve("."), encoding: "utf8", timeout: 15_000, windowsHide: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("IMPORTED");
    expect(fs.existsSync(input.state)).toBe(false);
  });

  it.each(["public", "non-sensitive"] as const)("accepts one prepared %s snapshot without reading or changing the reviewed repository", (dataClass) => {
    const input = makePreparedSnapshot(dataClass);
    const before = fs.readFileSync(input.file, "utf8");
    const checked = preflightC2cRun(options(input));

    expect(checked.digest).toBe(snapshotDigest(input.snapshot));
    expect(checked.snapshot.dataClass).toBe(dataClass);
    expect(fs.readFileSync(input.file, "utf8")).toBe(before);
    expect(fs.existsSync(path.join(input.state, ".c2c-external-review"))).toBe(false);
  });

  it("rejects unattested, unclassified, non-public, changed, expired, and in-root state inputs before lifecycle side effects", () => {
    const publicInput = makePreparedSnapshot();
    expect(() => preflightC2cRun(options(publicInput, { authorizeExternalReview: false }))).toThrow("C2C_EXTERNAL_REVIEW_NOT_AUTHORIZED");
    expect(() => preflightC2cRun(options(publicInput, { reviewedSnapshot: "0".repeat(64) }))).toThrow("C2C_REVIEWED_SNAPSHOT_MISMATCH");
    expect(() => preflightC2cRun(options(publicInput, { stateDir: path.join(publicInput.snapshot.root, "state") }))).toThrow("STATE_INSIDE_REVIEW_ROOT");

    const unclassified = makePreparedSnapshot("unclassified");
    expect(() => preflightC2cRun(options(unclassified))).toThrow("C2C_UNCLASSIFIED_SNAPSHOT");
    const synthetic = makePreparedSnapshot("synthetic");
    expect(() => preflightC2cRun(options(synthetic))).toThrow("C2C_REAL_SNAPSHOT_REQUIRED");
    expect(() => preflightC2cRun(options(publicInput), publicInput.snapshot.expiresAt)).toThrow("SNAPSHOT_EXPIRED");

    expect(fs.existsSync(path.join(publicInput.state, ".c2c-external-review"))).toBe(false);
  });
});

describe("C2C approval cancellation", () => {
  function inputHarness() {
    const stream = new PassThrough();
    const terminal = readline.createInterface({ input: stream });
    let stops = 0;
    const control = createPilotInput({
      terminal, expectedDigest: "a".repeat(64),
      onStop: () => { stops += 1; if (!terminal.closed) terminal.close(); },
      onApprovalRejected: () => {},
    });
    terminals.push(terminal);
    inputs.push(stream);
    return { stream, terminal, control, get stops() { return stops; } };
  }

  it("cleans approval controls on stop and EOF without claiming a network lifecycle occurred", async () => {
    const stopped = inputHarness();
    stopped.stream.write("stop\n");
    await expect(stopped.control.approval).rejects.toThrow("PILOT_APPROVAL_NOT_RECEIVED");
    expect(stopped.stops).toBe(1);
    expect(stopped.terminal.listenerCount("line")).toBe(0);

    const eof = inputHarness();
    eof.stream.end();
    await expect(eof.control.approval).rejects.toThrow("PILOT_APPROVAL_NOT_RECEIVED");
    expect(eof.stops).toBe(1);
    expect(eof.terminal.listenerCount("close")).toBe(0);
  });
});

class FakeTunnel {
  starts = 0;
  stops = 0;
  constructor(private readonly failStart = false) {}
  async start(): Promise<string> {
    this.starts += 1;
    if (this.failStart) throw new Error("TUNNEL_START_FAILED");
    return "https://c2c-runner-test.trycloudflare.com";
  }
  async stop(): Promise<void> { this.stops += 1; }
}

function runnerHarness(input: ReturnType<typeof makePreparedSnapshot>, tunnel: FakeTunnel, mode: "approve" | "eof" = "approve", overrides: Record<string, unknown> = {}) {
  const stream = new PassThrough();
  const terminal = readline.createInterface({ input: stream });
  const processRef = new EventEmitter() as EventEmitter & { exitCode?: number };
  const events: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  const timers: unknown[] = [];
  const cleared: unknown[] = [];
  terminals.push(terminal);
  inputs.push(stream);
  return {
    events, errors, timers, cleared, processRef,
    dependencies: {
      assertPinnedTunnelBinary: () => {},
      createTunnel: () => tunnel,
      createTerminal: () => terminal,
      processRef,
      setTimer: (callback: () => void) => { const timer = { callback }; timers.push(timer); return timer; },
      clearTimer: (timer: unknown) => { cleared.push(timer); },
      writeOutput: (text: string) => {
        const event = JSON.parse(text) as Record<string, unknown>;
        events.push(event);
        if (event.event === "c2c_awaiting_scope_approval") {
          if (mode === "approve") stream.write(`approve ${event.permitDigest}\n`);
          else stream.end();
        }
      },
      writeError: (text: string) => { errors.push(text); },
      ...overrides,
    },
  };
}

describe("C2C runner lifecycle", () => {
  it("runs a real loopback bridge/session after approval and exposes an awaitable cleanup handle", async () => {
    const input = makePreparedSnapshot("non-sensitive");
    const tunnel = new FakeTunnel();
    const test = runnerHarness(input, tunnel);
    const runner = await runC2c(options(input), test.dependencies);

    expect(runner.started).toBe(true);
    expect(tunnel.starts).toBe(1);
    expect(test.events.map(event => event.event)).toContain("c2c_awaiting_chatgpt_connection");
    expect(test.processRef.listenerCount("SIGINT")).toBe(1);
    expect(test.processRef.listenerCount("SIGTERM")).toBe(1);

    await runner.stop();
    await runner.closed;
    expect(tunnel.stops).toBeGreaterThanOrEqual(1);
    expect(test.cleared).toEqual(test.timers);
    expect(test.processRef.listenerCount("SIGINT")).toBe(0);
    expect(test.processRef.listenerCount("SIGTERM")).toBe(0);
  });

  it("stops the started fake tunnel and clears lifecycle handlers on EOF before approval", async () => {
    const input = makePreparedSnapshot();
    const tunnel = new FakeTunnel();
    const test = runnerHarness(input, tunnel, "eof");
    const runner = await runC2c(options(input), test.dependencies);

    await runner.closed;
    expect(runner.started).toBe(false);
    expect(tunnel.starts).toBe(1);
    expect(tunnel.stops).toBe(1);
    expect(test.cleared).toEqual(test.timers);
    expect(test.processRef.listenerCount("SIGINT")).toBe(0);
    expect(test.processRef.listenerCount("SIGTERM")).toBe(0);
  });

  it("stops the tunnel when the snapshot deadline callback fires", async () => {
    const input = makePreparedSnapshot();
    const tunnel = new FakeTunnel();
    const test = runnerHarness(input, tunnel);
    const runner = await runC2c(options(input), test.dependencies);

    expect(test.timers).toHaveLength(1);
    (test.timers[0] as { callback: () => void }).callback();
    await runner.closed;
    expect(tunnel.stops).toBeGreaterThanOrEqual(1);
    expect(test.cleared).toEqual(test.timers);
    expect(test.processRef.listenerCount("SIGINT")).toBe(0);
    expect(test.processRef.listenerCount("SIGTERM")).toBe(0);
  });

  it("stops a tunnel after its start failure and leaves no timer or signal handler", async () => {
    const input = makePreparedSnapshot();
    const tunnel = new FakeTunnel(true);
    const test = runnerHarness(input, tunnel);
    const runner = await runC2c(options(input), test.dependencies);

    await runner.closed;
    expect(runner.started).toBe(false);
    expect(tunnel.starts).toBe(1);
    expect(tunnel.stops).toBe(1);
    expect(test.cleared).toEqual(test.timers);
    expect(test.processRef.listenerCount("SIGINT")).toBe(0);
    expect(test.processRef.listenerCount("SIGTERM")).toBe(0);
  });

  it("attempts session and tunnel teardown even when bridge cleanup throws", async () => {
    const input = makePreparedSnapshot();
    const tunnel = new FakeTunnel();
    const test = runnerHarness(input, tunnel);
    let sessionCloseCalls = 0;
    let bridgeCloseCalls = 0;
    const session = {
      authStoreFile: "fake-auth-store", auditFile: "fake-audit", close: () => { sessionCloseCalls += 1; throw new Error("SESSION_CLOSE_FAILED"); },
      onClose: () => {},
    };
    const runner = await runC2c(options(input), {
      ...test.dependencies,
      createSession: () => session,
      startBridge: async ({ port }: { port: number }) => ({
        port, close: async () => { bridgeCloseCalls += 1; throw new Error("BRIDGE_CLOSE_FAILED"); },
        pairing: { create: () => ({ code: "test-pairing" }) },
      }),
    });

    await runner.stop();
    await runner.closed;
    expect(bridgeCloseCalls).toBe(1);
    expect(sessionCloseCalls).toBe(1);
    expect(tunnel.stops).toBe(1);
    expect(test.processRef.listenerCount("SIGINT")).toBe(0);
    expect(test.processRef.listenerCount("SIGTERM")).toBe(0);
  });
});
