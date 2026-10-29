"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { BarChart3, ClipboardList, FileText, LogOut, MapPin, Snowflake } from "lucide-react";
import { canAccess, type Role, type Section } from "@/lib/domain";
import { logout } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";

const NAV = [
  { s: "leads" as Section, to: "/leads", label: "Manage Leads", short: "Leads", icon: ClipboardList },
  { s: "quotations" as Section, to: "/quotations", label: "Create Quotation", short: "Quotes", icon: FileText },
  { s: "visits" as Section, to: "/visits", label: "My Work & Site Visits", short: "Visits", icon: MapPin },
  { s: "performance" as Section, to: "/performance", label: "Performance", short: "Stats", icon: BarChart3 },
];

export function AppShell({ user, children }: { user: { name: string; role: Role }; children: ReactNode }) {
  const path = usePathname();
  const items = NAV.filter((n) => canAccess(user.role, n.s));

  return (
    <div className="flex min-h-screen w-full bg-muted">
      <aside className="hidden w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground lg:flex">
        <Link href="/home" className="flex items-center gap-2 px-6 py-6">
          <Snowflake className="h-7 w-7" />
          <div>
            <div className="text-lg font-bold leading-tight">ATPL Sales Portal</div>
            <div className="text-xs opacity-75">Air Trendz Pvt Ltd</div>
          </div>
        </Link>
        <nav className="flex flex-col gap-1 px-3">
          {items.map((n) => (
            <Link key={n.to} href={n.to}
              className={`flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium transition-colors ${path === n.to ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-primary"}`}>
              <n.icon className="h-5 w-5" /> {n.label}
            </Link>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b bg-card px-4 py-3 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <Snowflake className="h-6 w-6 shrink-0 text-primary lg:hidden" />
            <div className="min-w-0">
              <div className="truncate font-semibold">{user.name}</div>
              <div className="truncate text-xs text-muted-foreground">{user.role}</div>
            </div>
          </div>
          <form action={logout}>
            <Button type="submit" variant="outline" size="lg"><LogOut className="h-4 w-4" /> Logout</Button>
          </form>
        </header>
        <main className="flex-1 px-4 pb-28 pt-5 lg:px-8 lg:pb-10">{children}</main>
      </div>

      {items.length > 1 && (
        <nav className="fixed inset-x-0 bottom-0 z-30 grid border-t bg-card lg:hidden" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0,1fr))` }}>
          {items.map((n) => (
            <Link key={n.to} href={n.to}
              className={`flex min-h-16 flex-col items-center justify-center gap-1 text-xs font-medium ${path === n.to ? "text-primary" : "text-muted-foreground"}`}>
              <n.icon className="h-6 w-6" /> {n.short}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
