import { NextResponse } from "next/server";
import { fetchPlasticPrice } from "../../../../lib/crawlers/plastic";
import type { TrackingEntry, PriceResult } from "../../../../lib/crawlers";

export const runtime = "edge";

function todayKey() {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date()).replaceAll("/", "-");
}

export async function POST(request: Request) {
  try {
    const entry = await request.json() as TrackingEntry;
    const result = await fetchPlasticPrice(entry, todayKey());
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Plastic crawler failed";
    const result: PriceResult = {
      success: false,
      category: "塑料件",
      material: "",
      price: null,
      currency: "RMB",
      unit: "RMB/ton",
      source: "SunSirs",
      updateDate: todayKey(),
      error: message,
    };
    return NextResponse.json(result, { status: 200 });
  }
}
