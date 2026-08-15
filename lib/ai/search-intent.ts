const SEARCH_TERMS = [
  "最新", "新闻", "资讯", "报道", "最近消息", "近期消息", "今天", "实时", "前沿资讯", "市场消息", "行业动态", "搜索实时新闻",
  "latest", "news", "recent", "today", "breaking", "market update", "recent report", "live news",
];

export function shouldUseLiveSearch(question: string) {
  const normalized = question.trim().toLowerCase();
  return Boolean(normalized) && SEARCH_TERMS.some((term) => normalized.includes(term));
}

export function buildLiveSearchQuery(input: { question: string; materialName?: string; category?: string }) {
  return [input.materialName, input.category, input.question.trim(), "semiconductor supply price market news"].filter(Boolean).join(" ").slice(0, 500);
}
