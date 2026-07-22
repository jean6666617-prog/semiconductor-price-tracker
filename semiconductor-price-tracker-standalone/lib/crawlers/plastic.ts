import type { PriceHistoryPoint, PriceResult, TrackingEntry } from "./index";
import { writeFile } from "fs/promises";

const isDevelopment = process.env.NODE_ENV === "development";

const fallbackUrls: Record<string, string> = {
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
  if (material === "ABS") await writeFile("/tmp/sunsirs-abs-debug.html", html, "utf8");
  return { response, html };
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
  };
}

export async function fetchSunSirsPlastic(entry: TrackingEntry, fallbackDate: string): Promise<PriceResult> {
  const material = entry.name;
  const url = entry.url || fallbackUrls[material];
  if (!url) {
    const result = failedResult(entry, fallbackDate, `Missing SunSirs URL for ${material}`);
    if (isDevelopment) console.log("[SunSirs Plastic]", { material, price: result.price, updateDate: result.updateDate, success: result.success });
    return result;
  }

  try {
    const { response, html } = await fetchSunSirsHtml(url, material);
    if (!response.ok) throw new Error(`SunSirs ${material} request failed: ${response.status}`);
    const parsed = parseSunSirsHistory(html, material);
    const latest = parsed.history.at(-1);
    if (isDevelopment) {
      console.log("[SunSirs History]", {
        material,
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
    };
    if (isDevelopment) console.log("[SunSirs Plastic]", { material, price: result.price, updateDate: result.updateDate, success: result.success });
    return result;
  } catch (error) {
    const result = failedResult(entry, fallbackDate, error instanceof Error ? error.message : `SunSirs ${material} fetch failed`);
    console.warn("[SunSirs Plastic] fetch failed", { material, error: result.error });
    if (isDevelopment) console.log("[SunSirs Plastic]", { material, price: result.price, updateDate: result.updateDate, success: result.success });
    return result;
  }
}

export async function fetchPlasticPrice(entry: TrackingEntry, updateDate: string): Promise<PriceResult> {
  return fetchSunSirsPlastic(entry, updateDate);
}
