import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { checkAnswerEvidence } from "../scripts/check-c2c-answer-evidence.mjs";

const script = path.resolve("scripts/check-c2c-answer-evidence.mjs");
const roots: string[] = [];
const verdict = (changes: Record<string, unknown> = {}) => ({
  answerChecks: [{ answerExcerpt: "高血壓" }, { answerExcerpt: "Follow-up" }],
  sourceChecked: true,
  answerReadDirectly: true,
  judged: true,
  success: true,
  falsePositives: 0,
  ...changes,
});

function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-answer-evidence-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    expect(path.dirname(path.resolve(dir))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(dir).startsWith("c2c-answer-evidence-")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("checkAnswerEvidence", () => {
  it("accepts two exact case-sensitive quotes, including Chinese", () => {
    const result = checkAnswerEvidence("病人有高血壓。\nFollow-up is planned.", verdict());
    expect(result).toEqual({ wordCount: 4, quoteCount: 2, errors: [], valid: true, contentJudgmentVerified: false });
  });

  it("rejects translated, hallucinated, and duplicated excerpts without inflating quoteCount", () => {
    const result = checkAnswerEvidence("The original finding is Alpha.", verdict({
      answerChecks: [
        { answerExcerpt: "Alpha" }, { answerExcerpt: "Alpha" },
        { answerExcerpt: "原始發現" }, { answerExcerpt: "Invented quote" },
      ],
    }));
    expect(result.quoteCount).toBe(1);
    expect(result.errors).toContain("INSUFFICIENT_EXACT_QUOTES");
    expect(result.valid).toBe(false);
  });

  it("requires direct source and answer attestations, judgment, boolean success, and a nonnegative integer false-positive count", () => {
    const result = checkAnswerEvidence("高血壓 Follow-up", verdict({
      sourceChecked: false,
      answerReadDirectly: false,
      judged: false,
      success: "true",
      falsePositives: -1,
    }));
    expect(result.errors).toEqual(expect.arrayContaining([
      "SOURCE_NOT_CHECKED", "ANSWER_NOT_READ_DIRECTLY", "ANSWER_NOT_JUDGED", "SUCCESS_NOT_BOOLEAN", "INVALID_FALSE_POSITIVES",
    ]));
  });

  it("rejects an invented extra quote even when two other quotes match", () => {
    const result = checkAnswerEvidence("Alpha Beta", verdict({
      answerChecks: [{ answerExcerpt: "Alpha" }, { answerExcerpt: "Beta" }, { answerExcerpt: "Invented" }],
    }));
    expect(result).toMatchObject({ valid: false, quoteCount: 2, errors: ["EXCERPT_NOT_IN_ANSWER"] });
  });

  it("rejects whitespace-only excerpts", () => {
    const result = checkAnswerEvidence("Alpha Beta", verdict({
      answerChecks: [{ answerExcerpt: "Alpha" }, { answerExcerpt: "Beta" }, { answerExcerpt: " " }],
    }));
    expect(result.errors).toContain("EMPTY_ANSWER_EXCERPT");
    expect(result.valid).toBe(false);
  });

  it("counts whitespace-delimited words exactly and enforces the default 500-word limit", () => {
    const answer = (count: number) => ["高血壓", "Follow-up", ...Array(count - 2).fill("w")].join(" ");
    expect(checkAnswerEvidence(answer(500), verdict()).wordCount).toBe(500);
    expect(checkAnswerEvidence(answer(500), verdict()).valid).toBe(true);
    expect(checkAnswerEvidence(answer(430), verdict()).wordCount).toBe(430);
    expect(checkAnswerEvidence(answer(501), verdict()).errors).toContain("WORD_LIMIT_EXCEEDED");
  });

  it("accepts a judged failed answer as valid evidence", () => {
    const result = checkAnswerEvidence("高血壓 Follow-up", verdict({ success: false }));
    expect(result).toMatchObject({ valid: true, contentJudgmentVerified: false, errors: [] });
  });
});

describe("check-c2c-answer-evidence CLI", () => {
  it("reads inputs without modifying them and reports JSON for invalid CLI arguments and missing files", () => {
    const dir = root();
    const answerFile = path.join(dir, "answer.txt");
    const verdictFile = path.join(dir, "verdict.json");
    fs.writeFileSync(answerFile, "高血壓 Follow-up");
    fs.writeFileSync(verdictFile, JSON.stringify(verdict()));
    const before = [fs.readFileSync(answerFile, "utf8"), fs.readFileSync(verdictFile, "utf8")];

    const valid = spawnSync(process.execPath, [script, answerFile, verdictFile], { encoding: "utf8", windowsHide: true });
    expect(valid.status).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({ valid: true, quoteCount: 2 });
    expect([fs.readFileSync(answerFile, "utf8"), fs.readFileSync(verdictFile, "utf8")]).toEqual(before);

    const invalid = spawnSync(process.execPath, [script], { encoding: "utf8", windowsHide: true });
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ valid: false, errors: ["USAGE"] });

    const missing = spawnSync(process.execPath, [script, path.join(dir, "missing.txt"), verdictFile], { encoding: "utf8", windowsHide: true });
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({ valid: false, errors: ["ENOENT"] });
  });
});
