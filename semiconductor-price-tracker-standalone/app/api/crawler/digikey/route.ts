import { NextResponse } from "next/server";
import trackingConfig from "../../../../config/tracking.json";
import { fetchDigiKeyPrice } from "../../../../lib/crawlers/digikey";
import type { PriceResult, TrackingEntry } from "../../../../lib/crawlers";

type DigiKeyEntry = TrackingEntry & { id: string };
type ApiResult = PriceResult & { id: string };

const trustedEntries = trackingConfig as DigiKeyEntry[];
const isDevelopment = process.env.NODE_ENV === "development";

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
    const result = await fetchDigiKeyPrice(entry, todayKey());
    return { ...result, id };
  }));

  if (isDevelopment) console.log("[DigiKey API]", { ids: body.ids, results: results.map((result) => ({ id: result.id, success: result.success, error: result.error })) });
  return NextResponse.json({ success: true, results });
}
