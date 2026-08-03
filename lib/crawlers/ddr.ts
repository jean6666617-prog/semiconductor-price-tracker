export type DDRSpotPriceRecord = {
  type: "spot_price";
  source: "DRAMeXchange";
  product: string;
  price: string;
  currency: string;
  unit: string;
  date: string;
  url: string;
};

export type DDRContractPriceRecord = {
  type: "contract_price";
  source: ["DRAMeXchange", "TrendForce"];
  product: string;
  price: string;
  trend: string;
  date: string;
  url: string;
};

export type DDRMarketAnalysisRecord = {
  type: "market_analysis";
  source: "TrendForce";
  title: string;
  date: string;
  summary: string;
  factors: string[];
  url: string;
};

export type DDRIndustryNewsRecord = {
  type: "industry_news";
  source: "DigiTimes";
  title: string;
  date: string;
  summary: string;
  url: string;
};

export type DDRMarketData = {
  success: boolean;
  status: "ready" | "access_restricted" | "empty";
  spotPrices: DDRSpotPriceRecord[];
  contractPrices: DDRContractPriceRecord[];
  marketAnalyses: DDRMarketAnalysisRecord[];
  industryNews: DDRIndustryNewsRecord[];
  sourceUrls: typeof ddrSourceUrls;
  errors: string[];
};

export type DDRFallbackInput = Partial<Pick<DDRMarketData, "spotPrices" | "contractPrices" | "marketAnalyses" | "industryNews">>;

export const ddrSourceUrls = {
  spotPrice: "https://www.dramexchange.com/",
  contractPriceDramExchange: "https://www.dramexchange.com/",
  contractPriceTrendForce: "https://www.trendforce.cn/",
  marketAnalysis: "https://www.trendforce.cn/",
  industryNews: "https://www.digitimes.com/",
} as const;

function hasFallbackData(fallback?: DDRFallbackInput) {
  return Boolean(
    fallback?.spotPrices?.length
    || fallback?.contractPrices?.length
    || fallback?.marketAnalyses?.length
    || fallback?.industryNews?.length,
  );
}

function emptyData(status: DDRMarketData["status"], errors: string[] = []): DDRMarketData {
  return {
    success: false,
    status,
    spotPrices: [],
    contractPrices: [],
    marketAnalyses: [],
    industryNews: [],
    sourceUrls: ddrSourceUrls,
    errors,
  };
}

export async function fetchDDRSpotPrices(): Promise<DDRSpotPriceRecord[]> {
  // DRAMeXchange access may require browser/session handling. Keep the crawler boundary stable without fabricating prices.
  return [];
}

export async function fetchDDRContractPrices(): Promise<DDRContractPriceRecord[]> {
  // Contract price records are reserved for DRAMeXchange plus TrendForce ingestion.
  return [];
}

export async function fetchDDRMarketAnalyses(): Promise<DDRMarketAnalysisRecord[]> {
  // TrendForce China is the fixed market trend source for DDR analysis.
  return [];
}

export async function fetchDDRIndustryNews(): Promise<DDRIndustryNewsRecord[]> {
  // DigiTimes news ingestion is reserved for explaining DDR price movement drivers.
  return [];
}

export async function fetchDDRMarketData(fallback?: DDRFallbackInput): Promise<DDRMarketData> {
  if (hasFallbackData(fallback)) {
    return {
      success: true,
      status: "ready",
      spotPrices: fallback?.spotPrices ?? [],
      contractPrices: fallback?.contractPrices ?? [],
      marketAnalyses: fallback?.marketAnalyses ?? [],
      industryNews: fallback?.industryNews ?? [],
      sourceUrls: ddrSourceUrls,
      errors: [],
    };
  }

  const [spotPrices, contractPrices, marketAnalyses, industryNews] = await Promise.all([
    fetchDDRSpotPrices(),
    fetchDDRContractPrices(),
    fetchDDRMarketAnalyses(),
    fetchDDRIndustryNews(),
  ]);

  if (spotPrices.length || contractPrices.length || marketAnalyses.length || industryNews.length) {
    return {
      success: true,
      status: "ready",
      spotPrices,
      contractPrices,
      marketAnalyses,
      industryNews,
      sourceUrls: ddrSourceUrls,
      errors: [],
    };
  }

  return emptyData("access_restricted", [
    "DRAMeXchange DDR spot/contract price crawler interface is reserved; no public record was ingested.",
    "TrendForce market analysis crawler interface is reserved; no public record was ingested.",
    "DigiTimes industry news crawler interface is reserved; no public record was ingested.",
  ]);
}
