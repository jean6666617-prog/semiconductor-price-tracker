import { validateAIResponseAgainstContext } from "../validation";
import type { AIProvider } from "../types";
import { getEvaluationCases } from "./cases";
import { scoreEvaluationCase } from "./scoring";
import type { EvaluationResult, EvaluationRun, EvaluationSummary } from "./types";

export const PROMPT_VERSION = "procurement-v1";
export const EVALUATION_VERSION = "eval-v2";
const DEFAULT_DELAY_MS = 3500;
const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_SAFETY_MS = 750;

function evaluated(results: EvaluationResult[]) {
  return results.filter((result) => result.status === "evaluated");
}

function rate(results: EvaluationResult[], read: (result: EvaluationResult) => boolean | null) {
  const eligible = evaluated(results).map(read).filter((value): value is boolean => value !== null);
  return eligible.length ? eligible.filter(Boolean).length / eligible.length : null;
}

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function providerErrorCode(error: unknown): "RATE_LIMIT" | "PROVIDER_ERROR" | "NETWORK_ERROR" {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "RATE_LIMIT" || code === "PROVIDER_ERROR" || code === "NETWORK_ERROR") return code;
  }
  return "NETWORK_ERROR";
}

function retryAfterMs(error: unknown) {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function parseResetDuration(value: string | undefined) {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.max(0, numeric * 1000);
  const match = value.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i);
  if (!match || !match[1] && !match[2] && !match[3]) return undefined;
  return ((Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0)) * 1000;
}

function resetDelayMs(error: unknown) {
  const headers = safeRateLimitHeaders(error);
  return parseResetDuration(headers["x-ratelimit-reset-tokens"])
    ?? parseResetDuration(headers["x-ratelimit-reset-requests"]);
}

function safeRateLimitHeaders(error: unknown) {
  if (typeof error !== "object" || error === null) return {};
  const headers = (error as { rateLimitHeaders?: unknown }).rateLimitHeaders;
  return headers && typeof headers === "object" ? headers as Record<string, string> : {};
}

function logRateLimit(caseId: string, attempt: number, waitMs: number, error: unknown) {
  console.warn("[AI Evaluation] provider rate limit", {
    caseId,
    attempt,
    waitMs,
    headers: safeRateLimitHeaders(error),
  });
}

export function summarizeEvaluation(results: EvaluationResult[]): EvaluationSummary {
  const evaluatedResults = evaluated(results);
  const successfulResponses = evaluatedResults.filter((result) => result.response).length;
  const providerErrors = results.filter((result) => result.status === "notEvaluated").length;
  const rateLimitErrors = results.filter((result) => result.providerError === "RATE_LIMIT").length;
  const rateLimitRetries = results.reduce((sum, result) => sum + (result.rateLimitRetries || 0), 0);
  const averageResponseTimeMs = evaluatedResults.length
    ? evaluatedResults.reduce((sum, result) => sum + result.durationMs, 0) / evaluatedResults.length
    : 0;
  const human = (read: (result: EvaluationResult) => number | null) => {
    const values = evaluatedResults.map(read).filter((value): value is number => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  const baselineStatus = providerErrors === 0 ? "complete" : "partial";
  return {
    totalCases: results.length,
    evaluatedCases: evaluatedResults.length,
    successfulResponses,
    providerErrors,
    rateLimitErrors,
    rateLimitRetries,
    providerErrorRate: results.length ? providerErrors / results.length : null,
    baselineStatus,
    structureValidityRate: rate(results, (result) => result.metrics.structureValidity) || 0,
    factAccuracyRate: rate(results, (result) => result.metrics.factAccuracy) || 0,
    sourceAccuracyRate: rate(results, (result) => result.metrics.sourceAccuracy) || 0,
    hallucinationRate: rate(results, (result) => result.metrics.hallucination) || 0,
    insufficientDataHandlingRate: rate(results, (result) => result.metrics.insufficientDataHandling),
    platformRiskConsistencyRate: rate(results, (result) => result.metrics.platformRiskConsistency),
    futurePredictionSafetyRate: rate(results, (result) => result.metrics.futurePredictionSafety),
    supportedAnswerRate: rate(results, (result) => result.metrics.answerSupport === "supported") || 0,
    averageResponseTimeMs,
    humanMetricAverages: {
      riskReasoning: human((result) => result.metrics.riskReasoning),
      recommendationUsefulness: human((result) => result.metrics.recommendationUsefulness),
    },
  };
}

export async function runEvaluation(input: {
  provider: AIProvider;
  providerName: string;
  model: string;
}): Promise<EvaluationRun> {
  const startedRun = Date.now();
  const results: EvaluationResult[] = [];
  const delayMs = numberEnv("AI_EVALUATION_DELAY_MS", DEFAULT_DELAY_MS);

  for (const [index, testCase] of getEvaluationCases().entries()) {
    if (index > 0 && delayMs > 0) await sleep(delayMs);
    const started = Date.now();
    let rateLimitRetryCount = 0;
    let completed = false;

    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES && !completed; attempt += 1) {
      try {
        const rawResponse = await input.provider.chat({ question: testCase.question, context: testCase.context });
        const metrics = scoreEvaluationCase(testCase, rawResponse);
        const safeResponse = metrics.structureValidity ? validateAIResponseAgainstContext(rawResponse, testCase.context) : undefined;
        results.push({
          caseId: testCase.id,
          question: testCase.question,
          context: testCase.context,
          response: safeResponse,
          status: "evaluated",
          rateLimitRetries: rateLimitRetryCount,
          metrics,
          durationMs: Date.now() - started,
        });
        completed = true;
      } catch (error) {
        const code = providerErrorCode(error);
        if (code === "RATE_LIMIT" && attempt < MAX_RATE_LIMIT_RETRIES) {
          const waitMs = (retryAfterMs(error) ?? resetDelayMs(error) ?? delayMs) + RATE_LIMIT_SAFETY_MS;
          rateLimitRetryCount += 1;
          logRateLimit(testCase.id, attempt + 1, waitMs, error);
          await sleep(waitMs);
          continue;
        }
        const metrics = scoreEvaluationCase(testCase, undefined);
        results.push({
          caseId: testCase.id,
          question: testCase.question,
          context: testCase.context,
          error: "AI provider request failed",
          status: "notEvaluated",
          providerError: code,
          rateLimitRetries: rateLimitRetryCount,
          metrics,
          durationMs: Date.now() - started,
        });
        console.error("[AI Evaluation] case not evaluated", { caseId: testCase.id, providerError: code, retries: rateLimitRetryCount });
        completed = true;
      }
    }
  }

  const summary = summarizeEvaluation(results);
  return {
    provider: input.providerName,
    model: input.model,
    timestamp: new Date().toISOString(),
    promptVersion: PROMPT_VERSION,
    evaluationVersion: EVALUATION_VERSION,
    status: summary.baselineStatus,
    durationMs: Date.now() - startedRun,
    results,
    summary,
  };
}
