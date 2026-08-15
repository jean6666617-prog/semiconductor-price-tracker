import type { LiveSearchResult, Message, ProcurementContext, PromptMessage } from "./types";

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
  liveSearchResults?: LiveSearchResult[];
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
    `【News｜新闻事实】\n${formatList((context.news || []).slice(0, 4), (item) => `${item.title}${item.summary ? `：${item.summary.slice(0, 240)}` : ""}${item.source ? `（${item.source}）` : ""}${item.url ? ` [${item.url}]` : ""}`)}`,
    `【Market Analyses｜外部机构市场分析】\n${formatList((context.marketAnalyses || []).slice(0, 2), (item) => `${item.title || "未命名分析"}${item.summary ? `：${item.summary.slice(0, 240)}` : ""}${item.source ? `（${item.source}）` : ""}${item.url ? ` [${item.url}]` : ""}`)}`,
    `【Market Factors｜平台规则化市场因素】\n${context.marketFactors ? `利多：${context.marketFactors.positiveFactors.join("；") || "暂无数据"}\n利空：${context.marketFactors.negativeFactors.join("；") || "暂无数据"}\n市场观点：${context.marketFactors.marketView || "暂无数据"}` : "暂无数据"}`,
    `【Existing Risk｜平台已有风险判断】\n风险等级：${context.riskLevel || "暂无数据"}\n判断依据：${context.riskReason || "暂无数据"}`,
    `数据来源：${formatList(context.sources, (source) => `${source.label}${source.value ? `（${source.value}）` : ""}${source.url ? ` [${source.url}]` : ""}`)}`,
  ].join("\n");
  const liveSearchText = input.liveSearchResults?.length
    ? input.liveSearchResults.map((item, index) => `[${index + 1}] ${item.title}${item.source ? `（${item.source}）` : ""}${item.publishedAt ? ` · ${item.publishedAt}` : ""}${item.snippet ? `：${item.snippet}` : ""} [${item.url}]`).join("\n")
    : "本轮没有实时搜索结果。";

  const system = [
    "你是半导体采购与供应链分析助手，只服务于当前页面传入的采购数据。",
    "你的首要任务是直接回答用户本轮最新问题。最新问题的优先级高于通用市场总结。",
    "Procurement Context 只是回答问题所需的业务依据；只使用与本轮问题相关的字段。",
    "不要因为 Context 中存在风险、历史、新闻或市场因素，就强制每次都分析所有内容。",
    "如果问题范围较窄，保持回答聚焦；只有问题直接涉及风险、驱动因素或采购动作时，才展开对应内容。",
    "不要用固定的市场报告结构替代对用户问题的直接回答。",
    "你会收到 Platform Data、News、Market Analyses、Market Factors、Existing Risk 五类信息。必须严格区分它们。",
    "Platform Data、Existing Risk 由系统确定，不能修改、重新计算、补全或用模型输出覆盖。",
    "不得创造不存在的价格、日期、来源、新闻、供应商或 URL；不得把 inference 写成 confirmed fact。",
    "Market Analyses 是外部机构分析，不是新闻；Market Factors 是平台规则化因素，不是新闻。",
    "Live Search Results 是本轮由搜索工具返回的外部信息，只能引用其中真实存在的标题、来源、日期、摘要和 URL。不得补写新闻、来源、日期或链接。",
    "如果用户要求最新新闻但本轮没有实时搜索结果，明确说明没有检索到可靠结果，并退回使用当前 Context；不要把旧 Context 新闻冒充实时结果。",
    "只有 Live Search Results 或当前 Context 中真实存在 Bloomberg 记录时，才可以提及 Bloomberg。",
    "如果历史、来源、新闻或市场分析缺失，明确说明当前数据不足。",
    "风险输出仅表示 AI 对风险的解释：如果已有 Existing Risk，不能改变平台风险等级；没有足够信息时使用 unknown。",
    "采购建议只能作为 AI 决策参考，不得声称价格一定上涨、必须采购、一定锁价或给出确定未来价格。",
    "请只输出合法 JSON，不要 Markdown 代码围栏，结构必须是：",
    '{"answer":"直接回答用户本轮最新问题","summary":"简短相关摘要","drivers":[{"text":"string","type":"data|news|market_analysis|platform_analysis|inference","source":"optional known source"}],"risk":{"level":"low|medium|high|unknown","explanation":"string"},"recommendation":{"text":"string","action":"optional string"},"evidence":[{"label":"string","source":"optional known source URL or label","value":"optional string"}],"dataConfidence":"low|medium|high","disclaimer":"optional string"}',
    "answer 必须直接回应最新问题；summary、drivers、risk、recommendation 和 evidence 是支持字段，应保持简洁并只在与问题相关时展开。",
    "drivers 的 type 必须准确：新闻用 news，机构分析用 market_analysis，平台规则用 platform_analysis，纯模型解释用 inference，直接引用平台字段用 data。",
    "evidence 的 source 只能使用 Context 已有 source/news/marketAnalyses 或本轮 Live Search Results；不要生成新 URL。",
    "\n当前 Procurement Context：\n" + contextText,
    "\n【LIVE SEARCH RESULTS｜本轮实时搜索结果】\n" + liveSearchText,
  ].join("\n");

  return [
    { role: "system", content: system },
    ...(input.history || []).slice(-8),
    { role: "user", content: input.question.trim() },
  ];
}
