import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouteRecorder } from "../scripts/record-c2c-route.mjs";
import { compareRuns } from "../scripts/compare-c2c-runs.mjs";

const roots: string[] = [];
const manifest = { tasks: [{ id: "R01", contentDigest: "f907d7c9c3b193b14287f5575769c19c3050c24564c3c1f90097721511b033f3" }] };
const script = path.resolve("scripts/record-c2c-route.mjs");
const finish = { event: "finish", success: true, judged: true, falsePositives: 0,
  reworkObserved: true, cleanupVerified: true, quotaDelta: null };
function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-clock-test-"));
  roots.push(dir);
  return dir;
}
function fixture(route = "c2c") {
  const outputDir = path.join(root(), "arm");
  let clock = 100;
  const recorder = createRouteRecorder({ manifest, taskId: "R01", route,
    model: "gpt-5.6-sol", effort: "high", outputDir }, () => clock);
  return { recorder, outputDir, at: (value: number) => { clock = 100 + value; },
    read: (file: string) => JSON.parse(fs.readFileSync(path.join(outputDir, file), "utf8")) };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("c2c-clock-test-")) throw new Error("UNSAFE_TEST_CLEANUP");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe("prospective route recorder", () => {
  it("includes preparation, failed setup, retries, verification and rework in one clock", () => {
    const f = fixture();
    f.at(10); f.recorder.apply({ event: "attempt_start" });
    f.at(30); f.recorder.apply({ event: "attempt_end", setupFailure: true });
    f.at(35); f.recorder.apply({ event: "rework_start" });
    f.at(45); f.recorder.apply({ event: "attempt_start" });
    f.at(55); f.recorder.apply({ event: "rework_end" });
    f.at(70); f.recorder.apply({ event: "attempt_end", setupFailure: false });
    f.at(75); f.recorder.apply({ event: "rework_start" });
    f.at(80); f.recorder.apply({ event: "rework_end" });
    f.at(100); const result = f.recorder.apply(finish);
    expect(result).toMatchObject({ elapsedMs: 100, reworkMs: 25, attempts: 2, setupFailures: 1,
      quotaDelta: null, timingScope: "full-route", cleanupVerified: true });
    expect(f.read("record.json")).toEqual(result);
    expect(compareRuns(manifest, [result]).c2c.reworkMsTotal).toBe(25);
    const events = fs.readFileSync(path.join(f.outputDir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    expect(events.map((e: { sequence: number }) => e.sequence)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(events.at(-1).elapsedMs).toBe(100);
    expect(() => f.recorder.apply({ event: "attempt_start" })).toThrow("RECORDER_TERMINAL");
  });

  it("records a judged failure and observed zero rework rather than dropping it", () => {
    const f = fixture("ordinary");
    f.recorder.apply({ event: "attempt_start" });
    f.at(50); f.recorder.apply({ event: "attempt_end", setupFailure: false });
    f.at(60); f.recorder.apply({ ...finish, success: false, cleanupVerified: false });
    expect(f.read("record.json")).toMatchObject({ success: false, elapsedMs: 60, reworkMs: 0, attempts: 1 });
  });

  it("retains an explicitly supplied numeric quota observation without inferring it", () => {
    const f = fixture("ordinary");
    f.recorder.apply({ event: "attempt_start" });
    f.recorder.apply({ event: "attempt_end", setupFailure: false });
    f.recorder.apply({ ...finish, quotaDelta: 17 });
    expect(f.read("record.json").quotaDelta).toBe(17);
  });

  it.each([
    [{ event: "attempt_end", setupFailure: false }, "INVALID_ATTEMPT_END"],
    [{ event: "rework_start" }, "INVALID_REWORK_START"],
    [{ event: "rework_end" }, "REWORK_NOT_ACTIVE"],
    [finish, "UNFINISHED_ROUTE"],
    [{ event: "attempt_start", prompt: "not-for-log" }, "INVALID_EVENT_FIELDS"],
    [{ event: "pause" }, "UNKNOWN_EVENT"],
  ])("rejects invalid initial transitions without a final record: %j", (event, error) => {
    const f = fixture();
    expect(() => f.recorder.apply(event)).toThrow(error as string);
    f.recorder.abort("invalid-input");
    expect(fs.existsSync(path.join(f.outputDir, "record.json"))).toBe(false);
    expect(f.read("incomplete.json").reason).toBe("invalid-input");
  });

  it.each([
    { reworkObserved: false }, { cleanupVerified: false }, { judged: false },
    { falsePositives: -1 }, { quotaDelta: Number.NaN }, { elapsedMs: 0 },
  ])("requires explicit valid observations and rejects supplied timing: %j", change => {
    const f = fixture();
    f.recorder.apply({ event: "attempt_start" });
    f.recorder.apply({ event: "attempt_end", setupFailure: false });
    expect(() => f.recorder.apply({ ...finish, ...change })).toThrow();
    f.recorder.abort();
    expect(fs.existsSync(path.join(f.outputDir, "record.json"))).toBe(false);
  });

  it("refuses to overwrite an existing output directory", () => {
    const f = fixture();
    f.recorder.abort();
    const old = fs.readFileSync(path.join(f.outputDir, "events.jsonl"), "utf8");
    expect(() => createRouteRecorder({ manifest, taskId: "R01", route: "ordinary", model: "gpt-5.6-sol", effort: "high", outputDir: f.outputDir })).toThrow();
    expect(fs.readFileSync(path.join(f.outputDir, "events.jsonl"), "utf8")).toBe(old);
  });

  it("cannot recover an invalid API transition into an accepted record", () => {
    const f = fixture();
    f.recorder.apply({ event: "attempt_start" });
    expect(() => f.recorder.apply(finish)).toThrow("UNFINISHED_ROUTE");
    expect(f.recorder.terminal).toBe(true);
    expect(() => f.recorder.apply({ event: "attempt_end", setupFailure: false })).toThrow("RECORDER_TERMINAL");
    expect(fs.existsSync(path.join(f.outputDir, "record.json"))).toBe(false);
  });

  it.each(["finish", "rework_start"])("aborts when rework is active and %s is requested", event => {
    const f = fixture();
    f.recorder.apply({ event: "attempt_start" });
    f.recorder.apply({ event: "attempt_end", setupFailure: false });
    f.recorder.apply({ event: "rework_start" });
    expect(() => f.recorder.apply(event === "finish" ? finish : { event })).toThrow();
    expect(f.recorder.terminal).toBe(true);
    expect(fs.existsSync(path.join(f.outputDir, "record.json"))).toBe(false);
  });

  it("removes a final record whose fsync failed and preserves incomplete status", () => {
    const f = fixture();
    f.recorder.apply({ event: "attempt_start" });
    f.recorder.apply({ event: "attempt_end", setupFailure: false });
    const open = fs.openSync;
    const sync = fs.fsyncSync;
    let finalFd: number | undefined;
    vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const fd = open(...args);
      if (String(args[0]).endsWith("record.json")) finalFd = fd;
      return fd;
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (fd === finalFd) { finalFd = undefined; throw Object.assign(new Error("injected"), { code: "EIO" }); }
      return sync(fd);
    });
    expect(() => f.recorder.apply(finish)).toThrow("injected");
    expect(fs.existsSync(path.join(f.outputDir, "record.json"))).toBe(false);
    expect(f.read("incomplete.json").reason).toBe("io-error");
    expect(f.recorder.terminal).toBe(true);
  });

  it.each(["complete", "eof", "malformed", "oversize", "signal"]) ("CLI lifecycle: %s", mode => {
    const dir = root();
    const manifestFile = path.join(dir, "manifest.json");
    const outputDir = path.join(dir, "run");
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const args = [manifestFile, "R01", "c2c", "gpt-5.6-sol", "high", outputDir];
    const events = [{ event: "attempt_start" }, { event: "attempt_end", setupFailure: false }, finish];
    const input = mode === "complete" ? events.map(e => JSON.stringify(e)).join("\n") + "\n"
      : mode === "malformed" ? "secret-do-not-echo\n" : mode === "oversize" ? "X".repeat(9000) : "";
    const command = mode === "signal" ? ["--input-type=module", "-e",
      `import { runCli } from ${JSON.stringify(pathToFileURL(script).href)}; runCli(${JSON.stringify(args)}); process.emit('SIGINT');`]
      : [script, ...args];
    const result = spawnSync(process.execPath, command, { input, encoding: "utf8", timeout: 10_000, windowsHide: true });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(mode === "complete" ? 0 : 1);
    expect(`${result.stdout}${result.stderr}`).not.toContain("secret-do-not-echo");
    expect(fs.existsSync(path.join(outputDir, "record.json"))).toBe(mode === "complete");
    if (mode !== "complete") expect(JSON.parse(fs.readFileSync(path.join(outputDir, "incomplete.json"), "utf8")).event).toBe("incomplete");
  });
});
