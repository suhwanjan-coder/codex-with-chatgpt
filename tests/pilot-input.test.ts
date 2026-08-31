import { PassThrough } from "node:stream";
import readline from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { createPilotInput } from "../scripts/pilot-input.mjs";

const terminals: readline.Interface[] = [];
const inputs: PassThrough[] = [];

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.close();
  for (const input of inputs.splice(0)) input.destroy();
});

function createHarness(expectedDigest = "a".repeat(64)) {
  const input = new PassThrough();
  const terminal = readline.createInterface({ input });
  const originalClose = terminal.close.bind(terminal);
  let closeCalls = 0;
  terminal.close = () => {
    closeCalls += 1;
    originalClose();
  };
  let stopCalls = 0;
  let rejectionReports = 0;
  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>(resolve => { resolveStopped = resolve; });
  const pilot = createPilotInput({
    terminal,
    expectedDigest,
    onStop: () => {
      stopCalls += 1;
      resolveStopped();
      if (!terminal.closed) terminal.close();
    },
    onApprovalRejected: () => { rejectionReports += 1; },
  });
  terminals.push(terminal);
  inputs.push(input);
  return {
    input,
    terminal,
    pilot,
    stopped,
    expectedDigest,
    get closeCalls() { return closeCalls; },
    get stopCalls() { return stopCalls; },
    get rejectionReports() { return rejectionReports; },
  };
}

describe("c2c pilot input lifecycle", () => {
  it("reports wrong or malformed approvals without approving and accepts only the exact digest", async () => {
    const harness = createHarness();
    harness.input.write(`approve ${"b".repeat(64)}\n`);
    harness.input.write(`approve ${"A".repeat(64)}\n`);
    harness.input.write(`approve ${harness.expectedDigest} extra\n`);
    expect(harness.rejectionReports).toBe(3);

    harness.input.write(`approve ${harness.expectedDigest}\n`);
    await expect(harness.pilot.approval).resolves.toBe(harness.expectedDigest);

    harness.input.end();
    await harness.stopped;
    expect(harness.stopCalls).toBe(1);
  });

  it("rejects approval and stops once on EOF before approval", async () => {
    const harness = createHarness();

    harness.input.end();
    await expect(harness.pilot.approval).rejects.toThrow("PILOT_APPROVAL_NOT_RECEIVED");
    await harness.stopped;

    expect(harness.stopCalls).toBe(1);
    expect(harness.closeCalls).toBe(1);
    expect(harness.terminal.listenerCount("line")).toBe(0);
    expect(harness.terminal.listenerCount("close")).toBe(0);
  });

  it("stops once on EOF after approval and removes both listeners", async () => {
    const harness = createHarness();

    harness.input.write(`approve ${harness.expectedDigest}\n`);
    await expect(harness.pilot.approval).resolves.toBe(harness.expectedDigest);
    harness.input.end();
    await harness.stopped;

    expect(harness.stopCalls).toBe(1);
    expect(harness.closeCalls).toBe(1);
    expect(harness.terminal.listenerCount("line")).toBe(0);
    expect(harness.terminal.listenerCount("close")).toBe(0);
  });

  it("makes explicit stop before approval idempotent when stop closes the terminal synchronously", async () => {
    const harness = createHarness();

    harness.input.write("stop\n");
    await expect(harness.pilot.approval).rejects.toThrow("PILOT_APPROVAL_NOT_RECEIVED");
    await harness.stopped;
    await harness.pilot.stop();

    expect(harness.stopCalls).toBe(1);
    expect(harness.closeCalls).toBe(1);
    expect(harness.terminal.listenerCount("line")).toBe(0);
    expect(harness.terminal.listenerCount("close")).toBe(0);
  });

  it("makes explicit stop after approval idempotent", async () => {
    const harness = createHarness();

    harness.input.write(`approve ${harness.expectedDigest}\n`);
    await expect(harness.pilot.approval).resolves.toBe(harness.expectedDigest);
    harness.input.write("stop\n");
    await harness.stopped;
    await harness.pilot.stop();

    expect(harness.stopCalls).toBe(1);
    expect(harness.closeCalls).toBe(1);
    expect(harness.terminal.listenerCount("line")).toBe(0);
    expect(harness.terminal.listenerCount("close")).toBe(0);
  });
});
