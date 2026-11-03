import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import { perfStats, todayIST, visibleFor, type PerfRange } from "@/lib/domain";
import { VisitsClient } from "./VisitsClient";

export const metadata = { title: "My Work & Site Visits" };
export const dynamic = "force-dynamic";

export default async function VisitsPage() {
  const user = await requireSection("visits");
  const repo = crm();
  const [visits, assignableUsers, leads, quotes, calls] = await Promise.all([
    repo.listVisits(), repo.listAssignableUsers(), repo.listLeads(), repo.listQuotes(), repo.listCalls(),
  ]);
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
