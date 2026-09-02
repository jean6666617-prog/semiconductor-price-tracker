import { getRequestContext } from "@cloudflare/next-on-pages";

type EdgeCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

type EdgeCacheStorage = { default?: EdgeCache };

type CrawlerDataKv = {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

type PriceHistoryPoint = { date: string; price: number };

type HistoricalCrawlerResult = {
  id?: string;
  material?: string;
  materialName?: string;
  history?: PriceHistoryPoint[];
};

const crawlerKeys: Record<string, string> = {
  "ddr-market": "crawler:ddr",
  "plastic-market": "crawler:plastic",
  "trendforce-market": "crawler:trendforce",
  "digikey-market": "crawler:digikey",
  "distributor-market": "crawler:distributor",
  "automatic-update-status": "crawler:auto-status",
  "market-news-display": "crawler:market-news:display",
  "market-news-battery": "crawler:market-news:battery",
  "market-news-soc": "crawler:market-news:soc",
};

// Edge entries are only an acceleration layer. Keep their maximum lifetime short
// so a refresh written to KV cannot be hidden by a stale value in another colo.
const maxEdgeCacheAgeSeconds = 5 * 60;

function getEdgeCache() {
  return (globalThis as typeof globalThis & { caches?: EdgeCacheStorage }).caches?.default;
}

function getCrawlerDataKv() {
  try {
    const context = getRequestContext();
    return (context.env as unknown as { CRAWLER_DATA?: CrawlerDataKv }).CRAWLER_DATA;
  } catch (error) {
    console.warn("[crawler-cache] KV binding unavailable", { error: String(error) });
    return undefined;
  }
}

function crawlerKey(name: string) {
  if (name.startsWith("crawler:")) return name;
  const key = crawlerKeys[name];
  if (!key) throw new Error(`Unknown crawler cache name: ${name}`);
  return key;
}

function edgeCacheKey(key: string) {
  return new Request(`https://semiconductor-price-tracker.pages.dev/__crawler-cache/${encodeURIComponent(key)}`);
}

function payloadCrawlTime(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  if (Array.isArray(payload)) {
    return payload.map(payloadCrawlTime).filter((value): value is string => Boolean(value)).sort().at(-1);
  }
  const value = payload as { crawlTime?: unknown; runAt?: unknown; results?: unknown };
  if (typeof value.crawlTime === "string") return value.crawlTime;
  if (typeof value.runAt === "string") return value.runAt;
  return payloadCrawlTime(value.results);
}

async function writeEdgeCache(key: string, serialized: string, maxAgeSeconds: number, crawlTime?: string) {
  const cache = getEdgeCache();
  if (!cache) {
    console.info("[crawler-cache] edge cache unavailable", { key, crawlTime });
    return;
  }
  try {
    const edgeMaxAgeSeconds = Math.min(maxAgeSeconds, maxEdgeCacheAgeSeconds);
    await cache.put(edgeCacheKey(key), new Response(serialized, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${edgeMaxAgeSeconds}`,
      },
    }));
    console.info("[crawler-cache] edge cache write success", { key, crawlTime });
  } catch (error) {
    console.warn("[crawler-cache] edge cache write failure", { key, crawlTime, error: String(error) });
  }
}

function resultKey(result: HistoricalCrawlerResult) {
  return result.id || result.materialName || result.material || "";
}

export function mergeCrawlerResultHistories<T extends HistoricalCrawlerResult>(previous: T[] = [], current: T[] = []) {
  const previousByKey = new Map(previous.map((result) => [resultKey(result), result]));
  return current.map((result) => {
    const previousResult = previousByKey.get(resultKey(result));
    const points = new Map<string, number>();
    for (const point of previousResult?.history || []) {
      if (point.date && Number.isFinite(point.price)) points.set(point.date, point.price);
    }
    for (const point of result.history || []) {
      if (point.date && Number.isFinite(point.price)) points.set(point.date, point.price);
    }
    const history = Array.from(points.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, price]) => ({ date, price }));
    return history.length ? { ...result, history } : result;
  });
}

export async function readCrawlerCache<T>(name: string): Promise<T | null> {
  const key = crawlerKey(name);
  const kv = getCrawlerDataKv();
  if (!kv) {
    console.warn("[crawler-cache] KV unavailable; using edge cache fallback", { key });
    const cache = getEdgeCache();
    if (!cache) return null;
    try {
      const response = await cache.match(edgeCacheKey(key));
      if (!response) {
        console.info("[crawler-cache] edge cache MISS", { key });
        return null;
      }
      const payload = await response.json() as T;
      console.info("[crawler-cache] edge cache HIT (fallback)", { key, crawlTime: payloadCrawlTime(payload) });
      return payload;
    } catch (error) {
      console.warn("[crawler-cache] edge cache fallback failure", { key, error: String(error) });
      return null;
    }
  }

  let serialized: string | null;
  try {
    serialized = await kv.get(key, "text");
  } catch (error) {
    console.error("[crawler-cache] KV read failure", { key, error: String(error) });
    return null;
  }
  if (serialized === null) {
    console.info("[crawler-cache] KV read MISS", { key });
    return null;
  }

  try {
    const payload = JSON.parse(serialized) as T;
    const crawlTime = payloadCrawlTime(payload);
    console.info("[crawler-cache] KV read HIT", { key, crawlTime });
    await writeEdgeCache(key, serialized, 8 * 60 * 60, crawlTime);
    return payload;
  } catch (error) {
    console.error("[crawler-cache] KV value invalid JSON", { key, error: String(error) });
    return null;
  }
}

export async function writeCrawlerCache<T>(name: string, payload: T, maxAgeSeconds = 8 * 60 * 60) {
  const key = crawlerKey(name);
  const serialized = JSON.stringify(payload);
  const crawlTime = payloadCrawlTime(payload);
  const kv = getCrawlerDataKv();
  if (!kv) {
    console.error("[crawler-cache] KV write failure", { key, crawlTime, error: "CRAWLER_DATA binding unavailable" });
    throw new Error("CRAWLER_DATA KV binding is unavailable");
  }

  try {
    await kv.put(key, serialized);
    console.info("[crawler-cache] KV write success", { key, crawlTime });
  } catch (error) {
    console.error("[crawler-cache] KV write failure", { key, crawlTime, error: String(error) });
    throw error;
  }

  await writeEdgeCache(key, serialized, maxAgeSeconds, crawlTime);
}
