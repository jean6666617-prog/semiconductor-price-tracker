import type { Message, ProcurementContext, PromptMessage } from "./types";

function formatNumber(value: number | undefined, suffix = "") {
  return typeof value === "number" ? `${value}${suffix}` : "暂无数据";
}

function formatList<T>(items: T[] | undefined, render: (item: T) => string) {
  return items?.length ? items.map(render).join("\n") : "暂无数据";
}

export function buildCopilotMessages(input: {
  question: string;
  context: ProcurementContext;
  history?: Message[];
}): PromptMessage[] {
  const { context } = input;
  const contextText = [
    "【Platform Data｜平台确定性数据】",
    `分析对象：${context.materialName}`,
    `品类：${context.category}`,
    `当前价格：${formatNumber(context.currentPrice)} ${context.currency || ""}${context.unit ? ` / ${context.unit}` : ""}`.trim(),
    `1日变化：${formatNumber(context.change1d, "%")}`,
    `7日变化：${formatNumber(context.change7d, "%")}`,
    `30日变化：${formatNumber(context.change30d, "%")}`,
    `连续变化天数：${formatNumber(context.streak, " 天")}`,
    `更新时间：${context.lastUpdated || "暂无数据"}`,
    `历史价格样本：${formatList(context.history, (point) => `${point.date}: ${point.price}`)}`,
    `【News｜新闻事实】\n${formatList(context.news, (item) => `${item.title}${item.summary ? `：${item.summary}` : ""}${item.source ? `（${item.source}）` : ""}${item.url ? ` [${item.url}]` : ""}`)}`,
    `【Market Analyses｜外部机构市场分析】\n${formatList(context.marketAnalyses, (item) => `${item.title || "未命名分析"}${item.summary ? `：${item.summary}` : ""}${item.source ? `（${item.source}）` : ""}${item.url ? ` [${item.url}]` : ""}`)}`,
    `【Market Factors｜平台规则化市场因素】\n${context.marketFactors ? `利多：${context.marketFactors.positiveFactors.join("；") || "暂无数据"}\n利空：${context.marketFactors.negativeFactors.join("；") || "暂无数据"}\n市场观点：${context.marketFactors.marketView || "暂无数据"}` : "暂无数据"}`,
    `【Existing Risk｜平台已有风险判断】\n风险等级：${context.riskLevel || "暂无数据"}\n判断依据：${context.riskReason || "暂无数据"}`,
    `数据来源：${formatList(context.sources, (source) => `${source.label}${source.value ? `（${source.value}）` : ""}${source.url ? ` [${source.url}]` : ""}`)}`,
  ].join("\n");

  const system = [
    "你是半导体采购与供应链分析助手，只服务于当前页面传入的采购数据。",
    "你会收到 Platform Data、News、Market Analyses、Market Factors、Existing Risk 五类信息。必须严格区分它们。",
    "Platform Data、Existing Risk 由系统确定，不能修改、重新计算、补全或用模型输出覆盖。",
    "不得创造不存在的价格、日期、来源、新闻、供应商或 URL；不得把 inference 写成 confirmed fact。",
    "Market Analyses 是外部机构分析，不是新闻；Market Factors 是平台规则化因素，不是新闻。",
    "如果历史、来源、新闻或市场分析缺失，明确说明当前数据不足。",
    "风险输出仅表示 AI 对风险的解释：如果已有 Existing Risk，不能改变平台风险等级；没有足够信息时使用 unknown。",
    "采购建议只能作为 AI 决策参考，不得声称价格一定上涨、必须采购、一定锁价或给出确定未来价格。",
    "请只输出合法 JSON，不要 Markdown 代码围栏，结构必须是：",
    '{"summary":"string","drivers":[{"text":"string","type":"data|news|market_analysis|platform_analysis|inference","source":"optional known source"}],"risk":{"level":"low|medium|high|unknown","explanation":"string"},"recommendation":{"text":"string","action":"optional string"},"evidence":[{"label":"string","source":"optional known source URL or label","value":"optional string"}],"dataConfidence":"low|medium|high","disclaimer":"optional string"}',
    "drivers 的 type 必须准确：新闻用 news，机构分析用 market_analysis，平台规则用 platform_analysis，纯模型解释用 inference，直接引用平台字段用 data。",
    "evidence 的 source 只能使用 Context 已有 source/news/marketAnalyses；不要生成新 URL。",
    "\n当前 Procurement Context：\n" + contextText,
  ].join("\n");

  return [
    { role: "system", content: system },
    ...(input.history || []).slice(-8),
    { role: "user", content: input.question.trim() },
  ];
}
