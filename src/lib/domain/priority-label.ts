export type PriorityTone = "critical" | "high" | "normal" | "low";

export function getPriorityDisplay(score: number): { label: string; tone: PriorityTone } {
  if (score >= 80) return { label: "紧急", tone: "critical" };
  if (score >= 50) return { label: "较急", tone: "high" };
  if (score >= 20) return { label: "普通", tone: "normal" };
  return { label: "低", tone: "low" };
}
