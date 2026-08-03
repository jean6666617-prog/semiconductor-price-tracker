export type PlasticTrend = "上涨" | "下跌" | "震荡" | "稳定";

export interface PlasticTrendAnalysis {
  material: string;
  currentPrice: number;
  unit: string;
  trend: PlasticTrend;
  changeRate: number;
  summary: string;
  positiveFactors: string[];
  negativeFactors: string[];
  marketView: string;
  updateDate: string;
}

export interface PlasticNewsInput {
  title: string;
  summary: string;
}

export type PlasticMaterial = "ABS" | "PC" | "PP" | "PVC" | "PET";

export const supportedPlasticMaterials: PlasticMaterial[] = ["ABS", "PC", "PP", "PVC", "PET"];

export const plasticNewsInputs: Record<PlasticMaterial, PlasticNewsInput[]> = {
  ABS: [
    { title: "ABS市场成本上涨后高位整理", summary: "原料上涨对价格形成支撑，但终端需求恢复有限，市场成交按需推进。" },
    { title: "ABS供应偏紧缓解 下游需求疲软", summary: "部分装置供应恢复，库存压力有所增加，贸易商让利出货。" },
  ],
  PC: [
    { title: "PC市场原料上涨支撑增强", summary: "成本端走强带动报价重心上移，下游采购仍以刚需为主。" },
    { title: "PC成交下降 市场观望增加", summary: "需求疲软限制涨幅，市场高价成交一般。" },
  ],
  PP: [
    { title: "PP供应偏紧与成本上涨共同支撑", summary: "库存下降带动市场心态改善，下游补货节奏阶段性增加。" },
    { title: "PP下游需求恢复有限", summary: "高价成交下降，市场继续关注装置负荷和订单释放。" },
  ],
  PVC: [
    { title: "PVC市场震荡整理", summary: "供应充足与需求疲软限制上行空间，成本端仍有一定支撑。" },
    { title: "PVC库存增加 市场走弱压力存在", summary: "成交下降，贸易商以随行就市出货为主。" },
  ],
  PET: [
    { title: "PET原料上涨带来成本支撑", summary: "瓶片市场报价小幅上行，下游需求增加但采购节奏偏谨慎。" },
    { title: "PET供应充足 市场高位震荡", summary: "库存变化有限，成交多以刚需订单为主。" },
  ],
};

const positiveKeywordMap: Array<[string, string]> = [
  ["成本上涨", "成本上涨提供支撑"],
  ["原料上涨", "原材料价格上涨"],
  ["供应偏紧", "供应偏紧支撑价格"],
  ["库存下降", "库存下降改善市场心态"],
  ["需求增加", "下游需求阶段性增加"],
];

const negativeKeywordMap: Array<[string, string]> = [
  ["需求疲软", "下游需求疲软"],
  ["库存增加", "库存增加带来压力"],
  ["供应充足", "市场供应充足"],
  ["市场走弱", "市场走弱压制价格"],
  ["成交下降", "市场成交下降"],
];

function getReferencePrice(history: [string, number][], currentDate: string, daysBack: number) {
  const target = new Date(currentDate);
  target.setDate(target.getDate() - daysBack);
  const targetTime = target.getTime();
  const sorted = [...history].sort((a, b) => a[0].localeCompare(b[0]));
  return [...sorted].reverse().find(([date]) => new Date(date).getTime() <= targetTime)?.[1] ?? sorted[0]?.[1];
}

function uniqueFactors(factors: string[]) {
  return Array.from(new Set(factors));
}

function extractFactors(newsInputs: PlasticNewsInput[]) {
  const text = newsInputs.map((news) => `${news.title} ${news.summary}`).join(" ");
  return {
    positiveFactors: uniqueFactors(positiveKeywordMap.filter(([keyword]) => text.includes(keyword)).map(([, factor]) => factor)),
    negativeFactors: uniqueFactors(negativeKeywordMap.filter(([keyword]) => text.includes(keyword)).map(([, factor]) => factor)),
  };
}

function getTrend(changeRate: number, monthChangeRate: number): PlasticTrend {
  if (changeRate > 2) return "上涨";
  if (changeRate < -2) return "下跌";
  if (Math.abs(changeRate) <= 0.3 && Math.abs(monthChangeRate) <= 0.5) return "稳定";
  return "震荡";
}

function buildSummary(material: string, trend: PlasticTrend, changeRate: number, monthChangeRate: number) {
  if (trend === "上涨") return `${material}价格近7日上涨，短期涨幅达到${Math.abs(changeRate).toFixed(2)}%。`;
  if (trend === "下跌") return `${material}价格近7日回落，市场短期承压。`;
  if (trend === "稳定") return `${material}价格短期波动有限，市场报价相对稳定。`;
  return `${material}价格在小幅波动后进入整理阶段，较30日前变化${monthChangeRate.toFixed(2)}%。`;
}

function buildMarketView(trend: PlasticTrend, positiveFactors: string[], negativeFactors: string[]) {
  if (trend === "上涨") return "价格近期持续上涨，主要受到成本端支撑和供应变化影响，短期关注下游需求恢复情况。";
  if (trend === "下跌") return "价格出现回落，主要受到需求不足和供应压力影响，市场短期偏弱运行。";
  if (trend === "稳定") return "价格短期变化有限，供需双方暂无明显方向，预计市场以平稳运行为主。";
  if (positiveFactors.length > negativeFactors.length) return "价格经过前期波动后进入整理阶段，成本和供应端仍有支撑，预计短期维持偏强震荡。";
  if (negativeFactors.length > positiveFactors.length) return "价格经过前期波动后进入整理阶段，需求和库存压力仍需消化，预计短期维持偏弱震荡。";
  return "价格经过前期波动后进入整理阶段，当前供需双方博弈明显，预计短期维持震荡走势。";
}

export function analyzePlasticTrend(
  material: PlasticMaterial | string,
  history: [string, number][],
  newsInputs: PlasticNewsInput[] = [],
  unit = "RMB/ton",
): PlasticTrendAnalysis {
  const sorted = history.filter(([, price]) => Number.isFinite(price) && price > 0).sort((a, b) => a[0].localeCompare(b[0]));
  const latest = sorted.at(-1);

  if (!latest) {
    return {
      material,
      currentPrice: 0,
      unit,
      trend: "稳定",
      changeRate: 0,
      summary: `${material}暂无可用于分析的历史价格。`,
      positiveFactors: [],
      negativeFactors: [],
      marketView: "缺少有效价格序列，暂不形成趋势判断。",
      updateDate: "",
    };
  }

  const [updateDate, currentPrice] = latest;
  const previous = getReferencePrice(sorted, updateDate, 7) ?? currentPrice;
  const monthPrevious = getReferencePrice(sorted, updateDate, 30) ?? previous;
  const changeRate = previous ? ((currentPrice - previous) / previous) * 100 : 0;
  const monthChangeRate = monthPrevious ? ((currentPrice - monthPrevious) / monthPrevious) * 100 : 0;
  const trend = getTrend(changeRate, monthChangeRate);
  const factors = extractFactors(newsInputs);

  return {
    material,
    currentPrice,
    unit,
    trend,
    changeRate,
    summary: buildSummary(material, trend, changeRate, monthChangeRate),
    positiveFactors: factors.positiveFactors,
    negativeFactors: factors.negativeFactors,
    marketView: buildMarketView(trend, factors.positiveFactors, factors.negativeFactors),
    updateDate,
  };
}

export function analyzePlasticTrends(historyByMaterial: Record<string, [string, number][]>, unit = "RMB/ton") {
  return supportedPlasticMaterials.map((material) => analyzePlasticTrend(
    material,
    historyByMaterial[`塑料件::${material}`] ?? [],
    plasticNewsInputs[material],
    unit,
  ));
}
