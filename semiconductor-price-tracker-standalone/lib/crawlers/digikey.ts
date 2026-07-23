import type { PriceResult, TrackingEntry } from "./index";
import { parseJsonTargetResponse, targetResponseError } from "./response";

const isDevelopment = process.env.NODE_ENV === "development";
const requestTimeoutMs = 15_000;
const apiBaseUrl = "https://api.digikey.com";
const tokenEndpoint = `${apiBaseUrl}/v1/oauth2/token`;
const missingCredentialsMessage = "未配置 DigiKey API 凭证，请在 .env.local 中设置 DIGIKEY_CLIENT_ID 和 DIGIKEY_CLIENT_SECRET，并重启开发服务器";

type TokenCache = {
  accessToken: string;
  expiresAt: number;
};

type QuantityOnePrice = {
  price: number;
  currency: string;
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

function responseMpns(value: unknown) {
  const matches = new Set<string>();
  walk(value, (record) => {
    for (const [key, candidate] of Object.entries(record)) {
      const normalizedKey = key.replace(/[^a-z]/gi, "").toLowerCase();
      if (["mpn", "manufacturerproductnumber", "manufacturerpartnumber"].includes(normalizedKey) && typeof candidate === "string") {
        matches.add(normalizeMpn(candidate));
      }
    }
  });
  return matches;
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

function quantityOnePrice(value: unknown): QuantityOnePrice | null {
  let result: QuantityOnePrice | null = null;
  const fallbackCurrency = responseCurrency(value);
  walk(value, (record) => {
    if (result) return;
    const quantity = Number(record.BreakQuantity ?? record.breakQuantity ?? record.Quantity ?? record.quantity);
    const priceValue = record.UnitPrice ?? record.unitPrice ?? record.Price ?? record.price;
    const currency = String(record.Currency ?? record.currency ?? record.CurrencyCode ?? record.currencyCode ?? fallbackCurrency).trim().toUpperCase();
    const price = strictPrice(priceValue);
    if (quantity === 1 && price !== null && currency) result = { price, currency };
  });
  return result;
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
  if (blockedByCloudflare) throw new Error("DigiKey API token request was blocked by Cloudflare challenge");
  if (!response.ok) throw new Error(targetResponseError("DigiKey token", response, text, "DigiKey token request failed"));

  const payload = parseJsonTargetResponse<{ access_token?: unknown; expires_in?: unknown }>("DigiKey token", response, text);
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  const expiresIn = Number(payload.expires_in);
  if (!accessToken) throw new Error("DigiKey token response did not include access_token");
  tokenCache = {
    accessToken,
    expiresAt: Date.now() + Math.max(Number.isFinite(expiresIn) ? expiresIn - 60 : 540, 60) * 1000,
  };
  return accessToken;
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
    const url = `${apiBaseUrl}/products/v4/search/${encodeURIComponent(entry.mpn)}/productdetails`;
    const response = await fetchWithTimeout(url, {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "X-DIGIKEY-Client-Id": clientId,
        "X-DIGIKEY-Locale-Site": "US",
        "X-DIGIKEY-Locale-Language": "en",
        "X-DIGIKEY-Locale-Currency": "USD",
      },
    });
    const { text, blockedByCloudflare } = await readResponse(response);
    if (isDevelopment) console.log("[DigiKey] productStatus=" + response.status);
    if (blockedByCloudflare) return failure(entry, fallbackDate, "DigiKey API request blocked by Cloudflare challenge");
    if (!response.ok) return failure(entry, fallbackDate, targetResponseError("DigiKey product", response, text, "DigiKey API request failed"));

    const payload = parseJsonTargetResponse<unknown>("DigiKey product", response, text);
    const mpns = responseMpns(payload);
    if (!mpns.has(normalizeMpn(entry.mpn))) return failure(entry, fallbackDate, "Configured MPN does not match DigiKey API response");

    const quantityOne = quantityOnePrice(payload);
    if (isDevelopment) console.log("[DigiKey] productPriceCheck", { mpn: entry.mpn, currency: quantityOne?.currency || "", quantityOneFound: Boolean(quantityOne) });
    if (!quantityOne) return failure(entry, fallbackDate, "Quantity 1 USD price was not found");
    if (quantityOne.currency !== "USD") return failure(entry, fallbackDate, `Unexpected DigiKey currency: ${quantityOne.currency}`);

    const result: PriceResult = {
      success: true,
      category: entry.category,
      material: entry.name,
      materialName: entry.name,
      manufacturer: entry.manufacturer,
      mpn: entry.mpn,
      quantity: 1,
      price: quantityOne.price,
      currency: "USD",
      unit: entry.unit || "USD/pcs",
      source: entry.source || "DigiKey",
      sourceUrl: entry.url,
      updateDate: todayKey(),
      crawlTime,
      mode: "real",
    };
    if (isDevelopment) console.log("[DigiKey] parsed", { mpn: result.mpn, price: result.price, unit: result.unit, updateDate: result.updateDate });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "DigiKey API request failed";
    if (isDevelopment) console.log("[DigiKey] failed", { mpn: entry.mpn, error: message });
    return failure(entry, fallbackDate, message);
  }
}
