import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import { isExecutive, visibleFor } from "@/lib/domain";
import { LeadsClient } from "./LeadsClient";

export const metadata = { title: "Manage Leads" };
export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  const user = await requireSection("leads");
  const repo = crm();
  const [all, users] = await Promise.all([repo.listLeads(), repo.listUsers()]);
  return (
    <>
      <h1 className="mb-5 text-2xl font-bold">Manage Leads</h1>
      <LeadsClient
        user={{ id: user.id, name: user.name, role: user.role }}
        leads={visibleFor(user, all)}
        executives={users.filter(isExecutive).map((u) => u.name)}
      />
    </>
  );
}
