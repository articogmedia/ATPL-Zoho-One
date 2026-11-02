import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import { env } from "@/lib/env";
import { isAssignable, visibleFor } from "@/lib/domain";
import { LeadsClient } from "./LeadsClient";

export const metadata = { title: "Manage Leads" };
export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  const user = await requireSection("leads");
  const repo = crm();
  const [all, users] = await Promise.all([repo.listLeads(), repo.listUsers()]);
  return (
    <LeadsClient
      user={{ id: user.id, name: user.name, role: user.role }}
      leads={visibleFor(user, all)}
      executives={users.filter((u) => isAssignable(u, env().ZOHO_QUEUE_OWNER_ID)).map((u) => u.name)}
      canAssign={user.role === "Manager" || user.role === "Calling Team"}
    />
  );
}
