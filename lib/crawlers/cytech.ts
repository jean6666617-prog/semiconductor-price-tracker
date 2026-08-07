import type { PriceHistoryPoint, PriceResult } from "./index";
import { targetResponseError } from "./response";

export type KeyComponentEntry = {
  id: string;
  mpn: string;
  name: string;
  category: "NXP" | "Memory" | string;
  description: string;
  manufacturer?: string;
  source: string;
  sourceUrl: string;
  searchKeyword?: string;
  crawler: string;
  enabled: boolean;
  status: "已追踪" | "待验证" | "待接入" | "市场趋势追踪" | string;
};

const isDevelopment = process.env.NODE_ENV === "development";
const maxFetchAttempts = 3;
const retryDelays = [800, 1600];
const cytechDomainDelayMs = 350;
const cytechTimeoutMs = 15000;
const cytechDomainQueues = new Map<string, Promise<void>>();
const cytechHeaders = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Upgrade-Insecure-Requests": "1",
};

function cytechCandidateUrls(sourceUrl: string) {
  const original = new URL(sourceUrl);
  const candidates = new Set<string>();
  const path = original.pathname;
  const cnOrigin = original.protocol + "//www.cytechsystems.com.cn";
  const globalOrigin = original.protocol + "//www.cytechsystems.com";

  candidates.add(cnOrigin + path);
  if (path.endsWith("/tja1042t-3-118")) candidates.add(cnOrigin + "/product/tja1042t3%2C118");
  if (path.endsWith("/tja1055t-c-518")) candidates.add(cnOrigin + "/product/tja1055tc%2C518");
  candidates.add(globalOrigin + path);

  return [...candidates];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCytechDomain(url: string) {
  const hostname = new URL(url).hostname;
  const previous = cytechDomainQueues.get(hostname) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = previous.then(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  cytechDomainQueues.set(hostname, current);
  await previous;

  return () => {
    setTimeout(() => {
      release();
      if (cytechDomainQueues.get(hostname) === current) cytechDomainQueues.delete(hostname);
    }, cytechDomainDelayMs);
  };
}

function todayKey() {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date()).replaceAll("/", "-");
}

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#36;/g, "$")
    .replace(/&yen;/gi, "¥")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePriceText(value: string) {
  const normalized = decodeEntities(value);
  const currency = /\bUSD\b|US\$|\$/.test(normalized) ? "USD" : /CNY|RMB|¥/.test(normalized) ? "RMB" : "USD";
  const unit = currency === "USD" ? "USD/pcs" : "RMB/pcs";
  const match = normalized.match(/(?:USD|US\$|\$|RMB|CNY|¥)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (!match) return null;
  const price = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(price) ? { price, currency, unit } : null;
}

function parseCytechPrice(html: string) {
  const priceBlock = html.match(/<div\s+class=["'][^"']*product-price[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
  const priceHtml = priceBlock?.[1] || html;
  const title = decodeEntities(priceHtml.match(/<div\s+class=["'][^"']*product-price-title[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "");
  const currency = /\bUSD\b|\$/.test(title) ? "USD" : /RMB|CNY|¥/.test(title) ? "RMB" : "USD";
  const unit = currency === "USD" ? "USD/pcs" : "RMB/pcs";
  const tiers = Array.from(priceHtml.matchAll(
    /<div\s+class=["']product-price-item["'][^>]*>[\s\S]*?<div\s+class=["']product-price-qnty["'][^>]*>([\s\S]*?)<\/div>[\s\S]*?<div\s+class=["']product-price-num["'][^>]*>([\s\S]*?)<\/div>[\s\S]*?<\/div>/gi,
  ));
  const quantityOneTier = tiers.find((tier) => decodeEntities(tier[1]).replace(/\s+/g, "") === "1+");
  if (quantityOneTier) {
    const parsed = parsePriceText(quantityOneTier[2]);
    if (parsed) return { price: parsed.price, currency, unit };
  }

  const visibleText = decodeEntities(html);
  const referenceBlock = visibleText.match(/Reference\s+Price\s*(?:\((USD|RMB|CNY|SGD|EUR)\))?([\s\S]*?)(?:Considering\s+price\s+fluctuations|Product\s+Specifications|产品属性|$)/i);
  if (!referenceBlock) return null;
  const referenceCurrency = referenceBlock[1] || currency;
  const onePiecePrice = referenceBlock[2].match(/(?:^|\s)1\+\s*(?:USD|US\$|\$|RMB|CNY|¥)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (!onePiecePrice) return null;
  const parsed = parsePriceText(referenceCurrency + " " + onePiecePrice[1]);
  return parsed ? { price: parsed.price, currency: parsed.currency, unit: parsed.unit } : null;
}
function errorCauseCode(error: unknown) {
  if (!error || typeof error !== "object") return "";
  const cause = "cause" in error ? (error as { cause?: unknown }).cause : undefined;
  if (!cause || typeof cause !== "object") return "";
  const code = "code" in cause ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : "";
}

function isCloudflareChallenge(html: string) {
  return /cloudflare|cf-chl|just a moment|enable javascript and cookies|attention required/i.test(html);
}

function isRetryableStatus(status: number) {
  return status === 403 || status === 408 || status === 429 || [500, 502, 503, 504].includes(status);
}

function cytechResponseError(response: Response, html: string, message: string) {
  const contentType = response.headers.get("content-type") || "";
  const blockedByCloudflare = isCloudflareChallenge(html);
  if (blockedByCloudflare) {
    return new Error(
      "Cytech 被 Cloudflare 验证拦截，页面未返回公开价格；HTTP status " + response.status + "；URL " + (response.url || "unknown"),
    );
  }
  return new Error(targetResponseError("Cytech", response, html, message + "; content-type " + contentType));
}

function logCytechAttempt(event: string, details: Record<string, unknown>) {
  if (isDevelopment) {
    console.log(`[Cytech] ${event} ${JSON.stringify(details)}`);
  }
}

function logCytechAttemptError(event: string, details: Record<string, unknown>) {
  if (isDevelopment) {
    console.error(`[Cytech] ${event} ${JSON.stringify(details)}`);
  }
}

function failedResult(entry: KeyComponentEntry, error: string): PriceResult & { id: string } {
  return {
    id: entry.id,
    success: false,
    category: entry.category,
    material: entry.mpn,
    materialName: entry.name,
    mpn: entry.mpn,
    price: null,
    currency: "USD",
    unit: "USD/pcs",
    source: entry.source,
    sourceUrl: entry.sourceUrl,
    updateDate: todayKey(),
    crawlTime: new Date().toISOString(),
    mode: "real",
    error,
  };
}

async function fetchCytechHtml(entry: KeyComponentEntry) {
  let lastError: unknown;
  const urls = cytechCandidateUrls(entry.sourceUrl);
  for (const candidateUrl of urls) {
  for (let attempt = 1; attempt <= maxFetchAttempts; attempt += 1) {
    const releaseDomain = await waitForCytechDomain(candidateUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cytechTimeoutMs);
    try {
      const response = await fetch(candidateUrl, {
        cache: "no-store",
        signal: controller.signal,
        headers: cytechHeaders,
      });
      const html = await response.text();
      const contentType = response.headers.get("content-type") || "";
      const blockedByCloudflare = isCloudflareChallenge(html);
      logCytechAttempt("response", {
        mpn: entry.mpn,
        url: candidateUrl,
        finalUrl: response.url || entry.sourceUrl,
        attempt,
        maxAttempts: maxFetchAttempts,
        status: response.status,
        contentType,
        htmlLength: html.length,
        blockedByCloudflare,
      });

      if (response.ok && !blockedByCloudflare) return { response, html, attempt, sourceUrl: candidateUrl };

      lastError = cytechResponseError(response, html, "Cytech request failed");
      if (!isRetryableStatus(response.status)) break;
    } catch (error) {
      lastError = error;
      logCytechAttemptError("attempt failed", {
        mpn: entry.mpn,
        url: candidateUrl,
        attempt,
        maxAttempts: maxFetchAttempts,
        timeoutMs: cytechTimeoutMs,
        errorName: error instanceof Error ? error.name : "",
        errorMessage: error instanceof Error ? error.message : String(error),
        causeCode: errorCauseCode(error),
      });
    } finally {
      clearTimeout(timeout);
      releaseDomain();
    }

    const delay = retryDelays[attempt - 1];
    if (attempt < maxFetchAttempts && delay) {
      logCytechAttempt("retry scheduled", {
        mpn: entry.mpn,
        url: candidateUrl,
        attempt,
        nextAttempt: attempt + 1,
        retryInMs: delay,
      });
      await sleep(delay);
    }
  }
  }

  throw lastError instanceof Error ? lastError : new Error("Cytech request failed");
}

export async function fetchCytechPrice(entry: KeyComponentEntry): Promise<PriceResult & { id: string; history?: PriceHistoryPoint[] }> {
  if (!entry.enabled || entry.crawler !== "cytech") {
    return failedResult(entry, "Key component crawler is disabled");
  }

  let responseStatus: number | "network-error" = "network-error";
  try {
    const { response, html, sourceUrl } = await fetchCytechHtml(entry);
    responseStatus = response.status;
    const parsed = parseCytechPrice(html);
    if (!parsed) throw new Error("Cytech price not found");
    const updateDate = todayKey();
    return {
      id: entry.id,
      success: true,
      category: entry.category,
      material: entry.mpn,
      materialName: entry.name,
      mpn: entry.mpn,
      price: parsed.price,
      currency: parsed.currency,
      unit: parsed.unit,
      source: entry.source,
      sourceUrl,
      updateDate,
      crawlTime: new Date().toISOString(),
      mode: "real",
      history: [{ date: updateDate, price: parsed.price }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Cytech request failed";
    if (isDevelopment) {
      console.error(`[Cytech Server Error] ${JSON.stringify({
        mpn: entry.mpn,
        url: entry.sourceUrl,
        status: responseStatus,
        errorName: error instanceof Error ? error.name : "",
        errorMessage,
      })}`);
    }
    return failedResult(entry, errorMessage);
  }
}
