import { fetchTrendForcePrice } from "./trendforce";
import { fetchPlasticPrice } from "./plastic";
import type { PlasticTrendAnalysis } from "../analysis/plasticTrendAnalysis";

export type TrackingEntry = {
  id?: string;
  category: string;
  name: string;
  source: string;
  url?: string;
  fallbackSource?: string;
  fallbackUrl?: string;
  crawler: string;
  mode?: "real" | "mock";
  unit?: string;
  matchNames?: string[];
  priceField?: "Session Average" | "Average" | "Price" | "Latest Price";
  tableId?: string;
  description?: string;
  manufacturer?: string;
  productName?: string;
  availability?: string;
  mpn?: string;
  currency?: string;
  quantity?: number;
  priceBreakQuantity?: number;
  minimumOrderQuantity?: number;
  selectedQuantity?: number;
  priceBreaks?: Array<{ quantity: number; price: number; currency: string }>;
  priceBasis?: "single-unit" | "minimum-public-tier";
  packageType?: string;
  stockStatus?: string;
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
  productName?: string;
  availability?: string;
  mpn?: string;
  quantity?: number;
  priceBreakQuantity?: number;
  minimumOrderQuantity?: number;
  selectedQuantity?: number;
  priceBreaks?: Array<{ quantity: number; price: number; currency: string }>;
  priceBasis?: "single-unit" | "minimum-public-tier";
  packageType?: string;
  stockStatus?: string;
  analysis?: PlasticTrendAnalysis;
  status?: "configuration_required" | "source_unavailable" | "success";
};

export type PriceHistoryPoint = {
  date: string;
  price: number;
  priceBreakQuantity?: number;
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
  if (entry.crawler === "plastic" || entry.crawler === "sunsirs_plastic") return fetchPlasticPrice(entry, updateDate);
  return { success: false, category: entry.category, material: entry.name, price: null, currency: "", unit: "", source: entry.source, updateDate };
}
