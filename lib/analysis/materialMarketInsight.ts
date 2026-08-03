import type { PlasticTrendAnalysis } from "./plasticTrendAnalysis";
import type { DDRMarketData } from "../crawlers/ddr";

export type MarketCategory = "Plastic" | "Memory" | "Display" | "Battery" | "SOC";
export type MarketTrend = "上涨" | "下跌" | "震荡" | "稳定" | "数据接入中";

export type MarketItem = {
  name: string;
  category: MarketCategory;
  price: number | null;
  unit: string;
  change: number | null;
  trend: MarketTrend;
  source: string;
  description: string;
  factors: string[];
  updateDate?: string;
};

export const marketCategories: MarketCategory[] = ["Plastic", "Memory", "Display", "Battery", "SOC"];

const ddrSourceLabel = "Price: DRAMeXchange | Contract: DRAMeXchange / TrendForce | Market Trend: TrendForce | Analysis: Tom's Hardware | Industry News: DigiTimes";

function pendingItem(category: MarketCategory, name: string, source: string, description: string): MarketItem {
  return {
    name,
    category,
    price: null,
    unit: "",
    change: null,
    trend: "数据接入中",
    source,
    description,
    factors: ["接口预留", "等待正式数据源接入", "不生成模拟价格"],
  };
}

function parsePrice(value: string) {
  const price = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(price) ? price : null;
}

function trendFromText(value: string): MarketTrend {
  if (/上涨|上升|up|increase/i.test(value)) return "上涨";
  if (/下跌|下降|down|decrease/i.test(value)) return "下跌";
  if (/稳定|stable/i.test(value)) return "稳定";
  if (/震荡|整理|fluctuat/i.test(value)) return "震荡";
  return "数据接入中";
}

export function plasticAnalysesToMarketItems(plasticAnalyses: PlasticTrendAnalysis[]): MarketItem[] {
  return plasticAnalyses.map((analysis) => ({
    name: analysis.material,
    category: "Plastic",
    price: analysis.currentPrice,
    unit: analysis.unit,
    change: analysis.changeRate,
    trend: analysis.trend,
    source: "SunSirs",
    description: analysis.marketView,
    factors: [...analysis.positiveFactors, ...analysis.negativeFactors],
    updateDate: analysis.updateDate,
  }));
}

export function ddrMarketDataToMarketItems(ddrData?: DDRMarketData): MarketItem[] {
  if (!ddrData || (!ddrData.spotPrices.length && !ddrData.contractPrices.length && !ddrData.marketAnalyses.length && !ddrData.industryNews.length)) {
    return [pendingItem("Memory", "DDR", ddrSourceLabel, "DDR价格趋势数据接入中；已按 DRAMeXchange、TrendForce、DigiTimes 规划保留 spot、contract、analysis、news 数据入口。")];
  }

  const analysis = ddrData.marketAnalyses[0];
  const news = ddrData.industryNews.find((record) => record.source === "DigiTimes");
  const tomsHardwareNews = ddrData.industryNews.filter((record) => record.source === "Tom's Hardware");
  const contractByProduct = new Map(ddrData.contractPrices.map((record) => [record.product, record]));
  const products = ["DDR4", "DDR5"];
  return products.map((product) => {
    const spot = ddrData.spotPrices.find((record) => record.product === product);
    const contract = contractByProduct.get(product);
    const price = spot ? parsePrice(spot.price) : null;
    const change = spot?.change ? parsePrice(spot.change) : null;
    const factors = [
      ...(analysis?.factors?.filter((factor) => !factor.startsWith("趋势：")) ?? []),
      ...tomsHardwareNews.slice(0, 3).map((record) => `Tom's Hardware行业观察：${record.summary}`),
      ...(news?.impact ? [`DigiTimes影响方向：${news.impact}`] : []),
    ];
    return {
      name: product,
      category: "Memory" as const,
      price,
      unit: spot?.currency || "USD",
      change,
      trend: trendFromText(contract?.trend || analysis?.factors?.[0] || analysis?.summary || news?.summary || ""),
      source: ddrSourceLabel,
      description: analysis?.summary || news?.summary || "DDR市场公开分析数据接入中。",
      factors: factors.length ? factors : ["暂无公开数据", "DRAMeXchange / TrendForce / DigiTimes接口保留"],
      updateDate: spot?.date || contract?.date || analysis?.date || news?.date,
    };
  });
}

export function buildMaterialMarketItems(plasticAnalyses: PlasticTrendAnalysis[], ddrData?: DDRMarketData): Record<MarketCategory, MarketItem[]> {
  return {
    Plastic: plasticAnalysesToMarketItems(plasticAnalyses),
    Memory: ddrMarketDataToMarketItems(ddrData),
    Display: [pendingItem("Display", "LCD", "Future data source", "显示面板价格趋势入口已预留，等待后续接入 LCD 数据源。")],
    Battery: [pendingItem("Battery", "Battery", "Future data source", "电池原材料价格趋势入口已预留，等待后续接入电池材料数据源。")],
    SOC: [pendingItem("SOC", "SOC", "Future data source", "SOC关键器件市场趋势入口已预留，等待后续接入对应数据源。")],
  };
}

export function getMarketSourceLabel(category: MarketCategory) {
  if (category === "Plastic") return "SunSirs · ABS / PC / PP / PVC / PET";
  if (category === "Memory") return "DDR · 数据接入中";
  return `${category} · 数据接入中`;
}
