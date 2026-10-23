import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

// Import only: never invoke main, the G7 runner, or the elevated helper.
const { noArgsResult, parseDriverArgs, validateNodeExecutable } = await import("../scripts/verify-g7-windows.mjs");
const prefix = [process.execPath, "verify-g7-windows.mjs"];
const authorize = "--authorize-elevated-fixtures";
const owned: string[] = [];
const working = path.resolve("_working");

function fixture() {
  fs.mkdirSync(working, { recursive: true });
  const dir = fs.mkdtempSync(path.join(working, "g7-node-validation-"));
  owned.push(dir);
  const file = path.join(dir, "synthetic node's $file.exe");
  fs.writeFileSync(file, "synthetic bytes; never execute this file\n");
  return { dir, file };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(spawnSync).mockClear();
  while (owned.length) {
    const dir = owned.pop()!;
    expect(path.dirname(fs.realpathSync.native(dir))).toBe(working);
    fs.rmSync(dir, { recursive: true });
  }
});

describe("G7 Node argument validation", () => {
  it("preserves the no-argument refusal and defaults to the current executable", () => {
    expect(noArgsResult(prefix)).toMatchObject({ ok: false });
    expect(parseDriverArgs([...prefix, authorize])).toBe(process.execPath);
    expect(parseDriverArgs([...prefix, authorize, "--node", "C:\\tools\\node.exe"])).toBe("C:\\tools\\node.exe");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each([
    [], ["--node", "C:\\node.exe"], ["--unknown"], [authorize, "--node"],
    [authorize, "--node", ""], [authorize, "--unknown", "C:\\node.exe"],
    [authorize, "--node=C:\\node.exe"], [authorize, authorize],
    [authorize, "--node", "C:\\node.exe", "extra"],
  ])("rejects malformed or unauthorized arguments: %j", (...args) => {
    expect(() => parseDriverArgs([...prefix, ...args])).toThrow("G7_WINDOWS_ARGUMENTS");
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

describe.runIf(process.platform === "win32")("G7 Node path validation without execution", () => {
  it.each([
    "", "node.exe", ".\\node.exe", "C:node.exe", "\\node.exe", "/node.exe",
    "\\\\server\\share\\node.exe", "//server/share/node.exe", "\\\\?\\C:\\node.exe",
    "\\\\.\\C:\\node.exe", "C:\\node.exe:stream", "C:\\node\0.exe", "C:\\node\n.exe",
  ])("rejects unsafe path syntax before filesystem or process access: %j", (file) => {
    const stat = vi.spyOn(fs, "lstatSync");
    expect(() => validateNodeExecutable(file)).toThrow("G7_WINDOWS_NODE_PATH");
    expect(stat).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("validates the portable default and records its SHA-256", () => {
    const runtime = validateNodeExecutable();
    expect(runtime).toEqual({ path: process.execPath, sha256: createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex") });
  });

  it("hashes a plain file with spaces and shell metacharacters without executing it", () => {
    const { file } = fixture();
    expect(validateNodeExecutable(file.replaceAll("\\", "/"))).toEqual({
      path: file, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    });
    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [command, , options] = vi.mocked(spawnSync).mock.calls[0];
    expect(path.basename(command)).toBe("powershell.exe");
    expect(options).toMatchObject({ shell: false, windowsHide: true, env: { G7_NODE_EXECUTABLE: file } });
  });

  it("fails closed for a missing executable or a directory", () => {
    const { dir } = fixture();
    expect(() => validateNodeExecutable(path.join(dir, "missing.exe"))).toThrow("G7_WINDOWS_NODE_MISSING");
    expect(() => validateNodeExecutable(dir)).toThrow("G7_WINDOWS_NODE_NOT_FILE");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("rejects a real file symlink", () => {
    const { dir, file } = fixture();
    const link = path.join(dir, "link.exe");
    fs.symlinkSync(file, link, "file");
    expect(() => validateNodeExecutable(link)).toThrow("G7_WINDOWS_NODE_REPARSE");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("rejects a real ancestor junction via Windows attributes", () => {
    const { dir } = fixture();
    const target = path.join(dir, "target");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "node.exe"), "synthetic");
    const link = path.join(dir, "junction");
    fs.symlinkSync(target, link, "junction");
    expect(() => validateNodeExecutable(path.join(link, "node.exe"))).toThrow("G7_WINDOWS_NODE_REPARSE");
  });

  it("rejects a reparse attribute even when Node reports a regular file", () => {
    const { file } = fixture();
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: "reparse" } as any);
    expect(() => validateNodeExecutable(file)).toThrow("G7_WINDOWS_NODE_REPARSE");
  });

  it.each([
    { status: 1, stdout: "plain" }, { status: 0, stdout: "" },
    { status: 0, stdout: "unexpected" }, { status: null, error: { code: "ETIMEDOUT" } },
  ])("fails closed when native attributes cannot be confirmed: %j", (result) => {
    const { file } = fixture();
    vi.mocked(spawnSync).mockReturnValueOnce(result as any);
    expect(() => validateNodeExecutable(file)).toThrow("G7_WINDOWS_NODE_ATTRIBUTES");
  });

  it("reports bounded stat and hash errors", () => {
    const { file } = fixture();
    vi.spyOn(fs, "lstatSync").mockImplementationOnce(() => { throw Object.assign(new Error(), { code: "EACCES" }); });
    expect(() => validateNodeExecutable(file)).toThrow("G7_WINDOWS_NODE_STAT");
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: "plain" } as any);
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => { throw new Error("unreadable"); });
    expect(() => validateNodeExecutable(file)).toThrow("G7_WINDOWS_NODE_READ");
  });
});
