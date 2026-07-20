import type { PriceResult, TrackingEntry } from "./index";

const mockPrices: Record<string, number> = {
  "DDR5 16Gb (2Gx8) 4800/5600": 48.5,
};

export async function fetchTrendForcePrice(entry: TrackingEntry, updateDate: string): Promise<PriceResult> {
  const supported = entry.category === "DDR内存";
  return {
    success: supported,
    category: entry.category,
    material: entry.name,
    price: supported ? mockPrices[entry.name] ?? 48.5 : null,
    currency: "USD",
    unit: "USD",
    source: "TrendForce",
    updateDate,
  };
}
