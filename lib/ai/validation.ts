import type { AIDriver, AIResponse, Evidence, LiveSearchResult, ProcurementContext } from "./types";

const DRIVER_TYPES = new Set<AIDriver["type"]>(["data", "news", "market_analysis", "platform_analysis", "inference"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isEvidence(value: unknown): value is Evidence {
  if (!isRecord(value) || !hasOnlyKeys(value, ["label", "source", "value"])) return false;
  return typeof value.label === "string" && value.label.trim().length > 0
    && (value.source === undefined || typeof value.source === "string")
    && (value.value === undefined || typeof value.value === "string");
}

function isDriver(value: unknown): value is AIDriver {
  if (!isRecord(value) || !hasOnlyKeys(value, ["text", "type", "source"])) return false;
  return typeof value.text === "string" && value.text.trim().length > 0
    && typeof value.type === "string"
    && DRIVER_TYPES.has(value.type as AIDriver["type"])
    && (value.source === undefined || typeof value.source === "string");
}

export function isAIResponse(value: unknown): value is AIResponse {
  if (!isRecord(value) || !hasOnlyKeys(value, ["answer", "summary", "drivers", "risk", "recommendation", "evidence", "dataConfidence", "disclaimer"])) return false;
  const risk = value.risk;
  const recommendation = value.recommendation;
  return (value.answer === undefined || (typeof value.answer === "string" && value.answer.trim().length > 0))
    && typeof value.summary === "string" && value.summary.trim().length > 0
    && Array.isArray(value.drivers) && value.drivers.every(isDriver)
    && isRecord(risk)
    && hasOnlyKeys(risk, ["level", "explanation"])
    && ["low", "medium", "high", "unknown"].includes(String(risk.level))
    && typeof risk.explanation === "string"
    && isRecord(recommendation)
    && hasOnlyKeys(recommendation, ["text", "action"])
    && typeof recommendation.text === "string" && recommendation.text.trim().length > 0
    && (recommendation.action === undefined || typeof recommendation.action === "string")
    && (value.evidence === undefined || (Array.isArray(value.evidence) && value.evidence.every(isEvidence)))
    && (value.dataConfidence === undefined || ["low", "medium", "high"].includes(String(value.dataConfidence)))
    && (value.disclaimer === undefined || typeof value.disclaimer === "string");
}

function knownSources(context: ProcurementContext, liveSearchResults: LiveSearchResult[] = []) {
  const labels = new Set<string>();
  const urls = new Set<string>();
  const canonicalByLabel = new Map<string, string>();
  const add = (label?: string, url?: string) => {
    if (label?.trim()) {
      const normalizedLabel = label.trim().toLowerCase();
      labels.add(normalizedLabel);
      if (url?.trim()) canonicalByLabel.set(normalizedLabel, url.trim());
    }
    if (url?.trim()) urls.add(url.trim());
  };
  context.sources?.forEach((source) => add(source.label, source.url));
  context.news?.forEach((item) => add(item.source, item.url));
  context.marketAnalyses?.forEach((item) => add(item.source, item.url));
  liveSearchResults.forEach((item) => add(item.source, item.url));
  return { labels, urls, canonicalByLabel };
}

function isKnownSource(source: string | undefined, known: ReturnType<typeof knownSources>) {
  if (!source?.trim()) return true;
  const value = source.trim();
  return known.urls.has(value) || known.labels.has(value.toLowerCase());
}

function canonicalSource(source: string | undefined, known: ReturnType<typeof knownSources>) {
  if (!source?.trim()) return undefined;
  const value = source.trim();
  return known.urls.has(value) ? value : known.canonicalByLabel.get(value.toLowerCase()) || value;
}

function numericValue(value: string) {
  const match = value.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : undefined;
}

function isUnverifiedPriceEvidence(item: Evidence, context: ProcurementContext) {
  if (!/(价格|price)/i.test(item.label) || !item.value) return false;
  const parsed = numericValue(item.value);
  if (parsed === undefined) return false;
  if (typeof context.currentPrice !== "number") return true;
  if (/当前价格|current price/i.test(item.label)) return Math.abs(parsed - context.currentPrice) > 1e-8;
  return false;
}

function confidenceForContext(context: ProcurementContext) {
  const coverage = context.dataCoverage;
  const hasCurrentPrice = coverage?.hasCurrentPrice ?? typeof context.currentPrice === "number";
  const hasSource = coverage?.hasSource ?? Boolean(context.sources?.length);
  const hasEnoughHistory = coverage?.hasEnoughHistory ?? false;
  const hasExternalEvidence = Boolean(coverage?.hasNews || coverage?.hasMarketAnalysis || context.news?.length || context.marketAnalyses?.length);
  if (hasCurrentPrice && hasSource && hasEnoughHistory && hasExternalEvidence) return "high" as const;
  if (hasCurrentPrice && hasSource) return "medium" as const;
  return "low" as const;
}

export function deriveDataConfidence(context: ProcurementContext) {
  return confidenceForContext(context);
}

function contextPriceLabel(context: ProcurementContext) {
  if (typeof context.currentPrice !== "number") return undefined;
  return [context.currentPrice, context.currency, context.unit ? `/ ${context.unit}` : ""]
    .filter(Boolean)
    .join(" ");
}

/** Facts copied from Context so optional model evidence cannot hide available data. */
function contextEvidence(context: ProcurementContext): Evidence[] {
  const evidence: Evidence[] = [];
  const add = (label: string, value?: string, source?: string) => {
    if (value?.trim()) evidence.push({ label, value, ...(source ? { source } : {}) });
  };
  add("当前价格", contextPriceLabel(context));
  if (typeof context.change1d === "number") add("1日变化", `${context.change1d >= 0 ? "+" : ""}${context.change1d.toFixed(2)}%`);
  if (typeof context.change7d === "number") add("7日变化", `${context.change7d >= 0 ? "+" : ""}${context.change7d.toFixed(2)}%`);
  if (typeof context.change30d === "number") add("30日变化", `${context.change30d >= 0 ? "+" : ""}${context.change30d.toFixed(2)}%`);
  if (typeof context.streak === "number") add("连续变化", `${context.streak} 天`);
  const historyPoints = context.dataCoverage?.historyPoints ?? context.history?.length ?? 0;
  if (historyPoints > 0) add("历史样本", `${historyPoints} 天`);
  if (typeof context.dataCoverage?.historySpanDays === "number" && context.dataCoverage.historySpanDays > 0) {
    add("历史跨度", `${context.dataCoverage.historySpanDays} 天`);
  }
  context.sources?.slice(0, 4).forEach((source) => add("数据来源", source.label, source.url || source.label));
  context.news?.slice(0, 3).forEach((item) => add("新闻证据", item.title, item.url || item.source));
  context.marketAnalyses?.slice(0, 3).forEach((item) => add("机构分析", item.title || item.summary, item.url || item.source));
  return evidence;
}

function normalizedRiskLevel(value?: string): AIResponse["risk"]["level"] | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["高", "high"].includes(normalized)) return "high";
  if (["中", "medium"].includes(normalized)) return "medium";
  if (["低", "low"].includes(normalized)) return "low";
  return undefined;
}

function deterministicRiskExplanation(context: ProcurementContext, effectiveLevel?: AIResponse["risk"]["level"]) {
  const facts = [
    contextPriceLabel(context) ? `当前价格为${contextPriceLabel(context)}` : "当前价格缺失",
    typeof context.change7d === "number" ? `7日变化${context.change7d >= 0 ? "+" : ""}${context.change7d.toFixed(2)}%` : "缺少7日变化",
    typeof context.change30d === "number" ? `30日变化${context.change30d >= 0 ? "+" : ""}${context.change30d.toFixed(2)}%` : "缺少30日变化",
  ];
  const coverage = context.dataCoverage;
  const missing = [
    coverage?.has7dBaseline === false ? "7日前附近的基准样本" : "",
    coverage?.has30dBaseline === false ? "30日前附近的基准样本" : "",
    !context.sources?.length ? "可核验来源" : "",
  ].filter(Boolean);
  if (effectiveLevel && effectiveLevel !== "unknown") {
    return `${context.riskReason ? `${context.riskReason} ` : `平台风险等级为${context.riskLevel || effectiveLevel}。 `}已核验数据：${facts.join("；")}。`;
  }
  return `当前 Context 未提供确定的平台风险等级。已核验数据：${facts.join("；")}。${missing.length ? `仍缺少${missing.join("、")}，因此不能据此给出确定的风险结论。` : "这些数据可用于继续跟踪，但不足以单独确认未来风险。"}`;
}

function hasUnverifiedAttribution(text: string) {
  return /\b(?:according to|reported by|reports?|says?|cited by)\s+[A-Z][\w.-]*/i.test(text)
    || /[\u4e00-\u9fffA-Za-z0-9._-]{2,40}\s*(?:表示|称|报道|指出|报告|消息称|显示)/.test(text);
}

export function validateAIResponseAgainstContext(response: AIResponse, context: ProcurementContext, liveSearchResults: LiveSearchResult[] = []): AIResponse {
  const known = knownSources(context, liveSearchResults);
  let removedDriverSource = false;
  const drivers = response.drivers.map((driver) => {
    if (isKnownSource(driver.source, known)) return { ...driver, ...(driver.source ? { source: canonicalSource(driver.source, known) } : {}) };
    if (driver.source && hasUnverifiedAttribution(driver.text)) return null;
    if (driver.source) removedDriverSource = true;
    return { text: driver.text, type: "inference" as const };
  }).filter((driver): driver is AIDriver => Boolean(driver));
  let removedEvidence = 0;
  const evidence = (response.evidence ?? []).filter((item) => {
    const sourceValid = isKnownSource(item.source, known);
    const sourceValueValid = !/(来源|source)/i.test(item.label) || !item.value || isKnownSource(item.value, known);
    const priceValid = !isUnverifiedPriceEvidence(item, context);
    if (!sourceValid || !sourceValueValid || !priceValid) {
      removedEvidence += 1;
      return false;
    }
    return true;
  }).map((item) => ({ ...item, ...(item.source ? { source: canonicalSource(item.source, known) } : {}) }));
  const removedUnverifiedDriver = response.drivers.length !== drivers.length;
  const validationNote = removedEvidence || removedUnverifiedDriver || removedDriverSource ? "部分模型生成内容未能在平台 Context 中核验，已隐藏。" : "";
  const deterministic = contextEvidence(context);
  const evidenceKeys = new Set(evidence.map((item) => `${item.label}|${item.value || ""}|${item.source || ""}`));
  const mergedEvidence = [...evidence, ...deterministic.filter((item) => {
    const key = `${item.label}|${item.value || ""}|${item.source || ""}`;
    if (evidenceKeys.has(key)) return false;
    evidenceKeys.add(key);
    return true;
  })];
  const contextRiskLevel = normalizedRiskLevel(context.riskLevel);
  const effectiveRiskLevel = response.risk.level === "unknown" && contextRiskLevel ? contextRiskLevel : response.risk.level;
  return {
    ...response,
    risk: {
      ...response.risk,
      level: effectiveRiskLevel,
      ...(response.risk.level === "unknown" || !response.risk.explanation.trim()
        ? { explanation: deterministicRiskExplanation(context, effectiveRiskLevel) }
        : {}),
    },
    drivers,
    evidence: mergedEvidence,
    dataConfidence: confidenceForContext(context),
    disclaimer: [response.disclaimer, validationNote].filter(Boolean).join(" ") || undefined,
  };
}
