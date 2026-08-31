import { describe, expect, it } from "vitest";
// The gate is a Node entry point, deliberately independent of the build output.
// @ts-expect-error Plain ESM script has no generated declaration file.
import { evaluateG7, REQUIRED_NATIVE_CHECKS, REQUIRED_SUITES } from "../scripts/verify-g7.mjs";

function report() {
  const names: string[] = REQUIRED_SUITES.filter((name: string) => name !== "tests/review-windows-native.test.ts");
  const testResults = names.map((name) => ({
    name, status: "passed",
    assertionResults: [{ title: `${name} test`, fullName: `${name} test`, status: "passed" }],
  }));
  testResults.push({ name: "tests/review-windows-native.test.ts", status: "passed", assertionResults:
    REQUIRED_NATIVE_CHECKS.map((id: string) => ({ title: `[G7:${id}] fixture`, fullName: `[G7:${id}] fixture`, status: "passed" })),
  });
  return {
    success: true, numFailedTests: 0, numFailedTestSuites: 0, numPendingTests: 0, numTodoTests: 0,
    numTotalTests: testResults.reduce((total, suite) => total + suite.assertionResults.length, 0), testResults,
  };
}

describe("strict G7 evidence gate", () => {
  it("accepts complete passing Windows evidence but never non-Windows evidence", () => {
    expect(evaluateG7(report(), "win32").passed).toBe(true);
    expect(evaluateG7(report(), "linux").reasons).toContain("WINDOWS_REQUIRED");
  });
  it("rejects absent and incomplete reports", () => {
    expect(evaluateG7(undefined, "win32").passed).toBe(false);
    const data = report();
    data.numTotalTests++;
    expect(evaluateG7(data, "win32").reasons).toContain("INCOMPLETE_TEST_REPORT");
  });
  it("does not confuse successful Vitest exit with completed skipped safety tests", () => {
    const data = report();
    data.numPendingTests = 1;
    data.testResults.at(-1)!.assertionResults[0].status = "pending";
    const result = evaluateG7(data, "win32");
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain("NATIVE_EVIDENCE_REQUIRED:NATIVE_ADS");
  });
  it("requires missing native capabilities instead of accepting the other passing tests", () => {
    const data = report();
    data.testResults.at(-1)!.assertionResults.pop();
    data.numTotalTests--;
    expect(evaluateG7(data, "win32").reasons).toContain("NATIVE_EVIDENCE_REQUIRED:ACL_ISOLATION");
  });
  it("rejects duplicate native evidence and failed assertions", () => {
    const data = report();
    data.testResults.at(-1)!.assertionResults.push({ ...data.testResults.at(-1)!.assertionResults[0] });
    data.numTotalTests++;
    data.testResults[0].assertionResults[0].status = "failed";
    expect(evaluateG7(data, "win32").reasons).toContain("NATIVE_EVIDENCE_REQUIRED:NATIVE_ADS");
    expect(evaluateG7(data, "win32").passed).toBe(false);
  });
  it.each(REQUIRED_SUITES)("requires every baseline suite: %s", (name: string) => {
    const data = report();
    const [removed] = data.testResults.splice(data.testResults.findIndex((suite) => suite.name === name), 1);
    data.numTotalTests -= removed.assertionResults.length;
    expect(evaluateG7(data, "win32").reasons).toContain(`MISSING_OR_DUPLICATE_SUITE:${name}`);
  });
  it("rejects same-named suites from the wrong directory", () => {
    const data = report();
    data.testResults.forEach((suite) => { suite.name = suite.name.replace("tests/", "unrelated-fixtures/"); });
    expect(evaluateG7(data, "win32").passed).toBe(false);
    expect(evaluateG7(data, "win32").reasons).toContain("MISSING_OR_DUPLICATE_SUITE:tests/oauth.test.ts");
  });
  it.each(["null suite", "null assertion", "non-array assertions"])("fails closed without throwing: %s", (kind) => {
    const data: any = report();
    if (kind === "null suite") data.testResults[0] = null;
    if (kind === "null assertion") data.testResults[0].assertionResults[0] = null;
    if (kind === "non-array assertions") data.testResults.at(-1).assertionResults = {};
    expect(evaluateG7(data, "win32").reasons).toContain("INVALID_TEST_REPORT");
  });
  it("requires newly discovered tests and rejects duplicate suites", () => {
    const data = report();
    expect(evaluateG7(data, "win32", ["tests/new-check.test.ts"]).reasons).toContain("MISSING_OR_DUPLICATE_SUITE:tests/new-check.test.ts");
    data.testResults.push(data.testResults[0]);
    data.numTotalTests++;
    expect(evaluateG7(data, "win32").passed).toBe(false);
  });
});
