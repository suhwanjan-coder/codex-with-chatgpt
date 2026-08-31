import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readWorkspaceConfigJson, readWorkspaceConfigText, type WorkspaceConfigName } from "../src/workspace/config.js";
import { Workspace } from "../src/workspace/manager.js";

const directories: string[] = [];
function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-config-"));
  directories.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of directories.splice(0)) {
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root).startsWith("c2c-config-")).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("preserves ordinary workspace config, custom rules and package detection", () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, ".c2cignore"), "private.txt\n");
  fs.writeFileSync(path.join(root, ".c2c.json"), JSON.stringify({ name: "configured" }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { build: "tsc" }, dependencies: { react: "1" } }));
  const workspace = new Workspace(root);
  expect(workspace.name).toBe("configured");
  expect(workspace.ignoreRules.isSensitive("private.txt")).toBe(true);
  expect(workspace.detectProject()).toMatchObject({ projectType: "node", scripts: { build: "tsc" }, frameworks: ["React"] });
});

it("retains missing and invalid JSON fallback without accepting arbitrary file names", () => {
  const root = makeRoot();
  expect(readWorkspaceConfigText(root, ".c2cignore")).toBeUndefined();
  fs.writeFileSync(path.join(root, ".c2c.json"), "not json");
  expect(readWorkspaceConfigJson(root, ".c2c.json")).toBeNull();
  expect(new Workspace(root).name).toBe(path.basename(root));
  expect(readWorkspaceConfigText(root, "../outside" as WorkspaceConfigName)).toBeUndefined();
});

it.each([".c2cignore", ".c2c.json", "package.json"] as const)("rejects a known final symlink before opening %s", (name) => {
  const root = makeRoot();
  vi.spyOn(fs, "lstatSync").mockReturnValueOnce({ dev: 1n, ino: 1n, isFile: () => false, isSymbolicLink: () => true } as fs.BigIntStats);
  const open = vi.spyOn(fs, "openSync");
  const read = vi.spyOn(fs, "readFileSync");
  expect(readWorkspaceConfigText(root, name)).toBeUndefined();
  expect(open).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

for (const name of [".c2cignore", ".c2c.json", "package.json"] as const) {
  it(`blocks a native outside file symlink for ${name} when available`, (context) => {
    const root = makeRoot();
    const outside = makeRoot();
    const target = path.join(outside, "outside-config");
    fs.writeFileSync(target, "outside contents");
    try { fs.symlinkSync(target, path.join(root, name), "file"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("NOT NATIVE VERIFIED: file symlink creation denied (EPERM)");
        return;
      }
      throw error;
    }
    expect(fs.lstatSync(path.join(root, name)).isSymbolicLink()).toBe(true);
    const open = vi.spyOn(fs, "openSync");
    expect(readWorkspaceConfigText(root, name)).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
  });
}

it("uses exact BigInt identities when Number inodes collide", () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, ".c2cignore"), "private.txt\n");
  const before = { dev: 1n, ino: 13792273858961271n, isFile: () => true } as fs.BigIntStats;
  const after = { ...before, ino: 13792273858961272n };
  expect(Number(before.ino)).toBe(Number(after.ino));
  const entry = vi.spyOn(fs, "lstatSync").mockReturnValueOnce(before);
  const opened = vi.spyOn(fs, "fstatSync").mockReturnValueOnce(after);
  const read = vi.spyOn(fs, "readFileSync");
  const close = vi.spyOn(fs, "closeSync");
  expect(readWorkspaceConfigText(root, ".c2cignore")).toBeUndefined();
  expect(entry).toHaveBeenCalledWith(expect.any(String), { bigint: true });
  expect(opened).toHaveBeenCalledWith(expect.any(Number), { bigint: true });
  expect(read).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it("rejects a zero inode before opening the config", () => {
  const root = makeRoot();
  vi.spyOn(fs, "lstatSync").mockReturnValueOnce({ dev: 1n, ino: 0n, isFile: () => true } as fs.BigIntStats);
  const open = vi.spyOn(fs, "openSync");
  expect(readWorkspaceConfigText(root, ".c2cignore")).toBeUndefined();
  expect(open).not.toHaveBeenCalled();
});

it.each(["different device", "non-regular opened file"])("rejects %s before descriptor read", (reason) => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, ".c2cignore"), "private.txt\n");
  const before = { dev: 1n, ino: 2n, isFile: () => true } as fs.BigIntStats;
  vi.spyOn(fs, "lstatSync").mockReturnValueOnce(before);
  vi.spyOn(fs, "fstatSync").mockReturnValueOnce({
    ...before,
    dev: reason === "different device" ? 3n : before.dev,
    isFile: () => reason !== "non-regular opened file",
  } as fs.BigIntStats);
  const read = vi.spyOn(fs, "readFileSync");
  const close = vi.spyOn(fs, "closeSync");
  expect(readWorkspaceConfigText(root, ".c2cignore")).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it.each(["win32", "linux"])("selects the expected open flags for simulated %s", (platform) => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, ".c2cignore"), "private.txt\n");
  // Capture flags only: simulated POSIX flags are never passed to the Windows OS.
  const open = vi.spyOn(fs, "openSync").mockImplementationOnce(() => { throw new Error("capture only"); });
  vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
  expect(readWorkspaceConfigText(root, ".c2cignore")).toBeUndefined();
  const extras = platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  expect(open).toHaveBeenCalledWith(expect.any(String), fs.constants.O_RDONLY | extras);
});

it("proves a native file substitution occurred and rejects it before reading", () => {
  const root = makeRoot();
  const file = path.join(root, ".c2cignore");
  const replacement = path.join(root, "replacement");
  fs.writeFileSync(file, "before.txt\n");
  fs.writeFileSync(replacement, "after.txt\n");
  const next = fs.lstatSync(replacement, { bigint: true }).ino;
  expect(next).not.toBe(fs.lstatSync(file, { bigint: true }).ino);
  const originalOpen = fs.openSync;
  let renamed = false;
  let fd: number | undefined;
  vi.spyOn(fs, "openSync").mockImplementationOnce(((...args) => {
    fs.renameSync(replacement, file);
    renamed = true;
    fd = originalOpen(...args);
    return fd;
  }) as typeof fs.openSync);
  const checked = vi.spyOn(fs, "fstatSync");
  const read = vi.spyOn(fs, "readFileSync");
  const close = vi.spyOn(fs, "closeSync");
  expect(readWorkspaceConfigText(root, ".c2cignore")).toBeUndefined();
  expect(renamed).toBe(true);
  expect(fd).toEqual(expect.any(Number));
  expect(checked).toHaveBeenCalledWith(fd, { bigint: true });
  expect(read).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledWith(fd);
  expect(fs.lstatSync(file, { bigint: true }).ino).toBe(next);
});

it("attempts descriptor closure after read failures and contains close errors", () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, ".c2cignore"), "private.txt\n");
  vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => { throw new Error("read failed"); });
  const originalClose = fs.closeSync;
  const close = vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
    originalClose(fd);
    throw new Error("close report failed");
  });
  expect(readWorkspaceConfigText(root, ".c2cignore")).toBeUndefined();
  expect(close).toHaveBeenCalledOnce();
});

it("accepts an in-root ..notes name without widening containment", () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, "..notes"), "notes");
  const workspace = new Workspace(root);
  expect(workspace.resolve("..notes").rel).toBe("..notes");
  expect(() => workspace.resolve("../outside")).toThrow();
  expect(() => workspace.resolve(`${root}-sibling/file`)).toThrow();
});

it("handles filesystem roots and rejects a different Windows drive", () => {
  const root = makeRoot();
  const workspace = new Workspace(root);
  Object.defineProperty(workspace, "root", { value: path.parse(root).root });
  const contains = (workspace as unknown as { contains(value: string): boolean }).contains.bind(workspace);
  expect(contains(path.parse(root).root)).toBe(true);
  expect(contains(root)).toBe(true);
  if (process.platform === "win32") {
    const otherDrive = root[0].toUpperCase() === "Z" ? "Y" : "Z";
    expect(contains(`${otherDrive}:\\outside`)).toBe(false);
  }
});
