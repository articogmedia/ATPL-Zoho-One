"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, type ReactNode } from "react";
import { BarChart3, ClipboardList, FileText, Home, LogOut, MapPin } from "lucide-react";
import { canAccess, type Role, type Section } from "@/lib/domain";
import { logout, logoutExpired } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";

const NAV = [
  { s: "leads" as Section, to: "/leads", label: "Manage Leads", short: "Leads", icon: ClipboardList },
  { s: "quotations" as Section, to: "/quotations", label: "Create Quotation", short: "Quotes", icon: FileText },
  { s: "visits" as Section, to: "/visits", label: "My Work & Site Visits", short: "Visits", icon: MapPin },
  { s: "performance" as Section, to: "/performance", label: "Performance", short: "Stats", icon: BarChart3 },
];

export function AppShell({ user, inactivityMinutes = 30, children }: { user: { name: string; role: Role }; inactivityMinutes?: number; children: ReactNode }) {
  const path = usePathname();
  const items = NAV.filter((n) => canAccess(user.role, n.s));

  useEffect(() => {
    let timer: number | undefined;
    const resetTimer = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void logoutExpired();
      }, inactivityMinutes * 60_000);
    };
    const events = ["pointerdown", "keydown", "touchstart", "scroll"] as const;
    events.forEach((event) => window.addEventListener(event, resetTimer, { passive: true }));
    resetTimer();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      events.forEach((event) => window.removeEventListener(event, resetTimer));
    };
  }, [inactivityMinutes]);

  return (
    <div className="flex min-h-dvh w-full bg-muted">
      <aside className="hidden w-[240px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex">
        <Link href="/home" className="flex items-center gap-2 px-6 py-6">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white">
            <Image src="/brand/atpl-mark-512.png" width={32} height={32} alt="ATPL mark" priority />
          </span>
          <div>
            <div className="text-lg font-bold leading-tight">ATPL Sales Portal</div>
            <div className="text-xs opacity-75">Air Trendz Pvt Ltd</div>
          </div>
        </Link>
        <nav className="mt-2 flex flex-col gap-1 px-3">
          <Link href="/home" className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold transition-colors ${path === "/home" ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm" : "hover:bg-sidebar-primary"}`}>
            <Home className="h-5 w-5" /> Home
          </Link>
          {items.map((n) => (
            <Link key={n.to} href={n.to}
              prefetch
              className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors ${path === n.to ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm" : "hover:bg-sidebar-primary"}`}>
              <n.icon className="h-5 w-5" /> {n.label}
            </Link>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-border bg-card/95 px-4 backdrop-blur md:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex min-w-0 items-center gap-2 md:hidden">
              <span className="grid h-10 w-10 place-items-center rounded-lg bg-white shadow-sm">
                <Image src="/brand/atpl-mark-512.png" width={32} height={32} alt="ATPL mark" />
              </span>
              <span className="truncate text-sm font-semibold">ATPL Sales Portal</span>
            </div>
            <div className="hidden min-w-0 text-right md:block">
              <div className="truncate text-sm font-semibold">{user.name}</div>
              <div className="truncate text-[11px] text-muted-foreground">{user.role}</div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <div className="text-right leading-tight md:hidden">
              <div className="truncate text-sm font-medium">{user.name}</div>
              <div className="truncate text-xs text-slate-500">{user.role}</div>
            </div>
            <form action={logout}>
              <Button type="submit" variant="outline" size="lg" className="max-[480px]:h-11 max-[480px]:w-11 max-[480px]:px-0" aria-label="Logout" title="Logout"><LogOut className="h-4 w-4" /><span className="max-[480px]:hidden">Logout</span></Button>
            </form>
          </div>
        </header>
        <main className="mx-auto min-w-0 w-full max-w-[1280px] flex-1 px-4 pb-28 pt-5 md:px-8 md:pb-10">
          <Suspense fallback={<div className="space-y-4" aria-label="Loading"><div className="h-8 w-48 animate-pulse rounded-lg bg-secondary" /><div className="h-32 animate-pulse rounded-xl bg-secondary" /></div>}>
            {children}
          </Suspense>
        </main>
      </div>

      {items.length > 0 && (
        <nav className="fixed inset-x-0 bottom-0 z-30 grid min-h-[64px] border-t border-border bg-card px-1 pb-[env(safe-area-inset-bottom)] lg:hidden" style={{ gridTemplateColumns: `repeat(${items.length + 1}, minmax(0,1fr))` }}>
          <Link href="/home" className={`flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium ${path === "/home" ? "text-primary" : "text-muted-foreground"}`}>
            <Home className="h-5 w-5" /> Home
          </Link>
          {items.map((n) => (
            <Link key={n.to} href={n.to}
              prefetch
              className={`flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium ${path === n.to ? "text-primary" : "text-muted-foreground"}`}>
              <n.icon className="h-5 w-5" /> {n.short}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
