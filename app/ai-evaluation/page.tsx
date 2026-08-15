import { notFound } from "next/navigation";
import EvaluationClient from "./EvaluationClient";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export default function AiEvaluationPage() {
  if (process.env.ENABLE_AI_EVALUATION !== "true") notFound();
  return <EvaluationClient />;
}
