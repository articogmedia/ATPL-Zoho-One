import "server-only";
import { after } from "next/server";
import { crm } from "@/lib/crm";
import { getCachedValue, setCachedValue } from "@/lib/cache";
import { env } from "@/lib/env";
import { summarizeLeads, type User } from "@/lib/domain";

type LeadSummary = ReturnType<typeof summarizeLeads>;
type LeadAggregate = Record<string, LeadSummary>;

const globalState = globalThis as typeof globalThis & {
  __atplLeadAggregateWarm?: Promise<void>;
};

async function buildLeadAggregate() {
  const repository = crm();
  const [leads, users] = await Promise.all([repository.listLeads(), repository.listUsers()]);
  const aggregate = Object.fromEntries(users.map((user) => [
    user.id,
    summarizeLeads(user, leads),
  ]));
  await setCachedValue("leads:aggregate", 60_000, aggregate);
}

function scheduleAggregateWarm() {
  if (env().DATA_SOURCE !== "zoho" || globalState.__atplLeadAggregateWarm) return;
  const warm = () => buildLeadAggregate()
    .catch((error: unknown) => {
      console.error("[leads] cached count aggregate warm failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      if (globalState.__atplLeadAggregateWarm === task) globalState.__atplLeadAggregateWarm = undefined;
    });
  let task: Promise<void>;
  try {
    task = new Promise<void>((resolve) => {
      after(async () => {
        await warm();
        resolve();
      });
    });
  } catch {
    task = warm();
  }
  globalState.__atplLeadAggregateWarm = task;
}

export async function getCachedLeadSummary(user: User): Promise<LeadSummary | undefined> {
  const aggregate = await getCachedValue<LeadAggregate>("leads:aggregate");
  const summary = aggregate?.[user.id];
  if (summary) return summary;
  scheduleAggregateWarm();
  return undefined;
}
