type EdgeCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

type EdgeCacheStorage = { default?: EdgeCache };

function getEdgeCache() {
  return (globalThis as typeof globalThis & { caches?: EdgeCacheStorage }).caches?.default;
}

function cacheKey(name: string) {
  return new Request(`https://semiconductor-price-tracker-cache.invalid/${name}`);
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
