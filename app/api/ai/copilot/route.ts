import { NextResponse } from "next/server";
import { getAIProvider } from "../../../../lib/ai/provider";
import type { Message, ProcurementContext } from "../../../../lib/ai/types";
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

export async function POST(request: Request) {
  let body: { question?: unknown; context?: unknown; history?: unknown };
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

  try {
    const resolution = getAIProvider();
    if (!resolution.provider) {
      return NextResponse.json({
        success: false,
        status: resolution.unavailable?.code || "AI_SERVICE_UNAVAILABLE",
        error: resolution.unavailable?.message || "AI采购助手当前不可用。网站价格和趋势数据不受影响。",
      }, { status: 503 });
    }
    const result = await resolution.provider.chat({
      question: body.question.trim().slice(0, 2000),
      context: body.context,
      history: body.history,
    });
    if (!isAIResponse(result)) throw new Error("AI provider returned an invalid AIResponse schema");
    return NextResponse.json({ success: true, result: validateAIResponseAgainstContext(result, body.context) });
  } catch (error) {
    console.error("[AI Copilot] provider request failed", { error: String(error) });
    return NextResponse.json({
      success: false,
      status: "AI_SERVICE_UNAVAILABLE",
      error: "AI采购助手当前暂时不可用，网站价格和趋势数据仍可正常使用。请稍后重试。",
    }, { status: 503 });
  }
}
