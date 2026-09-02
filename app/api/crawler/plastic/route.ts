import { NextResponse } from "next/server";
import { mergeCrawlerResultHistories, readCrawlerCache, writeCrawlerCache } from "../../../../lib/cache/edgeCrawlerCache";
import { fetchPlasticPrice, plasticFallbackUrls } from "../../../../lib/crawlers/plastic";
import type { TrackingEntry, PriceResult } from "../../../../lib/crawlers";
import { analyzePlasticTrend, plasticNewsInputs, supportedPlasticMaterials } from "../../../../lib/analysis/plasticTrendAnalysis";

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

type PlasticPayloadItem = {
  material: string;
  price: number | null;
  unit: string;
  updateDate: string;
  history: Array<{ date: string; price: number }>;
  analysis?: ReturnType<typeof analyzePlasticTrend>;
  success: boolean;
  [key: string]: unknown;
};

type PlasticPayload = PlasticPayloadItem[];

function stabilizePlasticPayload(results: PlasticPayload) {
  return results.map((result) => {
    // Older KV entries were written before `category` was included in the
    // response. Normalize them here so cached responses remain compatible with
    // the dashboard matcher after deployment.
    const normalized = result.category ? result : { ...result, category: "塑料件" };
    if (normalized.success && normalized.price !== null) return normalized;
    const latest = [...(normalized.history || [])]
      .filter((point) => point && Number.isFinite(point.price) && point.price > 0 && point.date)
      .sort((left, right) => left.date.localeCompare(right.date))
      .at(-1);
    if (!latest) return normalized;
    const analysis = analyzePlasticTrend(
      normalized.material,
      (normalized.history || []).map((point) => [point.date, point.price]),
      plasticNewsInputs[normalized.material as keyof typeof plasticNewsInputs] || [],
      normalized.unit || "RMB/ton",
    );
    return { ...normalized, price: latest.price, updateDate: latest.date, analysis, stale: true };
  });
}

export async function GET(request: Request) {
  const forceRefresh = new URL(request.url).searchParams.has("refresh");
  if (!forceRefresh) {
    const cached = await readCrawlerCache<unknown[]>("plastic-market");
    if (Array.isArray(cached) && hasFreshPrices(cached as Array<{ success?: boolean; price?: number | null; updateDate?: string }>)) {
      return NextResponse.json(stabilizePlasticPayload(cached as typeof payload), { headers: { "X-Crawler-Cache": "HIT" } });
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
    category: result.category,
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
  const cached = await readCrawlerCache<typeof payload>("plastic-market");
  const mergedPayload = mergeCrawlerResultHistories(cached || [], payload);
  const stabilizedPayload = stabilizePlasticPayload(mergedPayload);
  if (stabilizedPayload.some((result) => result.success || result.price !== null)) await writeCrawlerCache("plastic-market", stabilizedPayload);
  return NextResponse.json(stabilizedPayload, { headers: { "X-Crawler-Cache": "MISS" } });
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
