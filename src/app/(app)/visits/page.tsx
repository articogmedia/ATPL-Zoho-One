import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import { env } from "@/lib/env";
import { isAssignable, todayIST, visibleFor } from "@/lib/domain";
import { VisitsClient } from "./VisitsClient";

export const metadata = { title: "My Work & Site Visits" };
export const dynamic = "force-dynamic";

export default async function VisitsPage() {
  const user = await requireSection("visits");
  const repo = crm();
  const [visits, users] = await Promise.all([repo.listVisits(), repo.listUsers()]);
  return (
    <>
      <h1 className="mb-5 text-2xl font-bold">My Work &amp; Site Visits</h1>
      <VisitsClient
        user={{ id: user.id, name: user.name, role: user.role }}
        visits={visibleFor(user, visits)}
        executives={users.filter((u) => isAssignable(u, env().ZOHO_QUEUE_OWNER_ID)).map((u) => u.name)}
        today={todayIST()}
      />
    </>
  );
}
