import { crm } from "@/lib/crm";
import { env } from "@/lib/env";
import { requireSection } from "@/lib/auth/guard";
import { perfStats, todayIST, visibleFor, type PerfRange } from "@/lib/domain";
import { VisitsClient } from "./VisitsClient";
import { beginPagePerf, endPagePerf } from "@/lib/page-perf";
import { PageLoadError } from "@/components/PageLoadError";
import { withPageTimeout } from "@/lib/page-timeout";

export const metadata = { title: "My Work & Site Visits" };
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export default async function VisitsPage() {
  const started = Date.now();
  const perf = beginPagePerf("visits");
  const user = await requireSection("visits");
  const settings = env();
  console.info("[page] visits Zoho environment", {
    dataSource: settings.DATA_SOURCE,
    environment: settings.DATA_SOURCE !== "zoho" ? "mock" : settings.ZOHO_SANDBOX === "true" ? "sandbox" : "live",
    dataCenter: settings.ZOHO_DC,
  });
  const repo = crm();
  const executivePerformance = user.role === "Sales Executive";
  const dataDeadline = Date.now() + 12_000;
  let baseResults: [
    PromiseSettledResult<Awaited<ReturnType<typeof repo.listVisits>>>,
    PromiseSettledResult<Awaited<ReturnType<typeof repo.listAssignableUsers>>>,
  ];
  try {
    baseResults = await withPageTimeout(Promise.allSettled([
      repo.listVisits(),
      repo.listAssignableUsers(),
    ]), Math.max(1, dataDeadline - Date.now()));
  } catch (error) {
    console.error("[page] visits data load timed out", { message: error instanceof Error ? error.message : String(error) });
    endPagePerf(perf);
    return <PageLoadError message="Work items are temporarily unavailable. Retry to load them again." />;
  }
  const performanceResults = executivePerformance
    ? await withPageTimeout(Promise.allSettled([repo.listLeads(), repo.listQuotes(), repo.listCalls()]), Math.max(1, dataDeadline - Date.now())).catch((error) => {
      console.error("[page] visits performance data timed out", { message: error instanceof Error ? error.message : String(error) });
      return [];
    })
    : [];
  const failedIndex = baseResults.findIndex((result) => result.status === "rejected");
  if (failedIndex >= 0) {
    const errors = baseResults.map((result, index) => result.status === "rejected" ? `request ${index + 1}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}` : null).filter(Boolean);
    console.error("[page] visits data load failed", errors.join("; "));
  }
  const callsResult = performanceResults[2];
  if (callsResult?.status === "rejected") console.error("[page] Calls list failed", callsResult.reason);
  const callsError = callsResult?.status === "rejected"
    ? callsResult.reason instanceof Error ? callsResult.reason.message : String(callsResult.reason)
    : "";
  const callsScopeMismatch = /scope|permission/i.test(callsError);
  const callWarning = user.role === "Sales Executive" && callsResult?.status === "rejected"
    ? callsScopeMismatch
      ? "Call history is unavailable because the Zoho refresh token lacks Calls permission. Re-authorize Zoho with ZohoCRM.modules.calls.ALL, then reconnect."
      : "Call history is temporarily unavailable. Visits are still shown."
    : undefined;
  const visits = baseResults[0].status === "fulfilled" ? baseResults[0].value : [];
  const visitsWarning = baseResults[0].status === "rejected"
    ? `Unable to load Zoho work items: ${baseResults[0].reason instanceof Error ? baseResults[0].reason.message : String(baseResults[0].reason)}`
    : repo.getVisitsWarning?.() ?? undefined;
  const assignableUsers = baseResults[1].status === "fulfilled" ? baseResults[1].value : [];
  const leads = performanceResults[0]?.status === "fulfilled" ? performanceResults[0].value : [];
  const quotes = performanceResults[1]?.status === "fulfilled" ? performanceResults[1].value : [];
  const calls = callsResult?.status === "fulfilled" ? callsResult.value : [];
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
    <>
      <VisitsClient
        user={{ id: user.id, name: user.name, role: user.role }}
        visits={visibleFor(user, visits)}
        executives={assignableUsers.map((u) => u.name)}
        today={todayIST()}
        performance={user.role === "Sales Executive" ? { week: performance("week"), month: performance("month") } : undefined}
        callWarning={callWarning}
        visitsWarning={visitsWarning}
      />
    </>
  );
}
