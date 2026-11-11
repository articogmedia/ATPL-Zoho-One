import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import type { VisitStatus } from "@/lib/domain";
import { cn } from "@/lib/utils";

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
  Draft: "status-neutral",
  Sent: "status-contacted",
  Accepted: "status-won",
  Declined: "status-lost",
  Overdue: "status-lost",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return <span className={cn("status-badge", STATUS_TONES[status] ?? "status-neutral", className)}>{status}</span>;
}

export function PageHeader({ title, subtitle, action, mobileFloating = true, className }: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  mobileFloating?: boolean;
  className?: string;
}) {
  return (
    <header className={cn("flex min-w-0 flex-wrap items-start justify-between gap-3", className)}>
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-bold sm:text-2xl">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-muted-foreground">{subtitle}</div>}
      </div>
      {action && <div className={cn(
        "flex w-auto max-w-[calc(100vw-2rem)] justify-end sm:static sm:inset-auto sm:z-auto sm:ml-auto sm:max-w-none sm:flex-none",
        mobileFloating
          ? "fixed right-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30"
          : "w-full sm:w-auto",
      )}>
        <div className={cn("sm:w-auto", mobileFloating ? "w-auto" : "w-full")}>{action}</div>
      </div>}
    </header>
  );
}

export function EmptyState({ icon, message, action, className }: {
  icon?: ReactNode;
  message: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid justify-items-center gap-3 rounded-xl border border-dashed bg-card px-5 py-8 text-center", className)}>
      {icon && <div className="grid h-11 w-11 place-items-center rounded-full bg-brand-blue/10 text-brand-blue">{icon}</div>}
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      {action}
    </div>
  );
}

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-lg bg-secondary", className)} {...props} />;
}

export type PageSkeletonVariant = "home" | "leads" | "quotations" | "visits" | "performance" | "invoices";

export function PageSkeleton({ variant }: { variant: PageSkeletonVariant }) {
  const rows = variant === "leads" || variant === "visits" || variant === "invoices" ? 4 : 2;
  return (
    <section aria-label={`Loading ${variant}`} className="space-y-5">
      <div className="space-y-2"><Skeleton className="h-8 w-56" /><Skeleton className="h-4 w-80 max-w-full" /></div>
      {variant === "quotations" && <Skeleton className="h-14 w-full rounded-xl" />}
      <div className={cn("grid gap-3", variant === "home" ? "sm:grid-cols-2" : "grid-cols-1")}>
        {Array.from({ length: rows }, (_, index) => <Skeleton key={index} className={cn("h-28", variant === "home" && "h-36")} />)}
      </div>
    </section>
  );
}

export type ResponsiveColumn<T> = {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  className?: string;
  align?: "left" | "right" | "center";
};

export const ResponsiveTabList = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ResponsiveTabList(
  { className, ...props },
  ref,
) {
  return <div ref={ref} className={cn("flex min-w-0 flex-wrap gap-2 p-1", className)} {...props} />;
});

export function ResponsiveTable<T>({ rows, columns, getKey, renderCard, label, className }: {
  rows: readonly T[];
  columns: readonly ResponsiveColumn<T>[];
  getKey: (row: T, index: number) => string;
  renderCard: (row: T) => ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="hidden overflow-hidden rounded-lg border lg:block">
        <table aria-label={label} className="w-full table-fixed text-left text-sm">
          <thead className="bg-muted/70 text-muted-foreground">
            <tr>{columns.map((column) => <th key={column.key} scope="col" className={cn("px-2 py-3 font-medium sm:px-3", column.align === "right" && "text-right", column.align === "center" && "text-center", column.className)}>{column.header}</th>)}</tr>
          </thead>
          <tbody>{rows.map((row, index) => (
            <tr key={getKey(row, index)} className="border-t last:border-0">
              {columns.map((column) => <td key={column.key} className={cn("break-words px-2 py-3 sm:px-3", column.align === "right" && "text-right", column.align === "center" && "text-center", column.className)}>{column.render(row)}</td>)}
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="grid gap-3 lg:hidden">
        {rows.map((row, index) => <div key={getKey(row, index)}>{renderCard(row)}</div>)}
      </div>
    </div>
  );
}

export const ResponsivePanel = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(function ResponsivePanel(
  { className, ...props },
  ref,
) {
  return <aside ref={ref} className={cn("absolute bottom-0 left-0 flex h-[92dvh] w-full flex-col rounded-t-2xl bg-card shadow-2xl focus-visible:outline-none md:bottom-auto md:left-auto md:right-0 md:top-0 md:h-full md:max-w-lg md:rounded-none", className)} {...props} />;
});

export function BottomSheet({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={cn("w-full rounded-t-2xl bg-card p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl", className)} {...props} />;
}

export function Drawer({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <aside className={cn("h-full w-full max-w-lg bg-card shadow-2xl", className)} {...props} />;
}

export function ConfirmDialog({ title, description, confirmLabel = "Confirm", cancelLabel = "Cancel", destructive, onConfirm, onCancel }: {
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-4" role="presentation">
      <section role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-description" className="w-full max-w-md space-y-4 rounded-xl border bg-card p-5 shadow-xl">
        <div>
          <h2 id="confirm-dialog-title" className="text-lg font-semibold">{title}</h2>
          <div id="confirm-dialog-description" className="mt-2 text-sm text-muted-foreground">{description}</div>
        </div>
        <div className="flex flex-col-reverse justify-end gap-2 sm:flex-row">
          <button type="button" className="h-11 rounded-lg border px-4 text-sm font-medium hover:bg-secondary" onClick={onCancel}>{cancelLabel}</button>
          <button type="button" className={cn("h-11 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90", destructive && "bg-destructive text-destructive-foreground hover:bg-destructive/90")} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
