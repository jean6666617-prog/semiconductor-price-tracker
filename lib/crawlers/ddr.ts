export type DDRSpotPriceRecord = {
  type: "spot_price";
  source: "DRAMeXchange";
  product: string;
  price: string;
  currency: string;
  unit: string;
  date: string;
  url: string;
  change?: string;
};

export type DDRContractPriceRecord = {
  type: "contract_price";
  source: ["DRAMeXchange", "TrendForce"];
  product: string;
  price: string;
  period: string;
  trend: string;
  date: string;
  url: string;
};

export type DDRMarketAnalysisRecord = {
  type: "market_analysis";
  source: "TrendForce";
  title: string;
  date: string;
  summary: string;
  factors: string[];
  url: string;
};

export type DDRIndustryNewsRecord = {
  type: "industry_news";
  source: "DigiTimes" | "Tom's Hardware";
  title: string;
  date: string;
  summary: string;
  impact: string;
  url: string;
};

export type DDRMarketData = {
  success: boolean;
  status: "ready" | "partial" | "access_restricted" | "empty";
  spotPrices: DDRSpotPriceRecord[];
  contractPrices: DDRContractPriceRecord[];
  marketAnalyses: DDRMarketAnalysisRecord[];
  industryNews: DDRIndustryNewsRecord[];
  sourceUrls: typeof ddrSourceUrls;
  errors: string[];
};

export type DDRFallbackInput = Partial<Pick<DDRMarketData, "spotPrices" | "contractPrices" | "marketAnalyses" | "industryNews">>;

export const ddrSourceUrls = {
  spotPrice: "https://www.dramexchange.com/",
  contractPriceDramExchange: "https://www.dramexchange.com/",
  contractPriceTrendForce: "https://www.trendforce.cn/",
  marketAnalysis: "https://www.trendforce.cn/",
  industryNews: "https://www.digitimes.com/tech/",
  tomsHardwareAnalysis: "https://www.tomshardware.com/tag/ram-shortage",
} as const;

const trendForceTrendUrls = [
  "https://www.trendforce.cn/presscenter/news/20260703-13133.html",
  "https://www.trendforce.cn/presscenter/news/20260602-13073.html",
  "https://www.trendforce.cn/presscenter/news/20260331-12993.html",
];
const tomsHardwareAnalysisUrl = ddrSourceUrls.tomsHardwareAnalysis;

function hasFallbackData(fallback?: DDRFallbackInput) {
  return Boolean(
    fallback?.spotPrices?.length
    || fallback?.contractPrices?.length
    || fallback?.marketAnalyses?.length
    || fallback?.industryNews?.length,
  );
}


function stripHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url: string) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; SemiconductorPriceTracker/1.0)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.text();
}

function parseDramExchangeDate(text: string) {
  return text.match(/DRAM Spot Price Last Update:\s*([^<]+?)\s*Item/)?.[1]?.trim()
    || text.match(/DRAM Spot Price\s+Last Update:\s*([^<]+?)\s+Item/)?.[1]?.trim()
    || "";
}

function parseDramExchangeSpotRows(html: string): DDRSpotPriceRecord[] {
  const text = stripHtml(html);
  const date = parseDramExchangeDate(text);
  const rows: DDRSpotPriceRecord[] = [];
  const targets = [
    "DDR5 16Gb (2Gx8) 4800/5600",
    "DDR4 16Gb (2Gx8) 3200",
  ];
  for (const product of targets) {
    const escaped = product.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`${escaped}\\s+([0-9.]+)\\s+([0-9.]+)\\s+([0-9.]+)\\s+([0-9.]+)\\s+([0-9.]+)\\s+([+-]?[0-9.]+)\\s*%`, "i"));
    if (!match) continue;
    rows.push({
      type: "spot_price",
      source: "DRAMeXchange",
      product: product.startsWith("DDR5") ? "DDR5" : "DDR4",
      price: match[5],
      currency: "USD",
      unit: "USD",
      date,
      url: ddrSourceUrls.spotPrice,
      change: match[6],
    });
  }
  return rows;
}

function titleFromHtml(html: string) {
  return stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
}

function dateFromTrendForce(text: string) {
  return text.match(/(\d{1,2}\s+[A-Z][a-z]+\s+\d{4})/)?.[1]
    || text.match(/(20\d{2}[./-]\d{1,2}[./-]\d{1,2})/)?.[1]
    || "";
}

function extractTrendFactors(text: string) {
  const factorTests: Array<[RegExp, string]> = [
    [/AI服务器|AI Server|AI推理|大型数据中心|数据中心/i, "AI服务器与数据中心需求支撑"],
    [/HBM/i, "HBM需求影响DRAM产能配置"],
    [/DDR4.*供应|Consumer DRAM|退出Consumer DRAM|减产/i, "DDR4供应收缩"],
    [/DDR5|RDIMM/i, "DDR5与Server DRAM升级需求"],
    [/产能|供给|供应|原厂/i, "原厂产能调整"],
    [/库存/i, "库存变化影响采购节奏"],
    [/PC OEM|PC市场|笔记本/i, "PC市场需求承压"],
    [/Server|企业级服务器|通用型Server/i, "企业级服务器需求延续"],
  ];
  return Array.from(new Set(factorTests.filter(([pattern]) => pattern.test(text)).map(([, factor]) => factor)));
}

function summarizeTrendForce(text: string, factors: string[]) {
  const trend = /季增|上涨|上行|涨幅|支撑/.test(text) ? "上涨" : /下修|收敛|压力|疲弱/.test(text) ? "震荡" : "震荡";
  const reason = factors.slice(0, 3).join("、") || "供需变化";
  return {
    trend,
    summary: `DDR/DRAM价格短期${trend === "上涨" ? "维持上行" : "偏震荡运行"}，主要受到${reason}影响。`,
  };
}

export async function fetchDDRSpotPrices(): Promise<DDRSpotPriceRecord[]> {
  const html = await fetchText(ddrSourceUrls.spotPrice);
  return parseDramExchangeSpotRows(html);
}

export async function fetchDDRContractPrices(): Promise<DDRContractPriceRecord[]> {
  const analyses = await fetchDDRMarketAnalyses();
  const analysis = analyses[0];
  if (!analysis) return [];
  const period = analysis.title.match(/(\dQ\d{2}|\d{4}年第[一二三四]季|[1234]Q\d{2})/)?.[1] || "最新周期";
  const trendMatch = analysis.summary.match(/(季增[0-9]+-[0-9]+%|上涨|上行|涨幅收敛|震荡)/)?.[1] || "上涨";
  return ["DDR4", "DDR5"].map((product) => ({
    type: "contract_price",
    source: ["DRAMeXchange", "TrendForce"],
    product,
    price: "暂无公开数据",
    period,
    trend: trendMatch,
    date: analysis.date,
    url: analysis.url,
  }));
}

function extractTrendForceArticleUrls(html: string) {
  const urls = new Set<string>();
  for (const match of html.matchAll(/href=["']([^"']*presscenter\/news\/[^"']+\.html)["']/gi)) {
    try {
      const url = new URL(match[1], ddrSourceUrls.marketAnalysis).toString();
      if (/trendforce\.cn$/i.test(new URL(url).hostname)) urls.add(url);
    } catch {
      continue;
    }
  }
  return [...urls].slice(0, 8);
}

export async function fetchDDRMarketAnalyses(): Promise<DDRMarketAnalysisRecord[]> {
  let discoveredUrls: string[] = [];
  try {
    discoveredUrls = extractTrendForceArticleUrls(await fetchText(ddrSourceUrls.marketAnalysis));
  } catch {
    discoveredUrls = [];
  }
  const candidateUrls = Array.from(new Set([...discoveredUrls, ...trendForceTrendUrls]));
  for (const url of candidateUrls) {
    try {
      const html = await fetchText(url);
      const text = stripHtml(html);
      const title = titleFromHtml(html);
      if (!/DRAM|DDR|存储器|内存/.test(title + " " + text)) continue;
      const factors = extractTrendFactors(text);
      const analysis = summarizeTrendForce(text, factors);
      return [{
        type: "market_analysis",
        source: "TrendForce",
        title,
        date: dateFromTrendForce(text),
        summary: analysis.summary,
        factors: ["趋势：" + analysis.trend, ...factors],
        url,
      }];
    } catch {
      continue;
    }
  }
  return [];
}
function parseDigiTimesDate(value: string, year: number) {
  const normalized = stripHtml(value).replace(/\s+/g, " ").trim();
  const match = normalized.match(/([A-Z][a-z]{2,8}\s+\d{1,2})(?:,\s*(\d{4}))?(?:,?\s*(\d{1,2}:\d{2}))?/);
  if (!match) return normalized;
  const dateYear = Number(match[2] || year);
  const timestamp = Date.parse(`${match[1]}, ${dateYear} ${match[3] || "00:00"}`);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : normalized;
}

function parseDigiTimesTechNews(html: string): DDRIndustryNewsRecord[] {
  const pageDate = html.match(/<meta[^>]+name=["']Date["'][^>]+content=["'][^"']*?(20\d{2})/i)?.[1];
  const year = Number(pageDate || new Date().getUTCFullYear());
  const records: DDRIndustryNewsRecord[] = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\b([^>]*href=["']([^"']*\/news\/[^"']+)["'][^>]*)>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorPattern)) {
    const openingTag = match[1];
    const href = match[2];
    const inner = match[3];
    if (!/class=["'][^"']*(?:title|display-3-frame)[^"']*["']/i.test(openingTag)) continue;
    let url: string;
    try {
      url = new URL(href, ddrSourceUrls.industryNews).toString();
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    const titleHtml = inner.match(/<(?:div|h[1-6]|span)[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|h[1-6]|span)>/i)?.[1] || inner;
    const title = stripHtml(titleHtml).replace(/\s+/g, " ").trim();
    if (title.length < 12 || !/DRAM|DDR|memory|HBM|semiconductor|chip|shortage|AI|Samsung|SK Hynix|Micron|CXMT/i.test(title)) continue;
    const index = match.index ?? 0;
    const context = html.slice(Math.max(0, index - 900), Math.min(html.length, index + match[0].length + 1400));
    const dateText = context.match(/class=["'][^"']*date[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1]
      || context.match(/(?:Aug|September|October|November|December|January|February|March|April|May|June|July)\s+\d{1,2}(?:,\s*\d{4})?(?:,?\s*\d{1,2}:\d{2})?/i)?.[0]
      || "";
    const summary = stripHtml(context.match(/class=["'][^"']*abstract[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1] || "")
      .replace(/\s+/g, " ").trim().slice(0, 320);
    const combined = `${title} ${summary}`;
    records.push({
      type: "industry_news",
      source: "DigiTimes",
      title,
      date: parseDigiTimesDate(dateText, year),
      summary: summary || "DigiTimes公开页面提供了该半导体行业新闻摘要。",
      impact: /shortage|price|rise|increase|demand|supply|investment|capacity|HBM/i.test(combined) ? "上涨原因" : "行业观察",
      url,
    });
    seen.add(url);
  }
  return records.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)).slice(0, 8);
}

export async function fetchDDRIndustryNews(): Promise<DDRIndustryNewsRecord[]> {
  const news = parseDigiTimesTechNews(await fetchText(ddrSourceUrls.industryNews));
  if (!news.length) throw new Error("DigiTimes最新半导体新闻列表解析失败");
  return news;
}

function cleanTomsHardwareText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function parseTomsHardwareItems(text: string): DDRIndustryNewsRecord[] {
  const section = text.split("Latest about RAM shortage")[1]?.split("Stay On the Cutting Edge")[0] || text;
  const itemPattern = /(.{12,220}?)\s+By\s+[A-Z][A-Za-z .'-]+(?:,\s*[A-Z][A-Za-z .'-]+)?\s+published\s+(\d{1,2}\s+[A-Z][a-z]+\s+\d{2})\s+(.{24,320}?)(?=\s+.{12,220}?\s+By\s+[A-Z][A-Za-z .'-]+(?:,\s*[A-Z][A-Za-z .'-]+)?\s+published\s+\d{1,2}\s+[A-Z][a-z]+\s+\d{2}|\s+1\s+2\s+3\s+Archives|$)/gi;
  const records: DDRIndustryNewsRecord[] = [];
  for (const match of section.matchAll(itemPattern)) {
    const title = cleanTomsHardwareText(match[1]);
    const date = cleanTomsHardwareText(match[2]);
    const summary = cleanTomsHardwareText(match[3]).replace(/\s+(RAM|DRAM|DDR5|PC Building|Laptops|Operating Systems)$/i, "");
    const combined = `${title} ${summary}`;
    if (!/RAM|DRAM|DDR5|Micron|memory|shortage|AI|supply|price/i.test(combined)) continue;
    records.push({
      type: "industry_news",
      source: "Tom's Hardware",
      title,
      date,
      summary,
      impact: /AI|shortage|price|increase|crunch|supply|constraint|soar|hike|4x/i.test(combined) ? "上涨原因" : "行业观察",
      url: tomsHardwareAnalysisUrl,
    });
    if (records.length >= 4) break;
  }
  return records;
}

export async function fetchTomsHardwareAnalysis(): Promise<DDRIndustryNewsRecord[]> {
  const html = await fetchText(tomsHardwareAnalysisUrl);
  const text = stripHtml(html);
  const parsed = parseTomsHardwareItems(text);
  if (parsed.length) return parsed;
  const fallbackSummary = cleanTomsHardwareText(text.match(/Latest about RAM shortage\s+(.{40,360})/)?.[1] || "");
  return fallbackSummary ? [{
    type: "industry_news",
    source: "Tom's Hardware",
    title: "RAM shortage coverage",
    date: "",
    summary: fallbackSummary,
    impact: /AI|shortage|price|increase|crunch|supply|constraint|soar|hike/i.test(fallbackSummary) ? "上涨原因" : "行业观察",
    url: tomsHardwareAnalysisUrl,
  }] : [];
}


export async function fetchDDRMarketData(fallback?: DDRFallbackInput): Promise<DDRMarketData> {
  if (hasFallbackData(fallback)) {
    return {
      success: true,
      status: "ready",
      spotPrices: fallback?.spotPrices ?? [],
      contractPrices: fallback?.contractPrices ?? [],
      marketAnalyses: fallback?.marketAnalyses ?? [],
      industryNews: fallback?.industryNews ?? [],
      sourceUrls: ddrSourceUrls,
      errors: [],
    };
  }

  const errors: string[] = [];
  const [spotResult, analysisResult, newsResult, tomsHardwareResult] = await Promise.allSettled([
    fetchDDRSpotPrices(),
    fetchDDRMarketAnalyses(),
    fetchDDRIndustryNews(),
    fetchTomsHardwareAnalysis(),
  ]);
  const spotPrices = spotResult.status === "fulfilled" ? spotResult.value : [];
  const marketAnalyses = analysisResult.status === "fulfilled" ? analysisResult.value : [];
  const industryNews = [
    ...(newsResult.status === "fulfilled" ? newsResult.value : []),
    ...(tomsHardwareResult.status === "fulfilled" ? tomsHardwareResult.value : []),
  ];
  if (spotResult.status === "rejected") errors.push(`DRAMeXchange spot price unavailable: ${spotResult.reason instanceof Error ? spotResult.reason.message : "unknown error"}`);
  if (analysisResult.status === "rejected") errors.push(`TrendForce analysis unavailable: ${analysisResult.reason instanceof Error ? analysisResult.reason.message : "unknown error"}`);
  if (newsResult.status === "rejected") errors.push(`DigiTimes news unavailable: ${newsResult.reason instanceof Error ? newsResult.reason.message : "unknown error"}`);
  if (tomsHardwareResult.status === "rejected") errors.push(`Tom's Hardware analysis unavailable: ${tomsHardwareResult.reason instanceof Error ? tomsHardwareResult.reason.message : "unknown error"}`);

  const contractPrices = marketAnalyses[0]
    ? ["DDR4", "DDR5"].map((product) => ({
      type: "contract_price" as const,
      source: ["DRAMeXchange", "TrendForce"] as ["DRAMeXchange", "TrendForce"],
      product,
      price: "暂无公开数据",
      period: marketAnalyses[0].title.match(/(\dQ\d{2}|\d{4}年第[一二三四]季|[1234]Q\d{2})/)?.[1] || "最新周期",
      trend: marketAnalyses[0].factors[0]?.replace("趋势：", "") || "上涨",
      date: marketAnalyses[0].date,
      url: marketAnalyses[0].url,
    }))
    : [];
  if (!contractPrices.length) errors.push("DRAMeXchange / TrendForce contract price has no public table available.");
  if (!spotPrices.length) errors.push("DRAMeXchange DDR4/DDR5 spot price could not be parsed from public page.");

  const hasAnyData = Boolean(spotPrices.length || contractPrices.length || marketAnalyses.length || industryNews.length);
  return {
    success: hasAnyData,
    status: hasAnyData && errors.length ? "partial" : hasAnyData ? "ready" : "access_restricted",
    spotPrices,
    contractPrices,
    marketAnalyses,
    industryNews,
    sourceUrls: ddrSourceUrls,
    errors,
  };
}
