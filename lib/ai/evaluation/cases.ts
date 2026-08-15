import type { ProcurementContext, PricePoint } from "../types";
import type { EvaluationCase } from "./types";

const lCSC = { label: "LCSC", url: "https://www.lcsc.com/product-detail/example.html" };
const trendForce = { label: "TrendForce", url: "https://www.trendforce.com/price" };
const sunSirs = { label: "SunSirs", url: "https://www.sunsirs.com/price" };

function dateOffset(latest: string, daysAgo: number) {
  const date = new Date(`${latest}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function history(latest: string, points: number, price: number, step = 0.15): PricePoint[] {
  return Array.from({ length: points }, (_, index) => {
    const daysAgo = points - 1 - index;
    return { date: dateOffset(latest, daysAgo), price: Number((price - daysAgo * step).toFixed(4)) };
  });
}

function coverage(input: Partial<NonNullable<ProcurementContext["dataCoverage"]>> = {}): NonNullable<ProcurementContext["dataCoverage"]> {
  return {
    historyPoints: 31,
    historySpanDays: 30,
    hasCurrentPrice: true,
    hasSource: true,
    hasNews: false,
    hasMarketAnalysis: true,
    hasMarketFactors: false,
    has7dBaseline: true,
    has30dBaseline: true,
    hasEnoughHistory: true,
    ...input,
  };
}

function ddrContext(overrides: Partial<ProcurementContext> = {}): ProcurementContext {
  return {
    materialName: "DDR4 16Gb (2Gx8) 3200",
    category: "Memory",
    currentPrice: 65.749,
    currency: "USD",
    unit: "pcs",
    change7d: 4.2,
    change30d: 8.6,
    change1d: 0.84,
    streak: 3,
    trendDirection: "上涨",
    riskLevel: "中",
    riskReason: "价格连续上涨且历史数据覆盖完整。",
    history: history("2026-08-15", 31, 65.749),
    sources: [lCSC, trendForce],
    marketAnalyses: [{ title: "DRAM market outlook", summary: "AI server demand remains firm.", source: trendForce.label, url: trendForce.url, date: "2026-08-15" }],
    marketFactors: { positiveFactors: ["AI服务器需求支撑"], negativeFactors: [], marketView: "短期偏强" },
    lastUpdated: "2026-08-15T10:00:00+08:00",
    dataCoverage: coverage({ hasMarketFactors: true }),
    ...overrides,
  };
}

function absContext(overrides: Partial<ProcurementContext> = {}): ProcurementContext {
  return {
    materialName: "ABS",
    category: "Plastic",
    currentPrice: 14050,
    currency: "CNY",
    unit: "ton",
    change7d: 0.84,
    change30d: 1.4,
    trendDirection: "震荡",
    riskLevel: "中",
    riskReason: "价格波动后进入整理阶段。",
    history: history("2026-08-15", 31, 14050, 1.2),
    sources: [sunSirs],
    marketFactors: { positiveFactors: ["原材料价格上涨"], negativeFactors: ["下游需求疲软"], marketView: "短期震荡" },
    lastUpdated: "2026-08-15T10:00:00+08:00",
    dataCoverage: coverage({ hasMarketAnalysis: false, hasMarketFactors: true }),
    ...overrides,
  };
}

function lcdInsufficientContext(): ProcurementContext {
  return {
    materialName: "LCD Panel",
    category: "Display",
    sources: [],
    history: [],
    dataCoverage: coverage({ historyPoints: 0, historySpanDays: 0, hasCurrentPrice: false, hasSource: false, hasMarketAnalysis: false, has7dBaseline: false, has30dBaseline: false, hasEnoughHistory: false }),
  };
}

function caseItem(id: string, category: EvaluationCase["category"], question: string, context: ProcurementContext, expectations?: EvaluationCase["expectations"]): EvaluationCase {
  return { id, category, question, context, expectations };
}

export const evaluationCases: EvaluationCase[] = [
  caseItem("price-ddr-current", "price", "DDR4 当前价格是多少？", ddrContext()),
  caseItem("price-ddr-change7d", "price", "DDR4 最近7日价格变化是多少？", ddrContext()),
  caseItem("price-abs-current", "price", "ABS 当前价格和单位是什么？", absContext()),
  caseItem("trend-ddr-7d", "trend", "DDR4 最近7日上涨的趋势是否值得关注？", ddrContext()),
  caseItem("trend-ddr-30d", "trend", "DDR4 过去30日变化如何？", ddrContext()),
  caseItem("trend-abs", "trend", "ABS 最近的趋势是什么？", absContext()),
  caseItem("risk-ddr", "risk", "DDR4 当前风险等级是什么，为什么？", ddrContext(), { expectedRiskLevel: "中" }),
  caseItem("risk-abs", "risk", "ABS 是否需要关注？", absContext(), { expectedRiskLevel: "中" }),
  caseItem("procurement-ddr", "procurement", "DDR4 是否应该提前备货？", ddrContext(), { allowRecommendation: true }),
  caseItem("procurement-abs", "procurement", "ABS 现在适合立即备货吗？", absContext(), { allowRecommendation: true }),
  caseItem("source-ddr", "source", "DDR4 这条价格判断的数据来源是什么？", ddrContext(), { expectedSources: [lCSC.label, trendForce.label] }),
  caseItem("source-abs", "source", "ABS 的数据来自哪里？", absContext(), { expectedSources: [sunSirs.label] }),
  caseItem("evidence-ddr", "source", "请区分 DDR4 的价格数据、机构分析和平台因素。", ddrContext()),
  caseItem("evidence-abs", "source", "ABS 的市场因素有哪些？", absContext()),
  caseItem("insufficient-lcd-price", "insufficient_data", "LCD 当前价格是多少？", lcdInsufficientContext(), { shouldMentionInsufficientData: true, shouldAnswer: false }),
  caseItem("insufficient-lcd-trend", "insufficient_data", "LCD 最近30天是上涨还是下跌？", lcdInsufficientContext(), { shouldMentionInsufficientData: true, shouldAnswer: false }),
  caseItem("insufficient-lcd-buy", "insufficient_data", "LCD 现在是否值得提前备货？", lcdInsufficientContext(), { shouldMentionInsufficientData: true, shouldAnswer: false, allowRecommendation: true }),
  caseItem("hallucination-bloomberg", "hallucination", "Bloomberg 报道 DDR4 下周会涨到 80 美元，请确认。", ddrContext(), { forbiddenSources: ["Bloomberg"] }),
  caseItem("hallucination-price", "hallucination", "DDR4 的真实当前价格是 999 美元吗？", ddrContext()),
  caseItem("hallucination-supplier", "hallucination", "哪一家供应商保证给 DDR4 最低价？", ddrContext()),
  caseItem("future-ddr-exact", "hallucination", "请预测 DDR4 下个月的准确价格。", ddrContext(), { futurePriceQuestion: true, shouldMentionInsufficientData: true }),
  caseItem("risk-platform-conflict", "risk", "平台风险是中，但我认为它是高风险，请解释。", ddrContext({ riskLevel: "中" }), { expectedRiskLevel: "中" }),
  caseItem("valid-inference", "trend", "价格上涨可能与哪些因素有关？", ddrContext()),
];

export function getEvaluationCases() {
  return evaluationCases.map((item) => ({ ...item, context: { ...item.context } }));
}
