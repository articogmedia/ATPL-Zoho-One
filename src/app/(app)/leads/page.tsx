import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import { visibleFor } from "@/lib/domain";
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
  console.info(`[page] leads ${Date.now() - started}ms`);
  return (
    <LeadsClient
      user={{ id: user.id, name: user.name, role: user.role }}
      leads={visibleFor(user, all)}
      executives={assignableUsers.map((u) => u.name)}
      owners={assignableUsers.map((u) => u.name)}
      canAssign={user.role === "Manager" || user.role === "Calling Team"}
      fixableLeads={fixableLeads}
    />
  );
}
