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
  const priceBlock = html.match(/<div\s+class=["']product-price["'][^>]*>([\s\S]*?)<p>/i);
  if (!priceBlock) return null;

  const title = decodeEntities(priceBlock[1].match(/<div\s+class=["']product-price-title["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "");
  const currency = /\bUSD\b|\$/.test(title) ? "USD" : /RMB|CNY|¥/.test(title) ? "RMB" : "USD";
  const unit = currency === "USD" ? "USD/pcs" : "RMB/pcs";
  const tiers = Array.from(priceBlock[1].matchAll(
    /<div\s+class=["']product-price-item["'][^>]*>[\s\S]*?<div\s+class=["']product-price-qnty["'][^>]*>([\s\S]*?)<\/div>[\s\S]*?<div\s+class=["']product-price-num["'][^>]*>([\s\S]*?)<\/div>[\s\S]*?<\/div>/gi,
  ));
  const quantityOneTier = tiers.find((tier) => decodeEntities(tier[1]).replace(/\s+/g, "") === "1+");
  if (!quantityOneTier) return null;

  const parsed = parsePriceText(quantityOneTier[2]);
  return parsed ? { price: parsed.price, currency, unit } : null;
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
  const reason = blockedByCloudflare ? "Cytech request blocked by Cloudflare challenge" : message;
  return new Error(targetResponseError("Cytech", response, html, `${reason}; content-type ${contentType}`));
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
  for (let attempt = 1; attempt <= maxFetchAttempts; attempt += 1) {
    const releaseDomain = await waitForCytechDomain(entry.sourceUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cytechTimeoutMs);
    try {
      const response = await fetch(entry.sourceUrl, {
        cache: "no-store",
        signal: controller.signal,
        headers: cytechHeaders,
      });
      const html = await response.text();
      const contentType = response.headers.get("content-type") || "";
      const blockedByCloudflare = isCloudflareChallenge(html);
      logCytechAttempt("response", {
        mpn: entry.mpn,
        url: entry.sourceUrl,
        finalUrl: response.url || entry.sourceUrl,
        attempt,
        maxAttempts: maxFetchAttempts,
        status: response.status,
        contentType,
        htmlLength: html.length,
        blockedByCloudflare,
      });

      if (response.ok && !blockedByCloudflare) return { response, html, attempt };

      lastError = cytechResponseError(response, html, "Cytech request failed");
      if (!isRetryableStatus(response.status)) break;
    } catch (error) {
      lastError = error;
      logCytechAttemptError("attempt failed", {
        mpn: entry.mpn,
        url: entry.sourceUrl,
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
        url: entry.sourceUrl,
        attempt,
        nextAttempt: attempt + 1,
        retryInMs: delay,
      });
      await sleep(delay);
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
    const { response, html } = await fetchCytechHtml(entry);
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
      sourceUrl: entry.sourceUrl,
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
