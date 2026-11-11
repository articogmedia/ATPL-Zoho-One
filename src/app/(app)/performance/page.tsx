import Link from "next/link";
import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import { perfStats, todayIST, type PerfRange } from "@/lib/domain";
import { matchPortalUserToZohoUser, missingPortalUsers, portalRole, STATIC_USERS } from "@/lib/auth/users";
import { beginPagePerf, endPagePerf } from "@/lib/page-perf";
import { PageLoadError } from "@/components/PageLoadError";
import { withPageTimeout } from "@/lib/page-timeout";
import { z } from "zod";

export const metadata = { title: "Performance" };
export const dynamic = "force-dynamic";
export const preferredRegion = "bom1";

const RANGES: { id: PerfRange; label: string }[] = [
  { id: "week", label: "This Week" },
  { id: "month", label: "This Month" },
  { id: "lastMonth", label: "Last Month" },
];
export default async function PerformancePage({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string }> }) {
  const started = Date.now();
  const perf = beginPagePerf("performance");
  const viewer = await requireSection("performance");
  const { range: raw, from: rawFrom, to: rawTo } = await searchParams;
  const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) =>
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
  );
  const hasCustomRange = rawFrom !== undefined || rawTo !== undefined;
  const validFrom = rawFrom ? dateSchema.safeParse(rawFrom).success : false;
  const validTo = rawTo ? dateSchema.safeParse(rawTo).success : false;
  const customRange = validFrom && validTo && rawFrom! <= rawTo! ? { from: rawFrom!, to: rawTo! } : undefined;
  const invalidCustomRange = hasCustomRange && !customRange;
  const range: PerfRange = RANGES.some((r) => r.id === raw) ? (raw as PerfRange) : "month";

  const repo = crm();
  let leads: Awaited<ReturnType<typeof repo.listLeads>>;
  let quotes: Awaited<ReturnType<typeof repo.listQuotes>>;
  let visits: Awaited<ReturnType<typeof repo.listVisits>>;
  let calls: Awaited<ReturnType<typeof repo.listCalls>>;
  let liveUsers: Awaited<ReturnType<typeof repo.listUsers>>;
  try {
    [leads, quotes, visits, calls, liveUsers] = await withPageTimeout(Promise.all([
      repo.listLeads(), repo.listQuotes(), repo.listVisits(), repo.listCalls(), repo.listUsers(),
    ]));
  } catch (error) {
    console.error("[page] performance data load failed", { message: error instanceof Error ? error.message : String(error) });
    endPagePerf(perf);
    return <PageLoadError message="Performance data is temporarily unavailable. Retry without leaving this page." />;
  }
  console.info(`[page] performance ${Date.now() - started}ms`);
  endPagePerf(perf);
  const executives = STATIC_USERS.map((user) => ({
    id: (matchPortalUserToZohoUser(user, liveUsers)?.id ?? user.zohoUserId ?? "").trim(),
    name: user.role === "Manager" ? `${user.name} (Manager)` : user.name,
    role: portalRole(user.role),
  }));
  const s = perfStats(leads, quotes, visits, range, todayIST(), executives, viewer, calls, customRange);
  const unsetIds = missingPortalUsers(STATIC_USERS, liveUsers).map((user) => user.name);

  const cards = viewer.role === "Sales Executive"
    ? [
        { k: "Leads Assigned", v: String(s.totalLeads), sub: "in this period" },
        { k: "Calls Made", v: String(s.calls), sub: "in this period" },
        { k: "Visits Completed", v: String(s.completed), sub: `${s.scheduled} scheduled` },
        { k: "Quotations Sent", v: String(s.quotesSent), sub: "in this period" },
        { k: "Won", v: String(s.won), sub: "in this period" },
        { k: "Conversion %", v: `${s.conversion}%`, sub: "Won ÷ leads assigned" },
      ]
    : [
        { k: "Total Leads", v: String(s.totalLeads), sub: `${s.won} won` },
        { k: "Conversion Rate", v: `${s.conversion}%`, sub: "Won ÷ total leads" },
        { k: "Visits Completed", v: `${s.completed}/${s.scheduled}`, sub: "of scheduled visits" },
        { k: "Quotations Sent", v: String(s.quotesSent), sub: "in this period" },
      ];
  const maxSource = Math.max(1, ...s.bySource.map((b) => b.count));
  const visitPct = s.scheduled ? Math.round((s.completed / s.scheduled) * 100) : 0;

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">{viewer.role === "Sales Executive" ? "My Performance" : "Performance"}</h1>
      {viewer.role === "Manager" && unsetIds.length > 0 && (
        <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {unsetIds.map((name) => <div key={name}>No Zoho user found for {name}</div>)}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((r) => (
          <Link key={r.id} href={`/performance?range=${r.id}`} scroll={false}
            className={`inline-flex h-11 items-center rounded-lg px-4 text-sm font-semibold transition-colors ${range === r.id ? "bg-primary text-primary-foreground" : "border bg-card hover:bg-secondary"}`}>
            {r.label}
          </Link>
        ))}
      </div>
      <form method="get" className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-4">
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">From<input aria-label="Custom range from" className="h-10 rounded-md border border-input bg-background px-2 text-sm text-foreground" type="date" name="from" defaultValue={customRange?.from ?? ""} /></label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">To<input aria-label="Custom range to" className="h-10 rounded-md border border-input bg-background px-2 text-sm text-foreground" type="date" name="to" defaultValue={customRange?.to ?? ""} /></label>
        <button className="h-10 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground" type="submit">Apply date range</button>
        {customRange && <Link className="inline-flex h-10 items-center px-2 text-sm underline" href="/performance">Clear dates</Link>}
      </form>
      {invalidCustomRange && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">Enter a valid start and end date; the start date must not be after the end date.</p>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.k} className="rounded-xl bg-card p-4 shadow-sm">
            <div className="text-xs text-muted-foreground sm:text-sm">{c.k}</div>
            <div className="mt-1 text-xl font-bold text-primary sm:text-2xl">{c.v}</div>
            <div className="mt-1 text-xs text-muted-foreground">{c.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl bg-card p-5 shadow-sm">
          <h2 className="mb-4 text-base font-semibold">Leads by Source</h2>
          <div className="space-y-4">
            {s.bySource.map((b) => (
              <div key={b.source}>
                <div className="mb-1 flex justify-between gap-2 text-sm"><span>{b.source}</span><span className="text-right font-semibold">{b.count} leads · {b.won} won · {b.conversion}%</span></div>
                <div className="h-3 overflow-hidden rounded-full bg-secondary"><div className="h-3 rounded-full bg-primary" style={{ width: `${(b.count / maxSource) * 100}%` }} /></div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl bg-card p-5 shadow-sm">
          <h2 className="mb-4 text-base font-semibold">Site Visits — Scheduled vs Completed</h2>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-secondary p-4"><div className="text-3xl font-bold">{s.scheduled}</div><div className="text-xs text-muted-foreground">Scheduled</div></div>
            <div className="rounded-lg bg-accent p-4"><div className="text-3xl font-bold text-accent-foreground">{s.completed}</div><div className="text-xs text-accent-foreground/80">Completed</div></div>
          </div>
          <div className="mt-4">
            <div className="mb-1 flex justify-between text-sm"><span className="text-muted-foreground">Completion</span><span className="font-semibold">{visitPct}%</span></div>
            <div className="h-3 overflow-hidden rounded-full bg-secondary"><div className="h-3 rounded-full bg-primary" style={{ width: `${visitPct}%` }} /></div>
          </div>
        </div>
      </div>

      {viewer.role === "Manager" && <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h2 className="mb-4 text-base font-semibold">Executive-wise Performance</h2>
        <div className="hidden overflow-x-auto md:block">
          <table className="min-w-[980px] w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Executive</th>
                <th className="py-2 pr-3 text-right font-medium">Leads Assigned</th>
                <th className="py-2 pr-3 text-right font-medium">Open</th>
                <th className="py-2 pr-3 text-right font-medium">In Progress</th>
                <th className="py-2 pr-3 text-right font-medium">Calls Made</th>
                <th className="py-2 pr-3 text-right font-medium">Visits Completed</th>
                <th className="py-2 pr-3 text-right font-medium">Quotations Sent</th>
                <th className="py-2 pr-3 text-right font-medium">Won</th>
                <th className="py-2 text-right font-medium">Conversion %</th>
              </tr>
            </thead>
            <tbody>
              {s.rows.map((r) => (
                <tr key={r.name} className="border-b last:border-0">
                  <td className="py-3 pr-3 font-semibold">{r.name}</td>
                  <td className="py-3 pr-3 text-right">{r.leads}</td>
                  <td className="py-3 pr-3 text-right">{r.open}</td>
                  <td className="py-3 pr-3 text-right">{r.inProgress}</td>
                  <td className="py-3 pr-3 text-right">{r.calls}</td>
                  <td className="py-3 pr-3 text-right">{r.visits}</td>
                  <td className="py-3 pr-3 text-right">{r.quotes}</td>
                  <td className="py-3 pr-3 text-right">{r.won}</td>
                  <td className="py-3 text-right font-semibold text-primary">{r.conversion}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid gap-3 md:hidden">
          {s.rows.map((r) => (
            <article key={r.name} className="rounded-xl border border-border bg-muted/40 p-4">
              <h3 className="font-semibold">{r.name}</h3>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                <div><dt className="text-muted-foreground">Leads assigned</dt><dd className="font-semibold">{r.leads}</dd></div>
                <div><dt className="text-muted-foreground">Open leads</dt><dd className="font-semibold">{r.open}</dd></div>
                <div><dt className="text-muted-foreground">Work in progress</dt><dd className="font-semibold">{r.inProgress}</dd></div>
                <div><dt className="text-muted-foreground">Calls made</dt><dd className="font-semibold">{r.calls}</dd></div>
                <div><dt className="text-muted-foreground">Visits done</dt><dd className="font-semibold">{r.visits}</dd></div>
                <div><dt className="text-muted-foreground">Quotes sent</dt><dd className="font-semibold">{r.quotes}</dd></div>
                <div><dt className="text-muted-foreground">Conversion</dt><dd className="font-semibold text-primary">{r.conversion}%</dd></div>
              </dl>
            </article>
          ))}
        </div>
      </div>}
    </div>
  );
}
