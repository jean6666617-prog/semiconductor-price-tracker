import type { PriceResult } from "./index";
import type { KeyComponentEntry } from "./cytech";
const requestTimeoutMs = 15000;
export const missingMouserCredentialsMessage = "未配置 Mouser API Key，已跳过 Mouser 主来源";
export function hasMouserCredentials() { return Boolean(process.env.MOUSER_API_KEY?.trim()); }
function todayKey() { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replaceAll("/", "-"); }
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown) { return typeof value === "string" ? value.trim() : String(value ?? "").trim(); }
function number(value: unknown) { const parsed = Number(text(value).replace(/[^0-9.\-]/g, "")); return Number.isFinite(parsed) ? parsed : null; }
function normalize(value: unknown) { return text(value).replace(/\s+/g, "").toUpperCase(); }
function failure(entry: KeyComponentEntry, error: string): PriceResult & { id: string } { return { id: entry.id, success: false, category: entry.category, material: entry.mpn, materialName: entry.name, mpn: entry.mpn, price: null, currency: "USD", unit: "USD/pcs", source: "Mouser", sourceUrl: "https://www.mouser.com/c/?q=" + encodeURIComponent(entry.mpn), updateDate: todayKey(), crawlTime: new Date().toISOString(), mode: "real", error, status: "source_unavailable" }; }
export async function fetchMouserPrice(entry: KeyComponentEntry): Promise<PriceResult & { id: string }> {
  if (!hasMouserCredentials()) return failure(entry, missingMouserCredentialsMessage);
  const apiKey = process.env.MOUSER_API_KEY?.trim() || ""; const searchUrl = "https://www.mouser.com/c/?q=" + encodeURIComponent(entry.mpn);
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch("https://api.mouser.com/api/v1/search/partnumber?apiKey=" + encodeURIComponent(apiKey), { method: "POST", cache: "no-store", signal: controller.signal, headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ SearchByPartRequest: { mouserPartNumber: entry.mpn, partSearchOptions: "" } }) });
    const payload = await response.json().catch(() => null) as unknown; if (!response.ok) return failure(entry, "Mouser API request failed: HTTP " + response.status);
    const root = record(payload); const searchResults = record(root?.SearchResults); const parts = Array.isArray(searchResults?.Parts) ? searchResults.Parts.map(record).filter((part): part is Record<string, unknown> => Boolean(part)) : [];
    const expected = normalize(entry.mpn); const part = parts.find(item => [item.MouserPartNumber, item.ManufacturerPartNumber, item.ManufacturerPartNumberSearchable].some(candidate => normalize(candidate) === expected)); if (!part) return failure(entry, "Mouser exact MPN match not found");
    const priceBreaks = Array.isArray(part.PriceBreaks) ? part.PriceBreaks.map(record).filter((item): item is Record<string, unknown> => Boolean(item)) : []; const onePiece = priceBreaks.find(item => Number(item.Quantity) === 1) || priceBreaks[0]; const price = number(onePiece?.Price); if (price === null) return failure(entry, "Mouser quantity 1 price not found");
    const currency = text(onePiece?.Currency) || "USD"; const sourceUrl = text(part.ProductDetailUrl) || searchUrl; const updateDate = todayKey();
    return { id: entry.id, success: true, category: entry.category, material: entry.mpn, materialName: entry.name, mpn: entry.mpn, quantity: 1, price, currency, unit: currency + "/pcs", source: "Mouser", sourceUrl, updateDate, crawlTime: new Date().toISOString(), mode: "real", status: "success", history: [{ date: updateDate, price }] };
  } catch (error) { return failure(entry, error instanceof Error ? error.message : "Mouser API request failed"); } finally { clearTimeout(timeout); }
}
