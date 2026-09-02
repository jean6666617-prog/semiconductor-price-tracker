import { NextResponse } from "next/server";
import { readCrawlerCache, writeCrawlerCache } from "../../../../lib/cache/edgeCrawlerCache";
import { fetchMarketNews, type MarketNewsCategory, type MarketNewsData } from "../../../../lib/crawlers/marketNews";

export const runtime = "edge";

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const provided = request.headers.get("x-cron-secret")?.trim();
  return Boolean(secret && provided && provided === secret);
}

function isCategory(value: string): value is MarketNewsCategory { return value === "Display" || value === "Battery"; }
function cacheName(category: MarketNewsCategory) { return category === "Display" ? "market-news-display" : "market-news-battery"; }
function fresh(data: MarketNewsData) { const newest = Math.max(...data.news.map((item) => Date.parse(item.date)).filter(Number.isFinite)); return data.news.length > 0 && (!Number.isFinite(newest) || Date.now() - newest < 7 * 24 * 60 * 60 * 1000); }

export async function GET(request: Request) {
  const categoryValue = new URL(request.url).searchParams.get("category") || "";
  if (!isCategory(categoryValue)) return NextResponse.json({ success: false, error: "category must be Display or Battery" }, { status: 400 });
  const forceRefresh = new URL(request.url).searchParams.has("refresh");
  if (!forceRefresh) {
    const cached = await readCrawlerCache<MarketNewsData>(cacheName(categoryValue));
    if (cached && fresh(cached)) return NextResponse.json(cached, { headers: { "X-Crawler-Cache": "HIT" } });
  } else if (!authorized(request)) {
    return NextResponse.json({ success: false, error: "Scheduled refresh is not authorized" }, { status: 401 });
  }
  const data = await fetchMarketNews(categoryValue);
  if (data.news.length) await writeCrawlerCache(cacheName(categoryValue), data);
  return NextResponse.json(data, { headers: { "X-Crawler-Cache": "MISS" } });
}
