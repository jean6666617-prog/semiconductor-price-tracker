import type { PriceHistoryPoint, PriceResult } from "./index";

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
const cytechDomainQueues = new Map<string, Promise<void>>();
const cytechHeaders = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
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
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(entry.sourceUrl, {
        cache: "no-store",
        signal: controller.signal,
        headers: cytechHeaders,
      });
      const html = await response.text();
      if (isDevelopment) {
        console.log(`[Cytech] ${JSON.stringify({
          mpn: entry.mpn,
          url: entry.sourceUrl,
          attempt,
          status: response.status,
          contentType: response.headers.get("content-type") || "",
          htmlLength: html.length,
        })}`);
      }
      if (response.ok) return { response, html, attempt };

      lastError = new Error(`Cytech request failed: ${response.status}`);
    } catch (error) {
      lastError = error;
      if (isDevelopment) {
        console.error(`[Cytech Fetch Attempt Failed] ${JSON.stringify({
          mpn: entry.mpn,
          url: entry.sourceUrl,
          attempt,
          errorName: error instanceof Error ? error.name : "",
          errorMessage: error instanceof Error ? error.message : String(error),
        })}`);
      }
    } finally {
      clearTimeout(timeout);
      releaseDomain();
    }

    const delay = retryDelays[attempt - 1];
    if (attempt < maxFetchAttempts && delay) {
      if (isDevelopment) {
        console.log(`[Cytech Retry] ${JSON.stringify({
          mpn: entry.mpn,
          url: entry.sourceUrl,
          attempt,
          nextAttempt: attempt + 1,
          retryInMs: delay,
        })}`);
      }
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
