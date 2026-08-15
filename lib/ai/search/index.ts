import type { LiveSearchResult } from "../types";

export interface LiveSearchProvider {
  search(input: { query: string; materialName?: string; category?: string }): Promise<LiveSearchResult[]>;
}

export class LiveSearchError extends Error {
  readonly code: "CONFIGURATION" | "PROVIDER_ERROR" | "NETWORK_ERROR";

  constructor(message: string, code: LiveSearchError["code"]) {
    super(message);
    this.name = "LiveSearchError";
    this.code = code;
  }
}
