import { NextResponse } from "next/server";
import { getAIProvider } from "../../../../lib/ai/provider";
import { runEvaluation } from "../../../../lib/ai/evaluation/run";

export const runtime = "edge";

export async function POST() {
  if (process.env.ENABLE_AI_EVALUATION !== "true") {
    return NextResponse.json({ success: false, error: "AI evaluation is disabled" }, { status: 404 });
  }
  const resolution = getAIProvider();
  if (!resolution.provider) {
    return NextResponse.json({ success: false, status: "AI_SERVICE_UNAVAILABLE", error: "AI evaluation provider is unavailable" }, { status: 503 });
  }
  try {
    const model = resolution.name === "external" ? process.env.EXTERNAL_AI_MODEL?.trim() || "configured" : resolution.name === "internal-copilot" ? "internal-copilot" : "mock";
    const run = await runEvaluation({ provider: resolution.provider, providerName: resolution.name, model });
    return NextResponse.json({ success: true, ...run });
  } catch (error) {
    console.error("[AI Evaluation] run failed", { error: String(error) });
    return NextResponse.json({ success: false, error: "AI evaluation failed" }, { status: 500 });
  }
}
