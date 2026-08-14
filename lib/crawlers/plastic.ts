import type { PriceHistoryPoint, PriceResult, TrackingEntry } from "./index";
import { analyzePlasticTrend, plasticNewsInputs, supportedPlasticMaterials, type PlasticMaterial } from "../analysis/plasticTrendAnalysis";
import { targetResponseError } from "./response";

const isDevelopment = process.env.NODE_ENV === "development";
const maxScrapeAttempts = 3;

export const plasticFallbackUrls: Record<string, string> = {
  ABS: "https://www.sunsirs.com/uk/prodetail-713.html",
  PC: "https://www.sunsirs.com/uk/prodetail-172.html",
  PP: "https://www.sunsirs.com/uk/prodetail-718.html",
  PVC: "https://www.sunsirs.com/uk/prodetail-107.html",
  PET: "https://www.sunsirs.com/uk/prodetail-173.html",
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSunSirsHistory(html: string, material: string) {
  const tablePattern = new RegExp(
    `<tr[^>]*>\\s*<td[^>]*>\\s*${escapeRegExp(material)}\\s*</td>\\s*<td[^>]*>\\s*Rubber\\s*&(?:amp;)?\\s*plastics\\s*</td>\\s*<td[^>]*>\\s*([0-9]+(?:\\.[0-9]+)?)\\s*</td>\\s*<td[^>]*>\\s*(\\d{4}-\\d{2}-\\d{2})\\s*</td>`,
    "gi",
  );
  const byDate = new Map<string, number>();
  let totalRows = 0;
  let match: RegExpExecArray | null;
  while ((match = tablePattern.exec(html)) !== null) {
    totalRows += 1;
    const price = Number(match[1]);
    const date = match[2];
    if (Number.isFinite(price) && /^\d{4}-\d{2}-\d{2}$/.test(date)) byDate.set(date, price);
  }

  if (!byDate.size) {
    const text = html.replace(/&amp;/g, "&").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    const textPattern = new RegExp(`\\b${escapeRegExp(material)}\\s+Rubber\\s*&\\s*plastics\\s+([0-9]+(?:\\.[0-9]+)?)\\s+(\\d{4}-\\d{2}-\\d{2})\\b`, "gi");
    while ((match = textPattern.exec(text)) !== null) {
      totalRows += 1;
      const price = Number(match[1]);
      const date = match[2];
      if (Number.isFinite(price) && /^\d{4}-\d{2}-\d{2}$/.test(date)) byDate.set(date, price);
    }
  }

  const history: PriceHistoryPoint[] = Array.from(byDate.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, price]) => ({ date, price }));
  return { history, totalRows };
}

function extractSafetyCookie(html: string) {
  const match = html.match(/var\s+_0x2\s*=\s*"([^"]+)"/);
  return match ? `HW_CHECK=${match[1]}` : "";
}

async function fetchWithRetry(url: string, cookie = "") {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      return await fetch(url, {
        cache: "no-store",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0",
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function fetchSunSirsHtml(url: string, material: string) {
  let response = await fetchWithRetry(url);
  let html = await response.text();
  const cookie = extractSafetyCookie(html);
  if (cookie) {
    response = await fetchWithRetry(url, cookie);
    html = await response.text();
  }

  const contentType = response.headers.get("content-type") || "";
  if (isDevelopment) {
    console.log("[SunSirs Plastic Debug]", {
      material,
      status: response.status,
      contentType,
      htmlPreview: html.slice(0, 1000),
    });
  }
  return { response, html };
}

function historyTuples(history: PriceHistoryPoint[] = []): [string, number][] {
  return history.map((point) => [point.date, point.price]);
}

function analysisForResult(material: string, history: PriceHistoryPoint[] = [], unit = "RMB/ton") {
  const newsInputs = supportedPlasticMaterials.includes(material as PlasticMaterial)
    ? plasticNewsInputs[material as PlasticMaterial]
    : [];
  return analyzePlasticTrend(material, historyTuples(history), newsInputs, unit);
}

function failedResult(entry: TrackingEntry, updateDate: string, error: string): PriceResult {
  return {
    success: false,
    category: entry.category,
    material: entry.name,
    price: null,
    currency: "RMB",
    unit: entry.unit || "RMB/ton",
    source: entry.source || "SunSirs",
    updateDate,
    error,
    analysis: analysisForResult(entry.name, [], entry.unit || "RMB/ton"),
  };
}

export async function fetchSunSirsPlastic(entry: TrackingEntry, fallbackDate: string): Promise<PriceResult> {
  const material = entry.name;
  const url = entry.url || plasticFallbackUrls[material];
  if (!url) {
    const result = failedResult(entry, fallbackDate, `Missing SunSirs URL for ${material}`);
    if (isDevelopment) console.log("[SunSirs Plastic]", { material, price: result.price, updateDate: result.updateDate, success: result.success });
    return result;
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxScrapeAttempts; attempt += 1) {
    try {
      const { response, html } = await fetchSunSirsHtml(url, material);
      if (!response.ok) throw new Error(targetResponseError("SunSirs", response, html, `SunSirs ${material} request failed`));
      const parsed = parseSunSirsHistory(html, material);
      const latest = parsed.history.at(-1);
      if (isDevelopment) {
        console.log("[SunSirs History]", {
          material,
          attempt,
          totalRows: parsed.totalRows,
          validRows: parsed.history.length,
          firstDate: parsed.history[0]?.date || "",
          lastDate: latest?.date || "",
          latestPrice: latest?.price ?? null,
        });
      }
      if (!latest) throw new Error(`SunSirs ${material} price not found`);
      const result: PriceResult = {
        success: true,
        category: entry.category,
        material,
        price: latest.price,
        currency: "RMB",
        unit: entry.unit || "RMB/ton",
        source: entry.source || "SunSirs",
        updateDate: latest.date,
        history: parsed.history,
        analysis: analysisForResult(material, parsed.history, entry.unit || "RMB/ton"),
        crawlTime: new Date().toISOString(),
      };
      if (isDevelopment) console.log("[SunSirs Plastic]", { material, attempt, price: result.price, updateDate: result.updateDate, success: result.success });
      return result;
    } catch (error) {
      lastError = error;
      console.warn("[SunSirs Plastic] attempt failed", {
        material,
        attempt,
        maxAttempts: maxScrapeAttempts,
        error: error instanceof Error ? error.message : String(error),
      });
      if (attempt < maxScrapeAttempts) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }

  const result = failedResult(entry, fallbackDate, lastError instanceof Error ? lastError.message : `SunSirs ${material} fetch failed`);
  console.error("[SunSirs Plastic] all attempts failed", { material, attempts: maxScrapeAttempts, error: result.error });
  if (isDevelopment) console.log("[SunSirs Plastic]", { material, price: result.price, updateDate: result.updateDate, success: result.success });
  return result;
}

export async function fetchPlasticPrice(entry: TrackingEntry, updateDate: string): Promise<PriceResult> {
  return fetchSunSirsPlastic(entry, updateDate);
}
