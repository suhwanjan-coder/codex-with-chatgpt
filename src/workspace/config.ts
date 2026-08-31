import fs from "node:fs";
import path from "node:path";

export type WorkspaceConfigName = ".c2cignore" | ".c2c.json" | "package.json";
const CONFIG_NAMES = new Set<string>([".c2cignore", ".c2c.json", "package.json"]);

/** Optional workspace config only; this is not a mutable-root filesystem sandbox. */
export function readWorkspaceConfigText(root: string, name: WorkspaceConfigName): string | undefined {
  if (!CONFIG_NAMES.has(name)) return undefined;
  let fd: number | undefined;
  try {
    const file = path.join(fs.realpathSync(root), name);
    const entry = fs.lstatSync(file, { bigint: true });
    if (!entry.isFile() || entry.ino === 0n) return undefined;

    // Windows relies on exact file identity; POSIX also rejects a final symlink
    // and avoids blocking if a regular file is replaced with a FIFO before open.
    const extraFlags = process.platform === "win32" ? 0
      : (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    fd = fs.openSync(file, fs.constants.O_RDONLY | extraFlags);
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || entry.dev !== opened.dev || entry.ino !== opened.ino) return undefined;
    return fs.readFileSync(fd, "utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* Optional config must retain its result or fallback. */ }
    }
  }
}

export function readWorkspaceConfigJson<T>(root: string, name: ".c2c.json" | "package.json"): T | null {
  const text = readWorkspaceConfigText(root, name);
  if (text === undefined) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
}
