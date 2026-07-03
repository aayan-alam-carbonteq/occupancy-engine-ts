// Aggregate heuristic agent results into a scored verdict breakdown.
import type { HeuristicAgentResult, ScoreBreakdown, VerdictBand } from "./models.ts";

export function scoreResults(results: HeuristicAgentResult[]): ScoreBreakdown {
  const scoreable = results.filter((r) => r.status !== "error" && r.status !== "inconclusive");
  const sum = (pred: (r: HeuristicAgentResult) => boolean) =>
    scoreable.filter(pred).reduce((acc, r) => acc + r.score, 0);
  const riskPoints = sum((r) => r.direction === "risk" && r.score > 0);
  const mitigationPoints = sum((r) => r.direction === "mitigation" && r.score < 0);
  const qualityPoints = sum((r) => r.direction === "quality");
  const finalScore = Math.max(0, riskPoints + mitigationPoints + qualityPoints);
  const band = computeBand(finalScore, results);
  return {
    risk_points: riskPoints,
    mitigation_points: mitigationPoints,
    quality_points: qualityPoints,
    final_score: finalScore,
    band,
  };
}

function computeBand(score: number, results: HeuristicAgentResult[]): VerdictBand {
  if (results.some((r) => r.heuristic_id === "case_quality" && r.score < 0)) {
    return "manual_verification";
  }
  const hasHighConflict = results.some((r) => r.confidence === "high" && r.score >= 3);
  if (score >= 10 && hasHighConflict) {
    return "high_priority_review";
  }
  if (score >= 7) {
    return "review";
  }
  if (score >= 4) {
    return "monitor";
  }
  return "low_evidence";
}
