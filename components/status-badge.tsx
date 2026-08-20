/**
 * Status label for DM status. Plain text; color carries the state.
 */

const statusConfig: Record<string, { text: string; label: string }> = {
  SENT: { text: "text-success", label: "Zugestellt" },
  FAILED: { text: "text-error", label: "Fehlgeschlagen" },
  PENDING: { text: "text-warning", label: "Ausstehend" },
  SKIPPED_DEDUP: { text: "text-muted", label: "Doppelt" },
  SKIPPED_RATE_LIMIT: { text: "text-warning", label: "Limit erreicht" },
  SKIPPED_PLAN_LIMIT: { text: "text-warning", label: "Übersprungen" },
  SKIPPED_NO_MATCH: { text: "text-muted", label: "Kein Treffer" },
};

interface StatusBadgeProps {
  status: string;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const config = statusConfig[status] ?? statusConfig.PENDING;

  return (
    <span className={`shrink-0 whitespace-nowrap text-sm ${config.text}`}>
      {config.label}
    </span>
  );
}
