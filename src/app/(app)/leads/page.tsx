import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import { leadsForTab, todayIST, visibleFor, type LeadTab } from "@/lib/domain";
import { LeadsClient } from "./LeadsClient";

export const metadata = { title: "Manage Leads" };
export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  const started = Date.now();
  const user = await requireSection("leads");
  const repo = crm();
  const [all, assignableUsers, fixableLeads] = await Promise.all([
    repo.listLeads(),
    repo.listAssignableUsers(),
    user.role === "Manager" ? repo.listFixableAssignedLeads(user) : [],
  ]);
  const visibleLeads = visibleFor(user, all);
  const tabs: LeadTab[] = ["fresh", "assigned", "callback", "mine", "all"];
  const tabCounts = Object.fromEntries(tabs.map((tab) => [tab, leadsForTab(user, visibleLeads, tab).length])) as Record<LeadTab, number>;
  const initialTab: LeadTab = user.role === "Manager" && tabCounts.fresh === 0 ? "all" : user.role === "Sales Executive" ? "mine" : "fresh";
  const initialRows = leadsForTab(user, visibleLeads, initialTab).slice(0, 50);
  const todaysFollowUps = leadsForTab(user, visibleLeads, "callback").filter((lead) => lead.followUp === todayIST()).length;
  console.info(`[page] leads ${Date.now() - started}ms (${initialRows.length}/${tabCounts[initialTab]} rows)`);
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
      owners={assignableUsers.map((u) => u.name)}
      canAssign={user.role === "Manager" || user.role === "Calling Team"}
      fixableLeads={fixableLeads}
    />
  );
}
