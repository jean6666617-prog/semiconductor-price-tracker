import { NextResponse } from "next/server";
import { getAIProvider } from "../../../../lib/ai/provider";
import { buildCopilotMessages } from "../../../../lib/ai/prompt";
import { buildLiveSearchQuery, shouldUseLiveSearch } from "../../../../lib/ai/search-intent";
import { createGroqLiveSearchProvider } from "../../../../lib/ai/search/groq";
import type { LiveSearchResult, Message, ProcurementContext } from "../../../../lib/ai/types";
import { isAIResponse, validateAIResponseAgainstContext } from "../../../../lib/ai/validation";

export const runtime = "edge";

function isContext(value: unknown): value is ProcurementContext {
  if (!value || typeof value !== "object") return false;
  const context = value as Partial<ProcurementContext>;
  return typeof context.materialName === "string" && typeof context.category === "string";
}

function isHistory(value: unknown): value is Message[] {
  return Array.isArray(value) && value.every((item) => item && typeof item === "object"
    && (item as Message).role !== undefined
    && ((item as Message).role === "user" || (item as Message).role === "assistant")
    && typeof (item as Message).content === "string");
}

function isLiveSearchResult(value: unknown): value is LiveSearchResult {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<LiveSearchResult>;
  if (typeof item.title !== "string" || !item.title.trim() || typeof item.url !== "string") return false;
  try {
    const url = new URL(item.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  } catch { return false; }
  return item.accessType === "live_search" && (!item.source || typeof item.source === "string");
}

function dedupeLiveSearchResults(context: ProcurementContext, results: LiveSearchResult[]) {
  const existingUrls = new Set([
    ...(context.news || []).map((item) => item.url),
    ...(context.marketAnalyses || []).map((item) => item.url),
    ...(context.sources || []).map((item) => item.url),
  ].filter((url): url is string => Boolean(url)).map((url) => url.toLowerCase()));
  const existingTitles = new Set([
    ...(context.news || []).map((item) => `${item.title}|${item.source || ""}`),
    ...(context.marketAnalyses || []).map((item) => `${item.title || ""}|${item.source || ""}`),
  ].map((key) => key.toLowerCase()));
  const seen = new Set<string>();
  return results.filter((item) => {
    const titleKey = `${item.title}|${item.source || ""}`.toLowerCase();
    const urlKey = item.url.toLowerCase();
    if (existingUrls.has(urlKey) || existingTitles.has(titleKey) || seen.has(urlKey) || seen.has(titleKey)) return false;
    seen.add(urlKey);
    seen.add(titleKey);
    return true;
  }).slice(0, 5);
}

export async function POST(request: Request) {
  let body: { question?: unknown; context?: unknown; history?: unknown; liveSearchResults?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON request body" }, { status: 400 });
  }
  if (typeof body.question !== "string" || !body.question.trim()) {
    return NextResponse.json({ success: false, error: "Question is required" }, { status: 400 });
  }
  if (!isContext(body.context)) {
    return NextResponse.json({ success: false, error: "A valid procurement context is required" }, { status: 400 });
  }
  if (body.history !== undefined && !isHistory(body.history)) {
    return NextResponse.json({ success: false, error: "Invalid message history" }, { status: 400 });
  }
  if (body.liveSearchResults !== undefined && (!Array.isArray(body.liveSearchResults) || !body.liveSearchResults.every(isLiveSearchResult))) {
    return NextResponse.json({ success: false, error: "Invalid live search results" }, { status: 400 });
  }

  try {
    const resolution = getAIProvider();
    if (!resolution.provider) {
      return NextResponse.json({
        success: false,
        status: resolution.unavailable?.code || "AI_SERVICE_UNAVAILABLE",
        error: resolution.unavailable?.message || "AI采购助手当前不可用。网站价格和趋势数据不受影响。",
      }, { status: 503 });
    }
    const currentQuestion = body.question.trim().slice(0, 2000);
    const priorHistory = body.history || [];
    const wantsLiveSearch = shouldUseLiveSearch(currentQuestion);
    // Live search is an optional paid capability. Keep it opt-in so a plan
    // limitation or network failure never blocks the normal procurement AI.
    const liveSearchEnabled = process.env.AI_LIVE_SEARCH_ENABLED?.trim().toLowerCase() === "true";
    const needsLiveSearch = wantsLiveSearch && liveSearchEnabled;
    const priorLiveSearchResults = dedupeLiveSearchResults(body.context, (body.liveSearchResults as LiveSearchResult[] | undefined) || []);
    let liveSearchResults = priorLiveSearchResults;
    let liveSearchError: string | undefined;
    let liveSearchQuery: string | undefined;
    if (wantsLiveSearch) {
      liveSearchQuery = buildLiveSearchQuery({ question: currentQuestion, materialName: body.context.materialName, category: body.context.category });
    }
    if (wantsLiveSearch && !liveSearchEnabled) {
      liveSearchError = "实时搜索需要付费升级，当前暂未开通；已降级使用普通 AI，并参考平台已爬取的新闻和机构分析。";
    } else if (needsLiveSearch) {
      const searchProvider = createGroqLiveSearchProvider();
      if (!searchProvider) {
        liveSearchError = "实时搜索服务未配置；已降级使用普通 AI，并参考平台已爬取的新闻和机构分析。";
      } else {
        try {
          const searchQuery = liveSearchQuery || buildLiveSearchQuery({ question: currentQuestion, materialName: body.context.materialName, category: body.context.category });
          liveSearchResults = dedupeLiveSearchResults(body.context, await searchProvider.search({ query: searchQuery, materialName: body.context.materialName, category: body.context.category }));
        } catch (searchError) {
          const detail = searchError instanceof Error ? searchError.message : "实时搜索暂时不可用";
          liveSearchError = `${detail}；已降级使用普通 AI，并参考平台已爬取的新闻和机构分析。`;
          console.warn("[AI Copilot] live search failed", { error: liveSearchError });
          liveSearchResults = priorLiveSearchResults;
        }
      }
    }
    const result = await resolution.provider.chat({
      question: currentQuestion,
      context: body.context,
      history: priorHistory,
      liveSearchResults,
    });
    if (!isAIResponse(result)) throw new Error("AI provider returned an invalid AIResponse schema");
    const debugMessages = process.env.NODE_ENV !== "production"
      ? buildCopilotMessages({ question: currentQuestion, context: body.context, history: priorHistory, liveSearchResults })
      : undefined;
    return NextResponse.json({
      success: true,
      result: validateAIResponseAgainstContext(result, body.context, liveSearchResults),
      liveSearch: { triggered: wantsLiveSearch, enabled: liveSearchEnabled, ...(liveSearchQuery ? { query: liveSearchQuery } : {}), results: liveSearchResults, ...(liveSearchError ? { error: liveSearchError } : {}) },
      ...(debugMessages ? { debugMessages } : {}),
    });
  } catch (error) {
    console.error("[AI Copilot] provider request failed", { error: String(error) });
    return NextResponse.json({
      success: false,
      status: "AI_SERVICE_UNAVAILABLE",
      error: "AI采购助手当前暂时不可用，网站价格和趋势数据仍可正常使用。请稍后重试。",
    }, { status: 503 });
  }
}
