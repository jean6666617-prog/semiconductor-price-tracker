"use client";

import { useEffect, useState } from "react";
import type { AIResponse, AIDriver, Message, ProcurementContext } from "../../lib/ai/types";

type Props = {
  open: boolean;
  context: ProcurementContext | null;
  onClose: () => void;
};

const suggestions = [
  "为什么这个物料最近上涨？",
  "这个趋势是否值得关注？",
  "是否存在提前备货风险？",
  "过去30天最大的价格变化是什么？",
  "这条判断依据哪些数据？",
];

function percent(value?: number) {
  return typeof value === "number" ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%` : "暂无数据";
}

function priceLabel(context: ProcurementContext) {
  if (typeof context.currentPrice !== "number") return "暂无数据";
  return [context.currentPrice, context.currency, context.unit ? `/ ${context.unit}` : ""].filter(Boolean).join(" ");
}

function countLabel(value: number | undefined) {
  return typeof value === "number" && value > 0 ? `${value} 条` : "暂无数据";
}

function sourceLabel(source?: string) {
  return source || "来源未标注";
}

function sourceMeta(item: { source?: string; accessType?: string }) {
  if (item.source !== "Bloomberg") return "";
  if (item.accessType === "link_only") return " · 权威外部来源 · 仅链接";
  if (item.accessType === "manual") return " · 权威外部来源 · 人工录入";
  return "";
}

function driverTypeLabel(type: AIDriver["type"]) {
  if (type === "data") return "平台数据";
  if (type === "news") return "新闻";
  if (type === "market_analysis") return "机构分析";
  if (type === "platform_analysis") return "平台判断";
  return "AI推断";
}

function riskLabel(level: AIResponse["risk"]["level"]) {
  if (level === "high") return "高风险";
  if (level === "medium") return "中风险";
  if (level === "low") return "低风险";
  return "数据不足";
}

function isUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

export default function ProcurementAiDrawer({ open, context, onClose }: Props) {
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<Message[]>([]);
  const [result, setResult] = useState<AIResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [serviceUnavailable, setServiceUnavailable] = useState(false);
  const [showContextDebug, setShowContextDebug] = useState(false);

  useEffect(() => {
    if (open) {
      setQuestion("");
      setHistory([]);
      setResult(null);
      setError("");
      setServiceUnavailable(false);
      setShowContextDebug(false);
    }
  }, [open, context?.materialName]);

  if (!open || !context) return null;

  async function ask(value: string) {
    const trimmed = value.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError("");
    setServiceUnavailable(false);
    setQuestion("");
    const nextHistory = [...history, { role: "user" as const, content: trimmed }];
    setHistory(nextHistory);
    try {
      const response = await fetch("/api/ai/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed, context, history }),
      });
      const payload = await response.json() as { success?: boolean; result?: AIResponse; status?: string; error?: string };
      if (payload.status === "AI_SERVICE_UNAVAILABLE") {
        setServiceUnavailable(true);
        setError(payload.error || "AI采购助手当前不可用，网站价格和趋势数据仍可正常使用。");
        return;
      }
      if (!response.ok || !payload.success || !payload.result) throw new Error(payload.error || "AI分析暂时不可用");
      setResult(payload.result);
      setHistory([...nextHistory, { role: "assistant", content: payload.result.summary }]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "AI分析暂时不可用");
    } finally {
      setLoading(false);
    }
  }

  const coverage = context.dataCoverage;
  const sources = context.sources || [];
  const news = context.news || [];
  const marketAnalyses = context.marketAnalyses || [];
  const hasPlatformAnalysis = Boolean(context.riskLevel || context.riskReason || context.trendDirection || context.marketFactors);

  return <div className="procurement-ai-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="procurement-ai-drawer" role="dialog" aria-modal="true" aria-labelledby="procurement-ai-title">
      <div className="procurement-ai-header">
        <div><p className="kicker">PROCUREMENT AI COPILOT</p><h2 id="procurement-ai-title">AI采购助手</h2></div>
        <button type="button" className="procurement-ai-close" onClick={onClose} aria-label="关闭 AI采购助手">×</button>
      </div>
      <div className="procurement-ai-body">
        <section className="procurement-ai-subject">
          <span>当前分析对象</span>
          <strong>{context.materialName}</strong>
          <small>{context.category} · 更新于 {context.lastUpdated || "暂无数据"}</small>
        </section>

        <section className="procurement-ai-layer procurement-ai-platform-data" aria-label="平台数据">
          <div className="procurement-ai-layer-heading"><h3>平台数据</h3><span>Platform Data</span></div>
          <div className="procurement-ai-context">
            <div><span>当前价格</span><b>{priceLabel(context)}</b></div>
            <div><span>1日变化</span><b>{percent(context.change1d)}</b></div>
            <div><span>7日变化</span><b>{percent(context.change7d)}</b></div>
            <div><span>30日变化</span><b>{percent(context.change30d)}</b></div>
            <div><span>连续变化</span><b>{typeof context.streak === "number" ? `${context.streak} 天` : "暂无数据"}</b></div>
            <div><span>历史样本</span><b>{countLabel(coverage?.historyPoints)}</b></div>
            <div><span>更新时间</span><b>{context.lastUpdated || "暂无数据"}</b></div>
            <div><span>历史跨度</span><b>{coverage?.historySpanDays ? `${coverage.historySpanDays} 天` : "暂无数据"}</b></div>
          </div>
          <div className="procurement-ai-source-row"><span>来源</span>{sources.length ? sources.map((source, index) => source.url ? <a href={source.url} target="_blank" rel="noreferrer" key={`${source.label}-${index}`}>{source.label} ↗</a> : <b key={`${source.label}-${index}`}>{source.label}</b>) : <b>暂无数据</b>}</div>
        </section>

        <section className="procurement-ai-layer procurement-ai-external-evidence" aria-label="外部证据">
          <div className="procurement-ai-layer-heading"><h3>外部证据</h3><span>External Evidence</span></div>
          <div className="procurement-ai-subsection"><strong>新闻</strong>{news.length ? news.slice(0, 4).map((item, index) => <div className="procurement-ai-source-item" key={`${item.title}-${index}`}><span>{sourceLabel(item.source)}{sourceMeta(item)}{item.date ? ` · ${item.date}` : ""}</span>{item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.title} ↗</a> : <b>{item.title}</b>}<small>{item.summary || "暂无摘要"}</small></div>) : <small>暂无新闻数据</small>}</div>
          <div className="procurement-ai-subsection"><strong>机构市场分析</strong>{marketAnalyses.length ? marketAnalyses.slice(0, 4).map((item, index) => <div className="procurement-ai-source-item" key={`${item.title || "analysis"}-${index}`}><span>{sourceLabel(item.source)}{item.date ? ` · ${item.date}` : ""}</span>{item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.title || "机构分析"} ↗</a> : <b>{item.title || "机构分析"}</b>}<small>{item.summary || "暂无摘要"}</small></div>) : <small>暂无机构市场分析</small>}</div>
        </section>

        {hasPlatformAnalysis && <section className="procurement-ai-layer procurement-ai-platform-analysis" aria-label="平台分析">
          <div className="procurement-ai-layer-heading"><h3>平台分析</h3><span>Platform Analysis</span></div>
          {context.riskLevel || context.riskReason ? <div className="procurement-ai-analysis-row"><strong>平台风险：{context.riskLevel || "暂无数据"}</strong><p>{context.riskReason || "暂无判断依据"}</p></div> : null}
          {context.trendDirection ? <div className="procurement-ai-analysis-row"><strong>平台趋势：{context.trendDirection}</strong></div> : null}
          {context.marketFactors && <div className="procurement-ai-factors"><strong>平台市场因素</strong><div><span>利多</span><p>{context.marketFactors.positiveFactors.length ? context.marketFactors.positiveFactors.join("；") : "暂无数据"}</p></div><div><span>利空</span><p>{context.marketFactors.negativeFactors.length ? context.marketFactors.negativeFactors.join("；") : "暂无数据"}</p></div><div><span>市场观点</span><p>{context.marketFactors.marketView || "暂无数据"}</p></div></div>}
        </section>}

        {process.env.NODE_ENV !== "production" && <section className="procurement-ai-debug">
          <button type="button" onClick={() => setShowContextDebug((current) => !current)}>{showContextDebug ? "隐藏 AI Context" : "查看 AI Context"}</button>
          {showContextDebug && <pre>{JSON.stringify(context, null, 2)}</pre>}
        </section>}

        {!result && !loading && <section className="procurement-ai-suggestions"><h3>你可以这样问</h3><div>{suggestions.map((item) => <button type="button" key={item} onClick={() => void ask(item)}>{item}</button>)}</div></section>}
        {loading && <div className="procurement-ai-loading">正在基于平台数据、外部证据和平台分析生成 AI 推断…</div>}
        {error && <div className={`procurement-ai-error ${serviceUnavailable ? "is-service-unavailable" : ""}`}><strong>{serviceUnavailable ? "AI服务暂不可用" : "分析请求失败"}</strong><span>{error}</span>{serviceUnavailable && <small>当前价格、历史趋势和自动抓取功能不受影响。</small>}</div>}
        {result && <>
          <section className="procurement-ai-layer procurement-ai-inference" aria-label="AI推断">
            <div className="procurement-ai-layer-heading"><h3>AI推断</h3><span>Data Support · 数据支撑度 {result.dataConfidence || "暂无数据"}</span></div>
            <div className="procurement-ai-result-block"><h4>市场变化</h4><p>{result.summary}</p></div>
            <div className="procurement-ai-result-block"><h4>可能原因</h4><ul className="procurement-ai-driver-list">{result.drivers.map((driver, index) => <li key={`${driver.text}-${index}`}><span className="procurement-ai-tag">{driverTypeLabel(driver.type)}</span><p>{driver.text}</p>{driver.source && <small>来源：{driver.source}</small>}</li>)}</ul></div>
            <div className={`procurement-ai-risk risk-${result.risk.level}`}><div><h4>AI风险解释</h4><strong>{riskLabel(result.risk.level)}</strong></div><p>{result.risk.explanation}</p></div>
          </section>
          <section className="procurement-ai-layer procurement-ai-recommendation" aria-label="采购建议">
            <div className="procurement-ai-layer-heading"><h3>采购建议</h3><span>AI决策参考</span></div>
            <p>{result.recommendation.text}</p>
            {result.recommendation.action && <small>建议动作：{result.recommendation.action}</small>}
          </section>
          <section className="procurement-ai-layer procurement-ai-result-block" aria-label="数据依据"><div className="procurement-ai-layer-heading"><h3>数据依据</h3><span>Evidence</span></div><ul className="procurement-ai-evidence">{(result.evidence || []).length ? result.evidence?.map((item, index) => <li key={`${item.label}-${index}`}><span>{item.label}</span><b>{item.value || "暂无数据"}</b>{item.source && (isUrl(item.source) ? <a href={item.source} target="_blank" rel="noreferrer">来源 ↗</a> : <small>来源：{item.source}</small>)}</li>) : <li><span>可核验依据</span><b>暂无数据</b></li>}</ul></section>
          {result.disclaimer && <small className="procurement-ai-disclaimer">{result.disclaimer}</small>}
          <button type="button" className="procurement-ai-more" onClick={() => setResult(null)}>继续提问</button>
        </>}
      </div>
      <form className="procurement-ai-input" onSubmit={(event) => { event.preventDefault(); void ask(question); }}>
        <input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="询问这个物料的价格、趋势或采购风险…" aria-label="向 AI采购助手提问" />
        <button type="submit" disabled={loading || !question.trim()}>发送</button>
      </form>
    </aside>
  </div>;
}
