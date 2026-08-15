import type { LiveSearchProvider } from ".";
import type { LiveSearchResult } from "../types";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESULTS = 5;

function endpoint(baseUrl: string) {
  const normalized = baseUrl.replace(/\/$/, "");
  return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function urlValue(value: unknown) {
  const valueString = stringValue(value);
  if (!valueString) return undefined;
  try {
    const url = new URL(valueString);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeCandidate(value: unknown): LiveSearchResult | null {
  if (!isRecord(value)) return null;
  const url = urlValue(value.url || value.link || value.href);
  const title = stringValue(value.title || value.name || value.headline);
  if (!url || !title) return null;
  const source = stringValue(value.source || value.publisher || value.domain);
  const publishedAt = stringValue(value.publishedAt || value.published_at || value.date || value.published);
  const snippet = stringValue(value.snippet || value.description || value.summary || value.content);
  return {
    title,
    url,
    ...(source ? { source } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(snippet ? { snippet } : {}),
    sourceType: source?.toLowerCase().includes("bloomberg") ? "authoritative_news" : "news",
    accessType: "live_search",
  };
}

function collectCandidates(value: unknown, output: LiveSearchResult[], depth = 0) {
  if (depth > 5 || output.length >= MAX_RESULTS) return;
  const direct = normalizeCandidate(value);
  if (direct) output.push(direct);
  if (Array.isArray(value)) {
    value.forEach((item) => collectCandidates(item, output, depth + 1));
  } else if (isRecord(value)) {
    Object.values(value).forEach((item) => collectCandidates(item, output, depth + 1));
  }
}

function extractResults(payload: unknown) {
  const output: LiveSearchResult[] = [];
  const root = isRecord(payload) ? payload : {};
  const choice = Array.isArray(root.choices) && isRecord(root.choices[0]) ? root.choices[0] : undefined;
  const message = choice && isRecord(choice.message) ? choice.message : undefined;
  collectCandidates(message?.executed_tools, output);
  collectCandidates(message?.tool_calls, output);
  collectCandidates(message?.content, output);
  collectCandidates(root.citations, output);
  collectCandidates(root.executed_tools, output);
  const seen = new Set<string>();
  return output.filter((item) => {
    const key = item.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_RESULTS);
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

export function createGroqLiveSearchProvider(): LiveSearchProvider | null {
  const baseUrl = process.env.EXTERNAL_AI_BASE_URL?.trim();
  const apiKey = process.env.EXTERNAL_AI_API_KEY?.trim();
  const model = process.env.EXTERNAL_AI_MODEL?.trim();
  if (!baseUrl || !apiKey || !model) return null;

  return {
    async search({ query }) {
      let response: Response;
      try {
        response = await fetchWithTimeout(endpoint(baseUrl), {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: query }],
            temperature: 0.2,
            tool_choice: "required",
            tools: [{ type: "browser_search" }],
            max_completion_tokens: 1200,
          }),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.name : "unknown";
        throw new Error(`Live Search network request failed (${detail})`);
      }
      if (!response.ok) throw new Error(`Live Search request failed: HTTP ${response.status}`);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Live Search returned a non-JSON response");
      }
      return extractResults(payload);
    },
  };
}
