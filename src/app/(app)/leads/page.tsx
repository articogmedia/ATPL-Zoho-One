import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import { leadsForTab, todayIST, visibleFor, type LeadTab } from "@/lib/domain";
import { LeadsClient } from "./LeadsClient";
import { beginPagePerf, endPagePerf } from "@/lib/page-perf";
import { PageLoadError } from "@/components/PageLoadError";
import { withPageTimeout } from "@/lib/page-timeout";

export const metadata = { title: "Manage Leads" };
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export default async function LeadsPage() {
  const started = Date.now();
  const perf = beginPagePerf("leads");
  const user = await requireSection("leads");
  const repo = crm();
  let all: Awaited<ReturnType<typeof repo.listLeads>>;
  let fixableLeads: Awaited<ReturnType<typeof repo.listFixableAssignedLeads>>;
  try {
    [all, fixableLeads] = await withPageTimeout(Promise.all([
      repo.listLeads(),
      user.role === "Manager" ? repo.listFixableAssignedLeads(user) : [],
    ]));
  } catch (error) {
    console.error("[page] leads data load failed", { message: error instanceof Error ? error.message : String(error) });
    endPagePerf(perf);
    return <PageLoadError message="Lead data is temporarily unavailable. Retry without leaving this page." />;
  }
  let assignableUsers: Awaited<ReturnType<typeof repo.listAssignableUsers>> = [];
  let assignableUsersFailed = false;
  try {
    assignableUsers = await repo.listAssignableUsers();
    assignableUsersFailed = assignableUsers.length === 0;
    if (assignableUsersFailed) console.warn("[page] no active assignable users returned for leads");
  } catch (error) {
    assignableUsersFailed = true;
    console.error("[page] active team members unavailable", {
      message: error instanceof Error ? error.message : String(error),
      status: error instanceof Error && "status" in error ? error.status : undefined,
      code: error instanceof Error && "code" in error ? error.code : undefined,
      details: error instanceof Error && "details" in error ? error.details : undefined,
      operation: error instanceof Error && "operation" in error ? error.operation : undefined,
    });
  }
  const visibleLeads = visibleFor(user, all);
  const tabs: LeadTab[] = ["fresh", "assigned", "callback", "mine", "all"];
  const tabCounts = Object.fromEntries(tabs.map((tab) => [tab, leadsForTab(user, visibleLeads, tab).length])) as Record<LeadTab, number>;
  const initialTab: LeadTab = user.role === "Manager" && tabCounts.fresh === 0 ? "all" : user.role === "Sales Executive" ? "mine" : "fresh";
  const initialRows = leadsForTab(user, visibleLeads, initialTab).slice(0, 50);
  const todaysFollowUps = leadsForTab(user, visibleLeads, "callback").filter((lead) => lead.followUp === todayIST()).length;
  console.info(`[page] leads ${Date.now() - started}ms (${initialRows.length}/${tabCounts[initialTab]} rows)`);
  endPagePerf(perf);
  return (
    <LeadsClient
      user={{ id: user.id, name: user.name, role: user.role }}
      leads={initialRows}
      initialTab={initialTab}
      initialCount={tabCounts[initialTab]}
      tabCounts={tabCounts}
      todaysFollowUps={todaysFollowUps}
      hasAnyLeads={visibleLeads.length > 0}
      executives={assignableUsers.map((u) => u.name)}
      assignees={assignableUsers.map(({ id, name }) => ({ id, name }))}
      assigneesUnavailable={assignableUsersFailed}
      owners={assignableUsers.map((u) => u.name)}
      canAssign={user.role === "Manager" || user.role === "Calling Team"}
      fixableLeads={fixableLeads}
    />
  );
}
