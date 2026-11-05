import type { VisitStatus } from "@/lib/domain";

export const fieldClass =
  "h-11 w-full rounded-lg border border-input bg-card px-3 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring";

const STATUS_TONES: Record<string, string> & Record<VisitStatus, string> = {
  "Fresh Lead": "status-fresh",
  "Assigned to Sales": "status-assigned",
  "Attempted to Contact": "status-attempted",
  "Callback in Future": "status-callback",
  Contacted: "status-contacted",
  "Site Visit Scheduled": "status-site-visit",
  "Quotation Sent": "status-quotation",
  Won: "status-won",
  "Lost Lead": "status-lost",
  "Junk Lead": "status-junk",
  "Not Contacted": "status-neutral",
  "Pre-Qualified": "status-qualified",
  "Not Qualified": "status-lost",
  "Not Responsive": "status-neutral",
  Assigned: "status-assigned",
  "In Progress": "status-attempted",
  Completed: "status-won",
};

export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONES[status] ?? "status-neutral";
  return <span className={`status-badge ${tone}`}>{status}</span>;
}
