import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import { perfStats, todayIST, visibleFor, type PerfRange } from "@/lib/domain";
import { VisitsClient } from "./VisitsClient";

export const metadata = { title: "My Work & Site Visits" };
export const dynamic = "force-dynamic";

export default async function VisitsPage() {
  const started = Date.now();
  const user = await requireSection("visits");
  const repo = crm();
  const executivePerformance = user.role === "Sales Executive";
  const baseResults = await Promise.allSettled([
    repo.listVisits(),
    repo.listAssignableUsers(),
  ]);
  const performanceResults = executivePerformance
    ? await Promise.allSettled([repo.listLeads(), repo.listQuotes(), repo.listCalls()])
    : [];
  const failedIndex = baseResults.findIndex((result) => result.status === "rejected");
  if (failedIndex >= 0 && (!executivePerformance || failedIndex !== 4)) {
    const errors = baseResults.map((result, index) => result.status === "rejected" ? `request ${index + 1}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}` : null).filter(Boolean);
    console.error("[page] visits data load failed", errors.join("; "));
  }
  const callsResult = performanceResults[2];
  if (callsResult?.status === "rejected") console.error("[page] Calls list failed", callsResult.reason);
  const callsError = callsResult?.status === "rejected"
    ? callsResult.reason instanceof Error ? callsResult.reason.message : String(callsResult.reason)
    : "";
  const callsScopeMismatch = /scope|permission/i.test(callsError);
  const visits = baseResults[0].status === "fulfilled" ? baseResults[0].value : [];
  const assignableUsers = baseResults[1].status === "fulfilled" ? baseResults[1].value : [];
  const leads = performanceResults[0]?.status === "fulfilled" ? performanceResults[0].value : [];
  const quotes = performanceResults[1]?.status === "fulfilled" ? performanceResults[1].value : [];
  const calls = callsResult?.status === "fulfilled" ? callsResult.value : [];
  console.info(`[page] visits ${Date.now() - started}ms`);
  const performance = (range: PerfRange) => {
    const stats = perfStats(leads, quotes, visits, range, todayIST(), [{ id: user.id, name: user.name, role: user.role }], user, calls);
    return {
      leads: stats.totalLeads, calls: stats.calls, visits: stats.completed, quotes: stats.quotesSent,
      won: stats.won, conversion: stats.conversion,
    };
  };
  return (
    <>
      <h1 className="mb-5 text-2xl font-bold">My Work &amp; Site Visits</h1>
      {user.role === "Manager" && callsResult?.status === "rejected" && <div role="status" className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{callsScopeMismatch ? "Call history is unavailable because the Zoho refresh token lacks Calls permission. Re-authorize Zoho with ZohoCRM.modules.calls.ALL, then reconnect." : "Call history is temporarily unavailable. Visits are still shown."}</div>}
      <VisitsClient
        user={{ id: user.id, name: user.name, role: user.role }}
        visits={visibleFor(user, visits)}
        executives={assignableUsers.map((u) => u.name)}
        today={todayIST()}
        performance={user.role === "Sales Executive" ? { week: performance("week"), month: performance("month") } : undefined}
      />
    </>
  );
}
