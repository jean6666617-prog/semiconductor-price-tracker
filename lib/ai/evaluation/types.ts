import type { AIProvider, AIResponse, ProcurementContext } from "../types";

export type EvaluationCategory = "price" | "trend" | "risk" | "procurement" | "source" | "insufficient_data" | "hallucination";

export type EvaluationExpectations = {
  shouldAnswer?: boolean;
  expectedSources?: string[];
  forbiddenSources?: string[];
  shouldMentionInsufficientData?: boolean;
  expectedRiskLevel?: string;
  allowRecommendation?: boolean;
  futurePriceQuestion?: boolean;
};

export type EvaluationCase = {
  id: string;
  category: EvaluationCategory;
  question: string;
  context: ProcurementContext;
  expectations?: EvaluationExpectations;
};

export type EvaluationMetrics = {
  structureValidity: boolean;
  sourceAccuracy: boolean;
  hallucination: boolean;
  insufficientDataHandling: boolean | null;
  platformRiskConsistency: boolean | null;
  factAccuracy: boolean;
  futurePredictionSafety: boolean | null;
  answerSupport: "supported" | "partially_supported" | "unsupported";
  riskReasoning: number | null;
  recommendationUsefulness: number | null;
};

export type EvaluationResult = {
  caseId: string;
  question: string;
  context?: ProcurementContext;
  response?: AIResponse;
  error?: string;
  status: "evaluated" | "notEvaluated";
  providerError?: "RATE_LIMIT" | "PROVIDER_ERROR" | "NETWORK_ERROR";
  rateLimitRetries?: number;
  metrics: EvaluationMetrics;
  durationMs: number;
};

export type EvaluationSummary = {
  totalCases: number;
  evaluatedCases: number;
  successfulResponses: number;
  providerErrors: number;
  rateLimitErrors: number;
  rateLimitRetries: number;
  providerErrorRate: number | null;
  baselineStatus: "complete" | "partial";
  structureValidityRate: number;
  factAccuracyRate: number;
  sourceAccuracyRate: number;
  hallucinationRate: number;
  insufficientDataHandlingRate: number | null;
  platformRiskConsistencyRate: number | null;
  futurePredictionSafetyRate: number | null;
  supportedAnswerRate: number;
  averageResponseTimeMs: number;
  humanMetricAverages: {
    riskReasoning: number | null;
    recommendationUsefulness: number | null;
  };
};

export type EvaluationRun = {
  provider: string;
  model: string;
  timestamp: string;
  promptVersion: string;
  evaluationVersion?: string;
  status: "complete" | "partial";
  durationMs: number;
  results: EvaluationResult[];
  summary: EvaluationSummary;
};

export type EvaluationProvider = Pick<AIProvider, "chat">;
