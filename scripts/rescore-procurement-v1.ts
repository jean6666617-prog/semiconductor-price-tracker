import fs from "node:fs";
import { getEvaluationCases } from "../lib/ai/evaluation/cases";
import { scoreEvaluationCase } from "../lib/ai/evaluation/scoring";
import { EVALUATION_VERSION, summarizeEvaluation } from "../lib/ai/evaluation/run";
import type { EvaluationResult } from "../lib/ai/evaluation/types";

const inputPath = process.argv[2] || "ai-evaluation-real-procurement-v1-openai-gpt-oss-20b-2026-08-15.json";
const outputPath = process.argv[3] || inputPath.replace(/\.json$/, "-rescored.json");
const baseline = JSON.parse(fs.readFileSync(inputPath, "utf8")) as {
  results: Array<Record<string, unknown> & { caseId: string; response?: unknown; status?: string; metrics: Record<string, unknown> }>;
  [key: string]: unknown;
};
const cases = new Map(getEvaluationCases().map((item) => [item.id, item]));
const results = baseline.results.map((item) => {
  const testCase = cases.get(item.caseId);
  if (!testCase || item.status !== "evaluated" || !item.response) return item;
  return { ...item, metrics: scoreEvaluationCase(testCase, item.response) };
});

const run = {
  ...baseline,
  evaluationVersion: EVALUATION_VERSION,
  rescoredAt: new Date().toISOString(),
  results,
  summary: summarizeEvaluation(results as unknown as EvaluationResult[]),
};
fs.writeFileSync(outputPath, JSON.stringify(run, null, 2));
console.log(JSON.stringify({ outputPath, evaluationVersion: run.evaluationVersion, summary: run.summary }));
