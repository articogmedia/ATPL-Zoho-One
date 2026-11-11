import Link from "next/link";
import { Suspense } from "react";
import { BarChart3, ClipboardList, FileText, MapPin, ReceiptText } from "lucide-react";
import { crm } from "@/lib/crm";
import { requireUser } from "@/lib/auth/guard";
import { canAccess, todayIST, visibleFor, type Section, type User } from "@/lib/domain";
import { beginPagePerf, endPagePerf } from "@/lib/page-perf";
import { withPageTimeout } from "@/lib/page-timeout";
import { PageLoadError } from "@/components/PageLoadError";
import { WarmCacheOnce } from "./WarmCacheOnce";
import { Greeting } from "./Greeting";
import { ManagerPasswordReset } from "@/components/ManagerPasswordReset";
import { STATIC_USERS } from "@/lib/auth/users";
import { PageHeader, Skeleton } from "@/components/ui-bits";
import { managerMonthSummary, todaySummary } from "@/lib/home-dashboard";

export const metadata = { title: "Home" };
export const dynamic = "force-dynamic";
export const preferredRegion = "bom1";

async function HomeCount({ section, user }: { section: Section; user: User }) {
  const repo = crm();
  try {
    if (section === "leads") {
      const count = repo.listLeadsPage
        ? (await withPageTimeout(repo.listLeadsPage(1, 1, user.role === "Sales Executive" ? user.id : undefined))).total
        : visibleFor(user, await withPageTimeout(repo.listLeads())).length;
      return <Count>{count}</Count>;
    }
    if (section === "quotations") return <Count>{visibleFor(user, await withPageTimeout(repo.listQuotes())).length}</Count>;
    if (section === "invoices") return <Count>{visibleFor(user, await withPageTimeout(repo.listInvoices())).length}</Count>;
    if (section === "visits") return <Count>{visibleFor(user, await withPageTimeout(repo.listVisits())).filter((visit) => !visit.done).length}</Count>;
    return null;
  } catch (error) {
    console.error("[home] count unavailable", {
      section,
      message: error instanceof Error ? error.message : String(error),
    });
    return <PageLoadError message={`The ${section} count is temporarily unavailable.`} />;
  }
}

function Count({ children }: { children: number }) {
  return <span className="inline-flex min-w-8 items-center justify-center rounded-full bg-secondary px-3 py-1 text-xs font-bold text-secondary-foreground" aria-label={`${children} items`}>{children}</span>;
}

function MetricCard({ label, value, detail }: { label: string; value: number | string; detail?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="text-sm font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-foreground">{value}</div>
      {detail && <div className="mt-1 text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

function InsightsSkeleton({ label, count }: { label: string; count: number }) {
  return (
    <section aria-label={label} aria-busy="true" className="space-y-3">
      <Skeleton className="h-6 w-32" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: count }, (_, index) => <Skeleton key={index} className="h-24" />)}
      </div>
    </section>
  );
}

async function TodaySummary({ user }: { user: User }) {
  const repo = crm();
  try {
    const [leads, visits] = await withPageTimeout(Promise.all([
      repo.listLeads(),
      user.role === "Sales Executive" ? repo.listVisits() : Promise.resolve([]),
    ]));
    const summary = todaySummary(user, leads, visits, todayIST());
    if (!summary) return null;
    const metrics = summary.kind === "executive"
      ? [
          { label: "Follow-ups due", value: summary.followUpsDue },
          { label: "Visits today", value: summary.visitsToday },
          { label: "New assigned leads", value: summary.newAssignedLeads },
        ]
      : [{ label: "Fresh uncalled leads", value: summary.freshUncalledLeads }];

    return (
      <section aria-label="Today" className="space-y-3">
        <h2 className="text-lg font-semibold">Today</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {metrics.map((metric) => <MetricCard key={metric.label} {...metric} />)}
        </div>
      </section>
    );
  } catch (error) {
    console.error("[home] today's summary unavailable", {
      message: error instanceof Error ? error.message : String(error),
    });
    return <PageLoadError message="Today’s work summary is temporarily unavailable." />;
  }
}

async function ManagerMonthSummary() {
  const repo = crm();
  try {
    const [leads, quotes] = await withPageTimeout(Promise.all([repo.listLeads(), repo.listQuotes()]));
    const metrics = managerMonthSummary(leads, quotes, todayIST());
    return (
      <section aria-label="Monthly performance" className="space-y-3">
        <h2 className="text-lg font-semibold">This month</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <MetricCard label="Leads this month" value={metrics.leads} />
          <MetricCard label="Conversion" value={`${metrics.conversion}%`} detail="Won ÷ leads created this month" />
          <MetricCard label="Quotes sent" value={metrics.quotesSent} />
        </div>
      </section>
    );
  } catch (error) {
    console.error("[home] monthly summary unavailable", {
      message: error instanceof Error ? error.message : String(error),
    });
    return <PageLoadError message="Monthly performance is temporarily unavailable." />;
  }
}

export default async function Home() {
  const perf = beginPagePerf("home");
  const user = await requireUser();

  const cards: { s: Section; to: string; label: string; desc: string; icon: typeof ClipboardList }[] = [
    { s: "leads", to: "/leads", label: "Manage Leads", icon: ClipboardList,
      desc: user.role === "Calling Team" ? "Add new customer enquiries and keep them updated." : "Track enquiries and update their status." },
    { s: "quotations", to: "/quotations", label: "Create Quotation", icon: FileText,
      desc: "Pick products, auto-fill approved prices and create the offer." },
    { s: "visits", to: "/visits", label: "My Work & Site Visits", icon: MapPin,
      desc: "Your assignments, site visits and follow-ups." },
    { s: "invoices", to: "/invoices", label: "Invoices", icon: ReceiptText,
      desc: "Convert accepted quotations and view or email invoices." },
    { s: "performance", to: "/performance", label: "Performance", icon: BarChart3, desc: "Lead sources, visits, conversions and executive results." },
  ];

  endPagePerf(perf);
  return (
    <>
      <WarmCacheOnce />
      <PageHeader
        className="mb-6 rounded-xl bg-primary p-5 text-primary-foreground shadow-elegant [&_h1]:text-primary-foreground [&_div]:text-primary-foreground sm:p-6"
        title={<Greeting name={user.name} />}
        subtitle={<><span className="font-semibold">{user.role}</span><p className="mt-1 max-w-xl">Your sales workspace for leads, quotations, site visits and performance.</p></>}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {cards.filter((c) => canAccess(user.role, c.s)).map((c) => (
          <Link key={c.to} href={c.to}
            className="group flex min-h-36 flex-col justify-between gap-6 rounded-xl border border-border bg-card p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-primary hover:shadow-elegant sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div className="grid h-12 w-12 place-items-center rounded-xl bg-accent text-accent-foreground"><c.icon className="h-6 w-6" /></div>
              {c.s !== "performance" && <Suspense fallback={<Skeleton className="h-7 w-10 rounded-full" />}>
                <HomeCount section={c.s} user={user} />
              </Suspense>}
            </div>
            <div>
              <div className="text-lg font-bold leading-tight">{c.label}</div>
              <div className="mt-1 text-sm text-muted-foreground">{c.desc}</div>
            </div>
          </Link>
        ))}
      </div>
      {user.role === "Manager"
        ? <Suspense fallback={<InsightsSkeleton label="Loading monthly performance" count={3} />}><ManagerMonthSummary /></Suspense>
        : <Suspense fallback={<InsightsSkeleton label="Loading today's summary" count={user.role === "Sales Executive" ? 3 : 1} />}><TodaySummary user={user} /></Suspense>}
      {user.role === "Manager" && <ManagerPasswordReset users={STATIC_USERS.map(({ username, name }) => ({ username, name }))} />}
    </>
  );
}
