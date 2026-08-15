import { buildCopilotMessages } from "../prompt";
import { isAIResponse, validateAIResponseAgainstContext } from "../validation";
import type { AIProvider, AIResponse, PromptMessage } from "../types";

const REQUEST_TIMEOUT_MS = 20_000;

export type ExternalAIErrorCode = "RATE_LIMIT" | "PROVIDER_ERROR" | "NETWORK_ERROR";

export class ExternalAIRequestError extends Error {
  readonly status?: number;
  readonly code: ExternalAIErrorCode;
  readonly retryAfterMs?: number;
  readonly rateLimitHeaders: Record<string, string>;

  constructor(message: string, options: {
    status?: number;
    code: ExternalAIErrorCode;
    retryAfterMs?: number;
    rateLimitHeaders?: Record<string, string>;
  }) {
    super(message);
    this.name = "ExternalAIRequestError";
    this.status = options.status;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
    this.rateLimitHeaders = options.rateLimitHeaders || {};
  }
}

function endpoint(baseUrl: string) {
  const normalized = baseUrl.replace(/\/$/, "");
  return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
}

function parseJsonContent(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

function extractResponse(payload: unknown, context: Parameters<AIProvider["chat"]>[0]["context"], liveSearchResults: Parameters<AIProvider["chat"]>[0]["liveSearchResults"]): AIResponse {
  if (!payload || typeof payload !== "object") throw new Error("External AI returned an invalid response body");
  const choice = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0];
  if (typeof choice?.message?.content !== "string") throw new Error("External AI response did not contain message content");
  let parsed: unknown;
  try {
    parsed = parseJsonContent(choice.message.content);
  } catch {
    throw new Error("External AI returned invalid JSON content");
  }
  if (!isAIResponse(parsed)) throw new Error("External AI returned an invalid AIResponse schema");
  return validateAIResponseAgainstContext(parsed, context, liveSearchResults);
}

async function fetchWithTimeout(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function parseRetryAfter(value: string | null) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function rateLimitHeaders(response: Response) {
  const names = [
    "x-ratelimit-remaining-requests",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
  ];
  return Object.fromEntries(names.flatMap((name) => {
    const value = response.headers.get(name);
    return value === null ? [] : [[name, value]];
  }));
}

export function createExternalProvider(): AIProvider | null {
  const baseUrl = process.env.EXTERNAL_AI_BASE_URL?.trim();
  const apiKey = process.env.EXTERNAL_AI_API_KEY?.trim();
  const model = process.env.EXTERNAL_AI_MODEL?.trim();
  if (!baseUrl || !apiKey || !model) return null;

  return {
    async chat(input) {
      const messages: PromptMessage[] = buildCopilotMessages(input);
      const response = await fetchWithTimeout(endpoint(baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          response_format: { type: "json_object" },
        }),
      });
      if (!response.ok) {
        const status = response.status;
        throw new ExternalAIRequestError(`External AI request failed: HTTP ${status}`, {
          status,
          code: status === 429 ? "RATE_LIMIT" : "PROVIDER_ERROR",
          retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
          rateLimitHeaders: rateLimitHeaders(response),
        });
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("External AI returned a non-JSON response");
      }
      return extractResponse(payload, input.context, input.liveSearchResults);
    },
  };
}
