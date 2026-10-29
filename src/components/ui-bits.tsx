export const fieldClass =
  "h-12 w-full rounded-lg border border-input bg-card px-3 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring";

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "Won" ? "bg-success text-success-foreground"
    : status === "Lost" ? "bg-destructive text-destructive-foreground"
    : status === "Fresh Lead" ? "bg-accent text-accent-foreground"
    : "bg-secondary text-secondary-foreground";
  return <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>{status}</span>;
}
