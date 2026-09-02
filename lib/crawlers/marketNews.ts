export type MarketNewsCategory = "Display" | "Battery";

export type MarketNewsRecord = {
  category: MarketNewsCategory;
  title: string;
  summary: string;
  source: string;
  date: string;
  url: string;
  sourceUrl: string;
  accessType: "crawler" | "link_only";
  analysis: string;
};

export type MarketNewsData = {
  success: boolean;
  category: MarketNewsCategory;
  status: "ready" | "partial" | "empty";
  source: string;
  sourceUrl: string;
  news: MarketNewsRecord[];
  attemptedSources: string[];
  errors: string[];
  crawlTime: string;
};

type SourceDefinition = {
  source: string;
  url: string;
  relevant: RegExp;
  articlePath: RegExp;
};

const displaySources: SourceDefinition[] = [
  { source: "DigiTimes", url: "https://www.digitimes.com/topic/displays/", relevant: /lcd|display|panel|oled|mini-?led|micro-?led|fpd|screen|monitor|tv|e-paper/i, articlePath: /\/news\//i },
  { source: "Display Daily", url: "https://displaydaily.com/", relevant: /lcd|display|panel|oled|mini-?led|micro-?led|fpd|screen|monitor|tv|e-paper/i, articlePath: /\/(?:\d{4}\/)?[a-z0-9][a-z0-9-]{12,}/i },
  { source: "SEMI", url: "https://www.semi.org/en/technology-trends/topic/displays", relevant: /lcd|display|panel|oled|mini-?led|micro-?led|fpd|screen|monitor|tv|e-paper/i, articlePath: /\/(?:en\/)?(?:blog|technology-trends|news)\//i },
];

const batterySources: SourceDefinition[] = [
  { source: "electrive", url: "https://www.electrive.com/category/battery-fuel-cell/", relevant: /battery|batteries|lithium|cell|cathode|anode|nickel|cobalt|graphite|ev|energy storage|separator|electrolyte/i, articlePath: /\/\d{4}\/\d{2}\/\d{2}\//i },
  { source: "Batteries News", url: "https://batteriesnews.com/", relevant: /battery|batteries|lithium|cell|cathode|anode|nickel|cobalt|graphite|ev|energy storage|separator|electrolyte/i, articlePath: /\/\d{4}\/\d{2}\/\d{2}\//i },
  { source: "Benchmark Source", url: "https://source.benchmarkminerals.com/category/batteries", relevant: /battery|batteries|lithium|cell|cathode|anode|nickel|cobalt|graphite|ev|energy storage|separator|electrolyte/i, articlePath: /\/article\//i },
  { source: "IEA", url: "https://www.iea.org/news?type=news", relevant: /battery|batteries|lithium|cell|cathode|anode|nickel|cobalt|graphite|ev|energy storage|separator|electrolyte/i, articlePath: /\/news\//i },
];

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function cleanText(value: string) {
  return decodeEntities(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}

function cleanTitle(value: string) {
  return cleanText(value)
    .replace(/\s+published\s+(?:\d+\s+)?(?:minutes?|hours?|days?|weeks?|months?)\s+ago.*$/i, "")
    .replace(/\s+published\s+\d{1,2}\.\d{2}\.\d{4}.*$/i, "")
    .replace(/\s+\d{1,2}\.\d{2}\.20\d{2}$/i, "")
    .trim();
}

function absoluteUrl(value: string, base: string) {
  try { return new URL(decodeEntities(value), base).toString(); } catch { return ""; }
}

function parseDate(value: string, url: string) {
  const iso = value.match(/20\d{2}[-/]\d{1,2}[-/]\d{1,2}/)?.[0];
  const slash = url.match(/20(\d{2})[/-](\d{2})[/-](\d{2})/);
  const compact = url.match(/20(\d{2})(\d{2})(\d{2})/);
  if (iso) return iso.replaceAll("/", "-");
  if (slash) return `20${slash[1]}-${slash[2]}-${slash[3]}`;
  if (compact) return `20${compact[1]}-${compact[2]}-${compact[3]}`;
  const named = value.match(/(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+20\d{2}/i)?.[0];
  if (named) {
    const parsedNamed = Date.parse(named);
    if (Number.isFinite(parsedNamed)) return new Date(parsedNamed).toISOString().slice(0, 10);
  }
  const dotted = value.match(/\d{1,2}\.\d{2}\.20\d{2}/)?.[0];
  if (dotted) {
    const [day, month, year] = dotted.split(".");
    return `${year}-${month}-${day.padStart(2, "0")}`;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
}

function articleAnalysis(category: MarketNewsCategory, text: string) {
  const subject = category === "Display" ? "显示面板供需、出货或成本" : "电池材料、产能、出货或需求";
  return new RegExp("price|cost|shipment|demand|supply|shortage|capacity|production|inventory|sales|\u4ef7\u683c|\u51fa\u8d27|\u4f9b\u9700|\u4ea7\u80fd", "i").test(text)
    ? `该新闻提供${subject}背景，可作为外部证据与平台价格样本交叉验证，不单独代表价格结论。`
    : "该新闻作为行业背景证据，不单独代表价格方向。";
}

function extractArticles(html: string, category: MarketNewsCategory, definition: SourceDefinition) {
  const records: MarketNewsRecord[] = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) && records.length < 8) {
    const attributes = match[1];
    const heading = match[2].match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1];
    const paragraph = match[2].match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1];
    const title = cleanTitle(heading || match[2]);
    const href = attributes.match(/href\s*=\s*["']([^"']+)["']/i)?.[1] || "";
    const url = absoluteUrl(href, definition.url);
    if (!url || !title || title.length < 18 || !definition.articlePath.test(new URL(url).pathname) || !definition.relevant.test(title)) continue;
    if (new URL(url).hostname !== new URL(definition.url).hostname || seen.has(url)) continue;
    const windowText = cleanText(html.slice(Math.max(0, match.index - 360), Math.min(html.length, anchorPattern.lastIndex + 560)));
    const summaryCandidate = cleanText(paragraph || windowText.replace(title, "")).replace(/^(?:daily|news|category|battery|display)\s+/i, "").replace(/https?:\/\/\S+/g, "").trim();
    const summary = summaryCandidate && summaryCandidate.length >= 30 && !/class=|data-|attachment|decoding|loading|wp-content|published|batteries for evs|category|<|>|\{/.test(summaryCandidate)
      ? summaryCandidate.slice(0, 260)
      : title;
    const date = parseDate(windowText, url);
    seen.add(url);
    records.push({ category, title, summary, source: definition.source, date, url, sourceUrl: definition.url, accessType: "crawler", analysis: articleAnalysis(category, `${title} ${summary}`) });
  }
  return records.sort((left, right) => (Date.parse(right.date) || 0) - (Date.parse(left.date) || 0)).slice(0, 6);
}

async function fetchSource(url: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: "text/html,application/xhtml+xml", "user-agent": "SemiconductorPriceTracker/1.0" }, cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("source request failed");
}

export async function fetchMarketNews(category: MarketNewsCategory): Promise<MarketNewsData> {
  const sources = category === "Display" ? displaySources : batterySources;
  const errors: string[] = [];
  const attemptedSources = sources.map((source) => source.source);
  for (const source of sources) {
    try {
      const records = extractArticles(await fetchSource(source.url), category, source);
      if (records.length) return { success: true, category, status: errors.length ? "partial" : "ready", source: source.source, sourceUrl: source.url, news: records, attemptedSources, errors, crawlTime: new Date().toISOString() };
      errors.push(`${source.source}: no relevant article links found`);
    } catch (error) {
      errors.push(`${source.source}: ${error instanceof Error ? error.message : "request failed"}`);
    }
  }
  return { success: false, category, status: "empty", source: "", sourceUrl: "", news: [], attemptedSources, errors, crawlTime: new Date().toISOString() };
}
