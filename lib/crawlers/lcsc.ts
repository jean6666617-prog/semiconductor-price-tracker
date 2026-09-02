import type { PriceHistoryPoint, PriceResult } from "./index";
import type { KeyComponentEntry } from "./cytech";
import { parseEmbeddedJson, targetResponseError } from "./response";

const isDevelopment = process.env.NODE_ENV === "development";
const maxFetchAttempts = 3;
const retryDelays = [800, 1600];
const lcscHeaders = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
};

type LcscPriceTier = {
  ladder?: number;
  cnyPrice?: number | string;
  cnyProductPriceList?: LcscPriceTier[] | null;
  currencyPrice?: number | string;
  currencyCode?: string;
  currencySymbol?: string;
  priceUnit?: string;
  price?: number | string;
  usdPrice?: number;
  productPrice?: number | string;
};

type LcscWebData = {
  productModel?: string;
  currencyType?: string;
  currencySymbol?: string;
  priceUnit?: string;
  productPriceList?: LcscPriceTier[];
};

type LcscParsedPrice = {
  price: number;
  currency: "CNY" | "USD";
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function todayKey() {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date()).replaceAll("/", "-");
}

function normalizeMpn(value: unknown) {
  return String(value ?? "").trim().replace(/[\s\/\-,_]/g, "").toUpperCase();
}

function matchesLCSCModel(actual: unknown, expected: string) {
  const actualValue = String(actual ?? "").trim();
  const expectedValue = String(expected ?? "").trim();
  const actualModel = normalizeMpn(actualValue);
  const expectedModel = normalizeMpn(expectedValue);
  if (!actualModel || !expectedModel) return false;
  if (actualModel === expectedModel) return true;

  // LCSC may append a packaging or inventory suffix after a comma.
  const actualBase = normalizeMpn(actualValue.split(",")[0]);
  const expectedBase = normalizeMpn(expectedValue.split(",")[0]);
  return actualBase.length >= 6 && expectedBase.length >= 6 && actualBase === expectedBase;
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
    unit: "pcs",
    source: "LCSC",
    sourceUrl: entry.sourceUrl,
    updateDate: todayKey(),
    crawlTime: new Date().toISOString(),
    mode: "real",
    error,
  };
}

async function fetchLcscHtml(entry: KeyComponentEntry) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxFetchAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(entry.sourceUrl, {
        cache: "no-store",
        signal: controller.signal,
        headers: lcscHeaders,
      });
      const html = await response.text();
      if (isDevelopment) {
        console.log(`[LCSC] ${JSON.stringify({
          mpn: entry.mpn,
          url: entry.sourceUrl,
          attempt,
          status: response.status,
          contentType: response.headers.get("content-type") || "",
          htmlLength: html.length,
        })}`);
      }
      if (response.ok) return html;

      lastError = new Error(targetResponseError("LCSC", response, html, "LCSC request failed"));
    } catch (error) {
      lastError = error;
      if (isDevelopment) {
        console.error(`[LCSC Fetch Attempt Failed] ${JSON.stringify({
          mpn: entry.mpn,
          url: entry.sourceUrl,
          attempt,
          errorName: error instanceof Error ? error.name : "",
          errorMessage: error instanceof Error ? error.message : String(error),
        })}`);
      }
    } finally {
      clearTimeout(timeout);
    }

    const delay = retryDelays[attempt - 1];
    if (attempt < maxFetchAttempts && delay) await sleep(delay);
  }

  throw lastError instanceof Error ? lastError : new Error("LCSC request failed");
}

function parseLcscPrice(html: string, expectedMpn: string): LcscParsedPrice {
  const nextData = html.match(/<script id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!nextData) return parseVisibleLcscPrice(html, expectedMpn);

  const data = parseEmbeddedJson<{
    props?: { pageProps?: { webData?: LcscWebData } };
  }>("LCSC NEXT_DATA", nextData[1]);
  const webData = data.props?.pageProps?.webData;
  if (!webData) throw new Error("LCSC webData not found");
  if (!matchesLCSCModel(webData.productModel, expectedMpn)) {
    throw new Error(`LCSC MPN mismatch: expected ${expectedMpn}, got ${webData.productModel || "unknown"}`);
  }

  const quantityOne = webData.productPriceList
    ?.filter((item) => Number.isFinite(Number(item.ladder)) && Number(item.ladder) > 0)
    .sort((left, right) => Number(left.ladder) - Number(right.ladder))[0];
  const cnyQuantityOne = quantityOne?.cnyProductPriceList?.find((item) => item.ladder === 1);
  const isCnyPrice = webData.currencyType === "CNY"
    || webData.currencySymbol === "￥"
    || webData.currencySymbol === "¥"
    || webData.priceUnit === "￥"
    || webData.priceUnit === "¥"
    || quantityOne?.currencyCode === "CNY"
    || quantityOne?.currencySymbol === "￥"
    || quantityOne?.currencySymbol === "¥"
    || quantityOne?.priceUnit === "￥"
    || quantityOne?.priceUnit === "¥";
  const cnyPrice = cnyQuantityOne
    ? parsePriceValue(cnyQuantityOne.productPrice ?? cnyQuantityOne.currencyPrice ?? cnyQuantityOne.cnyPrice ?? cnyQuantityOne.price)
    : isCnyPrice
      ? parsePriceValue(quantityOne?.productPrice ?? quantityOne?.currencyPrice ?? quantityOne?.cnyPrice ?? quantityOne?.price)
      : parsePriceValue(quantityOne?.cnyPrice);
  if (Number.isFinite(cnyPrice)) return { price: cnyPrice, currency: "CNY" };

  const isUsdPrice = webData.currencyType === "USD"
    || webData.currencySymbol === "$"
    || quantityOne?.currencyCode === "USD"
    || quantityOne?.currencySymbol === "$";
  const usdPrice = parsePriceValue(quantityOne?.usdPrice ?? (isUsdPrice ? quantityOne?.productPrice ?? quantityOne?.currencyPrice ?? quantityOne?.price : undefined));
  if (Number.isFinite(usdPrice)) return { price: usdPrice, currency: "USD" };

  throw new Error(`LCSC quantity 1 price not found${webData.currencyType ? `; page returned ${webData.currencyType}` : ""}`);
}

function parseVisibleLcscPrice(html: string, expectedMpn: string): LcscParsedPrice {
  const visibleText = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  if (!matchesLCSCModel(visibleText.match(/(?:MPN|Part\s*#|Mfr\.?#)\s*:?\s*([A-Z0-9_./,-]+)/i)?.[1], expectedMpn)
    && !normalizeMpn(visibleText).includes(normalizeMpn(expectedMpn))) {
    throw new Error(`LCSC MPN not found: expected ${expectedMpn}`);
  }

  // New LCSC pages render the price ladder as plain table text instead of
  // exposing the former __NEXT_DATA__. Read the first (1+) unit-price tier.
  const onePiece = visibleText.match(/(?:Qty\s+)?(?:Unit\s+Price|Price)[\s\S]{0,180}?\b1\+\s*(?:\|\s*)?(?:USD|US\$|\$|RMB|CNY|¥|￥)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i)
    || visibleText.match(/\b1\+\s*(?:\|\s*)?(?:USD|US\$|\$|RMB|CNY|¥|￥)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (!onePiece) throw new Error("LCSC quantity 1 price not found in rendered page");
  const raw = onePiece[1];
  const price = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(price)) throw new Error("LCSC quantity 1 price is invalid");
  const context = visibleText.slice(Math.max(0, (onePiece.index || 0) - 80), (onePiece.index || 0) + 120);
  const currency: "CNY" | "USD" = /RMB|CNY|¥|￥/.test(context) ? "CNY" : "USD";
  return { price, currency };
}

function parsePriceValue(value: unknown) {
  if (typeof value === "number") return value;
  const normalized = String(value ?? "").replace(/[,¥￥]/g, "").trim();
  const match = normalized.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : Number.NaN;
}

export async function fetchLcscPrice(entry: KeyComponentEntry): Promise<PriceResult & { id: string; history?: PriceHistoryPoint[] }> {
  if (!entry.enabled || entry.crawler !== "lcsc") {
    return failedResult(entry, "Key component crawler is disabled");
  }

  try {
    const html = await fetchLcscHtml(entry);
    const parsed = parseLcscPrice(html, entry.mpn);
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
      unit: "pcs",
      source: "LCSC",
      sourceUrl: entry.sourceUrl,
      updateDate,
      crawlTime: new Date().toISOString(),
      mode: "real",
      history: [{ date: updateDate, price: parsed.price }],
    };
  } catch (error) {
    return failedResult(entry, error instanceof Error ? error.message : "LCSC request failed");
  }
}
