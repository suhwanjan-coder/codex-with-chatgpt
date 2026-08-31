import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function checkAnswerEvidence(answer, verdict, { maxWords = 500 } = {}) {
  const errors = [];
  const savedAnswer = typeof answer === "string" ? answer : "";
  const wordCount = (savedAnswer.match(/\S+/g) ?? []).length;
  const excerpts = new Set();

  if (typeof answer !== "string") errors.push("ANSWER_NOT_STRING");
  if (!Number.isInteger(maxWords) || maxWords < 0) errors.push("INVALID_MAX_WORDS");
  else if (wordCount > maxWords) errors.push("WORD_LIMIT_EXCEEDED");

  if (!object(verdict)) {
    errors.push("VERDICT_NOT_OBJECT");
  } else {
    if (!Array.isArray(verdict.answerChecks)) {
      errors.push("ANSWER_CHECKS_NOT_ARRAY");
    } else {
      for (const check of verdict.answerChecks) {
        if (!object(check) || !has(check, "answerExcerpt") || typeof check.answerExcerpt !== "string") {
          errors.push("INVALID_ANSWER_CHECK");
          continue;
        }
        if (check.answerExcerpt.trim().length === 0) {
          errors.push("EMPTY_ANSWER_EXCERPT");
          continue;
        }
        if (savedAnswer.includes(check.answerExcerpt)) excerpts.add(check.answerExcerpt);
        else errors.push("EXCERPT_NOT_IN_ANSWER");
      }
      if (excerpts.size < 2) errors.push("INSUFFICIENT_EXACT_QUOTES");
    }
    if (verdict.sourceChecked !== true) errors.push("SOURCE_NOT_CHECKED");
    if (verdict.answerReadDirectly !== true) errors.push("ANSWER_NOT_READ_DIRECTLY");
    if (verdict.judged !== true) errors.push("ANSWER_NOT_JUDGED");
    if (typeof verdict.success !== "boolean") errors.push("SUCCESS_NOT_BOOLEAN");
    if (!Number.isInteger(verdict.falsePositives) || verdict.falsePositives < 0) errors.push("INVALID_FALSE_POSITIVES");
  }

  return {
    wordCount,
    quoteCount: excerpts.size,
    errors,
    valid: errors.length === 0,
    contentJudgmentVerified: false,
  };
}

export function runCli(args = process.argv.slice(2)) {
  const [answerFile, verdictFile, ...extra] = args;
  if (!answerFile || !verdictFile || extra.length > 0) {
    return { wordCount: 0, quoteCount: 0, errors: ["USAGE"], valid: false, contentJudgmentVerified: false };
  }
  try {
    return checkAnswerEvidence(
      fs.readFileSync(path.resolve(answerFile), "utf8"),
      JSON.parse(fs.readFileSync(path.resolve(verdictFile), "utf8")),
    );
  } catch (error) {
    return {
      wordCount: 0,
      quoteCount: 0,
      errors: [error?.code ?? "INVALID_INPUT"],
      valid: false,
      contentJudgmentVerified: false,
    };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runCli();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.valid) process.exitCode = 1;
}
