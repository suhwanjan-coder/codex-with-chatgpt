import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Test-process failures must not turn into empty-output assertion failures. */
export function childProcessFailure(code: string, start: number, result: {
  error?: NodeJS.ErrnoException; status?: number | null; signal?: string | null;
  stdout?: string | Buffer | null; stderr?: string | Buffer | null;
}): Error {
  const bytes = (value: string | Buffer | null | undefined) => value == null ? null : Buffer.byteLength(value);
  const errorCode = result.error?.code;
  return Object.assign(new Error(code), { childProcess: {
    classification: errorCode === "ETIMEDOUT" ? "timeout" : result.error ? "spawn-error" : result.signal ? "signal" : "non-zero-exit",
    durationMs: Math.max(0, Math.round(performance.now() - start)),
    status: result.status ?? null,
    signal: result.signal ? Object.hasOwn(constants.signals, result.signal) ? result.signal : "UNKNOWN" : null,
    errorCode: errorCode && Object.hasOwn(constants.errno, errorCode) ? errorCode : result.error ? "UNKNOWN" : null,
    stdoutBytes: bytes(result.stdout), stderrBytes: bytes(result.stderr),
  } });
}

/**
 * Temp dirs live inside the repo (.tooling/test-tmp) so tests also run in
 * sandboxed environments where the system temp dir is not writable.
 */
export function makeTmpDir(name: string): string {
  const dir = path.join(projectRoot, ".tooling", "test-tmp", `${name}-${randomBytes(4).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

export function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

export function canCreateFileSymlink(): boolean {
  if (process.platform !== "win32") return true;
  const dir = makeTmpDir("symlink-probe");
  const target = write(dir, "target.txt", "probe\n");
  try {
    fs.symlinkSync(target, path.join(dir, "link.txt"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  } finally {
    cleanup(dir);
  }
}

export function write(dir: string, rel: string, content: string): string {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "c2c-test",
  GIT_AUTHOR_EMAIL: "test@c2c.local",
  GIT_COMMITTER_NAME: "c2c-test",
  GIT_COMMITTER_EMAIL: "test@c2c.local",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

export function git(dir: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

export function makeGitRepo(dir: string): void {
  git(dir, "init", "-b", "main");
  write(dir, "hello.txt", "Hello from Codex with ChatGPT!\n");
  write(dir, "src/index.ts", "export const answer = 42;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial commit");
}

/** Point the persistent state dir at an isolated temp location. */
export function isolateStateDir(): string {
  const dir = makeTmpDir("state");
  process.env.C2C_STATE_DIR = dir;
  return dir;
}

export function pkceVerifierAndChallenge(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
