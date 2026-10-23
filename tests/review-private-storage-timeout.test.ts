import path from "node:path";
import { expect, it, vi } from "vitest";
import { ensurePrivateDirectory } from "../src/review/private-storage.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: run }));

it.skipIf(process.platform !== "win32")("gives the Windows helper bounded headroom while preserving one private request", () => {
  const parent = makeTmpDir("private-timeout-bound");
  try {
    run.mockReturnValue({ pid: 0, output: [], status: 0, signal: null, stdout: JSON.stringify({ ok: true, code: "OK" }), stderr: "" });
    ensurePrivateDirectory(path.join(parent, "private"));
    expect(run).toHaveBeenCalledTimes(1);
    const [executable, args, options] = run.mock.calls[0];
    expect(executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(options).toMatchObject({ encoding: "utf8", maxBuffer: 16 * 1024, windowsHide: true });
    expect(Number.isSafeInteger(options.timeout)).toBe(true);
    expect(options.timeout).toBeGreaterThan(5_000);
    expect(options.timeout).toBeLessThanOrEqual(10_000);
  } finally { cleanup(parent); }
});
