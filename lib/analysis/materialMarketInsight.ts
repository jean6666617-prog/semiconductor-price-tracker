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
  url?: string;
};

/** Minimal dashboard data needed to expose an existing tracked category in the
 * material-market view. Kept separate from the crawler types so this module
 * remains a pure presentation-data adapter. */
export type MarketTrackedItem = {
  group: string;
  name: string;
  price: string | number;
  unit?: string;
  source?: string;
  url?: string;
  updated?: string;
};

export type MarketHistory = Record<string, [string, number][]>;

export const marketCategories: MarketCategory[] = ["Memory", "Plastic", "Display", "Battery", "SOC"];

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

function parseTrackedPrice(value: string | number) {
  const price = typeof value === "number" ? value : parsePrice(value);
  return price !== null && price > 0 ? price : null;
}

function normalizeUnit(item: MarketTrackedItem) {
  const explicit = String(item.unit || "").trim();
  // The workbook stores some TrendForce battery units as only "RMB". Recover
  // the published billing unit from the configured item name without changing
  // the underlying price or source data.
  const nameUnit = item.name.match(/\((USD\/ton|RMB\/Wh|RMB\/Ah|RMB\/ton)\)/i)?.[1];
  if ((!explicit || explicit.toUpperCase() === "RMB") && nameUnit) return nameUnit;
  return explicit || nameUnit || "—";
}

function defaultMarketUrl(category: MarketCategory, name: string) {
  if (category === "Display") return "https://www.trendforce.com/price/lcd/panel";
  if (category === "Battery") {
    return /Cell|Pack/i.test(name)
      ? "https://www.trendforce.com/price/battery-price/battery_cell_and_pack"
      : "https://www.trendforce.com/price/battery-price/li_co_ni";
  }
  return undefined;
}

function trendFromChangeRate(change: number): MarketTrend {
  if (change > 2) return "上涨";
  if (change < -2) return "下跌";
  if (Math.abs(change) <= 0.3) return "稳定";
  return "震荡";
}

function trackedCategoryToMarketItems(
  category: Extract<MarketCategory, "Display" | "Battery">,
  group: string,
  trackedItems: MarketTrackedItem[],
  history: MarketHistory,
): MarketItem[] {
  const items = trackedItems
    .filter((item) => item.group === group)
    .map((item) => {
      const key = `${item.group}::${item.name}`;
      const series = (history[key] || [])
        .filter(([date, price]) => Boolean(date) && Number.isFinite(Number(price)) && Number(price) > 0)
        .sort((a, b) => a[0].localeCompare(b[0]));
      const latest = series.at(-1);
      const previous = series.length > 1 ? series.at(-2) : undefined;
      const price = latest?.[1] ?? parseTrackedPrice(item.price);
      const change = previous && latest && previous[1] !== 0
        ? ((latest[1] - previous[1]) / previous[1]) * 100
        : null;
      const unit = normalizeUnit(item);
      const source = item.source || "TrendForce";
      const updateDate = latest?.[0] || item.updated || undefined;
      const url = item.url && !/^https?:\/\/www\.trendforce\.com\/?$/i.test(item.url)
        ? item.url
        : defaultMarketUrl(category, item.name);
      const categoryLabel = category === "Display" ? "LCD 面板" : "电池及上游材料";
      const description = change === null
        ? `${source} ${categoryLabel}价格已接入；当前有最新价格，但历史样本不足，暂不计算短期涨跌。`
        : `${source} ${categoryLabel}最新价格较上一条历史样本${change >= 0 ? "上涨" : "下跌"} ${Math.abs(change).toFixed(2)}%，该变化仅基于已保存的价格样本。`;
      return {
        name: item.name,
        category,
        price,
        unit,
        change,
        trend: change === null ? "数据接入中" : trendFromChangeRate(change),
        source,
        description,
        factors: change === null
          ? [`${source} 价格数据`, "历史样本不足以计算短期变化"]
          : [`${source} 价格数据`, `较上一条样本${change >= 0 ? "上涨" : "下跌"} ${Math.abs(change).toFixed(2)}%`],
        updateDate,
        url,
      };
    });
  return items.length
    ? items
    : [pendingItem(category, category === "Display" ? "LCD" : "Battery", "TrendForce", `${category === "Display" ? "LCD面板" : "电池及上游材料"}暂无可展示的已保存价格数据。`)];
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
    url: ({ ABS: "https://www.sunsirs.com/uk/prodetail-713.html", PC: "https://www.sunsirs.com/uk/prodetail-172.html", PP: "https://www.sunsirs.com/uk/prodetail-718.html", PVC: "https://www.sunsirs.com/uk/prodetail-107.html", PET: "https://www.sunsirs.com/uk/prodetail-173.html" } as Record<string, string>)[analysis.material],
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
      url: analysis?.url || spot?.url || contract?.url,
    };
  });
}

export function buildMaterialMarketItems(
  plasticAnalyses: PlasticTrendAnalysis[],
  ddrData?: DDRMarketData,
  trackedItems: MarketTrackedItem[] = [],
  history: MarketHistory = {},
): Record<MarketCategory, MarketItem[]> {
  return {
    Plastic: plasticAnalysesToMarketItems(plasticAnalyses),
    Memory: ddrMarketDataToMarketItems(ddrData),
    Display: trackedCategoryToMarketItems("Display", "LCD屏幕", trackedItems, history),
    Battery: trackedCategoryToMarketItems("Battery", "电池", trackedItems, history),
    SOC: [pendingItem("SOC", "SOC", "Future data source", "SOC关键器件市场趋势入口已预留，等待后续接入对应数据源。")],
  };
}

export function getMarketSourceLabel(category: MarketCategory) {
  if (category === "Plastic") return "SunSirs · ABS / PC / PP / PVC / PET";
  if (category === "Memory") return "DDR · 数据接入中";
  if (category === "Display") return "TrendForce · LCD TV / Monitor / Notebook";
  if (category === "Battery") return "TrendForce · 电芯 / 电池包 / 锂钴镍";
  return `${category} · 数据接入中`;
}
