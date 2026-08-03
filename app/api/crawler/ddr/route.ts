import { NextResponse } from "next/server";
import { fetchDDRMarketData, type DDRFallbackInput } from "../../../../lib/crawlers/ddr";

export const runtime = "edge";

export async function GET() {
  const data = await fetchDDRMarketData();
  return NextResponse.json(data);
}

export async function POST(request: Request) {
  try {
    const fallback = await request.json() as DDRFallbackInput;
    const data = await fetchDDRMarketData(fallback);
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({
      success: false,
      status: "access_restricted",
      spotPrices: [],
      contractPrices: [],
      marketAnalyses: [],
      industryNews: [],
      error: error instanceof Error ? error.message : "DDR crawler fallback payload failed",
    }, { status: 200 });
  }
}
