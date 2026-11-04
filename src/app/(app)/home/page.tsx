import Link from "next/link";
import { BarChart3, ClipboardList, FileText, MapPin } from "lucide-react";
import { crm } from "@/lib/crm";
import { requireUser } from "@/lib/auth/guard";
import { canAccess, hourIST, visibleFor, type Section } from "@/lib/domain";

export const metadata = { title: "Home" };
export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireUser();
  const hour = hourIST();
  const part = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const repo = crm();
  const [leads, quotes, visits] = await Promise.all([
    canAccess(user.role, "leads") ? repo.listLeads() : [],
    canAccess(user.role, "quotations") ? repo.listQuotes() : [],
    canAccess(user.role, "visits") ? repo.listVisits() : [],
  ]);

  const cards: { s: Section; to: string; label: string; desc: string; icon: typeof ClipboardList; count?: number }[] = [
    { s: "leads", to: "/leads", label: "Manage Leads", icon: ClipboardList, count: visibleFor(user, leads).length,
      desc: user.role === "Calling Team" ? "Add new customer enquiries and keep them updated." : "Track enquiries and update their status." },
    { s: "quotations", to: "/quotations", label: "Create Quotation", icon: FileText, count: visibleFor(user, quotes).length,
      desc: "Pick products, auto-fill approved prices and create the offer." },
    { s: "visits", to: "/visits", label: "My Work & Site Visits", icon: MapPin, count: visibleFor(user, visits).filter((v) => !v.done).length,
      desc: "Your assignments, site visits and follow-ups." },
    { s: "performance", to: "/performance", label: "Performance", icon: BarChart3, desc: "Lead sources, visits, conversions and executive results." },
  ];

  return (
    <>
      <section className="mb-6 rounded-xl bg-primary p-5 text-primary-foreground shadow-elegant sm:p-6">
        <p className="text-sm font-medium opacity-80">{user.role}</p>
        <h1 className="mt-1 text-[28px] font-bold leading-tight">{part}, {user.name}</h1>
        <p className="mt-2 max-w-xl text-sm opacity-90">Your sales workspace for leads, quotations, site visits and performance.</p>
      </section>
      <div className="grid gap-4 sm:grid-cols-2">
        {cards.filter((c) => canAccess(user.role, c.s)).map((c) => (
          <Link key={c.to} href={c.to}
            className="group flex min-h-36 flex-col justify-between gap-6 rounded-xl border border-border bg-card p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-primary hover:shadow-elegant sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div className="grid h-12 w-12 place-items-center rounded-xl bg-accent text-accent-foreground"><c.icon className="h-6 w-6" /></div>
              {typeof c.count === "number" && <span className="inline-flex min-w-8 items-center justify-center rounded-full bg-secondary px-3 py-1 text-xs font-bold text-secondary-foreground" aria-label={`${c.count} items`}>{c.count}</span>}
            </div>
            <div>
              <div className="text-lg font-bold leading-tight">{c.label}</div>
              <div className="mt-1 text-sm text-muted-foreground">{c.desc}</div>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
