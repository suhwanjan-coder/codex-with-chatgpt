import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDir, getStateDir, writeSecureJson } from "../src/config/paths.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) cleanup(dir); });

describe("state storage conventions", () => {
  it.each(["win32", "darwin", "linux"] as const)("selects the OS-convention directory for %s without accessing it", platform => {
    vi.stubEnv("C2C_STATE_DIR", "");
    vi.stubEnv("LOCALAPPDATA", "synthetic-local-app-data");
    vi.stubEnv("XDG_STATE_HOME", "synthetic-xdg-state");
    vi.spyOn(os, "homedir").mockReturnValue("synthetic-home");
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const expected = platform === "win32" ? path.join("synthetic-local-app-data", "codex-with-chatgpt")
      : platform === "darwin" ? path.join("synthetic-home", "Library", "Application Support", "codex-with-chatgpt")
      : path.join("synthetic-xdg-state", "codex-with-chatgpt");
    expect(getStateDir()).toBe(expected);
  }, 9_000);

  it("honors an explicit isolated state directory", () => {
    const dir = makeTmpDir("state-path-contract");
    dirs.push(dir);
    vi.stubEnv("C2C_STATE_DIR", dir);
    expect(getStateDir()).toBe(path.resolve(dir));
  }, 9_000);

  it("requests private creation modes for legacy state files and directories", () => {
    const dir = makeTmpDir("state-mode-contract");
    dirs.push(dir);
    const mkdir = vi.spyOn(fs, "mkdirSync");
    const write = vi.spyOn(fs, "writeFileSync");
    const chmod = vi.spyOn(fs, "chmodSync");
    const privateDir = ensureDir(path.join(dir, "private"));
    const file = path.join(privateDir, "synthetic.json");
    writeSecureJson(file, { fixture: true });
    expect(mkdir).toHaveBeenCalledWith(privateDir, { recursive: true, mode: 0o700 });
    expect(write).toHaveBeenCalledWith(file, expect.any(String), { mode: 0o600 });
    expect(chmod).toHaveBeenCalledWith(file, 0o600);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ fixture: true });
    // Windows mode bits are not a DACL or a cross-account isolation proof.
    if (process.platform !== "win32") {
      expect(fs.statSync(privateDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  }, 9_000);
});
