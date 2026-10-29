import Link from "next/link";
import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import { isExecutive, perfStats, todayIST, type PerfRange } from "@/lib/domain";

export const metadata = { title: "Performance" };
export const dynamic = "force-dynamic";

const RANGES: { id: PerfRange; label: string }[] = [
  { id: "week", label: "This Week" },
  { id: "month", label: "This Month" },
  { id: "lastMonth", label: "Last Month" },
];
const fmtDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

export default async function PerformancePage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  await requireSection("performance");
  const { range: raw } = await searchParams;
  const range: PerfRange = RANGES.some((r) => r.id === raw) ? (raw as PerfRange) : "month";

  const repo = crm();
  const [leads, quotes, visits, users] = await Promise.all([repo.listLeads(), repo.listQuotes(), repo.listVisits(), repo.listUsers()]);
  const s = perfStats(leads, quotes, visits, range, todayIST(), users.filter(isExecutive).map((u) => u.name));

  const cards = [
    { k: "Total Leads", v: String(s.totalLeads), sub: `${s.won} won` },
    { k: "Conversion Rate", v: `${s.conversion}%`, sub: "Won ÷ total leads" },
    { k: "Visits Completed", v: `${s.completed}/${s.scheduled}`, sub: "of scheduled visits" },
    { k: "Quotations Sent", v: String(s.quotesSent), sub: "in this period" },
  ];
  const maxSource = Math.max(1, ...s.bySource.map((b) => b.count));
  const visitPct = s.scheduled ? Math.round((s.completed / s.scheduled) * 100) : 0;

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Performance</h1>
      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((r) => (
          <Link key={r.id} href={`/performance?range=${r.id}`} scroll={false}
            className={`inline-flex h-11 items-center rounded-lg px-4 text-sm font-semibold transition-colors ${range === r.id ? "bg-primary text-primary-foreground" : "border bg-card hover:bg-secondary"}`}>
            {r.label}
          </Link>
        ))}
        <span className="text-xs text-muted-foreground sm:ml-auto">{fmtDate(s.from)} – {fmtDate(s.to)}</span>
      </div>

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
                <div className="mb-1 flex justify-between text-sm"><span>{b.source}</span><span className="font-semibold">{b.count}</span></div>
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

      <div className="rounded-xl bg-card p-5 shadow-sm">
        <h2 className="mb-4 text-base font-semibold">Executive-wise Performance</h2>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Executive</th>
                <th className="py-2 pr-3 text-right font-medium">Leads Assigned</th>
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
                  <td className="py-3 pr-3 text-right">{r.visits}</td>
                  <td className="py-3 pr-3 text-right">{r.quotes}</td>
                  <td className="py-3 pr-3 text-right">{r.won}</td>
                  <td className="py-3 text-right font-semibold text-primary">{r.conversion}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="space-y-3 md:hidden">
          {s.rows.map((r) => (
            <div key={r.name} className="rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{r.name}</span>
                <span className="rounded-full bg-accent px-2.5 py-1 text-xs font-semibold text-accent-foreground">{r.conversion}%</span>
              </div>
              <div className="mt-2 grid grid-cols-4 gap-2 text-center text-sm">
                {([["Leads", r.leads], ["Visits", r.visits], ["Quotes", r.quotes], ["Won", r.won]] as const).map(([l, n]) => (
                  <div key={l}><div className="font-bold">{n}</div><div className="text-xs text-muted-foreground">{l}</div></div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
