import type { PriceResult, TrackingEntry } from "./index";
import { parseJsonTargetResponse, targetResponseError } from "./response";

const isDevelopment = process.env.NODE_ENV === "development";
const requestTimeoutMs = 15_000;
const apiBaseUrl = process.env.DIGIKEY_API_ENV === "production"
  ? "https://api.digikey.com"
  : "https://sandbox-api.digikey.com";
const tokenEndpoint = `${apiBaseUrl}/v1/oauth2/token`;
export const missingCredentialsMessage = "未配置 DigiKey API 凭证，请在 .env.local 中设置 DIGIKEY_CLIENT_ID 和 DIGIKEY_CLIENT_SECRET，并重启开发服务器";

export function hasDigiKeyCredentials() {
  return Boolean(process.env.DIGIKEY_CLIENT_ID?.trim() && process.env.DIGIKEY_CLIENT_SECRET?.trim());
}

type TokenCache = {
  accessToken: string;
  expiresAt: number;
};

type QuantityOnePrice = {
  price: number;
  currency: string;
};

type DigiKeyProductMatch = {
  productNumber: string;
  mpn: string;
  productName: string;
  manufacturer: string;
  productUrl: string;
};

let tokenCache: TokenCache | null = null;

function todayKey() {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date()).replaceAll("/", "-");
}

function normalizeMpn(value: unknown) {
  return String(value ?? "").replace(/\s+/g, "").trim().toUpperCase();
}

function strictPrice(value: unknown) {
  const text = String(value ?? "").replace(/,/g, "").trim();
  const match = text.match(/^(?:US\$|USD\s*|\$)?\s*([0-9]+(?:\.[0-9]+)?)$/i);
  if (!match) return null;
  const price = Number(match[1]);
  return Number.isFinite(price) ? price : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function walk(value: unknown, visit: (record: Record<string, unknown>) => void) {
  if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
  else if (isRecord(value)) {
    visit(value);
    Object.values(value).forEach((item) => walk(item, visit));
  }
}

function responseCurrency(value: unknown) {
  let currency = "";
  walk(value, (record) => {
    if (currency) return;
    for (const [key, candidate] of Object.entries(record)) {
      const normalizedKey = key.replace(/[^a-z]/gi, "").toLowerCase();
      if (["currency", "currencycode", "localecurrency"].includes(normalizedKey) && typeof candidate === "string") {
        currency = candidate.trim().toUpperCase();
        return;
      }
    }
  });
  return currency;
}

function nestedText(value: unknown, fieldNames: string[]) {
  if (!isRecord(value)) return "";
  const expected = new Set(fieldNames.map((field) => field.replace(/[^a-z]/gi, "").toLowerCase()));
  for (const [key, candidate] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z]/gi, "").toLowerCase();
    if (expected.has(normalizedKey) && (typeof candidate === "string" || typeof candidate === "number")) return String(candidate).trim();
  }
  return "";
}

function productNumberFromVariation(value: unknown) {
  if (!isRecord(value)) return "";
  const direct = nestedText(value, ["DigiKeyProductNumber", "ProductNumber"]);
  if (direct) return direct;
  if (Array.isArray(value.ProductVariations)) {
    for (const variation of value.ProductVariations) {
      const productNumber = nestedText(variation, ["DigiKeyProductNumber", "ProductNumber"]);
      if (productNumber) return productNumber;
    }
  }
  return "";
}

function findKeywordProduct(payload: unknown, requestedMpn: string): DigiKeyProductMatch | null {
  if (!isRecord(payload) || !Array.isArray(payload.Products)) return null;
  const normalizedRequestedMpn = normalizeMpn(requestedMpn);
  for (const product of payload.Products) {
    if (!isRecord(product)) continue;
    const mpn = nestedText(product, ["ManufacturerProductNumber"]);
    if (normalizeMpn(mpn) !== normalizedRequestedMpn) continue;
    const productNumber = productNumberFromVariation(product);
    if (!productNumber) continue;
    const manufacturer = nestedText(product.Manufacturer, ["Name", "ManufacturerName"]) || nestedText(product, ["ManufacturerName"]);
    const productName = nestedText(product.Description, ["ProductDescription", "Description", "Value"]) || nestedText(product, ["ProductName", "ProductDescription"]);
    return { productNumber, mpn, productName, manufacturer, productUrl: nestedText(product, ["ProductUrl"]) };
  }
  return null;
}

function productDetails(payload: unknown) {
  if (!isRecord(payload)) return { productName: "", manufacturer: "", availability: "", mpn: "", productUrl: "" };
  const product = isRecord(payload.Product) ? payload.Product : payload;
  return {
    productName: nestedText(product.Description, ["ProductDescription", "Description", "Value"]) || nestedText(product, ["ProductName", "ProductDescription"]),
    manufacturer: nestedText(product.Manufacturer, ["Name", "ManufacturerName"]) || nestedText(product, ["ManufacturerName"]),
    availability: nestedText(product, ["QuantityAvailable", "Availability", "Stock"]),
    mpn: nestedText(product, ["ManufacturerProductNumber"]),
    productUrl: nestedText(product, ["ProductUrl"]),
  };
}

function productPricingPrice(payload: unknown): QuantityOnePrice | null {
  if (!isRecord(payload) || !Array.isArray(payload.ProductPricings)) return null;
  const fallbackCurrency = responseCurrency(payload) || "USD";
  for (const product of payload.ProductPricings) {
    if (!isRecord(product) || !Array.isArray(product.ProductVariations)) continue;
    for (const variation of product.ProductVariations) {
      if (!isRecord(variation) || !Array.isArray(variation.StandardPricing)) continue;
      for (const priceBreak of variation.StandardPricing) {
        if (!isRecord(priceBreak)) continue;
        const quantity = Number(priceBreak.BreakQuantity);
        const price = strictPrice(priceBreak.UnitPrice);
        if (quantity === 1 && price !== null) return { price, currency: fallbackCurrency };
      }
    }
  }
  return null;
}

function isCloudflareChallenge(text: string) {
  return /cloudflare|challenge|just a moment|cf-chl|enable javascript and cookies/i.test(text);
}

async function readResponse(response: Response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || "";
  const blockedByCloudflare = isCloudflareChallenge(`${title}\n${text.slice(0, 2000)}`);
  if (isDevelopment) {
    console.log("[DigiKey]", {
      status: response.status,
      finalUrl: response.url,
      contentType,
      title,
      blockedByCloudflare,
    });
  }
  return { contentType, text, title, blockedByCloudflare };
}

async function fetchWithTimeout(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function getAccessToken() {
  const clientId = process.env.DIGIKEY_CLIENT_ID?.trim();
  const clientSecret = process.env.DIGIKEY_CLIENT_SECRET?.trim();
  if (isDevelopment) console.log("[DigiKey] credentialsConfigured=" + Boolean(clientId && clientSecret));
  if (!clientId || !clientSecret) throw new Error(missingCredentialsMessage);
  if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000) return tokenCache.accessToken;

  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
  });
  const response = await fetchWithTimeout(tokenEndpoint, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const { text, blockedByCloudflare } = await readResponse(response);
  if (isDevelopment) console.log("[DigiKey] tokenStatus=" + response.status);
  const payload = parseJsonTargetResponse<{ access_token?: unknown; expires_in?: unknown }>("DigiKey token", response, text);
  if (blockedByCloudflare) throw new Error("DigiKey API token request was blocked by Cloudflare challenge");
  if (!response.ok) throw new Error(targetResponseError("DigiKey token", response, text, "DigiKey token request failed"));
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  const expiresIn = Number(payload.expires_in);
  if (!accessToken) throw new Error("DigiKey token response did not include access_token");
  tokenCache = {
    accessToken,
    expiresAt: Date.now() + Math.max(Number.isFinite(expiresIn) ? expiresIn - 60 : 540, 60) * 1000,
  };
  return accessToken;
}


function apiHeaders(token: string, clientId: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "X-DIGIKEY-Client-Id": clientId,
    "X-DIGIKEY-Locale-Site": "US",
    "X-DIGIKEY-Locale-Language": "en",
    "X-DIGIKEY-Locale-Currency": "USD",
  };
}

async function keywordSearch(mpn: string, token: string, clientId: string) {
  const response = await fetchWithTimeout(`${apiBaseUrl}/products/v4/search/keyword`, {
    method: "POST",
    cache: "no-store",
    headers: { ...apiHeaders(token, clientId), "Content-Type": "application/json" },
    body: JSON.stringify({ Keywords: mpn, Limit: 10, Offset: 0 }),
  });
  const { text, blockedByCloudflare } = await readResponse(response);
  if (isDevelopment) console.log("[DigiKey] keywordSearchStatus=" + response.status);
  if (blockedByCloudflare) throw new Error("DigiKey KeywordSearch returned an HTML challenge page; no price was used");
  if (response.status === 401 || response.status === 403) throw new Error(`DigiKey KeywordSearch 权限不足（HTTP ${response.status}）：请确认应用已订阅 Product Information V4`);
  if (!response.ok) throw new Error(targetResponseError("DigiKey KeywordSearch", response, text, "DigiKey KeywordSearch request failed"));
  return parseJsonTargetResponse<unknown>("DigiKey KeywordSearch", response, text);
}

async function productDetailsRequest(productNumber: string, token: string, clientId: string) {
  const response = await fetchWithTimeout(`${apiBaseUrl}/products/v4/search/${encodeURIComponent(productNumber)}/productdetails`, {
    method: "GET",
    cache: "no-store",
    headers: apiHeaders(token, clientId),
  });
  const { text, blockedByCloudflare } = await readResponse(response);
  if (isDevelopment) console.log("[DigiKey] productDetailsStatus=" + response.status);
  if (blockedByCloudflare) throw new Error("DigiKey ProductDetails returned an HTML challenge page; no price was used");
  if (response.status === 401 || response.status === 403) throw new Error(`DigiKey ProductDetails 权限不足（HTTP ${response.status}）：请确认应用已订阅 Product Information V4`);
  if (!response.ok) throw new Error(targetResponseError("DigiKey ProductDetails", response, text, "DigiKey ProductDetails request failed"));
  return parseJsonTargetResponse<unknown>("DigiKey ProductDetails", response, text);
}

async function productPricingRequest(productNumber: string, token: string, clientId: string) {
  const response = await fetchWithTimeout(`${apiBaseUrl}/products/v4/search/${encodeURIComponent(productNumber)}/pricing?limit=10&offset=0`, {
    method: "GET",
    cache: "no-store",
    headers: apiHeaders(token, clientId),
  });
  const { text, blockedByCloudflare } = await readResponse(response);
  if (isDevelopment) console.log("[DigiKey] productPricingStatus=" + response.status);
  if (blockedByCloudflare) throw new Error("DigiKey ProductPricing returned an HTML challenge page; no price was used");
  if (response.status === 401 || response.status === 403) throw new Error(`DigiKey ProductPricing 权限不足（HTTP ${response.status}）：请确认应用已订阅 Product Information V4，并具备 ProductPricing 权限`);
  if (!response.ok) throw new Error(targetResponseError("DigiKey ProductPricing", response, text, "DigiKey ProductPricing request failed"));
  return parseJsonTargetResponse<unknown>("DigiKey ProductPricing", response, text);
}

function failure(entry: TrackingEntry, updateDate: string, error: string): PriceResult {
  return {
    success: false,
    category: entry.category,
    material: entry.name,
    materialName: entry.name,
    manufacturer: entry.manufacturer,
    mpn: entry.mpn,
    quantity: entry.quantity,
    price: null,
    currency: entry.currency || "USD",
    unit: entry.unit || "USD/pcs",
    source: entry.source || "DigiKey",
    sourceUrl: entry.url,
    updateDate,
    crawlTime: new Date().toISOString(),
    mode: "real",
    error,
  };
}

export async function fetchDigiKeyPrice(entry: TrackingEntry, fallbackDate = todayKey()): Promise<PriceResult> {
  if (!entry.url || !entry.mpn || entry.quantity !== 1) return failure(entry, fallbackDate, "DigiKey tracking configuration is incomplete");

  const crawlTime = new Date().toISOString();
  try {
    const token = await getAccessToken();
    const clientId = process.env.DIGIKEY_CLIENT_ID?.trim() || "";
    const searchPayload = await keywordSearch(entry.mpn, token, clientId);
    const match = findKeywordProduct(searchPayload, entry.mpn);
    if (!match) return failure(entry, fallbackDate, `DigiKey KeywordSearch 未找到与 MPN ${entry.mpn} 精确匹配的产品`);

    const detailsPayload = await productDetailsRequest(match.productNumber, token, clientId);
    const details = productDetails(detailsPayload);
    const pricingPayload = await productPricingRequest(match.productNumber, token, clientId);
    const quantityOne = productPricingPrice(pricingPayload);
    const productName = details.productName || match.productName;
    const manufacturer = details.manufacturer || match.manufacturer || entry.manufacturer || "";
    const availability = details.availability;
    if (isDevelopment) console.log("[DigiKey] productPriceCheck", { mpn: entry.mpn, productNumber: match.productNumber, currency: quantityOne?.currency || "", quantityOneFound: Boolean(quantityOne) });
    if (!quantityOne) return failure(entry, fallbackDate, `DigiKey ProductPricing 未返回 MPN ${entry.mpn} 的 StandardPricing（BreakQuantity=1）`);
    if (quantityOne.currency !== "USD") return failure(entry, fallbackDate, `Unexpected DigiKey currency: ${quantityOne.currency}`);

    const result: PriceResult = {
      success: true,
      category: entry.category,
      material: entry.name,
      materialName: entry.name,
      productName: productName || entry.name,
      manufacturer: manufacturer || undefined,
      availability: availability || undefined,
      mpn: entry.mpn,
      quantity: 1,
      price: quantityOne.price,
      currency: "USD",
      unit: entry.unit || "USD/pcs",
      source: entry.source || "DigiKey",
      sourceUrl: match.productUrl || details.productUrl || entry.url,
      updateDate: todayKey(),
      crawlTime,
      mode: "real",
    };
    if (isDevelopment) console.log("[DigiKey] parsed", { mpn: result.mpn, price: result.price, unit: result.unit, updateDate: result.updateDate });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "DigiKey API request failed";
    if (isDevelopment) console.log("[DigiKey] failed", { mpn: entry.mpn, error: message });
    const result = failure(entry, fallbackDate, message);
    if (message === missingCredentialsMessage) result.status = "configuration_required";
    return result;
  }
}
