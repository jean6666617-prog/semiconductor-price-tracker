import type { DDRIndustryNewsRecord, DDRMarketAnalysisRecord, DDRMarketData } from "../crawlers/ddr";
import type { MarketItem } from "../analysis/materialMarketInsight";
import type { PlasticTrendAnalysis } from "../analysis/plasticTrendAnalysis";
import type { DataCoverage, MarketAnalysis, MarketFactors, NewsItem, PricePoint, ProcurementContext, Source } from "./types";

type HistoryTuple = [string, number];
type HistoryInput = HistoryTuple[] | PricePoint[] | undefined;

type BuilderBaseInput = {
  materialName: string;
  category: string;
  currentPrice?: number | null;
  currency?: string;
  unit?: string;
  history?: HistoryInput;
  sources?: Source[];
  news?: NewsItem[];
  marketAnalyses?: MarketAnalysis[];
  lastUpdated?: string;
  riskLevel?: string;
  riskReason?: string;
  streak?: number;
  timeRange?: string;
  marketFactors?: MarketFactors;
};

export type ContextMoverEntry = {
  key?: string;
  group: string;
  name: string;
  source: string;
  unit: string;
  price: number;
  risingStreak?: number;
  changeRate?: number;
};

export type ContextMoverInput = {
  entry: ContextMoverEntry;
  historyByKey?: Record<string, HistoryTuple[]>;
  sourceUrl?: string;
  riskLevel?: string;
  riskReason?: string;
  lastUpdated?: string;
  news?: NewsItem[];
};

export type ContextTrendInput = {
  materialName: string;
  category: string;
  points: HistoryTuple[];
  currentPrice?: number | null;
  currency?: string;
  unit?: string;
  source?: string;
  sourceUrl?: string;
  lastUpdated?: string;
  news?: NewsItem[];
  timeRange?: string;
};

export type ContextMarketItemInput = {
  item: MarketItem;
  historyByKey?: Record<string, HistoryTuple[]>;
  historyKey?: string;
  sourceUrl?: string;
  lastUpdated?: string;
  news?: NewsItem[];
  riskLevel?: string;
  riskReason?: string;
  streak?: number;
};

export type ContextPlasticInput = ContextMarketItemInput & {
  analysis?: PlasticTrendAnalysis;
};

export type ContextDDRInput = ContextMarketItemInput & {
  ddrData?: DDRMarketData;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_HISTORY_POINTS = 7;
export const BASELINE_TOLERANCE_DAYS = { 7: 2, 30: 5 } as const;

function normalizedDate(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const dateOnly = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2].padStart(2, "0")}-${dateOnly[3].padStart(2, "0")}`;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function dateMs(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function normalizeHistory(history: HistoryInput): PricePoint[] {
  const points: Array<PricePoint & { index: number }> = [];
  (history ?? []).forEach((point, index) => {
    const rawDate = Array.isArray(point) ? point[0] : point.date;
    const rawPrice = Array.isArray(point) ? point[1] : point.price;
    const date = normalizedDate(rawDate);
    const price = Number(rawPrice);
    if (date && Number.isFinite(price)) points.push({ date, price, index });
  });
  return points.sort((left, right) => left.date.localeCompare(right.date) || left.index - right.index).map(({ date, price }) => ({ date, price }));
}

function latestPoint(history: PricePoint[]) {
  return history.at(-1);
}

export function findBaselinePoint(input: {
  history: PricePoint[];
  latestDate?: string;
  daysAgo: number;
  toleranceDays: number;
}) {
  const latestDate = normalizedDate(input.latestDate);
  const latestTime = dateMs(latestDate);
  if (!latestDate || !Number.isFinite(latestTime) || input.daysAgo < 0 || input.toleranceDays < 0) return undefined;
  const minElapsed = Math.max(0, input.daysAgo - input.toleranceDays);
  const maxElapsed = input.daysAgo + input.toleranceDays;
  const candidates = input.history.filter((point) => {
    const pointTime = dateMs(point.date);
    if (!Number.isFinite(pointTime) || point.date === latestDate) return false;
    const elapsedDays = (latestTime - pointTime) / DAY_MS;
    return elapsedDays >= minElapsed && elapsedDays <= maxElapsed;
  });
  return candidates.sort((left, right) => {
    const leftDistance = Math.abs((latestTime - dateMs(left.date)) / DAY_MS - input.daysAgo);
    const rightDistance = Math.abs((latestTime - dateMs(right.date)) / DAY_MS - input.daysAgo);
    return leftDistance - rightDistance || right.date.localeCompare(left.date);
  })[0];
}

export function calculateHistoricalChange(history: PricePoint[], days: number, toleranceDays = days === 7 ? BASELINE_TOLERANCE_DAYS[7] : days === 30 ? BASELINE_TOLERANCE_DAYS[30] : 0) {
  const latest = latestPoint(history);
  const baseline = latest ? findBaselinePoint({ history, latestDate: latest.date, daysAgo: days, toleranceDays }) : undefined;
  if (!latest || !baseline || baseline.price === 0) return undefined;
  return ((latest.price - baseline.price) / baseline.price) * 100;
}

export function calculateAdjacentChange(history: PricePoint[]) {
  const latest = latestPoint(history);
  const previous = history.at(-2);
  if (!latest || !previous || previous.price === 0) return undefined;
  return ((latest.price - previous.price) / previous.price) * 100;
}

function direction(change?: number) {
  if (typeof change !== "number") return undefined;
  if (change > 0) return "上涨";
  if (change < 0) return "下跌";
  return "稳定";
}

function splitMoneyUnit(currency: string | undefined, unit: string | undefined) {
  const rawCurrency = String(currency ?? "").trim();
  const rawUnit = String(unit ?? "").trim();
  const match = rawUnit.match(/^\s*(USD|CNY|RMB|EUR|JPY|\$|¥|€|￥)\s*\/?\s*(.*)$/i);
  if (match) {
    const normalizedCurrency = match[1].toUpperCase() === "$" ? "USD" : match[1].toUpperCase() === "¥" || match[1] === "￥" ? "CNY" : match[1].toUpperCase();
    return { currency: rawCurrency || normalizedCurrency, unit: match[2].trim() || undefined };
  }
  return { currency: rawCurrency || undefined, unit: rawUnit || undefined };
}

export function dedupeSources(sources: Source[]) {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const label = String(source.label ?? "").trim();
    if (!label) return false;
    const url = source.url?.trim() || "";
    const key = `${label.toLowerCase()}|${url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((source) => ({
    label: source.label.trim(),
    ...(source.url?.trim() ? { url: source.url.trim() } : {}),
    ...(source.value?.trim() ? { value: source.value.trim() } : {}),
    ...(source.sourceType ? { sourceType: source.sourceType } : {}),
    ...(source.accessType ? { accessType: source.accessType } : {}),
  }));
}

export function dedupeNews(news: NewsItem[]) {
  const seen = new Set<string>();
  return news.filter((item) => {
    const title = item.title.trim();
    if (!title) return false;
    const key = `${title.toLowerCase()}|${item.source?.trim().toLowerCase() || ""}|${item.url?.trim() || ""}|${item.date?.trim() || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((item) => ({
    title: item.title.trim(),
    ...(item.summary?.trim() ? { summary: item.summary.trim() } : {}),
    ...(item.source?.trim() ? { source: item.source.trim() } : {}),
    ...(item.url?.trim() ? { url: item.url.trim() } : {}),
    ...(item.date?.trim() ? { date: item.date.trim() } : {}),
    ...(item.sourceType ? { sourceType: item.sourceType } : {}),
    ...(item.accessType ? { accessType: item.accessType } : {}),
  }));
}

export function createManualBloombergEvidence(input: {
  title: string;
  summary?: string;
  url: string;
  date?: string;
  accessType?: "manual" | "link_only";
}): NewsItem {
  const title = input.title.trim();
  const url = input.url.trim();
  if (!title) throw new Error("Bloomberg manual evidence requires a title");
  if (!/^https?:\/\//i.test(url)) throw new Error("Bloomberg manual evidence requires an http(s) URL");
  return {
    title,
    ...(input.summary?.trim() ? { summary: input.summary.trim() } : {}),
    source: "Bloomberg",
    url,
    ...(input.date?.trim() ? { date: input.date.trim() } : {}),
    sourceType: "authoritative_news",
    accessType: input.accessType || "link_only",
  };
}

function historySpanDays(history: PricePoint[]) {
  const first = history[0];
  const latest = history.at(-1);
  if (!first || !latest) return 0;
  return Math.max(0, Math.round((dateMs(latest.date) - dateMs(first.date)) / DAY_MS));
}

function coverage(history: PricePoint[], currentPrice: number | undefined, sources: Source[], news: NewsItem[], marketAnalyses: MarketAnalysis[], marketFactors?: MarketFactors): DataCoverage {
  const latestDate = history.at(-1)?.date;
  const has7dBaseline = Boolean(latestDate && findBaselinePoint({ history, latestDate, daysAgo: 7, toleranceDays: BASELINE_TOLERANCE_DAYS[7] }));
  const has30dBaseline = Boolean(latestDate && findBaselinePoint({ history, latestDate, daysAgo: 30, toleranceDays: BASELINE_TOLERANCE_DAYS[30] }));
  const spanDays = historySpanDays(history);
  return {
    historyPoints: history.length,
    historySpanDays: spanDays,
    hasCurrentPrice: typeof currentPrice === "number" && Number.isFinite(currentPrice),
    hasSource: sources.length > 0,
    hasNews: news.length > 0,
    hasMarketAnalysis: marketAnalyses.length > 0,
    hasMarketFactors: Boolean(marketFactors && (marketFactors.positiveFactors.length || marketFactors.negativeFactors.length || marketFactors.marketView)),
    has7dBaseline,
    has30dBaseline,
    hasEnoughHistory: history.length >= MIN_HISTORY_POINTS && spanDays >= MIN_HISTORY_POINTS,
  };
}

function dedupeMarketAnalyses(analyses: MarketAnalysis[]) {
  const seen = new Set<string>();
  return analyses.filter((item) => {
    const title = item.title?.trim() || "";
    const key = `${title.toLowerCase()}|${item.source?.trim().toLowerCase() || ""}|${item.url?.trim() || ""}|${item.date?.trim() || ""}`;
    if (!title || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((item) => ({
    ...(item.title?.trim() ? { title: item.title.trim() } : {}),
    ...(item.summary?.trim() ? { summary: item.summary.trim() } : {}),
    ...(item.source?.trim() ? { source: item.source.trim() } : {}),
    ...(item.url?.trim() ? { url: item.url.trim() } : {}),
    ...(item.date?.trim() ? { date: item.date.trim() } : {}),
  }));
}

function buildBaseContext(input: BuilderBaseInput): ProcurementContext {
  const history = normalizeHistory(input.history);
  const latest = latestPoint(history);
  const currentPrice = typeof input.currentPrice === "number" && Number.isFinite(input.currentPrice)
    ? input.currentPrice
    : undefined;
  const resolvedPrice = currentPrice ?? latest?.price;
  const sources = dedupeSources(input.sources ?? []);
  const news = dedupeNews(input.news ?? []);
  const marketAnalyses = dedupeMarketAnalyses(input.marketAnalyses ?? []);
  const moneyUnit = splitMoneyUnit(input.currency, input.unit);
  const change1d = calculateAdjacentChange(history);
  const change7d = calculateHistoricalChange(history, 7);
  const change30d = calculateHistoricalChange(history, 30);
  return {
    materialName: input.materialName,
    category: input.category,
    ...(resolvedPrice !== undefined ? { currentPrice: resolvedPrice } : {}),
    ...(moneyUnit.currency ? { currency: moneyUnit.currency } : {}),
    ...(moneyUnit.unit ? { unit: moneyUnit.unit } : {}),
    ...(change1d !== undefined ? { change1d } : {}),
    ...(change7d !== undefined ? { change7d } : {}),
    ...(change30d !== undefined ? { change30d } : {}),
    ...(input.streak !== undefined && Number.isFinite(input.streak) ? { streak: input.streak } : {}),
    ...(direction(change1d) ? { trendDirection: direction(change1d) } : {}),
    ...(input.riskLevel ? { riskLevel: input.riskLevel } : {}),
    ...(input.riskReason ? { riskReason: input.riskReason } : {}),
    history,
    sources,
    news,
    marketAnalyses,
    ...(input.marketFactors ? { marketFactors: input.marketFactors } : {}),
    ...(input.lastUpdated ? { lastUpdated: input.lastUpdated } : {}),
    ...(input.timeRange ? { timeRange: input.timeRange } : {}),
    dataCoverage: coverage(history, resolvedPrice, sources, news, marketAnalyses, input.marketFactors),
  };
}

export function buildMoverContext(input: ContextMoverInput): ProcurementContext {
  const history = input.entry.key ? input.historyByKey?.[input.entry.key] : undefined;
  const base = buildBaseContext({
    materialName: input.entry.name,
    category: input.entry.group,
    currentPrice: input.entry.price,
    unit: input.entry.unit,
    history,
    sources: [{ label: input.entry.source, ...(input.sourceUrl ? { url: input.sourceUrl } : {}) }],
    news: input.news,
    lastUpdated: input.lastUpdated,
    riskLevel: input.riskLevel,
    riskReason: input.riskReason,
    streak: input.entry.risingStreak,
  });
  const change1d = typeof input.entry.changeRate === "number" ? input.entry.changeRate : base.change1d;
  return {
    ...base,
    ...(change1d !== undefined ? { change1d, trendDirection: direction(change1d) } : {}),
  };
}

export function buildRiskContext(input: ContextMoverInput): ProcurementContext {
  return buildMoverContext(input);
}

export function buildTrendContext(input: ContextTrendInput): ProcurementContext {
  return buildBaseContext({
    materialName: input.materialName,
    category: input.category,
    currentPrice: input.currentPrice,
    currency: input.currency,
    unit: input.unit,
    history: input.points,
    sources: input.source ? [{ label: input.source, ...(input.sourceUrl ? { url: input.sourceUrl } : {}) }] : [],
    news: input.news,
    lastUpdated: input.lastUpdated,
    timeRange: input.timeRange,
  });
}

function marketItemHistory(input: ContextMarketItemInput) {
  return input.historyKey ? input.historyByKey?.[input.historyKey] : undefined;
}

export function buildPlasticContext(input: ContextPlasticInput): ProcurementContext {
  const analysis = input.analysis;
  const item = input.item;
  return buildBaseContext({
    materialName: item.name,
    category: item.category,
    currentPrice: item.price,
    unit: item.unit,
    history: marketItemHistory(input),
    sources: [{ label: item.source, ...(input.sourceUrl || item.url ? { url: input.sourceUrl || item.url } : {}) }],
    news: input.news,
    lastUpdated: item.updateDate || input.lastUpdated,
    riskLevel: input.riskLevel,
    riskReason: input.riskReason,
    streak: input.streak,
    marketFactors: analysis ? {
      positiveFactors: analysis.positiveFactors,
      negativeFactors: analysis.negativeFactors,
      marketView: analysis.marketView,
    } : {
      positiveFactors: item.factors.filter((factor) => /上涨|支撑|改善|增加/.test(factor)),
      negativeFactors: item.factors.filter((factor) => /疲软|压力|下降|充足|走弱/.test(factor)),
      marketView: item.description,
    },
  });
}

function ddrContent(data?: DDRMarketData) {
  const industryNews: NewsItem[] = (data?.industryNews ?? []).slice(0, 4).map((item: DDRIndustryNewsRecord) => ({
    title: item.title,
    summary: item.summary,
    source: item.source,
    url: item.url,
    date: item.date,
  }));
  const marketAnalyses: MarketAnalysis[] = (data?.marketAnalyses ?? []).slice(0, 2).map((item: DDRMarketAnalysisRecord) => ({
    title: item.title,
    summary: item.summary,
    source: item.source,
    url: item.url,
    date: item.date,
  }));
  return { news: industryNews, marketAnalyses };
}

export function buildDDRContext(input: ContextDDRInput): ProcurementContext {
  const item = input.item;
  const analysis = input.ddrData?.marketAnalyses?.[0];
  const factors = analysis?.factors?.filter((factor) => !factor.startsWith("趋势：")) ?? item.factors;
  const content = ddrContent(input.ddrData);
  return buildBaseContext({
    materialName: item.name,
    category: item.category,
    currentPrice: item.price,
    unit: item.unit,
    history: marketItemHistory(input),
    sources: [{ label: item.source, ...(input.sourceUrl || item.url ? { url: input.sourceUrl || item.url } : {}) }],
    news: [...(input.news ?? []), ...content.news],
    marketAnalyses: content.marketAnalyses,
    lastUpdated: item.updateDate || input.lastUpdated,
    riskLevel: input.riskLevel,
    riskReason: input.riskReason,
    streak: input.streak,
    marketFactors: {
      positiveFactors: factors,
      negativeFactors: [],
      marketView: analysis?.summary || item.description,
    },
  });
}
