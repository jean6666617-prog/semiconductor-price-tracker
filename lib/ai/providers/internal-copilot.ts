import type { AIProvider, AIResponse } from "../types";

export function createInternalCopilotProvider(): AIProvider | null {
  const url = process.env.INTERNAL_COPILOT_URL?.trim();
  if (!url) return null;
  return {
    async chat(input) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.INTERNAL_COPILOT_CLIENT_ID ? { "X-Client-Id": process.env.INTERNAL_COPILOT_CLIENT_ID } : {}),
          ...(process.env.INTERNAL_COPILOT_SCOPE ? { "X-Scope": process.env.INTERNAL_COPILOT_SCOPE } : {}),
        },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(`Internal Copilot request failed: HTTP ${response.status}`);
      return await response.json() as AIResponse;
    },
  };
}
