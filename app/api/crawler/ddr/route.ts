import { NextResponse } from "next/server";
import { readCrawlerCache, writeCrawlerCache } from "../../../../lib/cache/edgeCrawlerCache";
import { fetchDDRMarketData, type DDRFallbackInput } from "../../../../lib/crawlers/ddr";

export const runtime = "edge";

function refreshAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const provided = request.headers.get("x-cron-secret")?.trim();
  return Boolean(secret && provided && provided === secret);
}

export async function GET(request: Request) {
  const forceRefresh = new URL(request.url).searchParams.has("refresh");
  if (!forceRefresh) {
    const cached = await readCrawlerCache<Awaited<ReturnType<typeof fetchDDRMarketData>>>("ddr-market");
    if (cached) return NextResponse.json(cached, { headers: { "X-Crawler-Cache": "HIT" } });
  } else if (!refreshAuthorized(request)) {
    return NextResponse.json({ success: false, error: "Scheduled refresh is not authorized" }, { status: 401 });
  }
  const data = await fetchDDRMarketData();
  if (data.success || data.spotPrices.length || data.marketAnalyses.length || data.industryNews.length) await writeCrawlerCache("ddr-market", data);
  return NextResponse.json(data, { headers: { "X-Crawler-Cache": "MISS" } });
}

export async function POST(request: Request) {
  try {
    const fallback = await request.json() as DDRFallbackInput;
    const data = await fetchDDRMarketData(fallback);
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ success: false, status: "access_restricted", spotPrices: [], contractPrices: [], marketAnalyses: [], industryNews: [], error: error instanceof Error ? error.message : "DDR crawler fallback payload failed" }, { status: 200 });
  }
}
