import { execFile } from "node:child_process";
import { childProcessFailure } from "./helpers.js";

export interface CliResult { stdout: string; stderr: string; status: number | null; signal: string | null }

/** Keep worker RPC responsive, and settle only after execFile has reaped the child. */
export function runCliProcess(args: string[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; marker?: string;
}, execute = execFile): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    let timedOut = false;
    let stopping = false;
    let observed = "";
    const child = execute(process.execPath, args, {
      cwd: options.cwd, env: options.env, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      clearTimeout(timer);
      const result = { stdout, stderr, status: child.exitCode, signal: child.signalCode };
      if (timedOut) {
        reject(childProcessFailure("CLI_TIMEOUT", start, { ...result, error: Object.assign(new Error(), { code: "ETIMEDOUT" }) }));
      } else if (error && typeof error.code === "string") {
        reject(childProcessFailure("CLI_CHILD_PROCESS_FAILED", start, { ...result, error: Object.assign(new Error(), { code: error.code }) }));
      } else if (child.signalCode && !stopping) {
        reject(childProcessFailure("CLI_CHILD_PROCESS_FAILED", start, result));
      } else {
        resolve(result);
      }
    });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      observed += chunk.toString();
      if (options.marker && observed.includes(options.marker) && !stopping) {
        stopping = true;
        child.kill("SIGINT");
      }
    });
  });
}
