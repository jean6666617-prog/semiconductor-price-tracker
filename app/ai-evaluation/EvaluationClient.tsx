"use client";

import { useState } from "react";
import type { EvaluationRun } from "../../lib/ai/evaluation/types";

function percent(value: number | null) {
  return value === null ? "—" : `${(value * 100).toFixed(0)}%`;
}

export default function EvaluationClient() {
  const [run, setRun] = useState<EvaluationRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function execute() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/ai/evaluation", { method: "POST" });
      const payload = await response.json() as { success?: boolean; error?: string } & Partial<EvaluationRun>;
      if (!response.ok || !payload.success || !payload.results || !payload.summary) throw new Error(payload.error || "Evaluation unavailable");
      setRun(payload as EvaluationRun);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Evaluation failed");
    } finally {
      setLoading(false);
    }
  }

  function download() {
    if (!run) return;
    const blob = new Blob([JSON.stringify(run, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ai-evaluation-${run.timestamp}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return <main className="ai-evaluation-page">
    <div className="ai-evaluation-header"><div><p className="ai-evaluation-eyebrow">PROCUREMENT AI COPILOT</p><h1>Evaluation Runner</h1><p>对象级 ProcurementContext 的确定性可信度评估，不使用 Judge LLM。</p></div><div className="ai-evaluation-actions"><button type="button" onClick={() => void execute()} disabled={loading}>{loading ? "运行中…" : "运行 Evaluation"}</button><button type="button" onClick={download} disabled={!run}>导出 JSON</button></div></div>
    {error && <div className="ai-evaluation-error">{error}</div>}
    {run && <>
      <div className="ai-evaluation-meta"><span>Baseline Status: <b>{run.status.toUpperCase()}</b></span><span>Provider: <b>{run.provider}</b></span><span>Model: <b>{run.model}</b></span><span>Prompt: <b>{run.promptVersion}</b></span><span>Run: <b>{run.timestamp}</b></span></div>
      <div className="ai-evaluation-metrics">{[
        ["Structure Validity", run.summary.structureValidityRate], ["Fact Accuracy", run.summary.factAccuracyRate], ["Source Accuracy", run.summary.sourceAccuracyRate], ["Hallucination（越低越好）", run.summary.hallucinationRate], ["Insufficient Data", run.summary.insufficientDataHandlingRate], ["Platform Risk", run.summary.platformRiskConsistencyRate], ["Future Safety", run.summary.futurePredictionSafetyRate], ["Supported Answer", run.summary.supportedAnswerRate],
      ].map(([label, value]) => <div key={String(label)}><span>{label}</span><strong>{percent(value as number | null)}</strong></div>)}</div>
      <div className="ai-evaluation-summary"><span>Total {run.summary.totalCases}</span><span>Evaluated {run.summary.evaluatedCases}</span><span>Provider Errors {run.summary.providerErrors}</span><span>Rate-limit Retries {run.summary.rateLimitRetries}</span><span>Successful {run.summary.successfulResponses}</span><span>Avg response {run.summary.averageResponseTimeMs.toFixed(0)} ms</span></div>
      <div className="ai-evaluation-cases">{run.results.map((item) => <details key={item.caseId}><summary><span>{item.caseId}</span><b>{item.status === "notEvaluated" ? item.providerError || "notEvaluated" : item.metrics.answerSupport}</b><em>{item.durationMs} ms</em></summary><div className="ai-evaluation-case-body"><p><strong>问题：</strong>{item.question}</p><p><strong>Status：</strong>{item.status}</p><p><strong>Metrics：</strong>{JSON.stringify(item.metrics)}</p><details><summary>Context JSON</summary><pre>{JSON.stringify(item.context, null, 2)}</pre></details>{item.response && <details><summary>Validated AIResponse JSON</summary><pre>{JSON.stringify(item.response, null, 2)}</pre></details>}{item.error && <p className="ai-evaluation-error">{item.error}</p>}</div></details>)}</div>
    </>}
  </main>;
}
