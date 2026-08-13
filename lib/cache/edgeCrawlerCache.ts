type EdgeCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

type EdgeCacheStorage = { default?: EdgeCache };

type PriceHistoryPoint = { date: string; price: number };

type HistoricalCrawlerResult = {
  id?: string;
  material?: string;
  materialName?: string;
  history?: PriceHistoryPoint[];
};

function getEdgeCache() {
  return (globalThis as typeof globalThis & { caches?: EdgeCacheStorage }).caches?.default;
}

function cacheKey(name: string) {
  return new Request(`https://semiconductor-price-tracker-cache.invalid/${name}`);
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
  const cache = getEdgeCache();
  if (!cache) return null;
  const response = await cache.match(cacheKey(name));
  if (!response) return null;
  try {
    return await response.json() as T;
  } catch {
    return null;
  }
}

export async function writeCrawlerCache<T>(name: string, payload: T, maxAgeSeconds = 8 * 60 * 60) {
  const cache = getEdgeCache();
  if (!cache) return;
  await cache.put(cacheKey(name), new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${maxAgeSeconds}`,
    },
  }));
}
