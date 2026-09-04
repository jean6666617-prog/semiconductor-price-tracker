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
  quantity: number;
  priceBreaks: Array<{ quantity: number; price: number; currency: "CNY" | "USD" }>;
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

  const tiers = webData.productPriceList
    ?.filter((item) => Number.isFinite(Number(item.ladder)) && Number(item.ladder) > 0)
    .sort((left, right) => Number(left.ladder) - Number(right.ladder)) || [];
  const quantityOne = tiers[0];
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
  if (Number.isFinite(cnyPrice)) return { price: cnyPrice, currency: "CNY", quantity: Number(quantityOne?.ladder) || 1, priceBreaks: tiers.map((tier) => ({ quantity: Number(tier.ladder), price: tierPrice(tier, "CNY"), currency: "CNY" as const })).filter((item) => Number.isFinite(item.price)) };

  const isUsdPrice = webData.currencyType === "USD"
    || webData.currencySymbol === "$"
    || quantityOne?.currencyCode === "USD"
    || quantityOne?.currencySymbol === "$";
  const usdPrice = parsePriceValue(quantityOne?.usdPrice ?? (isUsdPrice ? quantityOne?.productPrice ?? quantityOne?.currencyPrice ?? quantityOne?.price : undefined));
  if (Number.isFinite(usdPrice)) return { price: usdPrice, currency: "USD", quantity: Number(quantityOne?.ladder) || 1, priceBreaks: tiers.map((tier) => ({ quantity: Number(tier.ladder), price: parsePriceValue(tier.usdPrice ?? tier.productPrice ?? tier.currencyPrice ?? tier.price), currency: "USD" as const })).filter((item) => Number.isFinite(item.price)) };

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

  const tiers = Array.from(visibleText.matchAll(/\b([0-9][0-9,]*)\+\s*(?:\|\s*)?(?:USD|US\$|\$|RMB|CNY|¥|￥)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/gi))
    .map((match) => ({ quantity: Number(match[1].replace(/,/g, "")), price: Number(match[2].replace(/,/g, "")), context: match[0] }))
    .filter((item) => Number.isFinite(item.quantity) && item.quantity > 0 && Number.isFinite(item.price))
    .sort((left, right) => left.quantity - right.quantity);
  const onePiece = tiers[0];
  if (!onePiece) throw new Error("LCSC public price tier not found in rendered page");
  const price = onePiece.price;
  if (!Number.isFinite(price)) throw new Error("LCSC quantity 1 price is invalid");
  const context = onePiece.context;
  const currency: "CNY" | "USD" = /RMB|CNY|¥|￥/.test(context) ? "CNY" : "USD";
  return { price, currency, quantity: onePiece.quantity, priceBreaks: tiers.map((item) => ({ quantity: item.quantity, price: item.price, currency: /RMB|CNY|¥|￥/.test(item.context) ? "CNY" as const : "USD" as const })) };
}

function parsePriceValue(value: unknown) {
  if (typeof value === "number") return value;
  const normalized = String(value ?? "").replace(/[,¥￥]/g, "").trim();
  const match = normalized.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : Number.NaN;
}

function tierPrice(tier: LcscPriceTier, currency: "CNY" | "USD") {
  const nested = tier.cnyProductPriceList?.find((item) => item.ladder === 1);
  return parsePriceValue(currency === "CNY"
    ? nested?.productPrice ?? nested?.currencyPrice ?? nested?.cnyPrice ?? nested?.price ?? tier.cnyPrice ?? tier.productPrice ?? tier.currencyPrice ?? tier.price
    : tier.usdPrice ?? tier.productPrice ?? tier.currencyPrice ?? tier.price);
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
      priceBreakQuantity: parsed.quantity,
      minimumOrderQuantity: parsed.quantity,
      selectedQuantity: parsed.quantity,
      priceBreaks: parsed.priceBreaks,
      priceBasis: parsed.quantity === 1 ? "single-unit" : "minimum-public-tier",
      history: [{ date: updateDate, price: parsed.price, priceBreakQuantity: parsed.quantity }],
    };
  } catch (error) {
    return failedResult(entry, error instanceof Error ? error.message : "LCSC request failed");
  }
}
