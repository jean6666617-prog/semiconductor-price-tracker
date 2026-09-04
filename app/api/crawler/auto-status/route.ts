import { NextResponse } from "next/server";
import { readCrawlerCache, writeCrawlerCache } from "../../../../lib/cache/edgeCrawlerCache";

export const runtime = "edge";

type AutoStatusPayload = { startedAt?: string; runAt: string; completedAt?: string; lastSuccessfulUpdateAt?: string; status?: "success" | "partial" | "failed"; results: Array<Record<string, unknown>> };

function authorized(request: Request) {
  const expected = process.env.CRON_SECRET?.trim();
  const provided = request.headers.get("x-cron-secret")?.trim();
  return Boolean(expected && provided && expected === provided);
}

export async function GET() {
  const payload = await readCrawlerCache<AutoStatusPayload>("automatic-update-status");
  return NextResponse.json(payload || { runAt: null, results: [] }, { headers: { "X-Crawler-Cache": payload ? "HIT" : "MISS" } });
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ success: false, error: "Scheduled refresh is not authorized" }, { status: 401 });
  let payload: AutoStatusPayload;
  try { payload = await request.json() as AutoStatusPayload; } catch { return NextResponse.json({ success: false, error: "Invalid JSON request body" }, { status: 400 }); }
  if (!payload || typeof payload.runAt !== "string" || !Array.isArray(payload.results)) return NextResponse.json({ success: false, error: "Invalid automatic update status payload" }, { status: 400 });
  const previous = await readCrawlerCache<AutoStatusPayload>("automatic-update-status");
  const lastSuccessfulUpdateAt = payload.status === "success"
    ? payload.completedAt || payload.runAt
    : previous?.lastSuccessfulUpdateAt;
  await writeCrawlerCache("automatic-update-status", { ...payload, lastSuccessfulUpdateAt }, 48 * 60 * 60);
  return NextResponse.json({ success: true });
}
