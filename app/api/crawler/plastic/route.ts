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

function hasFreshPrices(results: Array<{ success?: boolean; price?: number | null; updateDate?: string }>) {
  const dates = results
    .filter((result) => result.success && result.price !== null && result.updateDate)
    .map((result) => Date.parse(result.updateDate as string))
    .filter((timestamp) => Number.isFinite(timestamp));
  if (!dates.length) return false;
  return Date.now() - Math.max(...dates) < 36 * 60 * 60 * 1000;
}

export async function GET(request: Request) {
  const forceRefresh = new URL(request.url).searchParams.has("refresh");
  if (!forceRefresh) {
    const cached = await readCrawlerCache<unknown[]>("plastic-market");
    if (Array.isArray(cached) && hasFreshPrices(cached as Array<{ success?: boolean; price?: number | null; updateDate?: string }>)) {
      return NextResponse.json(cached, { headers: { "X-Crawler-Cache": "HIT" } });
    }
  } else {
    const secret = process.env.CRON_SECRET?.trim();
    const provided = request.headers.get("x-cron-secret")?.trim();
    if (!secret || !provided || provided !== secret) {
      return NextResponse.json({ success: false, error: "Scheduled refresh is not authorized" }, { status: 401 });
    }
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
    crawlTime: result.crawlTime,
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
