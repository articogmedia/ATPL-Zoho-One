
import Link from "next/link";
import { Suspense } from "react";
import {
  BarChart3,
  ClipboardList,
  FileText,
  MapPin,
  ReceiptText,
} from "lucide-react";

import { crm } from "@/lib/crm";
import { requireUser } from "@/lib/auth/guard";
import {
  canAccess,
  todayIST,
  visibleFor,
  type Section,
  type User,
} from "@/lib/domain";
import { beginPagePerf, endPagePerf } from "@/lib/page-perf";
import { withPageTimeout } from "@/lib/page-timeout";
import { PageLoadError } from "@/components/PageLoadError";
import { WarmCacheOnce } from "./WarmCacheOnce";
import { Greeting } from "./Greeting";
import { ManagerPasswordReset } from "@/components/ManagerPasswordReset";
import { STATIC_USERS } from "@/lib/auth/users";
import { PageHeader, Skeleton } from "@/components/ui-bits";
import {
  managerMonthSummary,
  todaySummary,
} from "@/lib/home-dashboard";
import { HomeCountFailure } from "./HomeCountFailure";
import { newErrorReference } from "@/lib/crm-action-errors";

export const metadata = { title: "Home" };
export const dynamic = "force-dynamic";
export const preferredRegion = "bom1";

async function HomeCount({
  section,
  user,
}: {
  section: Section;
  user: User;
}) {
  const repo = crm();

  try {
    if (section === "leads") {
      const count = repo.listLeadsPage
        ? (
            await withPageTimeout(
              repo.listLeadsPage(
                1,
                1,
                user.role === "Sales Executive" ? user.id : undefined
              )
            )
          ).total
        : visibleFor(
            user,
            await withPageTimeout(repo.listLeads())
          ).length;

      return <Count>{count}</Count>;
    }

    if (section === "quotations") {
      return (
        <Count>
          {visibleFor(
            user,
            await withPageTimeout(repo.listQuotes())
          ).length}
        </Count>
      );
    }

    if (section === "invoices") {
      return (
        <Count>
          {visibleFor(
            user,
            await withPageTimeout(repo.listInvoices())
          ).length}
        </Count>
      );
    }

    if (section === "visits") {
      return (
        <Count>
          {visibleFor(
            user,
            await withPageTimeout(repo.listVisits())
          ).filter((visit) => !visit.done).length}
        </Count>
      );
    }

    return null;
  } catch (error) {
    const reference = newErrorReference();

    console.error("[home] count unavailable", {
      reference,
      section,
      message:
        error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return <HomeCountFailure />;
  }
}

function Count({ children }: { children: number }) {
  return (
    <span
      className="inline-flex min-w-9 items-center justify-center rounded-full bg-blue-50 px-3 py-1.5 text-xs font-bold tabular-nums text-blue-800"
      aria-label={`${children} items`}
    >
      {children}
    </span>
  );
}

function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: number | string;
  detail?: string;
}) {
  return (
    <div className="flex min-h-[120px] min-w-0 flex-col justify-center rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md sm:p-6">
      <p className="text-sm font-medium text-slate-500">
        {label}
      </p>

      <p className="mt-3 text-3xl font-bold leading-none tracking-tight tabular-nums text-slate-900">
        {value}
      </p>

      {detail && (
        <p className="mt-2 text-sm leading-5 text-slate-500">
          {detail}
        </p>
      )}
    </div>
  );
}

function InsightsSkeleton({
  label,
  count,
}: {
  label: string;
  count: number;
}) {
  return (
    <section
      aria-label={label}
      aria-busy="true"
      className="space-y-4"
    >
      <Skeleton className="h-6 w-40" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: count }, (_, index) => (
          <Skeleton key={index} className="h-28 rounded-2xl" />
        ))}
      </div>
    </section>
  );
}

async function TodaySummary({ user }: { user: User }) {
  const repo = crm();

  try {
    const [leads, visits] = await withPageTimeout(
      Promise.all([
        repo.listLeads(),
        user.role === "Sales Executive"
          ? repo.listVisits()
          : Promise.resolve([]),
      ])
    );

    const summary = todaySummary(
      user,
      leads,
      visits,
      todayIST()
    );

    if (!summary) return null;

    const metrics =
      summary.kind === "executive"
        ? [
            {
              label: "Follow-ups due",
              value: summary.followUpsDue,
            },
            {
              label: "Visits today",
              value: summary.visitsToday,
            },
            {
              label: "New assigned leads",
              value: summary.newAssignedLeads,
            },
          ]
        : [
            {
              label: "Fresh uncalled leads",
              value: summary.freshUncalledLeads,
            },
          ];

    return (
      <section
        aria-label="Today's activity"
        className="w-full min-w-0 space-y-4"
      >
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-900">
            Today
          </h2>

          <p className="mt-1 text-sm text-slate-500">
            Your priorities and scheduled activity
          </p>
        </div>

        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {metrics.map((metric) => (
            <MetricCard
              key={metric.label}
              {...metric}
            />
          ))}
        </div>
      </section>
    );
  } catch (error) {
    console.error("[home] today's summary unavailable", {
      message:
        error instanceof Error ? error.message : String(error),
    });

    return (
      <PageLoadError message="Today's work summary is temporarily unavailable." />
    );
  }
}

async function ManagerMonthSummary() {
  const repo = crm();

  try {
    const [leads, quotes] = await withPageTimeout(
      Promise.all([
        repo.listLeads(),
        repo.listQuotes(),
      ])
    );

    const metrics = managerMonthSummary(
      leads,
      quotes,
      todayIST()
    );

    return (
      <section
        aria-label="Monthly performance"
        className="w-full min-w-0 space-y-4"
      >
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-900">
            This month
          </h2>

          <p className="mt-1 text-sm text-slate-500">
            A snapshot of your sales activity
          </p>
        </div>

        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <MetricCard
            label="Leads this month"
            value={metrics.leads}
          />

          <MetricCard
            label="Conversion"
            value={`${metrics.conversion}%`}
            detail="Won quotations ÷ leads created this month"
          />

          <MetricCard
            label="Quotes sent"
            value={metrics.quotesSent}
          />
        </div>
      </section>
    );
  } catch (error) {
    console.error("[home] monthly summary unavailable", {
      message:
        error instanceof Error ? error.message : String(error),
    });

    return (
      <PageLoadError message="Monthly performance is temporarily unavailable." />
    );
  }
}

export default async function Home() {
  const perf = beginPagePerf("home");
  const user = await requireUser();

  const cards: {
    s: Section;
    to: string;
    label: string;
    desc: string;
    icon: typeof ClipboardList;
  }[] = [
    {
      s: "leads",
      to: "/leads",
      label: "Manage Leads",
      icon: ClipboardList,
      desc:
        user.role === "Calling Team"
          ? "Add new customer enquiries and keep them updated."
          : "Track enquiries and update their status.",
    },
    {
      s: "quotations",
      to: "/quotations",
      label: "Create Quotation",
      icon: FileText,
      desc: "Select products, review pricing and prepare customer offers.",
    },
    {
      s: "visits",
      to: "/visits",
      label: "My Work & Site Visits",
      icon: MapPin,
      desc: "Manage assignments, site visits and follow-ups.",
    },
    {
      s: "invoices",
      to: "/invoices",
      label: "Invoices",
      icon: ReceiptText,
      desc: "Convert accepted quotations and manage invoices.",
    },
    {
      s: "performance",
      to: "/performance",
      label: "Performance",
      icon: BarChart3,
      desc: "Review lead sources, visits and sales performance.",
    },
  ];

  endPagePerf(perf);

  return (
    <div className="mx-auto w-full min-w-0 max-w-[1600px] space-y-7 pb-8">
      <WarmCacheOnce />

      <PageHeader
        className="mb-0 rounded-2xl bg-primary p-5 text-primary-foreground shadow-sm sm:p-7 [&_h1]:text-primary-foreground [&_div]:text-primary-foreground"
        title={<Greeting name={user.name} />}
        subtitle={
          <>
            <span className="font-semibold">
              {user.role}
            </span>

            <p className="mt-2 max-w-2xl text-sm leading-6 opacity-90">
              Your sales workspace for leads, quotations,
              site visits and performance.
            </p>
          </>
        }
      />

      <section
        aria-label="Workspace"
        className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        {cards
          .filter((card) => canAccess(user.role, card.s))
          .map((card) => (
            <Link
              key={card.to}
              href={card.to}
              className="group flex min-h-[165px] min-w-0 flex-col justify-between gap-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 sm:p-6"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-blue-50 text-blue-800 transition-colors group-hover:bg-blue-100">
                  <card.icon className="h-6 w-6" />
                </div>

                {card.s !== "performance" && (
                  <Suspense
                    fallback={
                      <Skeleton className="h-7 w-10 rounded-full" />
                    }
                  >
                    <HomeCount
                      section={card.s}
                      user={user}
                    />
                  </Suspense>
                )}
              </div>

              <div className="min-w-0">
                <h3 className="text-lg font-bold leading-tight text-slate-900">
                  {card.label}
                </h3>

                <p className="mt-2 text-sm leading-6 text-slate-500">
                  {card.desc}
                </p>
              </div>
            </Link>
          ))}
      </section>

      <div className="space-y-5 border-t border-slate-200 pt-7">
        {user.role === "Manager" ? (
          <Suspense
            fallback={
              <InsightsSkeleton
                label="Loading monthly performance"
                count={3}
              />
            }
          >
            <ManagerMonthSummary />
          </Suspense>
        ) : (
          <Suspense
            fallback={
              <InsightsSkeleton
                label="Loading today's summary"
                count={
                  user.role === "Sales Executive" ? 3 : 1
                }
              />
            }
          >
            <TodaySummary user={user} />
          </Suspense>
        )}
      </div>

      {user.role === "Manager" && (
        <ManagerPasswordReset
          users={STATIC_USERS.map(({ username, name }) => ({
            username,
            name,
          }))}
        />
      )}
    </div>
  );
}
