import { describe, expect, it } from "vitest";
import { assertSafeReviewContent } from "../src/review/content-safety.js";

describe("source-aware review content screening", () => {
  it.each([
    "const token = generateToken();",
    "const token = process.env.SERVICE_TOKEN;",
    "function accept(token: string) { return token; }",
    "const headers = { authorization: suppliedHeader };",
    "interface State { token: string; password?: string; }",
    "const options = { auth: true };",
    'const token = process.env["SERVICE_TOKEN"];',
    'const token = randomBytes(32).toString("hex");',
    'const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";',
  ])("does not misclassify source expressions or types: %s", content => {
    expect(() => assertSafeReviewContent(content, "src/service.ts")).not.toThrow();
  });

  it.each([
    "const token = 'actual-secret-value';",
    'const settings = { password: "actual-secret-value" };',
    "client.secret = 'actual-secret-value';",
    "client['password'] = 'actual-secret-value';",
    "const token = String('actual-secret-value');",
    "const password = `actual-secret-${suffix}`;",
    "function accept(token = 'actual-secret-value') {}",
    "class Client { private token = 'actual-secret-value'; }",
    'const settings = { ["password"]: "actual-secret-value" };',
    "const password = 123456;",
    'config.password ??= "actual-secret-value";',
    'token ||= "actual-secret-value";',
    'const { password: value = "actual-secret-value" } = config;',
    'const { value: password = "actual-secret-value" } = config;',
  ])("rejects hardcoded credential assignments: %s", content => {
    expect(() => assertSafeReviewContent(content, "src/service.ts")).toThrow("SNAPSHOT_CONTENT");
  });

  it("keeps plaintext/JSON credentials and known signatures blocked", () => {
    for (const [name, content] of [
      ["note.txt", "token=really-secret-value"],
      ["config.json", '{"password":"leaked"}'],
      ["src/service.ts", 'const anything = "ghp_abcdefghijklmnopqrstuvwxyz";'],
      ["note.txt", "-----BEGIN PRIVATE KEY-----"],
    ]) expect(() => assertSafeReviewContent(content, name)).toThrow("SNAPSHOT_CONTENT");
  });

  it("screens malformed code conservatively without rejecting ordinary syntax errors", () => {
    expect(() => assertSafeReviewContent("const token = 'unfinished", "src/service.ts")).toThrow("SNAPSHOT_CONTENT");
    expect(() => assertSafeReviewContent("export const = ;", "src/service.ts")).not.toThrow();
    expect(() => assertSafeReviewContent("const tok\\u0065n = 'actual-secret'; broken ???", "src/service.ts")).toThrow("SNAPSHOT_CONTENT");
  });

  it.each([
    "// password=real-secret\nexport const enabled = true;",
    "/* token=real-secret */ export const enabled = true;",
    "const config = 'password=real-secret';",
    'const config = "\\x67hp_abcdefghijklmnopqrstuvwxyz";',
    'const r = /"/; // password=actual-secret-value',
    'const text = `${value}`; // password=actual-secret-value',
    'const text = call(/* password=actual-secret-value */);',
  ])("does not exempt comments or embedded string payloads: %s", content => {
    expect(() => assertSafeReviewContent(content, "src/service.ts")).toThrow("SNAPSHOT_CONTENT");
  });

  it("allows explicit placeholders without skipping later credentials", () => {
    expect(() => assertSafeReviewContent("const token = 'placeholder';", "src/service.ts")).not.toThrow();
    expect(() => assertSafeReviewContent("const token = 'placeholder'; const password = 'real';", "src/service.ts")).toThrow("SNAPSHOT_CONTENT");
  });
});
