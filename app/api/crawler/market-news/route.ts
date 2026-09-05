import { NextResponse } from "next/server";
import { readCrawlerCache, writeCrawlerCache } from "../../../../lib/cache/edgeCrawlerCache";
import { fetchMarketNews, normalizeMarketNewsRecords, type MarketNewsCategory, type MarketNewsData } from "../../../../lib/crawlers/marketNews";

export const runtime = "edge";

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const provided = request.headers.get("x-cron-secret")?.trim();
  return Boolean(secret && provided && provided === secret);
}

function isCategory(value: string): value is MarketNewsCategory { return value === "Display" || value === "Battery" || value === "SOC"; }
function cacheName(category: MarketNewsCategory) { return category === "Display" ? "market-news-display" : category === "Battery" ? "market-news-battery" : "market-news-soc"; }
function fresh(data: MarketNewsData) { const newest = Math.max(...data.news.map((item) => Date.parse(item.date)).filter(Number.isFinite)); return data.news.length > 0 && (!Number.isFinite(newest) || Date.now() - newest < 7 * 24 * 60 * 60 * 1000); }

export async function GET(request: Request) {
  const categoryValue = new URL(request.url).searchParams.get("category") || "";
  if (!isCategory(categoryValue)) return NextResponse.json({ success: false, error: "category must be Display, Battery, or SOC" }, { status: 400 });
  const forceRefresh = new URL(request.url).searchParams.has("refresh");
  if (!forceRefresh) {
    const cached = await readCrawlerCache<MarketNewsData>(cacheName(categoryValue));
    if (cached && fresh(cached)) {
      const news = normalizeMarketNewsRecords(categoryValue, Array.isArray(cached.news) ? cached.news : []);
      if (news.length) return NextResponse.json({ ...cached, news }, { headers: { "X-Crawler-Cache": "HIT" } });
    }
  } else if (!authorized(request)) {
    return NextResponse.json({ success: false, error: "Scheduled refresh is not authorized" }, { status: 401 });
  }
  const data = await fetchMarketNews(categoryValue);
  // Local Next.js preview does not always expose the Cloudflare KV binding.
  // The crawl result is still valid in that case, so return it to the page and
  // only skip persistence. Production requests with KV continue to persist as
  // before; a cache write failure must not turn a successful news fetch into a
  // 500 response.
  if (data.news.length) {
    try {
      await writeCrawlerCache(cacheName(categoryValue), data);
    } catch (error) {
      console.warn("[market-news] cache write skipped", { category: categoryValue, error: String(error) });
    }
  }
  return NextResponse.json(data, { headers: { "X-Crawler-Cache": "MISS" } });
}
