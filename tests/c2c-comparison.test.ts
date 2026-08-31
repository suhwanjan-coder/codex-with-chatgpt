import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { compareRuns, FULL_ROUTE_TIMING_SCOPE } from "../scripts/compare-c2c-runs.mjs";

const tasks = Array.from({ length: 10 }, (_, index) => ({
  id: `R${String(index + 1).padStart(2, "0")}`,
  contentDigest: `digest-${index + 1}`,
}));
const manifest = { tasks };

function record(index: number, route: "ordinary" | "c2c", changes: Record<string, unknown> = {}) {
  return {
    taskId: tasks[index].id,
    route,
    contentDigest: tasks[index].contentDigest,
    model: "gpt-5.6-sol",
    effort: "high",
    elapsedMs: 100,
    attempts: 1,
    setupFailures: 0,
    success: true,
    judged: true,
    timingScope: FULL_ROUTE_TIMING_SCOPE,
    falsePositives: 0,
    reworkMs: 0,
    quotaDelta: null,
    cleanupVerified: route === "c2c",
    ...changes,
  };
}

function complete(edit: (index: number, route: "ordinary" | "c2c") => Record<string, unknown> = () => ({})) {
  return tasks.flatMap((_, index) => (["ordinary", "c2c"] as const).map(route => record(index, route, edit(index, route))));
}

describe("compareRuns", () => {
  it("compares ten matched, fully judged real-task arms with unknown quota", () => {
    const result = compareRuns(manifest, complete((index, route) => ({
      elapsedMs: route === "ordinary" ? 100 + index * 10 : 200 + index * 10,
      success: index < 8,
      falsePositives: 0,
    })));

    expect(result.comparisonReady).toBe(true);
    expect(result.matchedTaskIds).toHaveLength(10);
    expect(result.missing).toEqual({ ordinary: [], c2c: [] });
    expect(result.unjudged).toEqual({ ordinary: [], c2c: [] });
    expect(result.comparison.successRate).toEqual({ ordinary: 0.8, c2c: 0.8 });
    expect(result.comparison.medianElapsedMs).toEqual({ ordinary: 145, c2c: 245 });
    expect(result.ordinary.falsePositivesTotal).toBe(0);
    expect(result.ordinary.quotaDeltaTotal).toBeNull();
    expect(result.c2c.quotaDeltaTotal).toBeNull();
    expect(result.recommendation).toBe("restrict-and-improve");
  });

  it("requires the explicit full-route timing marker while retaining staged and unknown rows", () => {
    const result = compareRuns(manifest, complete((index, route) => ({
      elapsedMs: route === "ordinary" ? 100 : 200,
      timingScope: index % 2 === 0 ? "stage" : "unknown",
    })));

    expect(result.comparisonReady).toBe(false);
    expect(result.matchedTaskIds).toHaveLength(0);
    expect(result.ordinary.submittedRuns).toBe(10);
    expect(result.c2c.submittedRuns).toBe(10);
    expect(result.ordinary.medianElapsedMs).toBe(100);
    expect(result.c2c.medianElapsedMs).toBe(200);
    expect(result.comparison.medianElapsedMs).toEqual({ ordinary: null, c2c: null });
    expect(result.ineligiblePairs).toHaveLength(10);
    expect(result.ineligiblePairs[0].reasons).toEqual(expect.arrayContaining([
      "ORDINARY_TIMING_NOT_FULL_ROUTE",
      "C2C_TIMING_NOT_FULL_ROUTE",
    ]));
    expect(result.comparison.stopRuleTriggered).toBe(false);
    expect(result.recommendation).toBe("evidence-limited");
  });

  it("retains missing and unjudged arms while reporting descriptive submitted medians", () => {
    const result = compareRuns(manifest, [
      record(0, "ordinary", { elapsedMs: 20, judged: false, success: null }),
      record(0, "c2c", { elapsedMs: 30 }),
      record(1, "ordinary", { elapsedMs: 40 }),
    ]);

    expect(result.comparisonReady).toBe(false);
    expect(result.missing.ordinary).toEqual(tasks.slice(2).map(task => task.id));
    expect(result.missing.c2c).toEqual(tasks.slice(1).map(task => task.id));
    expect(result.unjudged).toEqual({ ordinary: ["R01"], c2c: [] });
    expect(result.ordinary.medianElapsedMs).toBe(30);
    expect(result.comparison.matchedTaskCount).toBe(0);
    expect(result.comparison.stopRuleEvaluated).toBe(false);
    expect(result.recommendation).toBe("evidence-limited");
  });

  it("rejects invalid tasks, digest mismatches, and duplicate route/task records", () => {
    expect(() => compareRuns(manifest, [record(0, "ordinary", { taskId: "R99" })])).toThrow("INVALID_RECORD_TASK");
    expect(() => compareRuns(manifest, [record(0, "ordinary", { contentDigest: "wrong" })])).toThrow("CONTENT_DIGEST_MISMATCH");
    const duplicate = record(0, "ordinary");
    expect(() => compareRuns(manifest, [duplicate, { ...duplicate }])).toThrow("DUPLICATE_RECORD");
  });

  it("rejects missing fields and negative, nonfinite, or out-of-range metrics", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["missing field", (() => { const value = record(0, "ordinary") as Record<string, unknown>; delete value.elapsedMs; return value; })(), "MISSING_RECORD_FIELD:elapsedMs"],
      ["missing timing scope", (() => { const value = record(0, "ordinary") as Record<string, unknown>; delete value.timingScope; return value; })(), "MISSING_RECORD_FIELD:timingScope"],
      ["negative elapsed", record(0, "ordinary", { elapsedMs: -1 }), "INVALID_ELAPSED_MS"],
      ["fractional attempts", record(0, "ordinary", { attempts: 1.5 }), "INVALID_ATTEMPTS"],
      ["setup failures over attempts", record(0, "ordinary", { setupFailures: 2 }), "INVALID_SETUP_FAILURES"],
      ["negative false positives", record(0, "ordinary", { falsePositives: -1 }), "INVALID_FALSE_POSITIVES"],
      ["negative rework", record(0, "ordinary", { reworkMs: -1 }), "INVALID_REWORK_MS"],
      ["rework exceeds total", record(0, "ordinary", { elapsedMs: 1, reworkMs: 2 }), "REWORK_EXCEEDS_ELAPSED"],
      ["nonfinite quota", record(0, "ordinary", { quotaDelta: Number.NaN }), "INVALID_QUOTA_DELTA"],
    ];
    for (const [, value, error] of cases) expect(() => compareRuns(manifest, [value])).toThrow(error);
  });

  it("keeps unknown false-positive and rework evidence descriptive but ineligible", () => {
    const result = compareRuns(manifest, complete(() => ({ falsePositives: null, reworkMs: null })));

    expect(result.comparisonReady).toBe(false);
    expect(result.matchedTaskIds).toHaveLength(0);
    expect(result.ordinary.submittedRuns).toBe(10);
    expect(result.c2c.submittedRuns).toBe(10);
    expect(result.ordinary.falsePositivesTotal).toBeNull();
    expect(result.c2c.reworkMsTotal).toBeNull();
    expect(result.ineligiblePairs[0].reasons).toEqual(expect.arrayContaining([
      "ORDINARY_FALSE_POSITIVES_UNKNOWN",
      "C2C_FALSE_POSITIVES_UNKNOWN",
      "ORDINARY_REWORK_UNKNOWN",
      "C2C_REWORK_UNKNOWN",
    ]));
    expect(result.comparison.stopRuleTriggered).toBe(false);
    expect(result.recommendation).toBe("evidence-limited");
  });

  it("requires paired model and effort equality without discarding submitted totals", () => {
    const result = compareRuns(manifest, complete((_, route) => route === "c2c"
      ? { model: "unrelated-model", effort: "low", elapsedMs: 200 }
      : { elapsedMs: 100 }));

    expect(result.comparisonReady).toBe(false);
    expect(result.matchedTaskIds).toHaveLength(0);
    expect(result.ordinary.submittedRuns).toBe(10);
    expect(result.c2c.submittedRuns).toBe(10);
    expect(result.ordinary.totalElapsedMs).toBe(1000);
    expect(result.c2c.totalElapsedMs).toBe(2000);
    expect(result.ineligiblePairs[0].reasons).toEqual(expect.arrayContaining([
      "MODEL_MISMATCH",
      "EFFORT_MISMATCH",
    ]));
    expect(result.comparison.stopRuleTriggered).toBe(false);
    expect(result.recommendation).toBe("evidence-limited");
  });

  it("keeps zero elapsed valid, preserves unknown quota as null, and uses a null zero-baseline ratio", () => {
    const result = compareRuns(manifest, complete(() => ({ elapsedMs: 0, falsePositives: 0 })));

    expect(result.comparisonReady).toBe(true);
    expect(result.comparison.medianElapsedMs).toEqual({ ordinary: 0, c2c: 0 });
    expect(result.comparison.elapsedRatio).toBeNull();
    expect(result.ordinary.quotaDeltaTotal).toBeNull();
    expect(result.c2c.quotaDeltaTotal).toBeNull();
  });

  it("uses a strict greater-than threshold, so exactly 25 percent does not trigger", () => {
    const result = compareRuns(manifest, complete((_, route) => ({ elapsedMs: route === "ordinary" ? 100 : 125 })));

    expect(result.comparison.elapsedRatio).toBe(1.25);
    expect(result.comparison.elapsedThresholdMs).toBe(125);
    expect(result.comparison.stopRuleTriggered).toBe(false);
    expect(result.recommendation).toBe("evidence-limited");
  });

  it("includes failed and setup-heavy attempts in aggregate elapsed and counters", () => {
    const result = compareRuns(manifest, complete((index, route) => index === 0
      ? { elapsedMs: route === "ordinary" ? 1000 : 900, attempts: 3, setupFailures: 2, success: false }
      : { elapsedMs: 10 }));

    expect(result.comparisonReady).toBe(true);
    expect(result.ordinary.totalElapsedMs).toBe(1090);
    expect(result.ordinary.attempts).toBe(12);
    expect(result.ordinary.setupFailures).toBe(2);
    expect(result.ordinary.failedRuns).toBe(1);
    expect(result.comparison.ordinary.totalElapsedMs).toBe(1090);
    expect(result.c2c.totalElapsedMs).toBe(990);
    expect(result.c2c.failedRuns).toBe(1);
    expect(result.comparison.c2c.totalElapsedMs).toBe(990);
  });

  it("retains a C2C row without verified cleanup but excludes it from matched evidence", () => {
    const result = compareRuns(manifest, complete((index, route) => index === 0 && route === "c2c"
      ? { cleanupVerified: false }
      : {}));

    expect(result.comparisonReady).toBe(false);
    expect(result.matchedTaskIds).toHaveLength(9);
    expect(result.c2c.submittedRuns).toBe(10);
    expect(result.ineligiblePairs.find(pair => pair.taskId === "R01")?.reasons).toContain("C2C_CLEANUP_UNVERIFIED");
    expect(result.comparison.stopRuleTriggered).toBe(false);
    expect(result.recommendation).toBe("evidence-limited");
  });

  it("retains failed C2C attempts without verified cleanup as incomplete safety evidence", () => {
    const result = compareRuns(manifest, complete((_, route) => ({
      elapsedMs: route === "ordinary" ? 100 : 200,
      success: false,
      cleanupVerified: route === "c2c" ? null : false,
    })));

    expect(result.comparisonReady).toBe(false);
    expect(result.matchedTaskIds).toHaveLength(0);
    expect(result.c2c.submittedRuns).toBe(10);
    expect(result.c2c.fullyJudgedRuns).toBe(10);
    expect(result.c2c.failedRuns).toBe(10);
    expect(result.c2c.totalElapsedMs).toBe(2000);
    expect(result.ineligiblePairs[0].reasons).toContain("C2C_CLEANUP_UNVERIFIED");
    expect(result.comparison.stopRuleTriggered).toBe(false);
    expect(result.recommendation).toBe("evidence-limited");
  });

  it("has no import-time file or output side effects", () => {
    const file = pathToFileURL(path.resolve("scripts/compare-c2c-runs.mjs")).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(file)}); process.stdout.write("IMPORTED")`], {
      cwd: path.resolve("."), encoding: "utf8", timeout: 15_000, windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("IMPORTED");
  });
});
