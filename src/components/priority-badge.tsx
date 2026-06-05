import { getPriorityDisplay } from "@/lib/domain/priority-label";

export function PriorityBadge({ score, showScore = false }: { score: number; showScore?: boolean }) {
  const priority = getPriorityDisplay(score);

  return (
    <span className={`priority-badge priority-${priority.tone}`}>
      <span>{priority.label}</span>
      {showScore && <small>{score}</small>}
    </span>
  );
}
