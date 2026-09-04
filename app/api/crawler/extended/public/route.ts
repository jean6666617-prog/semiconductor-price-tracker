import { NextResponse } from "next/server";
import { readCrawlerCache } from "../../../../../lib/cache/edgeCrawlerCache";

export const runtime = "edge";

/**
 * Public, read-only projection for the trend page. The refresh endpoint stays
 * protected; this route exposes only the cached quote/history fields needed
 * by the UI and never accepts a refresh request or secret.
 */
export async function GET() {
  const payload = await readCrawlerCache<{
    success?: boolean;
    batchId?: string | null;
    completedAt?: string | null;
    results?: Array<Record<string, unknown>>;
  }>("extended-category-results");
  const results = (payload?.results || []).map((result) => ({
    modelId: result.modelId,
    categoryName: result.categoryName,
    modelName: result.modelName,
    manufacturer: result.manufacturer,
    source: result.source,
    requestUrl: result.requestUrl,
    price: result.price,
    currency: result.currency,
    unit: result.unit,
    priceBreakQuantity: result.priceBreakQuantity,
    minimumOrderQuantity: result.minimumOrderQuantity,
    selectedQuantity: result.selectedQuantity,
    priceBreaks: result.priceBreaks,
    priceBasis: result.priceBasis,
    priceObservedAt: result.priceObservedAt,
    history: result.history,
    finalStatus: result.finalStatus,
    failureCode: result.failureCode,
    failureReason: result.failureReason,
  }));
  return NextResponse.json(
    { success: payload?.success ?? true, batchId: payload?.batchId ?? null, completedAt: payload?.completedAt ?? null, results },
    { headers: { "Cache-Control": "no-store" } },
  );
}
