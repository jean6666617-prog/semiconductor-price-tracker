export function responsePreview(text: string, length = 200) {
  return text.replace(/\s+/g, " ").trim().slice(0, length);
}

export function looksLikeHtml(text: string) {
  return /^\s*(?:<!doctype|<html)\b/i.test(text);
}

export function targetResponseError(label: string, response: Response, text: string, message: string) {
  const url = response.url || "unknown";
  return `${message}; HTTP status ${response.status}; URL ${url}; preview: ${responsePreview(text)}`;
}

export function assertJsonTargetResponse(label: string, response: Response, text: string) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json") || looksLikeHtml(text)) {
    throw new Error(targetResponseError(label, response, text, "Target website returned HTML instead of JSON"));
  }
}

export function parseJsonTargetResponse<T>(label: string, response: Response, text: string): T {
  assertJsonTargetResponse(label, response, text);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON response";
    throw new Error(targetResponseError(label, response, text, `${label} JSON parse failed: ${message}`));
  }
}

export function parseEmbeddedJson<T>(label: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid embedded JSON";
    throw new Error(`${label} embedded JSON parse failed: ${message}; preview: ${responsePreview(text)}`);
  }
}
