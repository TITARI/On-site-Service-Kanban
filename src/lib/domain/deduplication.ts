export type DeduplicationAction = "create" | "urge" | "manual-review";

export const DEDUPLICATION_THRESHOLDS = {
  urge: 0.86,
  manualReview: 0.62
} as const;

export function decideDeduplication(confidence: number): DeduplicationAction {
  if (confidence >= DEDUPLICATION_THRESHOLDS.urge) return "urge";
  if (confidence >= DEDUPLICATION_THRESHOLDS.manualReview) return "manual-review";
  return "create";
}
