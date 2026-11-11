import { crm } from "@/lib/crm";
import { STATIC_USERS, matchPortalUserToZohoUser, missingPortalUsers, portalRole } from "@/lib/auth/users";
import { perfStats, todayIST, type PerfRange, type User } from "@/lib/domain";
import { PageLoadError } from "@/components/PageLoadError";
import { ResponsiveTable, Skeleton } from "@/components/ui-bits";
import { withPageTimeout } from "@/lib/page-timeout";
import { newErrorReference } from "@/lib/crm-action-errors";
import { ZohoError } from "@/lib/zoho/client";

type Props = { viewer: User; range: PerfRange; customRange?: { from: string; to: string } };

function executivesFor(liveUsers: Awaited<ReturnType<ReturnType<typeof crm>["listUsers"]>>) {
  return STATIC_USERS.map((user) => ({
    id: (matchPortalUserToZohoUser(user, liveUsers)?.id ?? user.zohoUserId ?? "").trim(),
    name: user.role === "Manager" ? `${user.name} (Manager)` : user.name,
    role: portalRole(user.role),
  }));
}

function reportLoadFailure(section: string, error: unknown) {
  const reference = newErrorReference();
  const zohoError = error instanceof ZohoError ? error : null;
  console.error(`[page] performance ${section} load failed`, {
    reference,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    zohoStatus: zohoError?.status,
    zohoCode: zohoError?.code,
    zohoOperation: zohoError?.operation,
    zohoDetails: zohoError?.details,
  });
  return <PageLoadError message="Performance data is temporarily unavailable." reference={reference} />;
}

export function PerformanceSectionSkeleton({ label, lines = 3 }: { label: string; lines?: number }) {
  return <section aria-label={`Loading ${label}`} aria-busy="true" className="space-y-3 rounded-xl bg-card p-5 shadow-sm">
    <Skeleton className="h-6 w-48" />
    {Array.from({ length: lines }, (_, index) => <Skeleton key={index} className="h-10" />)}
  </section>;
}

export async function PerformanceKpis({ viewer, range, customRange }: Props) {
  try {
    const repo = crm();
    const [leads, quotes, visits, calls, liveUsers] = await withPageTimeout(Promise.all([
      repo.listLeads(), repo.listQuotes(), repo.listVisits(), repo.listCalls(), repo.listUsers(),
    ]));
    const stats = perfStats(leads, quotes, visits, range, todayIST(), executivesFor(liveUsers), viewer, calls, customRange);
    const cards = viewer.role === "Sales Executive"
      ? [
          { label: "Leads Assigned", value: String(stats.totalLeads), detail: "in this period" },
          { label: "Calls Made", value: String(stats.calls), detail: "in this period" },
          { label: "Visits Completed", value: String(stats.completed), detail: `${stats.scheduled} scheduled` },
          { label: "Quotations Sent", value: String(stats.quotesSent), detail: "in this period" },
          { label: "Won", value: String(stats.won), detail: "in this period" },
          { label: "Conversion %", value: `${stats.conversion}%`, detail: "Won ÷ leads assigned" },
        ]
      : [
          { label: "Total Leads", value: String(stats.totalLeads), detail: `${stats.won} won` },
          { label: "Conversion Rate", value: `${stats.conversion}%`, detail: "Won ÷ total leads" },
          { label: "Visits Completed", value: `${stats.completed}/${stats.scheduled}`, detail: "of scheduled visits" },
          { label: "Quotations Sent", value: String(stats.quotesSent), detail: "in this period" },
        ];
    const visitPct = stats.scheduled ? Math.round((stats.completed / stats.scheduled) * 100) : 0;
    return <>
      <section aria-label="Performance KPIs" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((card) => <div key={card.label} className="rounded-xl bg-card p-4 shadow-sm">
          <div className="text-xs text-muted-foreground sm:text-sm">{card.label}</div>
          <div className="mt-1 text-xl font-bold text-primary sm:text-2xl">{card.value}</div>
          <div className="mt-1 text-xs text-muted-foreground">{card.detail}</div>
        </div>)}
      </section>
      <section className="rounded-xl bg-card p-5 shadow-sm">
        <h2 className="mb-4 text-base font-semibold">Site Visits — Scheduled vs Completed</h2>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-secondary p-4"><div className="text-3xl font-bold">{stats.scheduled}</div><div className="text-xs text-muted-foreground">Scheduled</div></div>
          <div className="rounded-lg bg-accent p-4"><div className="text-3xl font-bold text-accent-foreground">{stats.completed}</div><div className="text-xs text-accent-foreground/80">Completed</div></div>
        </div>
        <div className="mt-4">
          <div className="mb-1 flex justify-between text-sm"><span className="text-muted-foreground">Completion</span><span className="font-semibold">{visitPct}%</span></div>
          <div className="h-3 overflow-hidden rounded-full bg-secondary"><div className="h-3 rounded-full bg-primary" style={{ width: `${visitPct}%` }} /></div>
        </div>
      </section>
    </>;
  } catch (error) {
    return reportLoadFailure("KPI", error);
  }
}

export async function PerformanceSourceChart({ viewer, range, customRange }: Props) {
  try {
    const leads = await withPageTimeout(crm().listLeads());
    const stats = perfStats(leads, [], [], range, todayIST(), [], viewer, [], customRange);
    const maxSource = Math.max(1, ...stats.bySource.map((item) => item.count));
    return <section className="rounded-xl bg-card p-5 shadow-sm">
      <h2 className="mb-4 text-base font-semibold">Leads by Source</h2>
      <div className="space-y-4">
        {stats.bySource.map((item) => <div key={item.source}>
          <div className="mb-1 flex justify-between gap-2 text-sm"><span>{item.source}</span><span className="text-right font-semibold">{item.count} leads · {item.won} won · {item.conversion}%</span></div>
          <div className="h-3 overflow-hidden rounded-full bg-secondary"><div className="h-3 rounded-full bg-primary" style={{ width: `${(item.count / maxSource) * 100}%` }} /></div>
        </div>)}
      </div>
    </section>;
  } catch (error) {
    return reportLoadFailure("source chart", error);
  }
}

export async function ExecutivePerformanceTable({ viewer, range, customRange }: Props) {
  if (viewer.role !== "Manager") return null;
  try {
    const repo = crm();
    const [leads, quotes, visits, calls, liveUsers] = await withPageTimeout(Promise.all([
      repo.listLeads(), repo.listQuotes(), repo.listVisits(), repo.listCalls(), repo.listUsers(),
    ]));
    const executives = executivesFor(liveUsers);
    const stats = perfStats(leads, quotes, visits, range, todayIST(), executives, viewer, calls, customRange);
    const unsetNames = missingPortalUsers(STATIC_USERS, liveUsers).map((user) => user.name);
    return <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="mb-4 text-base font-semibold">Executive-wise Performance</h2>
      {unsetNames.length > 0 && <p className="mb-3 text-sm text-amber-900">No Zoho user found for {unsetNames.join(", ")}</p>}
      <ResponsiveTable
        label="Executive-wise Performance"
        rows={stats.rows}
        getKey={(row) => row.name}
        columns={[
          { key: "name", header: "Executive", render: (row) => <span className="font-semibold">{row.name}</span> },
          { key: "leads", header: "Leads Assigned", align: "right", render: (row) => row.leads },
          { key: "open", header: "Open", align: "right", render: (row) => row.open },
          { key: "progress", header: "In Progress", align: "right", render: (row) => row.inProgress },
          { key: "calls", header: "Calls Made", align: "right", render: (row) => row.calls },
          { key: "visits", header: "Visits Completed", align: "right", render: (row) => row.visits },
          { key: "quotes", header: "Quotations Sent", align: "right", render: (row) => row.quotes },
          { key: "won", header: "Won", align: "right", render: (row) => row.won },
          { key: "conversion", header: "Conversion %", align: "right", render: (row) => <span className="font-semibold text-primary">{row.conversion}%</span> },
        ]}
        renderCard={(row) => <article className="rounded-xl border border-border bg-muted/40 p-4">
          <h3 className="font-semibold">{row.name}</h3>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <div><dt className="text-muted-foreground">Leads assigned</dt><dd className="font-semibold">{row.leads}</dd></div>
            <div><dt className="text-muted-foreground">Open leads</dt><dd className="font-semibold">{row.open}</dd></div>
            <div><dt className="text-muted-foreground">Work in progress</dt><dd className="font-semibold">{row.inProgress}</dd></div>
            <div><dt className="text-muted-foreground">Calls made</dt><dd className="font-semibold">{row.calls}</dd></div>
            <div><dt className="text-muted-foreground">Visits done</dt><dd className="font-semibold">{row.visits}</dd></div>
            <div><dt className="text-muted-foreground">Quotes sent</dt><dd className="font-semibold">{row.quotes}</dd></div>
            <div><dt className="text-muted-foreground">Won</dt><dd className="font-semibold">{row.won}</dd></div>
            <div><dt className="text-muted-foreground">Conversion</dt><dd className="font-semibold text-primary">{row.conversion}%</dd></div>
          </dl>
        </article>}
      />
    </section>;
  } catch (error) {
    return reportLoadFailure("executive table", error);
  }
}
