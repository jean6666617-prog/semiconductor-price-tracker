import { NextResponse } from "next/server";
import trackingConfig from "../../../../config/tracking.json";
import { fetchDigiKeyPrice } from "../../../../lib/crawlers/digikey";
import { fetchLcscPrice } from "../../../../lib/crawlers/lcsc";
import { mergeCrawlerResultHistories, readCrawlerCache, writeCrawlerCache } from "../../../../lib/cache/edgeCrawlerCache";
import type { PriceResult, TrackingEntry } from "../../../../lib/crawlers";
import type { KeyComponentEntry } from "../../../../lib/crawlers/cytech";

type DigiKeyEntry = TrackingEntry & { id: string };
type ApiResult = PriceResult & { id: string };

const trustedEntries = trackingConfig as DigiKeyEntry[];
const isDevelopment = process.env.NODE_ENV === "development";

export const runtime = "edge";

function todayKey() {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date()).replaceAll("/", "-");
}

function failedResult(id: string, entry: Partial<DigiKeyEntry>, error: string): ApiResult {
  return {
    id,
    success: false,
    category: entry.category || "",
    material: entry.name || "",
    materialName: entry.name || "",
    manufacturer: entry.manufacturer,
    mpn: entry.mpn,
    quantity: entry.quantity,
    price: null,
    currency: entry.currency || "USD",
    unit: entry.unit || "USD/pcs",
    source: entry.source || "DigiKey",
    sourceUrl: entry.url,
    updateDate: todayKey(),
    crawlTime: new Date().toISOString(),
    mode: "real",
    error,
  };
}

function isRequestBody(value: unknown): value is { ids: string[] } {
  return Boolean(value) && typeof value === "object"
    && Array.isArray((value as { ids?: unknown }).ids)
    && (value as { ids: unknown[] }).ids.every((id) => typeof id === "string");
}

function refreshAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const provided = request.headers.get("x-cron-secret")?.trim();
  return Boolean(secret && provided && provided === secret);
}

function fallbackEntry(entry: DigiKeyEntry): KeyComponentEntry | null {
  if (entry.fallbackSource !== "LCSC" || !entry.fallbackUrl || !entry.mpn || !entry.id) return null;
  return { id: entry.id, mpn: entry.mpn, name: entry.name, category: entry.category, description: entry.description || "", manufacturer: entry.manufacturer, source: "LCSC", sourceUrl: entry.fallbackUrl, crawler: "lcsc", enabled: true, status: "已追踪" };
}

async function fetchWithFallback(entry: DigiKeyEntry): Promise<ApiResult> {
  const primary = await fetchDigiKeyPrice(entry, todayKey());
  if (primary.success) return { ...primary, id: entry.id };
  const fallback = fallbackEntry(entry);
  if (!fallback) return { ...primary, id: entry.id };
  const secondary = await fetchLcscPrice(fallback);
  if (secondary.success) return { ...secondary, id: entry.id, material: entry.name, materialName: entry.name, category: entry.category, manufacturer: entry.manufacturer, mpn: entry.mpn, quantity: entry.quantity, unit: secondary.unit, source: entry.fallbackSource || secondary.source, sourceUrl: entry.fallbackUrl };
  return { ...primary, id: entry.id, error: "DigiKey: " + (primary.error || "价格获取失败") + "；" + entry.fallbackSource + ": " + (secondary.error || "价格获取失败"), source: entry.source + " / " + entry.fallbackSource, sourceUrl: entry.fallbackUrl };
}

async function fetchEntries(entries: DigiKeyEntry[]) {
  return Promise.all(entries.map(async (entry): Promise<ApiResult> => {
    return fetchWithFallback(entry);
  }));
}

export async function GET(request: Request) {
  const forceRefresh = new URL(request.url).searchParams.has("refresh");
  if (!forceRefresh) {
    const cached = await readCrawlerCache<{ success: boolean; results: ApiResult[] }>("digikey-market");
    if (cached) return NextResponse.json(cached, { headers: { "X-Crawler-Cache": "HIT" } });
  } else if (!refreshAuthorized(request)) {
    return NextResponse.json({ success: false, error: "Scheduled refresh is not authorized" }, { status: 401 });
  }
  const entries = trustedEntries.filter((entry) => entry.enabled && entry.mode === "real" && entry.crawler === "digikey");
  const results = await fetchEntries(entries);
  const cached = await readCrawlerCache<{ success: boolean; results: ApiResult[] }>("digikey-market");
  const payload = { success: true, results: mergeCrawlerResultHistories(cached?.results || [], results) };
  if (results.some((result) => result.success)) await writeCrawlerCache("digikey-market", payload);
  return NextResponse.json(payload, { headers: { "X-Crawler-Cache": "MISS" } });
}

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON request body" }, { status: 400 });
  }
  if (!isRequestBody(body) || body.ids.length === 0) {
    return NextResponse.json({ success: false, error: "Request body must contain a non-empty ids array" }, { status: 400 });
  }

  const results = await Promise.all(Array.from(new Set(body.ids)).map(async (id): Promise<ApiResult> => {
    const entry = trustedEntries.find((candidate) => candidate.id === id);
    if (!entry) return failedResult(id, {}, "Unknown tracking id");
    if (entry.crawler !== "digikey") return failedResult(id, entry, "Tracking entry is not a DigiKey crawler");
    if (!entry.enabled) return failedResult(id, entry, "Tracking entry is disabled");
    if (entry.mode !== "real") return failedResult(id, entry, "Tracking entry is not configured for real mode");
    return fetchWithFallback(entry);
  }));

  if (isDevelopment) console.log("[DigiKey API]", { ids: body.ids, results: results.map((result) => ({ id: result.id, success: result.success, error: result.error })) });
  const cached = await readCrawlerCache<{ success: boolean; results: ApiResult[] }>("digikey-market");
  const mergedResults = mergeCrawlerResultHistories(cached?.results || [], results);
  if (mergedResults.some((result) => result.success)) await writeCrawlerCache("digikey-market", { success: true, results: mergedResults });
  return NextResponse.json({ success: true, results: mergedResults });
}
