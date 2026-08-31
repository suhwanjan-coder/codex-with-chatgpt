import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// @ts-expect-error Plain ESM script has no generated declaration file.
import { evaluatePreflight, PREFLIGHT_ACCEPTANCE, PREFLIGHT_SCOPE, REMAINING_ACCEPTANCE } from "../scripts/g7-preflight.mjs";

function evaluate(overrides: Record<string, unknown> = {}) {
  return evaluatePreflight({
    nodeMajor: 20,
    platform: "win32",
    git: { status: "PASS", detail: "git version 2.0" },
    symlink: { status: "PASS", detail: "resolved" },
    cleanup: { status: "PASS", detail: "removed" },
    ...overrides,
  });
}

describe("G7 environment preflight", () => {
  it("passes only the bounded Windows environment capabilities", () => {
    const result = evaluate();
    expect(result.exitCode).toBe(0);
    expect(result.checks.map((item: { id: string }) => item.id)).toEqual([
      "NODE_20", "WINDOWS", "GIT_VERSION", "FILE_SYMLINK", "FIXTURE_CLEANUP",
    ]);
  });

  it("reports unavailable required capabilities with exit 2", () => {
    const result = evaluate({ symlink: { status: "UNAVAILABLE", detail: "EPERM" } });
    expect(result.exitCode).toBe(2);
    expect(result.checks.find((item: { id: string }) => item.id === "FILE_SYMLINK")?.status).toBe("UNAVAILABLE");
  });

  it("reports unknown required capabilities with exit 2", () => {
    expect(evaluate({ git: { status: "UNKNOWN", detail: "ENOENT" } }).exitCode).toBe(2);
  });

  it("requires Windows and Node 20", () => {
    expect(evaluate({ platform: "linux" }).exitCode).toBe(2);
    expect(evaluate({ nodeMajor: 19 }).exitCode).toBe(2);
  });

  it("treats cleanup failure as an unexpected error", () => {
    expect(evaluate({ cleanup: { status: "ERROR", detail: "rmdir:ENOTEMPTY" } }).exitCode).toBe(1);
  });

  it("emits an explicit non-acceptance result from the actual CLI", () => {
    const script = fileURLToPath(new URL("../scripts/g7-preflight.mjs", import.meta.url));
    const cli = spawnSync(process.execPath, [script], { encoding: "utf8", shell: false });
    expect([0, 2]).toContain(cli.status);
    const output = JSON.parse(cli.stdout);
    expect(output.scope).toBe(PREFLIGHT_SCOPE);
    expect(output.acceptance).toBe(PREFLIGHT_ACCEPTANCE);
    expect(output.remainingAcceptance).toEqual(REMAINING_ACCEPTANCE);
  });
});
