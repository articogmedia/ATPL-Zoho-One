"use client";

import Link, { useLinkStatus } from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, BarChart3, ClipboardList, FileText, Home, LogOut, MapPin, Package, ReceiptText, RotateCw } from "lucide-react";
import { canAccess, type Role, type Section } from "@/lib/domain";
import { logout, logoutExpired } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";

const NAV = [
  { s: "leads" as Section, to: "/leads", label: "Manage Leads", short: "Leads", icon: ClipboardList },
  { s: "quotations" as Section, to: "/quotations", label: "Create Quotation", short: "Quotes", icon: FileText },
  { s: "invoices" as Section, to: "/invoices", label: "Invoices", short: "Invoices", icon: ReceiptText },
  { s: "visits" as Section, to: "/visits", label: "My Work & Site Visits", short: "Visits", icon: MapPin },
  { s: "performance" as Section, to: "/performance", label: "Performance", short: "Stats", icon: BarChart3 },
];

export function AppShell({ user, inactivityMinutes = 30, children }: { user: { name: string; role: Role }; inactivityMinutes?: number; children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [newVersionAvailable, setNewVersionAvailable] = useState(false);
  const lastWarmAt = useRef(0);
  const applyingServiceWorkerUpdate = useRef(false);
  const items = [
    ...NAV.filter((n) => canAccess(user.role, n.s)),
    ...(user.role === "Manager" ? [{ to: "/products", label: "Products", short: "Products", icon: Package }] : []),
  ];

  useEffect(() => {
    const versionMismatch = (message: string) => {
      if (/failed to find server action|chunkloaderror|loading chunk .* failed/i.test(message)) {
        setNewVersionAvailable(true);
        return true;
      }
      return false;
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const message = event.reason instanceof Error ? `${event.reason.name}: ${event.reason.message}` : String(event.reason);
      if (versionMismatch(message)) event.preventDefault();
    };
    const onError = (event: ErrorEvent) => { versionMismatch(`${event.message} ${event.error?.name ?? ""}`); };
    const onUpdateAvailable = () => setNewVersionAvailable(true);
    const onControllerChange = () => {
      if (applyingServiceWorkerUpdate.current) window.location.reload();
    };
    window.addEventListener("atpl:pwa-update-ready", onUpdateAvailable);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    window.addEventListener("error", onError);
    navigator.serviceWorker?.addEventListener("controllerchange", onControllerChange);
    return () => {
      window.removeEventListener("atpl:pwa-update-ready", onUpdateAvailable);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      window.removeEventListener("error", onError);
      navigator.serviceWorker?.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  useEffect(() => {
    const refreshAfterRetry = () => router.refresh();
    window.addEventListener("atpl:mutation-recovered", refreshAfterRetry);
    return () => window.removeEventListener("atpl:mutation-recovered", refreshAfterRetry);
  }, [router]);

  useEffect(() => {
    const warm = () => {
      lastWarmAt.current = Date.now();
      void fetch("/api/warm", { method: "GET", cache: "no-store" }).catch(() => undefined);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastWarmAt.current < 5 * 60_000) return;
      warm();
    };
    lastWarmAt.current = Date.now();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

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
    <div className="flex min-h-dvh w-full max-w-full overflow-x-hidden bg-muted">
      <aside className="hidden w-[240px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:flex lg:h-dvh lg:overflow-y-auto">
        <Link href="/home" className="flex items-center gap-2 px-6 py-6">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white">
            <Image src="/brand/atpl-mark-96.webp" width={40} height={40} sizes="40px" quality={75} alt="ATPL mark" priority />
          </span>
          <div>
            <div className="whitespace-nowrap text-lg font-bold leading-tight">ATPL Sales Portal</div>
            <div className="text-xs opacity-75">Air Trendz Pvt Ltd</div>
          </div>
        </Link>
        <nav className="mt-2 flex flex-col gap-1 px-3">
          <Link href="/home" prefetch={true} className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold transition-colors ${path === "/home" ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm" : "hover:bg-sidebar-primary"}`}>
            <PendingNavContent icon={Home} label="Home" />
          </Link>
          {items.map((n) => (
            <Link key={n.to} href={n.to} prefetch={true}
              className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors ${path === n.to ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm" : "hover:bg-sidebar-primary"}`}>
              <PendingNavContent icon={n.icon} label={n.label} />
            </Link>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col lg:ml-[240px]">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-card/95 px-4 backdrop-blur md:px-8">
          <Link href="/home" className="flex min-w-0 items-center gap-2 lg:hidden">
              <span className="grid h-10 w-10 place-items-center rounded-lg bg-white shadow-sm">
                <Image src="/brand/atpl-mark-96.webp" width={40} height={40} sizes="40px" quality={75} alt="ATPL mark" />
              </span>
            <span className="max-[379px]:hidden truncate text-sm font-semibold">ATPL Sales Portal</span>
          </Link>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <div className="hidden text-right leading-tight lg:block">
              <div className="truncate text-sm font-semibold">{user.name}</div>
              <div className="truncate text-[11px] text-muted-foreground">{user.role}</div>
            </div>
            <div className="text-right leading-tight lg:hidden">
              <div className="truncate text-sm font-medium">{user.name}</div>
              <div className="truncate text-xs text-slate-500">{user.role}</div>
            </div>
            <form action={logout}>
              <Button type="submit" variant="outline" size="lg" className="max-[480px]:h-11 max-[480px]:w-11 max-[480px]:px-0" aria-label="Logout" title="Logout"><LogOut className="h-4 w-4" /><span className="max-[480px]:hidden">Logout</span></Button>
            </form>
          </div>
        </header>
        <main className="mx-auto min-w-0 w-full max-w-[1280px] flex-1 overflow-visible px-4 pb-28 pt-5 md:px-8 md:pb-10">
          {newVersionAvailable && <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
            <span className="inline-flex items-center gap-2"><AlertTriangle className="h-4 w-4 shrink-0" />A new version is available. Reload to continue safely.</span>
            <Button type="button" variant="outline" className="h-10" onClick={async () => {
              const registration = await navigator.serviceWorker?.getRegistration();
              if (registration?.waiting) {
                applyingServiceWorkerUpdate.current = true;
                registration.waiting.postMessage({ type: "SKIP_WAITING" });
              } else {
                window.location.reload();
              }
            }}><RotateCw className="h-4 w-4" /> Update now</Button>
          </div>}
          <Suspense fallback={<div className="space-y-4" aria-label="Loading"><div className="h-8 w-48 animate-pulse rounded-lg bg-secondary" /><div className="h-32 animate-pulse rounded-xl bg-secondary" /></div>}>
            {children}
          </Suspense>
        </main>
      </div>

      {items.length > 0 && (
        <nav className="fixed inset-x-0 bottom-0 z-30 grid min-h-[64px] border-t border-border bg-card px-1 pb-[env(safe-area-inset-bottom)] lg:hidden" style={{ gridTemplateColumns: `repeat(${items.length + 1}, minmax(0,1fr))` }}>
          <Link href="/home" prefetch={true} className={`flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium ${path === "/home" ? "text-primary" : "text-muted-foreground"}`}>
            <PendingNavContent icon={Home} label="Home" vertical />
          </Link>
          {items.map((n) => (
            <Link key={n.to} href={n.to} prefetch={true}
              className={`flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium ${path === n.to ? "text-primary" : "text-muted-foreground"}`}>
              <PendingNavContent icon={n.icon} label={n.short} vertical />
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}

function PendingNavContent({ icon: Icon, label, vertical = false }: { icon: typeof Home; label: string; vertical?: boolean }) {
  const { pending } = useLinkStatus();
  return <span className={`flex items-center gap-3 ${vertical ? "flex-col gap-1" : ""} ${pending ? "animate-pulse opacity-60" : ""}`} aria-busy={pending}>
    <Icon className="h-5 w-5" />{label}
  </span>;
}
