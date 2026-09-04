import { NextResponse } from "next/server";
import { activeLcscAutoUpdateModels, extendedCategoryModels } from "../../../../lib/modelSets";
import { fetchDigiKeyPrice, hasDigiKeyCredentials } from "../../../../lib/crawlers/digikey";
import { fetchLcscPrice } from "../../../../lib/crawlers/lcsc";
import type { KeyComponentEntry } from "../../../../lib/crawlers/cytech";
import type { TrackingEntry } from "../../../../lib/crawlers";
import { mergeCrawlerResultHistories, readCrawlerCache, writeCrawlerCache } from "../../../../lib/cache/edgeCrawlerCache";

export const runtime = "edge";

function authorized(request: Request) {
  const expected = process.env.CRON_SECRET?.trim();
  return Boolean(expected && request.headers.get("x-cron-secret")?.trim() === expected);
}

type ExtendedResult = {
  batchId: string; modelId: string; categoryName: string; modelName: string; manufacturer?: string; source?: string; requestUrl?: string; requestStartedAt: string; priceBreakQuantity?: number; minimumOrderQuantity?: number; selectedQuantity?: number; priceBreaks?: Array<{ quantity: number; price: number; currency: string }>; priceBasis?: "single-unit" | "minimum-public-tier";
  currentPrice?: number | null; currentPriceDate?: string; currentPriceOrigin?: string; attemptedCrawler?: string; responseStatus?: number; responseContentType?: string; responseBytes?: number; finalUrl?: string; price: number | null; currency: string; unit: string; priceObservedAt?: string; history?: Array<{ date: string; price: number; priceBreakQuantity?: number }>; finalStatus: "success" | "unchanged" | "not_found" | "price_not_available" | "parse_failed" | "validation_failed" | "blocked" | "timeout" | "rate_limited" | "source_unavailable" | "request_failed" | "unsupported_page_type" | "failed"; failureCode?: string; failureReason?: string;
};

function makeBatchId() { return `extended-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`; }
function base(model: typeof extendedCategoryModels[number], batchId: string, requestStartedAt: string): ExtendedResult {
  return { batchId, modelId: model.id, categoryName: model.category, modelName: model.trackedMpn || model.mpn || model.name, manufacturer: model.manufacturer, source: model.source, requestUrl: model.sourceUrl, requestStartedAt, currentPrice: model.currentPrice ?? null, currentPriceDate: model.currentPriceDate, currentPriceOrigin: model.priceOrigin, attemptedCrawler: /lcsc\.com/i.test(model.sourceUrl || "") ? "lcsc" : /digikey\.(?:com|sg)/i.test(model.sourceUrl || "") ? "digikey" : "public-source-probe", price: null, currency: "", unit: "", finalStatus: "failed" };
}

function classifyFailure(error: string) {
  const value = error.toLowerCase();
  if (/timeout|aborted|aborterror/.test(value)) return { status: "timeout" as const, code: "timeout" };
  if (/403|forbidden|challenge|cloudflare|access denied|blocked/.test(value)) return { status: "blocked" as const, code: "blocked" };
  if (/429|rate limit|too many requests/.test(value)) return { status: "rate_limited" as const, code: "rate_limited" };
  if (/mpn mismatch|mpn not found|not found/.test(value)) return { status: "not_found" as const, code: "not_found" };
  if (/price.*not found|price.*unavailable|quantity 1 price/.test(value)) return { status: "price_not_available" as const, code: "price_not_available" };
  if (/json|parse|webdata|invalid/.test(value)) return { status: "parse_failed" as const, code: "parse_failed" };
  return { status: "request_failed" as const, code: "request_failed" };
}

async function probePublicSource(model: typeof extendedCategoryModels[number], resultBase: ExtendedResult) {
  if (!model.sourceUrl) return { ...resultBase, finalStatus: "source_unavailable" as const, failureCode: "source_unavailable", failureReason: "未配置合法来源 URL" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(model.sourceUrl, { cache: "no-store", signal: controller.signal, redirect: "follow", headers: { Accept: "text/html,application/xhtml+xml,application/json", "User-Agent": "Mozilla/5.0" } });
    const body = await response.text();
    const responseBase = { ...resultBase, responseStatus: response.status, responseContentType: response.headers.get("content-type") || "", responseBytes: body.length, finalUrl: response.url };
    const sample = body.slice(0, 4000);
    if (/captcha|access denied|cloudflare|just a moment|verify you are human|sign in|log in/i.test(sample)) return { ...responseBase, finalStatus: "blocked" as const, failureCode: "blocked", failureReason: `来源返回访问限制页面（HTTP ${response.status}）` };
    if (response.status === 429) return { ...responseBase, finalStatus: "rate_limited" as const, failureCode: "rate_limited", failureReason: "来源返回 HTTP 429" };
    if (!response.ok) return { ...responseBase, finalStatus: "failed" as const, failureCode: "request_failed", failureReason: `来源请求失败（HTTP ${response.status}）` };
    const normalizedBody = body.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const normalizedMpn = (model.mpn || model.name).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!normalizedBody.includes(normalizedMpn)) return { ...responseBase, finalStatus: "not_found" as const, failureCode: "not_found", failureReason: "公开页面未找到准确型号" };
    return { ...responseBase, finalStatus: "price_not_available" as const, failureCode: "price_not_available", failureReason: "公开页面包含型号但未提供可验证的目标价格" };
  } catch (error) {
    const classified = classifyFailure(error instanceof Error ? error.message : "来源请求失败");
    return { ...resultBase, finalStatus: classified.status, failureCode: classified.code, failureReason: error instanceof Error ? error.message.slice(0, 180) : "来源请求失败" };
  } finally { clearTimeout(timer); }
}

async function probeLcscSearch(model: typeof extendedCategoryModels[number], resultBase: ExtendedResult, searchUrl: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(searchUrl, { cache: "no-store", redirect: "follow", signal: controller.signal, headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0" } });
    const body = await response.text();
    const base = { ...resultBase, source: "LCSC fallback", requestUrl: searchUrl, attemptedCrawler: "lcsc-search", responseStatus: response.status, responseContentType: response.headers.get("content-type") || "", responseBytes: body.length, finalUrl: response.url };
    if (!response.ok) return { ...base, finalStatus: "failed" as const, failureCode: "request_failed", failureReason: `LCSC 搜索请求失败（HTTP ${response.status}）` };
    const normalized = body.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const target = (model.mpn || model.name).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (normalized.includes(target)) return { ...base, finalStatus: "price_not_available" as const, failureCode: "price_not_available", failureReason: "LCSC 搜索页命中型号，但未返回可验证的阶梯价格" };
    if (/__NEXT_DATA__|id=["']__next["']|webpackJsonp|window\.__/.test(body)) return { ...base, finalStatus: "unsupported_page_type" as const, failureCode: "unsupported_page_type", failureReason: "LCSC 搜索结果依赖客户端渲染，响应未包含候选产品列表" };
    return { ...base, finalStatus: "not_found" as const, failureCode: "not_found", failureReason: "LCSC 搜索响应未找到准确型号" };
  } catch (error) {
    const classified = classifyFailure(error instanceof Error ? error.message : "LCSC 搜索请求失败");
    return { ...resultBase, source: "LCSC fallback", requestUrl: searchUrl, attemptedCrawler: "lcsc-search", finalStatus: classified.status, failureCode: classified.code, failureReason: error instanceof Error ? error.message.slice(0, 180) : "LCSC 搜索请求失败" };
  } finally { clearTimeout(timer); }
}

async function updateOne(model: typeof extendedCategoryModels[number], batchId: string): Promise<ExtendedResult> {
  const started = new Date().toISOString(); const resultBase = base(model, batchId, started); const mpn = model.mpn && model.mpn !== "—" ? model.mpn : model.name;
  try {
    if (/lcsc\.com/i.test(model.sourceUrl || "")) {
      const entry: KeyComponentEntry = { id: model.id, mpn, name: model.trackedMpn || model.name, category: model.category, description: model.spec || "", manufacturer: model.manufacturer, source: "LCSC", sourceUrl: model.sourceUrl || "", crawler: "lcsc", enabled: true, status: "已追踪" };
      const result = await fetchLcscPrice(entry);
      return result.success && result.price !== null
        ? { ...resultBase, source: result.source, price: result.price, currency: result.currency, unit: result.unit, priceBreakQuantity: result.priceBreakQuantity, minimumOrderQuantity: result.minimumOrderQuantity, selectedQuantity: result.selectedQuantity, priceBreaks: result.priceBreaks, priceBasis: result.priceBasis, priceObservedAt: result.updateDate, history: result.history, finalStatus: "success" }
        : (() => { const reason = result.error || "未找到该型号的有效报价"; const failure = classifyFailure(reason); return { ...resultBase, finalStatus: failure.status, failureCode: failure.code, failureReason: reason }; })();
    }
    if (/digikey\.(?:com|sg)/i.test(model.sourceUrl || "")) {
      if (!hasDigiKeyCredentials()) {
        const lcscSearchUrl = `https://www.lcsc.com/search?q=${encodeURIComponent(mpn)}`;
        return probeLcscSearch(model, resultBase, lcscSearchUrl);
      }
      const entry: TrackingEntry = { id: model.id, category: model.category, name: model.name, mpn, source: "DigiKey", url: model.sourceUrl, crawler: "digikey", mode: "real", unit: "USD/pcs", manufacturer: model.manufacturer, enabled: true };
      const result = await fetchDigiKeyPrice(entry, started.slice(0, 10));
      return result.success && result.price !== null
        ? { ...resultBase, source: result.source, price: result.price, currency: result.currency, unit: result.unit, priceObservedAt: result.updateDate, finalStatus: "success" }
        : (() => { const reason = result.error || "未找到该型号的有效报价"; const failure = classifyFailure(reason); return { ...resultBase, finalStatus: failure.status, failureCode: failure.code, failureReason: reason }; })();
    }
    return probePublicSource(model, resultBase);
  } catch (error) {
    return { ...resultBase, finalStatus: "failed", failureCode: "failed", failureReason: error instanceof Error ? error.message.slice(0, 180) : "更新失败" };
  }
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ success: false, error: "Scheduled refresh is not authorized" }, { status: 401 });
  let requestedIds: string[] | null = null;
  try {
    const body = await request.json() as { ids?: unknown };
    if (Array.isArray(body.ids) && body.ids.every((id) => typeof id === "string")) requestedIds = Array.from(new Set(body.ids));
  } catch { /* scheduled calls may omit a body */ }
  const activeModels = activeLcscAutoUpdateModels;
  const runModels = requestedIds
    ? activeModels.filter((model) => requestedIds!.includes(model.id))
    : activeModels;
  const batchId = makeBatchId(); const results: ExtendedResult[] = [];
  for (let index = 0; index < runModels.length; index += 4) {
    const chunk = await Promise.allSettled(runModels.slice(index, index + 4).map((model) => updateOne(model, batchId)));
    chunk.forEach((entry, offset) => results.push(entry.status === "fulfilled" ? entry.value : { ...base(runModels[index + offset], batchId, new Date().toISOString()), finalStatus: "failed", failureCode: "failed", failureReason: "更新失败" }));
  }
  const completedAt = new Date().toISOString();
  const cached = await readCrawlerCache<{ success: boolean; results: ExtendedResult[] }>("extended-category-results");
  const mergedResults = mergeCrawlerResultHistories(cached?.results || [], results);
  await writeCrawlerCache("extended-category-results", { success: true, batchId, completedAt, results: mergedResults }, 48 * 60 * 60);
  // POST reports this batch only; GET exposes the merged cache for the UI.
  return NextResponse.json({ success: true, batchId, completedAt, results });
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ success: false, error: "Scheduled refresh is not authorized" }, { status: 401 });
  const payload = await readCrawlerCache("extended-category-results");
  return NextResponse.json(payload || { success: true, batchId: null, completedAt: null, results: [] }, { headers: { "Cache-Control": "no-store" } });
}
