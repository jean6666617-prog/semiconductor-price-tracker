import { NextResponse } from "next/server";
import { core41Models, extendedCategoryModels, modelSetSummary, pendingDiscoveryModels, protectedModels, lcscDiscoveryCandidates, nonLcscCandidates } from "../../../../lib/modelSets";

export const runtime = "edge";

export async function GET() {
  return NextResponse.json({
    ...modelSetSummary(),
    core41Models,
    extendedCategoryModels,
    pendingDiscoveryModels,
    protectedModels,
    lcscDiscoveryCandidates,
    nonLcscCandidates,
  }, { headers: { "Cache-Control": "no-store" } });
}
