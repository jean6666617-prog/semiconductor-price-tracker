import { fetchTrendForcePrice } from "./trendforce";

export type TrackingEntry = {
  id?: string;
  category: string;
  name: string;
  source: string;
  url?: string;
  crawler: string;
  mode?: "real" | "mock";
  unit?: string;
  matchNames?: string[];
  priceField?: "Session Average" | "Average" | "Price" | "Latest Price";
  tableId?: string;
  description?: string;
  manufacturer?: string;
  mpn?: string;
  currency?: string;
  quantity?: number;
  enabled: boolean;
};

export type PriceResult = {
  success: boolean;
  category: string;
  material: string;
  price: number | null;
  currency: string;
  unit: string;
  source: string;
  updateDate: string;
  error?: string;
  history?: PriceHistoryPoint[];
  materialName?: string;
  crawlTime?: string;
  sourceUrl?: string;
  mode?: "real" | "mock";
  manufacturer?: string;
  mpn?: string;
  quantity?: number;
};

export type PriceHistoryPoint = {
  date: string;
  price: number;
};

function todayKey() {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date()).replaceAll("/", "-");
}

export async function runCrawler(entry: TrackingEntry): Promise<PriceResult> {
  const updateDate = todayKey();
  if (!entry.enabled) {
    return { success: false, category: entry.category, material: entry.name, price: null, currency: "", unit: "", source: entry.source, updateDate };
  }
  if (entry.crawler === "dram" || entry.crawler === "trendforce") return fetchTrendForcePrice(entry, updateDate);
  return { success: false, category: entry.category, material: entry.name, price: null, currency: "", unit: "", source: entry.source, updateDate };
}
