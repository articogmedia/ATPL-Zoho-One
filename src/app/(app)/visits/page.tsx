import { Suspense } from "react";
import { crm } from "@/lib/crm";
import { env } from "@/lib/env";
import { requireSection } from "@/lib/auth/guard";
import { perfStats, todayIST, visibleFor, type PerfRange, type User } from "@/lib/domain";
import { VisitsClient } from "./VisitsClient";
import { beginPagePerf, endPagePerf } from "@/lib/page-perf";
import { RouteLoading } from "@/components/RouteLoading";
import { PageDataTimeoutError } from "@/lib/page-timeout";

export const metadata = { title: "My Work & Site Visits" };
export const dynamic = "force-dynamic";
export const preferredRegion = "bom1";
export const maxDuration = 30;

async function VisitsData({ user }: { user: User }) {
  const started = Date.now();
  const perf = beginPagePerf("visits");
  const settings = env();
  console.info("[page] visits Zoho environment", {
    dataSource: settings.DATA_SOURCE,
    environment: settings.DATA_SOURCE !== "zoho" ? "mock" : settings.ZOHO_SANDBOX === "true" ? "sandbox" : "live",
    dataCenter: settings.ZOHO_DC,
  });

  const repo = crm();
  const executivePerformance = user.role === "Sales Executive";
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => reject(new PageDataTimeoutError()), 12_000);
  });
  const withinDeadline = <T,>(request: Promise<T>) => Promise.race([request, deadline]);

  let results: [
    PromiseSettledResult<Awaited<ReturnType<typeof repo.listVisits>>>,
    PromiseSettledResult<Awaited<ReturnType<typeof repo.listAssignableUsers>>>,
    PromiseSettledResult<Awaited<ReturnType<typeof repo.listLeads>>>,
    PromiseSettledResult<Awaited<ReturnType<typeof repo.listQuotes>>>,
    PromiseSettledResult<Awaited<ReturnType<typeof repo.listCalls>>>,
  ];
  try {
    results = await Promise.allSettled([
      withinDeadline(repo.listVisits()),
      withinDeadline(repo.listAssignableUsers()),
      withinDeadline(executivePerformance ? repo.listLeads() : Promise.resolve([])),
      withinDeadline(executivePerformance ? repo.listQuotes() : Promise.resolve([])),
      withinDeadline(executivePerformance ? repo.listCalls() : Promise.resolve([])),
    ]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }

  const [visitsResult, usersResult, leadsResult, quotesResult, callsResult] = results;
  for (const [name, result] of [
    ["visits", visitsResult],
    ["assignable users", usersResult],
    ["leads", leadsResult],
    ["quotations", quotesResult],
    ["calls", callsResult],
  ] as const) {
    if (result.status === "rejected") {
      console.error(`[page] visits ${name} load failed`, {
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  const callsError = callsResult.status === "rejected"
    ? callsResult.reason instanceof Error ? callsResult.reason.message : String(callsResult.reason)
    : "";
  const callsScopeMismatch = /scope|permission/i.test(callsError);
  const callWarning = executivePerformance && callsResult.status === "rejected"
    ? callsScopeMismatch
      ? "Call history is unavailable because the Zoho refresh token lacks Calls permission. Re-authorize Zoho with ZohoCRM.modules.calls.ALL, then reconnect."
      : "Call history is temporarily unavailable. Visits are still shown."
    : undefined;
  const visits = visitsResult.status === "fulfilled" ? visitsResult.value : [];
  const visitsWarning = visitsResult.status === "rejected"
    ? `Unable to load Zoho work items: ${visitsResult.reason instanceof Error ? visitsResult.reason.message : String(visitsResult.reason)}`
    : repo.getVisitsWarning?.() ?? undefined;
  const assignableUsers = usersResult.status === "fulfilled" ? usersResult.value : [];
  const assignableUsersUnavailable = usersResult.status === "rejected" || assignableUsers.length === 0;
  const leads = leadsResult.status === "fulfilled" ? leadsResult.value : [];
  const quotes = quotesResult.status === "fulfilled" ? quotesResult.value : [];
  const calls = callsResult.status === "fulfilled" ? callsResult.value : [];

  console.info(`[page] visits ${Date.now() - started}ms`);
  endPagePerf(perf);
  const performance = (range: PerfRange) => {
    const stats = perfStats(leads, quotes, visits, range, todayIST(), [{ id: user.id, name: user.name, role: user.role }], user, calls);
    return {
      leads: stats.totalLeads, calls: stats.calls, visits: stats.completed, quotes: stats.quotesSent,
      won: stats.won, conversion: stats.conversion,
    };
  };
  return (
    <VisitsClient
      user={{ id: user.id, name: user.name, role: user.role }}
      visits={visibleFor(user, visits)}
      executives={assignableUsers.map((u) => u.name)}
      executivesUnavailable={assignableUsersUnavailable}
      today={todayIST()}
      performance={executivePerformance ? { week: performance("week"), month: performance("month") } : undefined}
      callWarning={callWarning}
      visitsWarning={visitsWarning}
    />
  );
}

export default async function VisitsPage() {
  const user = await requireSection("visits");
  return (
    <Suspense fallback={<RouteLoading title="My Work and Site Visits" cards={3} />}>
      <VisitsData user={user} />
    </Suspense>
  );
}
