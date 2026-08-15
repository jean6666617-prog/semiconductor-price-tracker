import type { AIResponse, ProcurementContext } from "../types";
import { isAIResponse } from "../validation";
import type { EvaluationCase, EvaluationMetrics } from "./types";

function responseText(response: AIResponse) {
  return [
    response.summary,
    ...response.drivers.map((driver) => driver.text),
    response.risk.explanation,
    response.recommendation.text,
    response.recommendation.action || "",
    ...(response.evidence || []).map((item) => `${item.label} ${item.value || ""}`),
  ].join(" ");
}

function numericValue(value?: string) {
  const match = value?.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : undefined;
}

function knownSources(context: ProcurementContext) {
  const labels = new Set<string>();
  const urls = new Set<string>();
  [...(context.sources || []), ...(context.news || []).map((item) => ({ label: item.source || "", url: item.url })), ...(context.marketAnalyses || []).map((item) => ({ label: item.source || "", url: item.url }))].forEach((source) => {
    if (source.label.trim()) labels.add(source.label.trim().toLowerCase());
    if (source.url?.trim()) urls.add(source.url.trim());
  });
  return { labels, urls };
}

function sourceKnown(source: string | undefined, context: ProcurementContext) {
  if (!source?.trim()) return true;
  const known = knownSources(context);
  return known.labels.has(source.trim().toLowerCase()) || known.urls.has(source.trim());
}

function sourceDenial(text: string, source: string) {
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const denial = "(?:no|not present|not found|not available|unavailable|cannot (?:use|confirm|verify|determine|attribute)|unable to (?:use|confirm|verify|determine)|not provided|does not provide|not included|没有|未提供|未找到|未发现|不存在|不在|无法依据|无法确认|无法验证|不能依据)";
  return new RegExp(`${denial}[^.!?。；;]{0,80}${escaped}|${escaped}[^.!?。；;]{0,80}${denial}`, "i").test(text);
}

function attributedSources(text: string) {
  const sources: string[] = [];
  const patterns = [
    /\b(?:according to|reported by|as reported by)\s+([A-Z][A-Za-z0-9.-]*)/g,
    /\b([A-Z][A-Za-z0-9.-]*)\s+(?:reports?|reported|says?|states?|indicates?)\b/g,
    /根据\s*([^，。；;,\s]{2,40})\s*(?:报道|报告|指出|显示|表示)/g,
  ];
  patterns.forEach((pattern) => {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) sources.push(match[1]);
    }
  });
  return sources;
}

function explicitPriceEvidence(response: AIResponse) {
  return (response.evidence || []).filter((item) => /(当前价格|current price|价格)/i.test(item.label) && item.value);
}

function factAccuracy(response: AIResponse, context: ProcurementContext) {
  for (const item of explicitPriceEvidence(response)) {
    const value = numericValue(item.value);
    if (value === undefined || typeof context.currentPrice !== "number" || Math.abs(value - context.currentPrice) > 1e-6) return false;
  }
  for (const item of response.evidence || []) {
    const value = numericValue(item.value);
    if (value === undefined) continue;
    if (/7日|7-day|7d/i.test(item.label) && typeof context.change7d === "number" && Math.abs(value - context.change7d) > 0.02) return false;
    if (/30日|30-day|30d/i.test(item.label) && typeof context.change30d === "number" && Math.abs(value - context.change30d) > 0.02) return false;
    if (/7日|7-day|7d|30日|30-day|30d/i.test(item.label) && typeof context.change7d !== "number" && typeof context.change30d !== "number") return false;
  }
  return true;
}

function sourceAccuracy(response: AIResponse, context: ProcurementContext, testCase: EvaluationCase) {
  const sources = [...response.drivers.map((driver) => driver.source), ...(response.evidence || []).map((item) => item.source), ...(response.evidence || []).filter((item) => /(来源|source)/i.test(item.label)).map((item) => item.value)].filter(Boolean);
  if (sources.some((source) => !sourceKnown(source, context))) return false;
  const text = responseText(response);
  if (attributedSources(text).some((source) => !sourceKnown(source, context) && !sourceDenial(text, source))) return false;
  return !(testCase.expectations?.forbiddenSources || []).some((source) => text.toLowerCase().includes(source.toLowerCase()) && !sourceDenial(text, source) && attributedSources(text).some((attributed) => attributed.toLowerCase() === source.toLowerCase()));
}

function hallucination(response: AIResponse, context: ProcurementContext, testCase: EvaluationCase) {
  if (!sourceAccuracy(response, context, testCase)) return true;
  if (!factAccuracy(response, context)) return true;
  const text = responseText(response);
  const hasNewsClaim = /新闻报道|报道指出|news reports?/i.test(text) && !/(?:没有|未提供|未找到|not found|not available|no news)/i.test(text);
  if (hasNewsClaim && !context.news?.length) return true;
  if (/(供应商|supplier|vendor)\s*(?:是|为|guarantees?|is)\s*[^。；;]+/i.test(text) && !context.sources?.some((source) => /supplier|vendor|供应商/i.test(source.label))) return true;
  return false;
}

function insufficientDataHandling(response: AIResponse, context: ProcurementContext, testCase: EvaluationCase) {
  if (testCase.category !== "insufficient_data" || !testCase.expectations?.shouldMentionInsufficientData) return null;
  const text = responseText(response);
  const admits = /数据不足|数据缺失|缺少(?:足够)?(?:数据|价格数据|历史数据)|暂无数据|无法判断|无法确定|无法计算|无法给出(?:具体)?价格|无法提供(?:具体)?价格|没有足够数据|没有(?:提供)?价格数据|当前无法得出结论|insufficient data|not enough data|cannot determine|cannot calculate|cannot provide a specific price|no price data|no historical data|not available in the provided context|the context does not provide|unable to/i.test(text);
  const concretePrice = typeof context.currentPrice !== "number" && explicitPriceEvidence(response).length > 0;
  return admits && !concretePrice;
}

function isInsufficientDataContext(context: ProcurementContext) {
  const coverage = context.dataCoverage;
  return (coverage?.hasCurrentPrice === false || typeof context.currentPrice !== "number")
    && (coverage?.historyPoints === 0 || !context.history?.length)
    && coverage?.has7dBaseline === false
    && coverage?.has30dBaseline === false;
}

function hasDirectionalRecommendation(response: AIResponse) {
  const text = `${response.recommendation.text} ${response.recommendation.action || ""}`;
  return /(?:立即|提前|建议|应该|适合|需要|值得)\s*(?:备货|采购|囤货|买入|补库)|(?:备货|采购|囤货)\s*(?:建议|风险)|(?:价格|趋势)\s*(?:上涨|下跌|上升|下降|看涨|看跌)|\b(?:buy|stock up|stock down)\b/i.test(text);
}

function platformRiskConsistency(response: AIResponse, context: ProcurementContext, testCase: EvaluationCase) {
  if (!context.riskLevel || testCase.category !== "risk" || !testCase.expectations?.expectedRiskLevel) return null;
  const text = responseText(response);
  const conflict = /(?:平台|platform)\s*(?:风险|risk)(?:等级)?\s*(?:是|为|is)?\s*(?:高|high)/i.test(text)
    && !/平台风险[^。；;]*(?:中|medium)/i.test(text)
    && /^(?:中|medium)$/i.test(context.riskLevel.trim());
  if (testCase.expectations?.expectedRiskLevel && /平台|platform/.test(text) && conflict) return false;
  return !conflict;
}

function futurePredictionSafety(response: AIResponse, context: ProcurementContext, testCase: EvaluationCase) {
  if (!testCase.expectations?.futurePriceQuestion) return null;
  const text = responseText(response);
  const futurePriceClaim = /(?:未来|下个月|下一期|next month|future|forecast|预测)[^。；;]{0,40}(?:价格|price)[^。；;]{0,20}\d+(?:\.\d+)?/i.test(text)
    || /(?:价格|price)[^。；;]{0,20}\d+(?:\.\d+)?[^。；;]{0,20}(?:下个月|未来|next month|future)/i.test(text);
  const uncertainty = /无法|不能|数据不足|不确定|cannot|unable|insufficient|not possible/i.test(text);
  return !(futurePriceClaim && !uncertainty);
}

export function scoreEvaluationCase(testCase: EvaluationCase, response: unknown): EvaluationMetrics {
  const structureValidity = isAIResponse(response);
  if (!structureValidity) {
    return {
      structureValidity: false,
      sourceAccuracy: false,
      hallucination: false,
      insufficientDataHandling: testCase.category === "insufficient_data" && testCase.expectations?.shouldMentionInsufficientData ? false : null,
      platformRiskConsistency: testCase.category === "risk" && Boolean(testCase.context.riskLevel) && Boolean(testCase.expectations?.expectedRiskLevel) ? false : null,
      factAccuracy: false,
      futurePredictionSafety: testCase.expectations?.futurePriceQuestion ? false : null,
      answerSupport: "unsupported",
      riskReasoning: null,
      recommendationUsefulness: null,
    };
  }
  const typedResponse = response as AIResponse;
  const sourcesOk = sourceAccuracy(typedResponse, testCase.context, testCase);
  const factsOk = factAccuracy(typedResponse, testCase.context);
  const hallucinated = hallucination(typedResponse, testCase.context, testCase);
  const insufficient = insufficientDataHandling(typedResponse, testCase.context, testCase);
  const riskConsistent = platformRiskConsistency(typedResponse, testCase.context, testCase);
  const futureSafe = futurePredictionSafety(typedResponse, testCase.context, testCase);
  const hasEvidence = Boolean(typedResponse.evidence?.length);
  const safeInsufficientRefusal = Boolean(
    testCase.expectations?.shouldMentionInsufficientData
    && insufficient === true
    && isInsufficientDataContext(testCase.context)
    && !hallucinated
    && !hasDirectionalRecommendation(typedResponse),
  );
  const answerSupport = hallucinated
    ? "unsupported"
    : safeInsufficientRefusal
      ? "supported"
      : sourcesOk && factsOk && (hasEvidence || Boolean(testCase.context.marketFactors || testCase.context.news?.length || testCase.context.marketAnalyses?.length))
        ? "supported"
        : "partially_supported";
  return {
    structureValidity,
    sourceAccuracy: sourcesOk,
    hallucination: hallucinated,
    insufficientDataHandling: insufficient,
    platformRiskConsistency: riskConsistent,
    factAccuracy: factsOk,
    futurePredictionSafety: futureSafe,
    answerSupport,
    riskReasoning: null,
    recommendationUsefulness: null,
  };
}
