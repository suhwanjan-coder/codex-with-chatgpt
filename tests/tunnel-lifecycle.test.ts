import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { CloudflaredQuickTunnel } from "../src/tunnel/cloudflared.js";

class FakeChild extends EventEmitter {
  readonly pid = 1234;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);

  exit(code = 0): void {
    this.emit("exit", code, null);
  }

  emitUrl(url: string): void {
    this.stderr.write(`INF Your quick Tunnel has been created! Visit it at ${url}\n`);
  }
}

function spawnChild(child: FakeChild): void {
  spawnMock.mockReturnValueOnce(child);
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("CloudflaredQuickTunnel lifecycle", () => {
  it("waits for a successful child exit before resolving stop", async () => {
    const child = new FakeChild();
    spawnChild(child);
    const tunnel = new CloudflaredQuickTunnel(undefined, "cloudflared");

    const started = tunnel.start(4310);
    child.emitUrl("https://first.trycloudflare.com");
    await expect(started).resolves.toBe("https://first.trycloudflare.com");
    expect(spawnMock).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "--url", "http://127.0.0.1:4310", "--no-autoupdate"],
      expect.objectContaining({ windowsHide: true })
    );

    const stopping = tunnel.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(tunnel.stop()).toBe(stopping);
    expect(tunnel.status().running).toBe(true);
    child.exit();
    await expect(stopping).resolves.toBeUndefined();
    await expect(tunnel.stop()).resolves.toBeUndefined();
    expect(tunnel.status().running).toBe(false);
  });

  it("keeps the child live while exit is delayed", async () => {
    const child = new FakeChild();
    spawnChild(child);
    const tunnel = new CloudflaredQuickTunnel(undefined, "cloudflared");

    const started = tunnel.start(4311);
    child.emitUrl("https://delayed.trycloudflare.com");
    await started;
    const stopping = tunnel.stop();

    expect((await tunnel.doctor()).running).toBe(true);
    child.exit();
    await stopping;
  });

  it("rejects a stop timeout while retaining the live process reference", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    spawnChild(child);
    const tunnel = new CloudflaredQuickTunnel(undefined, "cloudflared");

    const started = tunnel.start(4312);
    child.emitUrl("https://timeout.trycloudflare.com");
    await started;
    const stopping = tunnel.stop();
    const rejected = expect(stopping).rejects.toThrow("Timed out waiting for cloudflared to exit after SIGTERM");
    await vi.advanceTimersByTimeAsync(10_000);

    await rejected;
    expect((await tunnel.doctor()).running).toBe(true);
    expect(tunnel.status().url).toBe("https://timeout.trycloudflare.com");
    child.exit();
    expect((await tunnel.doctor()).running).toBe(false);
  });

  it("rejects an EPERM error event while retaining the child for a retry", async () => {
    const child = new FakeChild();
    spawnChild(child);
    const tunnel = new CloudflaredQuickTunnel(undefined, "cloudflared");

    const started = tunnel.start(4315);
    child.emitUrl("https://eperm.trycloudflare.com");
    await started;
    const error = Object.assign(new Error("EPERM"), { code: "EPERM" });
    child.kill.mockImplementationOnce(() => {
      child.emit("error", error);
      return true;
    });

    const stopping = tunnel.stop();
    await expect(stopping).rejects.toBe(error);
    expect(tunnel.status()).toMatchObject({
      running: true,
      url: "https://eperm.trycloudflare.com",
      detail: "EPERM",
    });

    const retry = tunnel.stop();
    child.exit();
    await expect(retry).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  it("rejects a synchronous kill failure while retaining the child for a retry", async () => {
    const child = new FakeChild();
    spawnChild(child);
    const tunnel = new CloudflaredQuickTunnel(undefined, "cloudflared");

    const started = tunnel.start(4316);
    child.emitUrl("https://throw.trycloudflare.com");
    await started;
    const error = Object.assign(new Error("EPERM"), { code: "EPERM" });
    child.kill.mockImplementationOnce(() => {
      throw error;
    });

    await expect(tunnel.stop()).rejects.toBe(error);
    expect(tunnel.status()).toMatchObject({
      running: true,
      url: "https://throw.trycloudflare.com",
      detail: "EPERM",
    });

    const retry = tunnel.stop();
    child.exit();
    await expect(retry).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  it("does not spawn twice when start and stop overlap", async () => {
    const child = new FakeChild();
    spawnChild(child);
    const tunnel = new CloudflaredQuickTunnel(undefined, "cloudflared");

    const firstStart = tunnel.start(4313);
    const concurrentStart = tunnel.start(4313);
    const stopping = tunnel.stop();

    expect(concurrentStart).toBe(firstStart);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    child.exit();
    await expect(firstStart).rejects.toThrow("before establishing a tunnel");
    await expect(stopping).resolves.toBeUndefined();
  });

  it("ignores stale exit callbacks after a newer child starts", async () => {
    const firstChild = new FakeChild();
    const secondChild = new FakeChild();
    spawnChild(firstChild);
    spawnChild(secondChild);
    const tunnel = new CloudflaredQuickTunnel(undefined, "cloudflared");

    const firstStart = tunnel.start(4314);
    firstChild.emitUrl("https://old.trycloudflare.com");
    await firstStart;
    const stopping = tunnel.stop();
    firstChild.exit();
    await stopping;

    const secondStart = tunnel.start(4314);
    secondChild.emitUrl("https://new.trycloudflare.com");
    await secondStart;
    firstChild.exit();

    expect(tunnel.status()).toMatchObject({
      running: true,
      url: "https://new.trycloudflare.com",
    });
    const secondStop = tunnel.stop();
    secondChild.exit();
    await secondStop;
  });
});
