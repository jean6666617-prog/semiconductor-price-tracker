export type PricePoint = { date: string; price: number };

export type SourceType =
  | "pricing"
  | "industry_research"
  | "news"
  | "distributor"
  | "commodity"
  | "authoritative_news";

export type AccessType = "crawler" | "api" | "manual" | "link_only" | "licensed";

export type Source = {
  label: string;
  url?: string;
  value?: string;
  sourceType?: SourceType;
  accessType?: AccessType;
};

export type NewsItem = {
  title: string;
  summary?: string;
  source?: string;
  url?: string;
  date?: string;
  sourceType?: SourceType;
  accessType?: AccessType;
};

export type MarketAnalysis = {
  title?: string;
  summary?: string;
  source?: string;
  url?: string;
  date?: string;
};

export type MarketFactors = {
  positiveFactors: string[];
  negativeFactors: string[];
  marketView?: string;
};

export type DataCoverage = {
  historyPoints: number;
  historySpanDays: number;
  hasCurrentPrice: boolean;
  hasSource: boolean;
  hasNews: boolean;
  hasMarketAnalysis: boolean;
  hasMarketFactors: boolean;
  has7dBaseline: boolean;
  has30dBaseline: boolean;
  hasEnoughHistory: boolean;
};

export interface ProcurementContext {
  materialName: string;
  category: string;
  currentPrice?: number;
  currency?: string;
  unit?: string;
  change7d?: number;
  change30d?: number;
  change1d?: number;
  streak?: number;
  trendDirection?: string;
  riskLevel?: string;
  riskReason?: string;
  history?: PricePoint[];
  sources?: Source[];
  news?: NewsItem[];
  marketAnalyses?: MarketAnalysis[];
  marketFactors?: MarketFactors;
  lastUpdated?: string;
  timeRange?: string;
  dataCoverage?: DataCoverage;
}

export type Message = {
  role: "user" | "assistant";
  content: string;
};

export type PromptMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type Evidence = {
  label: string;
  source?: string;
  value?: string;
};

export type AIDriverType = "data" | "news" | "market_analysis" | "platform_analysis" | "inference";

export type AIDriver = {
  text: string;
  type: AIDriverType;
  source?: string;
};

export type AIRecommendation = {
  text: string;
  action?: string;
};

export type AIResponse = {
  summary: string;
  drivers: AIDriver[];
  risk: {
    level: "low" | "medium" | "high" | "unknown";
    explanation: string;
  };
  recommendation: AIRecommendation;
  evidence?: Evidence[];
  dataConfidence?: "low" | "medium" | "high";
  disclaimer?: string;
};

export interface AIProvider {
  chat(input: {
    question: string;
    context: ProcurementContext;
    history?: Message[];
  }): Promise<AIResponse>;
}

export type AIProviderResolution = {
  provider: AIProvider | null;
  name: string;
  unavailable?: {
    code: "AI_SERVICE_UNAVAILABLE";
    message: string;
  };
};
