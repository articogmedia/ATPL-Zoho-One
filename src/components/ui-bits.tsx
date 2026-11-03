export const fieldClass =
  "h-12 w-full rounded-lg border border-input bg-card px-3 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring";

const STATUS_TONES: Record<string, string> = {
  "Fresh Lead": "bg-accent text-accent-foreground",
  "Assigned to Sales": "bg-blue-100 text-blue-800",
  "Attempted to Contact": "bg-amber-100 text-amber-800",
  "Callback in Future": "bg-purple-100 text-purple-800",
  Contacted: "bg-cyan-100 text-cyan-800",
  "Site Visit Scheduled": "bg-indigo-100 text-indigo-800",
  "Quotation Sent": "bg-orange-100 text-orange-800",
  Won: "bg-success text-success-foreground",
  "Junk Lead": "bg-destructive text-destructive-foreground",
  "Lost Lead": "bg-destructive text-destructive-foreground",
  "Not Contacted": "bg-slate-100 text-slate-800",
  "Pre-Qualified": "bg-teal-100 text-teal-800",
  "Not Qualified": "bg-rose-100 text-rose-800",
  "Not Responsive": "bg-gray-100 text-gray-800",
};

export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONES[status] ?? "bg-secondary text-secondary-foreground";
  return <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>{status}</span>;
}
