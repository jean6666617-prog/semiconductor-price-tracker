import { NextResponse } from "next/server";
import trackingConfig from "../../../../config/tracking.json";
import { fetchTrendForcePriceBatch } from "../../../../lib/crawlers/trendforce";
import type { PriceResult, TrackingEntry } from "../../../../lib/crawlers";

type TrendForceEntry = TrackingEntry & { id: string };
type ApiResult = PriceResult & { id: string; materialName: string; sourceUrl: string; mode: "real" | "mock" };

const isDevelopment = process.env.NODE_ENV === "development";
const trustedEntries = trackingConfig as TrendForceEntry[];

export const runtime = "edge";

function todayKey() {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date()).replaceAll("/", "-");
}

function failedResult(id: string, entry: Partial<TrendForceEntry>, error: string): ApiResult {
  return {
    id,
    success: false,
    category: entry.category || "",
    material: entry.name || "",
    materialName: entry.name || "",
    price: null,
    currency: entry.unit?.startsWith("USD") ? "USD" : "RMB",
    unit: entry.unit || "",
    source: entry.source || "TrendForce",
    sourceUrl: entry.url || "",
    updateDate: todayKey(),
    crawlTime: new Date().toISOString(),
    mode: entry.mode || "real",
    error,
  };
}

function isRequestBody(value: unknown): value is { ids: string[]; includeDisabled?: boolean } {
  if (!value || typeof value !== "object") return false;
  const body = value as { ids?: unknown; includeDisabled?: unknown };
  return Array.isArray(body.ids) && body.ids.every((id) => typeof id === "string")
    && (body.includeDisabled === undefined || typeof body.includeDisabled === "boolean");
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON request body" }, { status: 400 });
  }
  if (!isRequestBody(body) || body.ids.length === 0) {
    return NextResponse.json({ success: false, error: "Request body must contain a non-empty ids array" }, { status: 400 });
  }

  const startedAt = Date.now();
  const requestedIds = Array.from(new Set(body.ids));
  const resultsById = new Map<string, ApiResult>();
  const entriesToFetch: TrendForceEntry[] = [];

  for (const id of requestedIds) {
    const entry = trustedEntries.find((candidate) => candidate.id === id);
    if (!entry) {
      resultsById.set(id, failedResult(id, {}, "Unknown tracking id"));
      continue;
    }
    if (entry.crawler !== "trendforce") {
      resultsById.set(id, failedResult(id, entry, "Tracking entry is not a TrendForce crawler"));
      continue;
    }
    if (!entry.enabled && !body.includeDisabled) {
      resultsById.set(id, failedResult(id, entry, "Tracking entry is disabled"));
      continue;
    }
    if (entry.mode !== "real") {
      resultsById.set(id, failedResult(id, entry, "Tracking entry is not configured for real mode"));
      continue;
    }
    entriesToFetch.push(entry);
  }

  if (isDevelopment) {
    console.log("[TrendForce API]", {
      ids: requestedIds,
      batteryEntryCount: entriesToFetch.filter((entry) => entry.category === "电池").length,
      urlCount: new Set(entriesToFetch.map((entry) => entry.url)).size,
    });
  }

  try {
    const fetched = await fetchTrendForcePriceBatch(entriesToFetch, todayKey());
    entriesToFetch.forEach((entry, index) => {
      const result = fetched[index];
      resultsById.set(entry.id, {
        ...result,
        id: entry.id,
        materialName: result.materialName || entry.name,
        sourceUrl: result.sourceUrl || entry.url || "",
        mode: result.mode || "real",
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "TrendForce batch failed";
    entriesToFetch.forEach((entry) => resultsById.set(entry.id, failedResult(entry.id, entry, message)));
  }

  const results = requestedIds.map((id) => resultsById.get(id) || failedResult(id, {}, "Missing crawler result"));
  if (isDevelopment) {
    console.log("[TrendForce API] completed", {
      durationMs: Date.now() - startedAt,
      results: results.map((result) => ({ id: result.id, success: result.success, error: result.error })),
    });
  }
  return NextResponse.json({ success: true, results });
}
