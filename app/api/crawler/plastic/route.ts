import { NextResponse } from "next/server";
import { readCrawlerCache, writeCrawlerCache } from "../../../../lib/cache/edgeCrawlerCache";
import { fetchPlasticPrice, plasticFallbackUrls } from "../../../../lib/crawlers/plastic";
import type { TrackingEntry, PriceResult } from "../../../../lib/crawlers";
import { supportedPlasticMaterials } from "../../../../lib/analysis/plasticTrendAnalysis";

export const runtime = "edge";

function todayKey() {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date()).replaceAll("/", "-");
}

export async function GET(request: Request) {
  const forceRefresh = new URL(request.url).searchParams.has("refresh");
  if (!forceRefresh) {
    const cached = await readCrawlerCache<unknown[]>("plastic-market");
    if (cached) return NextResponse.json(cached, { headers: { "X-Crawler-Cache": "HIT" } });
  } else if (!process.env.CRON_SECRET || request.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return NextResponse.json({ success: false, error: "Scheduled refresh is not authorized" }, { status: 401 });
  }
  const results = await Promise.all(supportedPlasticMaterials.map((material) => fetchPlasticPrice({
    category: "塑料件",
    name: material,
    source: "SunSirs",
    url: plasticFallbackUrls[material],
    crawler: "sunsirs_plastic",
    mode: "real",
    unit: "RMB/ton",
    enabled: true,
  }, todayKey())));

  const payload = results.map((result) => ({
    material: result.material,
    price: result.price,
    currency: result.currency,
    unit: result.unit,
    source: result.source,
    updateDate: result.updateDate,
    history: result.history ?? [],
    analysis: result.analysis,
    success: result.success,
    error: result.error,
  }));
  if (payload.some((result) => result.success)) await writeCrawlerCache("plastic-market", payload);
  return NextResponse.json(payload, { headers: { "X-Crawler-Cache": "MISS" } });
}

export async function POST(request: Request) {
  try {
    const entry = await request.json() as TrackingEntry;
    const result = await fetchPlasticPrice(entry, todayKey());
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Plastic crawler failed";
    const result: PriceResult = {
      success: false,
      category: "塑料件",
      material: "",
      price: null,
      currency: "RMB",
      unit: "RMB/ton",
      source: "SunSirs",
      updateDate: todayKey(),
      error: message,
    };
    return NextResponse.json(result, { status: 200 });
  }
}
