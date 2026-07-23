import type { PriceResult, TrackingEntry } from "./index";
import { targetResponseError } from "./response";

const dramSpotUrl = "https://www.trendforce.com/price/dram/dram_spot";
const targetMaterial = "DDR5 16Gb (2Gx8) 4800/5600";
const isDevelopment = process.env.NODE_ENV === "development";
const requestTimeoutMs = 15_000;
const maxRequestAttempts = 3;
const retryBaseDelayMs = 800;
const retryJitterMs = 250;
const maxRetryAfterMs = 5_000;

const mockPrices: Record<string, number> = {
  [targetMaterial]: 48.5,
};

type TrendForcePage = {
  url: string;
  status: number;
  contentType: string;
  body: string;
  crawlTime: string;
  attemptCount: number;
};

type ParsedPrice = {
  price: number;
  updateDate: string;
  matchedName: string;
  headers: string[];
};

type ParseFailure =
  | "TABLE_NOT_FOUND"
  | "TARGET_ROW_NOT_FOUND"
  | "AMBIGUOUS_TARGET_ROW"
  | "PRICE_COLUMN_NOT_FOUND"
  | "INVALID_PRICE_FORMAT"
  | "LAST_UPDATE_INVALID";

type ParseOutcome = { value: ParsedPrice } | { error: ParseFailure };
type TrendForceRequestTask = {
  promise: Promise<TrendForcePage>;
  logicalRequestCount: 1;
  attemptCount: number;
};
type TrendForceRequestCache = Map<string, TrendForceRequestTask>;

class TrendForceRequestError extends Error {
  status?: number;
  code?: string;
  retryable: boolean;
  retryAfterMs?: number;

  constructor(message: string, options: { status?: number; code?: string; retryable?: boolean; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "TrendForceRequestError";
    this.status = options.status;
    this.code = options.code;
    this.retryable = Boolean(options.retryable);
    this.retryAfterMs = options.retryAfterMs;
  }
}

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function textFromHtml(value: string) {
  return decodeHtml(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

export function normalizeTrendForceName(value: string) {
  return textFromHtml(value)
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeDate(value: string) {
  const match = value.match(/(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function canonicalPriceField(value: string) {
  const normalized = normalizeTrendForceName(value).replace(/\./g, "");
  if (normalized === "avg" || normalized === "average") return "average";
  if (normalized === "session average") return "session average";
  if (normalized === "latest price") return "latest price";
  return normalized;
}

function parsePrice(value: string) {
  const normalized = textFromHtml(value).replace(/,/g, "").trim();
  const match = normalized.match(/^(?:(?:US)?\$|USD|RMB|CNY)?\s*([+-]?(?:\d+(?:\.\d+)?))\s*(?:USD|RMB|CNY|\$)?$/i);
  if (!match) return null;
  const price = Number(match[1]);
  return Number.isFinite(price) ? price : null;
}

function urlGroupName(url: string) {
  if (url.includes("/dram/")) return "DRAM Spot";
  if (url.includes("/lcd/")) return "Large Size Panel";
  if (url.includes("battery_cell_and_pack")) return "Battery Cell & Pack";
  if (url.includes("li_co_ni")) return "Li, Co & Ni";
  if (url.includes("/flash/")) return "NAND Flash Spot";
  return url;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function causeCode(error: unknown) {
  const record = error as { code?: unknown; cause?: { code?: unknown } };
  return typeof record.code === "string"
    ? record.code
    : typeof record.cause?.code === "string"
      ? record.cause.code
      : undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableNetworkError(error: unknown) {
  if (error instanceof TrendForceRequestError) return error.retryable;
  const message = errorMessage(error);
  const code = causeCode(error);
  return /fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|socket closed/i.test(`${message} ${code || ""}`);
}

function retryableStatus(status: number) {
  return status === 408 || status === 429 || [500, 502, 503, 504].includes(status);
}

function retryAfterMs(response: Response) {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), maxRetryAfterMs);
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.min(Math.max(dateMs - Date.now(), 0), maxRetryAfterMs);
}

function isBlockedOrErrorPage(html: string) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
  const sample = textFromHtml(`${title} ${html.slice(0, 2000)}`);
  return /cloudflare|just a moment|cf-chl|enable javascript and cookies|access denied|forbidden|verification required/i.test(sample);
}

function sectionFor(entry: TrackingEntry, html: string) {
  if (!entry.tableId) return html;
  const id = escapeRegExp(entry.tableId);
  return html.match(new RegExp(`<div\\s+id=["']${id}["'][\\s\\S]*?<\\/table>`, "i"))?.[0] || "";
}

/** Extracts a configured TrendForce item by table header and exact normalized row name. */
export function parseTrackedItemFromTable(html: string, entry: TrackingEntry): ParseOutcome {
  const section = sectionFor(entry, html);
  const table = section.match(/<table[^>]*>[\s\S]*?<\/table>/i)?.[0] || "";
  if (!table) return { error: "TABLE_NOT_FOUND" };

  const headerRow = table.match(/<thead[^>]*>[\s\S]*?<tr[^>]*>([\s\S]*?)<\/tr>[\s\S]*?<\/thead>/i)?.[1] || "";
  const headers = Array.from(headerRow.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)).map((cell) => textFromHtml(cell[1]));
  const priceField = canonicalPriceField(entry.priceField || "Session Average");
  const priceIndex = headers.findIndex((header) => canonicalPriceField(header) === priceField);
  if (priceIndex < 0) return { error: "PRICE_COLUMN_NOT_FOUND" };

  const matchNames = (entry.matchNames?.length ? entry.matchNames : [entry.name]).map(normalizeTrendForceName);
  const body = table.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] || "";
  const matches: { name: string; cells: string[] }[] = [];
  for (const row of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = Array.from(row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map((cell) => textFromHtml(cell[1]));
    if (cells.length <= priceIndex || !cells[0]) continue;
    if (matchNames.includes(normalizeTrendForceName(cells[0]))) matches.push({ name: cells[0], cells });
  }

  if (!matches.length) return { error: "TARGET_ROW_NOT_FOUND" };
  if (matches.length > 1) return { error: "AMBIGUOUS_TARGET_ROW" };
  const price = parsePrice(matches[0].cells[priceIndex]);
  if (price === null) return { error: "INVALID_PRICE_FORMAT" };
  const updateDate = normalizeDate(section.match(/Last\s+Update\s+([\d-]+)/i)?.[1] || "");
  if (!updateDate) return { error: "LAST_UPDATE_INVALID" };
  return { value: { price, updateDate, matchedName: matches[0].name, headers } };
}

/** Backward-compatible wrapper for the initial DDR5 parser. */
export function parseTrendForceDramSpotHtml(html: string, material: string) {
  const entry: TrackingEntry = {
    category: "DDR内存",
    name: material || targetMaterial,
    source: "TrendForce",
    crawler: "trendforce",
    tableId: "dram_spot",
    priceField: "Session Average",
    enabled: true,
  };
  const parsed = parseTrackedItemFromTable(html, entry);
  return "value" in parsed ? { price: parsed.value.price, updateDate: parsed.value.updateDate, item: parsed.value.matchedName } : null;
}

async function requestTrendForcePageOnce(url: string, attemptCount: number): Promise<TrendForcePage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
      },
    });
    const contentType = response.headers.get("content-type") || "";
    const finalUrl = response.url || url;
    const body = await response.text();
    const page = { url: finalUrl, status: response.status, contentType, body, crawlTime: new Date().toISOString(), attemptCount };
    if (isDevelopment) {
      console.log("[TrendForce Debug]", {
        url,
        finalUrl,
        status: page.status,
        contentType,
        bodyLength: body.length,
        htmlPreview: process.env.TRENDFORCE_DEBUG_HTML === "true" ? body.slice(0, 500) : undefined,
      });
    }
    if (!response.ok) {
      throw new TrendForceRequestError(targetResponseError("TrendForce", response, body, "TrendForce request failed"), {
        status: response.status,
        retryable: retryableStatus(response.status),
        retryAfterMs: retryAfterMs(response),
      });
    }
    if (!contentType.includes("html")) {
      throw new TrendForceRequestError(`TrendForce request failed: unexpected content-type ${contentType || "unknown"}`);
    }
    if (!body.trim()) {
      throw new TrendForceRequestError("TrendForce request failed: empty HTML response", { retryable: true });
    }
    if (isBlockedOrErrorPage(body)) {
      throw new TrendForceRequestError("TrendForce request failed: access restriction or verification page");
    }
    return page;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new TrendForceRequestError("TrendForce request timeout", { code: "ETIMEDOUT", retryable: true });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestTrendForcePage(url: string, task: TrendForceRequestTask): Promise<TrendForcePage> {
  const groupName = urlGroupName(url);
  const startedAt = Date.now();
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRequestAttempts; attempt += 1) {
    task.attemptCount = attempt;
    try {
      const page = await requestTrendForcePageOnce(url, attempt);
      if (isDevelopment) console.log(`[TrendForce] urlGroup=${groupName} succeeded attempt=${attempt}/${maxRequestAttempts}`);
      return page;
    } catch (error) {
      lastError = error;
      const retryable = isRetryableNetworkError(error);
      const retryDelay = error instanceof TrendForceRequestError && error.retryAfterMs !== undefined
        ? error.retryAfterMs
        : retryBaseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * retryJitterMs);
      if (isDevelopment) {
        console.log(`[TrendForce] urlGroup=${groupName} attempt=${attempt}/${maxRequestAttempts} failed`);
        console.log("[TrendForce] errorName=" + (error instanceof Error ? error.name : typeof error));
        console.log("[TrendForce] errorMessage=" + errorMessage(error));
        console.log("[TrendForce] causeCode=" + (causeCode(error) || (error instanceof TrendForceRequestError ? error.code : "") || "unknown"));
        if (retryable && attempt < maxRequestAttempts) console.log("[TrendForce] retryInMs=" + retryDelay);
      }
      if (!retryable || attempt >= maxRequestAttempts) break;
      await sleep(retryDelay);
    }
  }
  const code = causeCode(lastError) || (lastError instanceof TrendForceRequestError ? lastError.code || lastError.status : undefined);
  const message = code || errorMessage(lastError) || "unknown";
  if (isDevelopment) {
    console.log(`[TrendForce] urlGroup=${groupName} exhausted retries`);
    console.log("[TrendForce] attempts=" + task.attemptCount);
    console.log("[TrendForce] totalDurationMs=" + (Date.now() - startedAt));
  }
  throw new TrendForceRequestError(`TrendForce request failed after ${task.attemptCount} attempts: ${message}`, {
    code: typeof code === "string" ? code : undefined,
    status: typeof code === "number" ? code : undefined,
  });
}

function requestFromCache(url: string, cache: TrendForceRequestCache) {
  const existing = cache.get(url);
  if (existing) return existing.promise;
  const task: TrendForceRequestTask = {
    logicalRequestCount: 1,
    attemptCount: 0,
    promise: Promise.resolve(null as never),
  };
  task.promise = requestTrendForcePage(url, task);
  cache.set(url, task);
  return task.promise;
}

function failedResult(entry: TrackingEntry, updateDate: string, error: string, sourceUrl = entry.url || dramSpotUrl, crawlTime = new Date().toISOString()): PriceResult {
  return {
    success: false,
    category: entry.category,
    material: entry.name,
    materialName: entry.name,
    price: null,
    currency: entry.unit?.startsWith("USD") ? "USD" : "RMB",
    unit: entry.unit || "USD",
    source: entry.source || "TrendForce",
    sourceUrl,
    updateDate,
    crawlTime,
    mode: entry.mode || "mock",
    error,
  };
}

export async function fetchTrendForceRealPrice(entry: TrackingEntry, fallbackDate: string, cache: TrendForceRequestCache = new Map()): Promise<PriceResult> {
  const url = entry.url || dramSpotUrl;
  try {
    const page = await requestFromCache(url, cache);
    const parsed = parseTrackedItemFromTable(page.body, entry);
    if (!("value" in parsed)) {
      const messages: Record<ParseFailure, string> = {
        TABLE_NOT_FOUND: "表格不存在",
        TARGET_ROW_NOT_FOUND: "目标行不存在",
        AMBIGUOUS_TARGET_ROW: "匹配到多行",
        PRICE_COLUMN_NOT_FOUND: "价格列不存在",
        INVALID_PRICE_FORMAT: "价格格式无效",
        LAST_UPDATE_INVALID: "Last Update 不存在或无效",
      };
      return failedResult(entry, fallbackDate, messages[parsed.error], url, page.crawlTime);
    }
    if (isDevelopment) {
      console.log("[TrendForce Parsed]", {
        url,
        category: entry.category,
        headers: parsed.value.headers,
        materialName: entry.name,
        matchedName: parsed.value.matchedName,
        price: parsed.value.price,
        unit: entry.unit,
        updateDate: parsed.value.updateDate,
      });
    }
    return {
      success: true,
      category: entry.category,
      material: entry.name,
      materialName: entry.name,
      price: parsed.value.price,
      currency: entry.unit?.startsWith("USD") ? "USD" : "RMB",
      unit: entry.unit || "USD",
      source: entry.source || "TrendForce",
      sourceUrl: url,
      updateDate: parsed.value.updateDate,
      crawlTime: page.crawlTime,
      mode: "real",
    };
  } catch (error) {
    const result = failedResult(entry, fallbackDate, error instanceof Error ? error.message : "页面请求失败", url);
    if (isDevelopment) console.warn("[TrendForce] fetch failed", { material: entry.name, error: result.error });
    return result;
  }
}

/** Uses one in-memory request per URL for a single multi-item TrendForce update. */
export async function fetchTrendForcePriceBatch(entries: TrackingEntry[], updateDate: string) {
  const cache: TrendForceRequestCache = new Map();
  const entriesByUrl = new Map<string, TrackingEntry[]>();
  entries.forEach((entry) => {
    const url = entry.url || dramSpotUrl;
    const group = entriesByUrl.get(url) || [];
    group.push(entry);
    entriesByUrl.set(url, group);
  });
  if (isDevelopment) {
    console.log("[TrendForce Batch]", {
      entryCount: entries.length,
      urlGroupCount: entriesByUrl.size,
      urls: Array.from(entriesByUrl, ([url, group]) => ({ url, entryCount: group.length })),
    });
  }
  const results = await Promise.all(entries.map((entry) => entry.mode === "real"
    ? fetchTrendForceRealPrice(entry, updateDate, cache)
    : fetchTrendForceMockPrice(entry, updateDate)));
  if (isDevelopment) {
    console.log("[TrendForce Batch] completed", {
      logicalRequestCount: cache.size,
      totalAttemptCount: Array.from(cache.values()).reduce((total, task) => total + task.attemptCount, 0),
      groups: Array.from(entriesByUrl, ([url, group]) => {
        const groupResults = group.map((entry) => results[entries.indexOf(entry)]);
        const task = cache.get(url);
        return {
          url,
          logicalRequestCount: group.some((entry) => entry.mode === "real") ? task?.logicalRequestCount || 1 : 0,
          attemptCount: task?.attemptCount || 0,
          successCount: groupResults.filter((result) => result.success).length,
          failureCount: groupResults.filter((result) => !result.success).length,
        };
      }),
    });
  }
  return results;
}

export async function fetchTrendForceMockPrice(entry: TrackingEntry, updateDate: string): Promise<PriceResult> {
  const supported = entry.category === "DDR内存";
  return {
    success: supported,
    category: entry.category,
    material: entry.name,
    materialName: entry.name,
    price: supported ? mockPrices[entry.name] ?? 48.5 : null,
    currency: entry.unit?.startsWith("RMB") ? "RMB" : "USD",
    unit: entry.unit || "USD",
    source: entry.source || "TrendForce",
    sourceUrl: entry.url || dramSpotUrl,
    updateDate,
    crawlTime: new Date().toISOString(),
    mode: "mock",
  };
}

export async function fetchTrendForcePrice(entry: TrackingEntry, updateDate: string): Promise<PriceResult> {
  return entry.mode === "real"
    ? fetchTrendForceRealPrice(entry, updateDate)
    : fetchTrendForceMockPrice(entry, updateDate);
}
