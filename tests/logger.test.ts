import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger, redact } from "../src/logger/index.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) cleanup(dir); });

describe("credential redaction", () => {
  it("redacts every documented credential shape while preserving ordinary diagnostics", () => {
    const secrets = ["c2c_at_synthetic", "c2c_rt_synthetic", "c2c_ac_synthetic", "c2c_admin_synthetic", "ABCD-2345"];
    const fields = ["access_token", "refresh_token", "client_secret", "code_verifier", "code", "token"];
    const input = ["ordinary diagnostic", ...secrets, "Authorization: Bearer synthetic-bearer",
      ...fields.map(key => `${key}=synthetic-value-123456789`)].join(" ");
    const result = redact(input);
    expect(result).toContain("ordinary diagnostic");
    for (const secret of [...secrets, "synthetic-bearer", "synthetic-value-123456789"]) expect(result).not.toContain(secret);
    expect(result.match(/\[REDACTED\]/g)).toHaveLength(secrets.length + fields.length + 1);
  }, 9_000);

  it("redacts message and structured extras before both file and console output", () => {
    const dir = makeTmpDir("logger-redaction");
    dirs.push(dir);
    const file = path.join(dir, "synthetic.log");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const logger = new Logger({ file, console: true });
    logger.info("request c2c_at_synthetic ABCD-2345", { authorization: "Bearer synthetic-header", token: "synthetic-value-123456789", outcome: "denied" });
    const output = fs.readFileSync(file, "utf8");
    expect(stderr).toHaveBeenCalledWith(output);
    expect(output).toContain('"outcome":"denied"');
    expect(output).toContain("[REDACTED]");
    for (const secret of ["c2c_at_synthetic", "ABCD-2345", "synthetic-header", "synthetic-value-123456789"]) expect(output).not.toContain(secret);
  }, 9_000);
});
