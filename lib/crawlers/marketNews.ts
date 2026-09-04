export type MarketNewsCategory = "Display" | "Battery" | "SOC";

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
  displayUrl?: string;
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

// SoC sources are public newsroom/index pages. We only collect visible
// headlines and links; no prices are fabricated when a source does not expose
// a verifiable quote.
const socSources: SourceDefinition[] = [
  { source: "Tom's Hardware", url: "https://www.tomshardware.com/feeds.xml", displayUrl: "https://www.tomshardware.com/tag/cpus", relevant: /soc|processor|chip|cpu|gpu|architecture|silicon|automotive|iot|semiconductor/i, articlePath: /\//i },
  { source: "EE Times SoC", url: "https://www.eetimes.com/tag/soc/", relevant: /soc|system[- ]on[- ]chip|processor|chip|eda|architecture|ip|automotive|iot|snapdragon|mediatek|qualcomm/i, articlePath: /\//i },
  { source: "Qualcomm Newsroom", url: "https://www.qualcomm.com/news/releases", relevant: /soc|snapdragon|processor|chip|automotive|iot|edge|platform/i, articlePath: /\/news\//i },
  { source: "MediaTek Press Room", url: "https://corp.mediatek.com/news-events/press-releases", relevant: /soc|dimensity|processor|chip|automotive|iot|connectivity|platform/i, articlePath: /\/news-events\//i },
  { source: "Arm Newsroom", url: "https://newsroom.arm.com/", relevant: /soc|processor|cpu|gpu|chip|architecture|automotive|iot|neoverse|cortex/i, articlePath: /\//i },
  { source: "Counterpoint AP-SoC", url: "https://counterpointresearch.com/en/insights/ap-soc", relevant: /soc|application processor|smartphone|chip|mediatek|qualcomm|apple|silicon/i, articlePath: /\//i },
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
  const rfc = value.match(/\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+20\d{2}\b/i);
  if (rfc) {
    const parsedRfc = Date.parse(rfc[0]);
    if (Number.isFinite(parsedRfc)) return new Date(parsedRfc).toISOString().slice(0, 10);
  }
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
  const subject = category === "Display" ? "显示面板供需、出货或成本" : category === "Battery" ? "电池材料、产能、出货或需求" : "SoC 产品发布、芯片设计与终端需求";
  return new RegExp("price|cost|shipment|demand|supply|shortage|capacity|production|inventory|sales|\u4ef7\u683c|\u51fa\u8d27|\u4f9b\u9700|\u4ea7\u80fd", "i").test(text)
    ? `该新闻提供${subject}背景，可作为外部证据与平台价格样本交叉验证，不单独代表价格结论。`
    : "该新闻作为行业背景证据，不单独代表价格方向。";
}

function xmlValue(block: string, tag: string) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? cleanText(match[1]) : "";
}

function extractRssArticles(xml: string, category: MarketNewsCategory, definition: SourceDefinition) {
  const records: MarketNewsRecord[] = [];
  const itemPattern = /<item\b[\s\S]*?<\/item>/gi;
  console.debug("[SOC raw item count]", definition.source, (xml.match(/<item\b/gi) || []).length);
  let match: RegExpExecArray | null;
  while ((match = itemPattern.exec(xml)) && records.length < 8) {
    const block = match[0];
    const title = cleanTitle(xmlValue(block, "title"));
    const rawUrl = xmlValue(block, "link") || xmlValue(block, "guid");
    const url = absoluteUrl(rawUrl, definition.url);
    const summary = cleanText(xmlValue(block, "description") || title).slice(0, 260) || title;
    const date = parseDate(xmlValue(block, "pubDate") || xmlValue(block, "dc:date") || xmlValue(block, "date") || xmlValue(block, "updated"), url);
    if (!title || title.length < 10) { console.debug("[SOC rejected item]", definition.source, "missing_title"); continue; }
    if (!url) { console.debug("[SOC rejected item]", definition.source, "missing_url"); continue; }
    if (!definition.relevant.test(`${title} ${summary}`)) { console.debug("[SOC rejected item]", definition.source, "not_soc_related"); continue; }
    if (records.some((record) => record.url === url)) { console.debug("[SOC rejected item]", definition.source, "duplicate"); continue; }
    records.push({ category, title, summary, source: definition.source, date, url, sourceUrl: definition.url, accessType: "crawler", analysis: articleAnalysis(category, `${title} ${summary}`) });
  }
  console.debug("[SOC classified item count]", definition.source, records.length);
  return records;
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
    if (!url || !title || title.length < 10 || !definition.articlePath.test(new URL(url).pathname) || !definition.relevant.test(title)) continue;
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
  // Several modern newsroom pages render article cards client-side but still
  // expose JSON-LD metadata. Use it as a read-only fallback when anchors are
  // unavailable; the headline and URL still come directly from the source.
  if (!records.length) {
    const jsonLdPattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let jsonMatch: RegExpExecArray | null;
    while ((jsonMatch = jsonLdPattern.exec(html)) && records.length < 8) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim()) as Record<string, unknown> | Array<Record<string, unknown>>;
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        for (const entry of entries) {
          const title = cleanTitle(String(entry.headline || entry.name || ""));
          const url = absoluteUrl(String(entry.url || entry.mainEntityOfPage || ""), definition.url);
          if (!title || title.length < 10 || !url || new URL(url).hostname !== new URL(definition.url).hostname || !definition.relevant.test(title)) continue;
          const date = parseDate(String(entry.datePublished || entry.dateCreated || ""), url);
          const summary = cleanText(String(entry.description || title)).slice(0, 260) || title;
          if (seen.has(url)) continue;
          seen.add(url);
          records.push({ category, title, summary, source: definition.source, date, url, sourceUrl: definition.url, accessType: "crawler", analysis: articleAnalysis(category, `${title} ${summary}`) });
        }
      } catch {
        // Ignore malformed metadata and continue trying the next source.
      }
    }
  }
  return records.sort((left, right) => (Date.parse(right.date) || 0) - (Date.parse(left.date) || 0)).slice(0, 6);
}

async function fetchSource(url: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(url, { headers: { accept: "application/rss+xml,application/atom+xml,text/html,application/xhtml+xml", "user-agent": "SemiconductorPriceTracker/1.0" }, cache: "no-store", signal: controller.signal }).finally(() => clearTimeout(timeout));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      console.debug("[SOC source response]", url, response.status, response.headers.get("content-type") || "", text.length);
      return text;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("source request failed");
}

export async function fetchMarketNews(category: MarketNewsCategory): Promise<MarketNewsData> {
  const sources = category === "Display" ? displaySources : category === "Battery" ? batterySources : socSources;
  const errors: string[] = [];
  const attemptedSources = sources.map((source) => source.source);
  for (const source of sources) {
    try {
      const raw = await fetchSource(source.url);
      const records = /<rss\\b|<feed\\b/i.test(raw)
        ? extractRssArticles(raw, category, source)
        : extractArticles(raw, category, source);
      console.debug("[SOC normalized item count]", source.source, records.length);
      if (records.length) return { success: true, category, status: errors.length ? "partial" : "ready", source: source.source, sourceUrl: source.displayUrl || source.url, news: records, attemptedSources, errors, crawlTime: new Date().toISOString() };
      errors.push(`${source.source}: no relevant article links found`);
    } catch (error) {
      errors.push(`${source.source}: ${error instanceof Error ? error.message : "request failed"}`);
    }
  }
  return { success: false, category, status: "empty", source: "", sourceUrl: "", news: [], attemptedSources, errors, crawlTime: new Date().toISOString() };
}
