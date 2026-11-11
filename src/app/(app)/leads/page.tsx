import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import { summarizeLeadCalls, summarizeLeads, visibleFor, type LeadTab } from "@/lib/domain";
import { getCachedLeadSummary } from "@/lib/lead-aggregate";
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
  let pageData: { leads: Awaited<ReturnType<typeof repo.listLeads>>; total: number; hasMore: boolean };
  let calls: Awaited<ReturnType<typeof repo.listCalls>> = [];
  let summary: Awaited<ReturnType<typeof getCachedLeadSummary>>;
  let assignableUsers: Awaited<ReturnType<typeof repo.listAssignableUsers>> = [];
  let leadSources: Awaited<ReturnType<typeof repo.listLeadSources>> = [];
  let assignableUsersFailed = false;
  let leadSourcesUnavailable = false;

  const optionalData = withPageTimeout(Promise.allSettled([
    repo.listAssignableUsers(),
    repo.listLeadSources(),
  ]), 2_500).catch((error: unknown) => {
    console.error("[page] optional lead data timed out", { message: error instanceof Error ? error.message : String(error) });
    return null;
  });
  try {
    const [page, cachedSummary, callRows] = await withPageTimeout(Promise.all([
      repo.listLeadsPage
        ? repo.listLeadsPage(1, 50, user.role === "Sales Executive" ? user.id : undefined)
        : repo.listLeads().then((leads) => ({ leads, total: visibleFor(user, leads).length, hasMore: false })),
      getCachedLeadSummary(user),
      repo.listCalls(),
    ]));
    pageData = page;
    summary = cachedSummary;
    calls = callRows;
    if (!summary && env().DATA_SOURCE !== "zoho") {
      summary = summarizeLeads(user, await repo.listLeads());
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
    const [assigneesResult, sourcesResult] = optionalResults;
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

  const visibleLeads = visibleFor(user, pageData.leads);
  const pageSummary = summarizeLeads(user, visibleLeads);
  const tabCounts = summary?.tabCounts ?? pageSummary.tabCounts;
  const totalLeads = summary?.total ?? pageData.total;
  const initialTab: LeadTab = user.role === "Manager" && tabCounts.fresh === 0 ? "all" : user.role === "Sales Executive" ? "mine" : "fresh";
  const todaysFollowUps = summary?.todaysFollowUps ?? pageSummary.todaysFollowUps;
  console.info(`[page] leads ${Date.now() - started}ms (${visibleLeads.length}/${totalLeads} rows)`);
  endPagePerf(perf);
  return (
    <LeadsClient
      user={{ id: user.id, name: user.name, role: user.role }}
      leads={visibleLeads}
      callStats={Object.fromEntries(visibleLeads.map((lead) => [lead.id, summarizeLeadCalls(calls, lead.id, env().NOT_RESPONSIVE_ATTEMPTS)]))}
      initialHasMore={pageData.hasMore}
      initialTab={initialTab}
      initialCount={totalLeads}
      tabCounts={tabCounts}
      todaysFollowUps={todaysFollowUps}
      hasAnyLeads={summary?.hasAnyLeads ?? pageData.total > 0}
      executives={assignableUsers.map((u) => u.name)}
      assignees={assignableUsers.map(({ id, name }) => ({ id, name }))}
      assigneesUnavailable={assignableUsersFailed}
      leadSources={leadSources}
      leadSourcesUnavailable={leadSourcesUnavailable}
      owners={assignableUsers.map((u) => u.name)}
      canAssign={user.role === "Manager" || user.role === "Calling Team"}
      fixableLeads={[]}
    />
  );
}
