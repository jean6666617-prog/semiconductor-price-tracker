import { NextResponse } from "next/server";
import keyComponents from "../../../../config/key-components.json";
import { fetchCytechPrice, type KeyComponentEntry } from "../../../../lib/crawlers/cytech";

const entries = keyComponents as KeyComponentEntry[];
const isDevelopment = process.env.NODE_ENV === "development";

export const runtime = "edge";

function failed(entry: Partial<KeyComponentEntry>, error: string) {
  return {
    id: entry.id || "",
    success: false,
    category: entry.category || "",
    material: entry.mpn || entry.name || "",
    materialName: entry.name || entry.mpn || "",
    mpn: entry.mpn || "",
    price: null,
    currency: "USD",
    unit: "USD/pcs",
    source: entry.source || "Cytech",
    sourceUrl: entry.sourceUrl || "",
    updateDate: new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replaceAll("/", "-"),
    crawlTime: new Date().toISOString(),
    mode: "real",
    error,
  };
}

function isRequestBody(value: unknown): value is { ids: string[] } {
  if (!value || typeof value !== "object") return false;
  const body = value as { ids?: unknown };
  return Array.isArray(body.ids) && body.ids.every((id) => typeof id === "string");
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

  if (isDevelopment) {
    console.log(`[Cytech API] POST ${JSON.stringify({ ids: body.ids })}`);
  }

  const results = await Promise.all(Array.from(new Set(body.ids)).map(async (id) => {
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) return failed({ id }, "Unknown key component id");
    if (entry.crawler !== "cytech") return failed(entry, "Key component is not a Cytech crawler");
    if (!entry.enabled) return failed(entry, "Key component crawler is disabled");
    return fetchCytechPrice(entry);
  }));

  if (isDevelopment) {
    for (const result of results) {
      if (result.success) {
        console.log(`[Cytech API] result ${JSON.stringify({
          id: result.id,
          mpn: result.mpn,
          success: result.success,
          price: result.price,
          unit: result.unit,
          updateDate: result.updateDate,
          url: result.sourceUrl,
        })}`);
      } else {
        console.error(`[Cytech API] result failed ${JSON.stringify({
          id: result.id,
          mpn: result.mpn,
          success: result.success,
          error: result.error,
          url: result.sourceUrl,
        })}`);
      }
    }
  }

  return NextResponse.json({ success: true, results });
}
