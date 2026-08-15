import { deriveDataConfidence } from "../validation";
import type { AIDriver, AIProvider, AIResponse, ProcurementContext } from "../types";

function formatPercent(value?: number) {
  return typeof value === "number" ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%` : "暂无数据";
}

function platformRiskToAILevel(value?: string): AIResponse["risk"]["level"] | undefined {
  if (value === "高" || value === "high") return "high";
  if (value === "中" || value === "medium") return "medium";
  if (value === "低" || value === "low") return "low";
  return undefined;
}

function riskLevel(context: ProcurementContext): AIResponse["risk"]["level"] {
  if (typeof context.currentPrice !== "number") return "unknown";
  const existing = platformRiskToAILevel(context.riskLevel);
  if (existing) return existing;
  if (typeof context.change7d !== "number" && typeof context.streak !== "number") return "unknown";
  if ((context.streak ?? 0) >= 3 || (context.change7d ?? 0) >= 5) return "high";
  if (Math.abs(context.change7d ?? 0) >= 2) return "medium";
  return "low";
}

function buildDrivers(context: ProcurementContext): AIDriver[] {
  const drivers: AIDriver[] = [];
  if (typeof context.change7d === "number") {
    drivers.push({ text: `平台数据显示近7日变化为${formatPercent(context.change7d)}。`, type: "data" });
  }
  context.news?.slice(0, 2).forEach((item) => {
    drivers.push({ text: item.summary || item.title, type: "news", source: item.source });
  });
  context.marketAnalyses?.slice(0, 2).forEach((item) => {
    drivers.push({ text: item.summary || item.title || "外部机构提供了市场分析。", type: "market_analysis", source: item.source });
  });
  const factors = [
    ...(context.marketFactors?.positiveFactors || []),
    ...(context.marketFactors?.negativeFactors || []),
  ];
  factors.slice(0, 2).forEach((factor) => drivers.push({ text: factor, type: "platform_analysis" }));
  if (!drivers.length) drivers.push({ text: "当前缺少足够新闻或市场分析支持原因判断。", type: "platform_analysis" });
  return drivers;
}

export const mockProvider: AIProvider = {
  async chat({ question, context }): Promise<AIResponse> {
    const level = riskLevel(context);
    const direction = typeof context.change7d !== "number"
      ? "当前缺少足够的7日变化数据"
      : context.change7d > 0 ? "近7日上涨" : context.change7d < 0 ? "近7日下跌" : "近7日变化有限";
    const hasHistory = Boolean(context.history?.length);
    const recommendation = level === "high"
      ? "建议核对库存覆盖天数、供应商报价和替代料，再决定是否分批提前备货。"
      : level === "unknown"
        ? "建议先补充价格历史、可靠来源或外部市场证据，再形成采购判断。"
        : "建议继续跟踪下一次价格更新，并结合供应商报价和库存周期做决策。";
    const evidence = [
      typeof context.currentPrice === "number" ? { label: "当前价格", value: `${context.currentPrice} ${context.currency || ""}${context.unit ? ` / ${context.unit}` : ""}`.trim() } : undefined,
      typeof context.change7d === "number" ? { label: "7日变化", value: formatPercent(context.change7d) } : undefined,
      typeof context.change30d === "number" ? { label: "30日变化", value: formatPercent(context.change30d) } : undefined,
      context.sources?.[0] ? { label: "数据来源", value: context.sources[0].label, source: context.sources[0].url } : undefined,
    ].filter((item): item is NonNullable<typeof item> => Boolean(item));

    return {
      summary: `${context.materialName}${direction}。${hasHistory ? "当前已有历史价格序列。" : "当前没有足够历史价格序列，不能形成可靠趋势结论。"}`,
      drivers: buildDrivers(context),
      risk: {
        level,
        explanation: level === "unknown" ? "当前数据不足以形成可靠的 AI 风险解释。" : "该解释仅基于当前 Context，不代表确定的未来价格结果。",
      },
      recommendation: {
        text: recommendation,
        action: level === "high" ? "核对库存、报价和替代料" : "继续跟踪并补充证据",
      },
      evidence,
      dataConfidence: deriveDataConfidence(context),
      disclaimer: `当前为 Provider mock 分析；问题“${question}”的回答仅基于页面传入的真实数据，不代表模型预测或采购承诺。`,
    };
  },
};
