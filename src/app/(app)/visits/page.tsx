
import { Suspense } from "react";
import { crm } from "@/lib/crm";
import { requireSection } from "@/lib/auth/guard";
import {
  perfStats,
  todayIST,
  visibleFor,
  type PerfRange,
  type User,
} from "@/lib/domain";
import { VisitsClient } from "./VisitsClient";
import { RouteLoading } from "@/components/RouteLoading";

export const metadata = { title: "My Work & Site Visits" };
export const dynamic = "force-dynamic";
export const preferredRegion = "bom1";
export const maxDuration = 30;

const DATA_TIMEOUT_MS = 8_000;

async function withTimeout<T>(
  request: Promise<T>,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} took too long. Please retry.`)),
          DATA_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function VisitsData({ user }: { user: User }) {
  const repo = crm();
  const today = todayIST();
  const isExecutive = user.role === "Sales Executive";

  console.info("[visits] Loading page data", {
    role: user.role,
    dataSource: process.env.DATA_SOURCE,
  });

  const [visitsResult, usersResult, leadsResult, quotesResult, callsResult] =
    await Promise.allSettled([
      withTimeout(repo.listVisits(), "Visits"),
      withTimeout(
        user.role === "Manager"
          ? repo.listAssignableUsers()
          : Promise.resolve([]),
        "Team members",
      ),
      withTimeout(
        isExecutive ? repo.listLeads() : Promise.resolve([]),
        "Leads",
      ),
      withTimeout(
        isExecutive ? repo.listQuotes() : Promise.resolve([]),
        "Quotations",
      ),
      withTimeout(
        isExecutive ? repo.listCalls() : Promise.resolve([]),
        "Calls",
      ),
    ]);

  const visits =
    visitsResult.status === "fulfilled" ? visitsResult.value : [];

  const assignableUsers =
    usersResult.status === "fulfilled" ? usersResult.value : [];

  const leads =
    leadsResult.status === "fulfilled" ? leadsResult.value : [];

  const quotes =
    quotesResult.status === "fulfilled" ? quotesResult.value : [];

  const calls =
    callsResult.status === "fulfilled" ? callsResult.value : [];

  if (visitsResult.status === "rejected") {
    console.error("[visits] Visit loading failed:", visitsResult.reason);
  }

  if (usersResult.status === "rejected") {
    console.error("[visits] Team loading failed:", usersResult.reason);
  }

  if (callsResult.status === "rejected") {
    console.error("[visits] Call history loading failed:", callsResult.reason);
  }

  const visitsWarning =
    visitsResult.status === "rejected"
      ? visitsResult.reason instanceof Error
        ? visitsResult.reason.message
        : "Unable to retrieve visits from Zoho CRM."
      : repo.getVisitsWarning?.() ?? undefined;

  const callsWarning =
    isExecutive && callsResult.status === "rejected"
      ? "Call history is temporarily unavailable. Your scheduled work is still accessible."
      : undefined;

  const performance = (range: PerfRange) => {
    const stats = perfStats(
      leads,
      quotes,
      visits,
      range,
      today,
      [{ id: user.id, name: user.name, role: user.role }],
      user,
      calls,
    );

    return {
      leads: stats.totalLeads,
      calls: stats.calls,
      visits: stats.completed,
      quotes: stats.quotesSent,
      won: stats.won,
      conversion: stats.conversion,
    };
  };

  return (
    <VisitsClient
      user={{
        id: user.id,
        name: user.name,
        role: user.role,
      }}
      visits={visibleFor(user, visits)}
      executives={assignableUsers.map((member) => member.name)}
      executivesUnavailable={
        user.role === "Manager" &&
        (usersResult.status === "rejected" || assignableUsers.length === 0)
      }
      today={today}
      performance={
        isExecutive
          ? {
              week: performance("week"),
              month: performance("month"),
            }
          : undefined
      }
      callWarning={callsWarning}
      visitsWarning={visitsWarning}
    />
  );
}

export default async function VisitsPage() {
  const user = await requireSection("visits");

  return (
    <Suspense
      fallback={
        <RouteLoading title="My Work & Site Visits" cards={3} />
      }
    >
      <VisitsData user={user} />
    </Suspense>
  );
}
