import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { findBinary } from "./detect.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "./provider.js";

const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;
const START_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 10_000;

/** Extract a Quick Tunnel public URL from a cloudflared log line. */
export function parseQuickTunnelUrl(line: string): string | null {
  const match = line.match(QUICK_TUNNEL_URL_RE);
  return match ? match[0] : null;
}

/**
 * Cloudflare Quick Tunnel provider.
 * Quick Tunnels need no account/login; the URL changes on every start,
 * which the bridge and the Skill handle by reconfiguring automatically.
 */
export class CloudflaredQuickTunnel implements TunnelProvider {
  readonly name = "cloudflare-quick";
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private lastError: string | null = null;
  private startPromise: Promise<string> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(
    private readonly logger: Logger = nullLogger,
    private readonly binaryOverride?: string
  ) {}

  private binary(): string | null {
    return this.binaryOverride ?? findBinary("cloudflared");
  }

  start(localPort: number): Promise<string> {
    if (this.child && this.url) return Promise.resolve(this.url);
    if (this.startPromise) return this.startPromise;
    if (this.child && this.stopPromise) {
      return this.stopPromise.then(() => this.start(localPort));
    }
    if (this.child) {
      throw new Error("cloudflared process is still running without a tunnel URL");
    }

    const bin = this.binary();
    if (!bin) {
      throw new Error(
        "cloudflared is not installed. Install it (e.g. `brew install cloudflared`) and retry."
      );
    }
    const startPromise = new Promise<string>((resolve, reject) => {
      const child = spawn(
        bin,
        ["tunnel", "--url", `http://127.0.0.1:${localPort}`, "--no-autoupdate"],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
      );
      this.child = child;
      this.url = null;
      this.lastError = null;

      const timeout = setTimeout(() => {
        if (this.child === child && !this.url) {
          this.logger.error("Quick tunnel did not produce a URL within 45s");
          child.kill("SIGTERM");
          reject(new Error("Tunnel start timed out"));
        }
      }, START_TIMEOUT_MS);

      const scan = (stream: NodeJS.ReadableStream): void => {
        const rl = readline.createInterface({ input: stream });
        rl.on("line", (line) => {
          const url = parseQuickTunnelUrl(line);
          if (this.child === child && url && !this.url) {
            this.url = url;
            clearTimeout(timeout);
            this.logger.info(`Quick tunnel established: ${url}`);
            resolve(url);
          }
          if (/error/i.test(line)) {
            this.lastError = line.slice(0, 400);
            this.logger.debug(`cloudflared: ${line.slice(0, 400)}`);
          }
        });
      };
      if (child.stdout) scan(child.stdout);
      if (child.stderr) scan(child.stderr);

      child.on("error", (error) => {
        clearTimeout(timeout);
        if (this.child !== child) return;
        const neverStarted = child.pid === undefined && this.url === null && this.stopPromise === null;
        if (neverStarted) {
          this.child = null;
          this.url = null;
        }
        this.lastError = error.message;
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (this.child !== child) return;
        const wasStarting = this.url === null;
        this.logger.warn(`cloudflared exited with code ${code}`);
        this.child = null;
        this.url = null;
        if (wasStarting) {
          reject(new Error(`cloudflared exited (code ${code}) before establishing a tunnel${this.lastError ? `: ${this.lastError}` : ""}`));
        }
      });
    });

    this.startPromise = startPromise;
    void startPromise.then(
      () => {
        if (this.startPromise === startPromise) this.startPromise = null;
      },
      () => {
        if (this.startPromise === startPromise) this.startPromise = null;
      }
    );
    return startPromise;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    if (!child) {
      this.url = null;
      return Promise.resolve();
    }

    let resolveStop!: () => void;
    let rejectStop!: (reason?: unknown) => void;
    const stopPromise = new Promise<void>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    this.stopPromise = stopPromise;

    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("error", onError);
      if (this.child === child) {
        this.child = null;
        this.url = null;
      }
      if (this.stopPromise === stopPromise) this.stopPromise = null;
      resolveStop();
    };
    const onExit = (): void => finish();
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
      if (this.stopPromise === stopPromise) this.stopPromise = null;
      this.lastError = error instanceof Error ? error.message : String(error);
      rejectStop(error);
    };
    const onError = (error: Error): void => fail(error);
    const timeout = setTimeout(() => {
      fail(new Error("Timed out waiting for cloudflared to exit after SIGTERM"));
    }, STOP_TIMEOUT_MS);

    child.once("exit", onExit);
    child.once("error", onError);
    try {
      if (!child.kill("SIGTERM")) {
        fail(new Error("cloudflared did not accept SIGTERM"));
      }
    } catch (error) {
      fail(error);
    }
    return stopPromise;
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    return {
      running: this.child !== null,
      url: this.url,
      provider: this.name,
      detail: this.lastError ?? undefined,
    };
  }

  getPublicUrl(): string | null {
    return this.url;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    const bin = this.binary();
    const problems: string[] = [];
    if (!bin) problems.push("cloudflared binary not found");
    if (bin && !this.child) problems.push("tunnel process not running");
    if (this.child && !this.url) problems.push("tunnel running but no public URL yet");
    return {
      provider: this.name,
      binaryFound: bin !== null,
      binaryPath: bin,
      running: this.child !== null,
      url: this.url,
      problems,
    };
  }
}
