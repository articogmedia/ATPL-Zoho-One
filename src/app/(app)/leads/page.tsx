import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import { leadsForTab, todayIST, visibleFor, type LeadTab } from "@/lib/domain";
import { LeadsClient } from "./LeadsClient";
import { beginPagePerf, endPagePerf } from "@/lib/page-perf";
import { PageLoadError } from "@/components/PageLoadError";
import { withPageTimeout } from "@/lib/page-timeout";
import { env } from "@/lib/env";

export const metadata = { title: "Manage Leads" };
export const dynamic = "force-dynamic";
export const preferredRegion = "bom1";
export const maxDuration = 30;

export default async function LeadsPage() {
  const started = Date.now();
  const perf = beginPagePerf("leads");
  const user = await requireSection("leads");
  const repo = crm();
  let allLeads: Awaited<ReturnType<typeof repo.listLeads>>;
  let totalLeads = 0;
  let fixableLeads: Awaited<ReturnType<typeof repo.listFixableAssignedLeads>> = [];
  let assignableUsers: Awaited<ReturnType<typeof repo.listAssignableUsers>> = [];
  let leadSources: Awaited<ReturnType<typeof repo.listLeadSources>> = [];
  let assignableUsersFailed = false;
  let leadSourcesUnavailable = false;
  const optionalData = withPageTimeout(Promise.allSettled([
    user.role === "Manager" ? repo.listFixableAssignedLeads(user) : Promise.resolve([]),
    repo.listAssignableUsers(),
    repo.listLeadSources(),
  ]), 2_500).catch((error: unknown) => {
    console.error("[page] optional lead data timed out", { message: error instanceof Error ? error.message : String(error) });
    return null;
  });
  try {
    allLeads = await withPageTimeout(repo.listLeads());
    const visibleLeads = visibleFor(user, allLeads);
    totalLeads = visibleLeads.length;
    if (allLeads.length >= env().ZOHO_MAX_LEADS && repo.listLeadsPage) {
      totalLeads = await withPageTimeout(repo.listLeadsPage(
        1, 1, user.role === "Sales Executive" ? user.id : undefined,
      )).then((page) => page.total);
    }
  } catch (error) {
    console.error("[page] leads data load failed", { message: error instanceof Error ? error.message : String(error) });
    endPagePerf(perf);
    return <PageLoadError message="Lead data is temporarily unavailable. Retry without leaving this page." />;
  }
  const optionalResults = await optionalData;
  if (!optionalResults) {
    assignableUsersFailed = true;
    leadSourcesUnavailable = true;
  } else {
    const [fixableResult, assigneesResult, sourcesResult] = optionalResults;
    if (fixableResult.status === "fulfilled") fixableLeads = fixableResult.value;
    else console.error("[page] fixable assigned leads unavailable", { message: String(fixableResult.reason) });
    if (assigneesResult.status === "fulfilled") assignableUsers = assigneesResult.value;
    else {
      assignableUsersFailed = true;
      console.error("[page] active team members unavailable", { message: String(assigneesResult.reason) });
    }
    if (sourcesResult.status === "fulfilled") leadSources = sourcesResult.value;
    else {
      leadSourcesUnavailable = true;
      console.error("[page] lead sources unavailable", { message: String(sourcesResult.reason) });
    }
  }
  assignableUsersFailed ||= assignableUsers.length === 0;
  leadSourcesUnavailable ||= leadSources.length === 0;
  const visibleLeads = visibleFor(user, allLeads);
  const tabs: LeadTab[] = ["fresh", "assigned", "callback", "mine", "all"];
  const tabCounts = Object.fromEntries(tabs.map((tab) => [tab, leadsForTab(user, visibleLeads, tab).length])) as Record<LeadTab, number>;
  const initialTab: LeadTab = user.role === "Manager" && tabCounts.fresh === 0 ? "all" : user.role === "Sales Executive" ? "mine" : "fresh";
  const todaysFollowUps = leadsForTab(user, visibleLeads, "callback").filter((lead) => lead.followUp === todayIST()).length;
  console.info(`[page] leads ${Date.now() - started}ms (${visibleLeads.length}/${totalLeads} rows)`);
  endPagePerf(perf);
  return (
    <LeadsClient
      user={{ id: user.id, name: user.name, role: user.role }}
      leads={visibleLeads}
      initialHasMore={false}
      initialTab={initialTab}
      initialCount={totalLeads}
      tabCounts={tabCounts}
      todaysFollowUps={todaysFollowUps}
      hasAnyLeads={visibleLeads.length > 0}
      executives={assignableUsers.map((u) => u.name)}
      assignees={assignableUsers.map(({ id, name }) => ({ id, name }))}
      assigneesUnavailable={assignableUsersFailed}
      leadSources={leadSources}
      leadSourcesUnavailable={leadSourcesUnavailable}
      owners={assignableUsers.map((u) => u.name)}
      canAssign={user.role === "Manager" || user.role === "Calling Team"}
      fixableLeads={fixableLeads}
    />
  );
}
