import { mockProvider } from "./providers/mock";
import { createExternalProvider } from "./providers/external";
import { createInternalCopilotProvider } from "./providers/internal-copilot";
import type { AIProviderResolution } from "./types";

function unavailable(name: string, reason: string): AIProviderResolution {
  return {
    provider: null,
    name,
    unavailable: {
      code: "AI_SERVICE_UNAVAILABLE",
      message: `AI采购助手当前不可用：${reason}。网站价格和趋势数据不受影响。`,
    },
  };
}

export function getAIProvider(): AIProviderResolution {
  const configured = process.env.AI_PROVIDER?.trim();
  const isDevelopment = process.env.NODE_ENV !== "production";
  if (!configured) {
    if (isDevelopment) return { provider: mockProvider, name: "mock" };
    return unavailable("unset", "生产环境未配置 AI_PROVIDER");
  }
  const selected = configured;
  if (selected === "mock") return { provider: mockProvider, name: selected };
  if (selected === "internal-copilot") {
    const provider = createInternalCopilotProvider();
    if (provider) return { provider, name: selected };
    return isDevelopment
      ? { provider: mockProvider, name: "mock" }
      : unavailable(selected, "内部 Copilot 连接配置缺失");
  }
  if (selected === "external") {
    const provider = createExternalProvider();
    if (provider) return { provider, name: selected };
    return isDevelopment
      ? { provider: mockProvider, name: "mock" }
      : unavailable(selected, "外部 AI 连接配置缺失");
  }
  return isDevelopment
    ? { provider: mockProvider, name: "mock" }
    : unavailable(selected, "Provider 配置不受支持");
}
