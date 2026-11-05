import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/auth/guard";
import { crm } from "@/lib/crm";
import { ZohoError } from "@/lib/zoho/client";
import { friendlyZohoError, newErrorReference } from "@/lib/crm-action-errors";
import { LEAD_SOURCES, LEAD_STATUSES, leadsForTab, todayIST, visibleFor, type LeadTab } from "@/lib/domain";

export const dynamic = "force-dynamic";
const tabs = ["fresh", "assigned", "callback", "mine", "all"] as const;
const querySchema = z.object({
  tab: z.enum(tabs),
  page: z.coerce.number().int().min(1).default(1),
  search: z.string().max(120).default(""),
  source: z.enum(["All", ...LEAD_SOURCES]).default("All"),
  owner: z.string().max(120).default("All"),
  stage: z.enum(["All", ...LEAD_STATUSES]).default("All"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const TABS: LeadTab[] = [...tabs];
const PAGE_SIZE = 50;

function listFields(lead: Awaited<ReturnType<ReturnType<typeof crm>["listLeads"]>>[number]) {
  return {
    id: lead.id, name: lead.name, company: lead.company, phone: lead.phone, area: lead.area,
    source: lead.source, status: lead.status, assignedTo: lead.assignedTo,
    assignedToId: lead.assignedToId, ownerId: lead.ownerId, remarks: lead.remarks,
    createdOn: lead.createdOn, address: lead.address, touchedBy: lead.touchedBy,
    followUp: lead.followUp, followUpTime: lead.followUpTime,
  };
}

export async function GET(request: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid lead query." }, { status: 400 });

  try {
    const allLeads = await crm().listLeads();
    const visibleLeads = visibleFor(user, allLeads);
    const filters = { owner: parsed.data.owner, stage: parsed.data.stage, from: parsed.data.from, to: parsed.data.to };
    const source = parsed.data.source;
    const allForTab = (tab: LeadTab) => leadsForTab(user, allLeads, tab, parsed.data.search, source, filters);
    const filtered = allForTab(parsed.data.tab);
    const tabCounts = Object.fromEntries(TABS.map((tab) => [tab, allForTab(tab).length])) as Record<LeadTab, number>;
    const offset = (parsed.data.page - 1) * PAGE_SIZE;
    return NextResponse.json({
      leads: filtered.slice(offset, offset + PAGE_SIZE).map(listFields),
      total: filtered.length,
      tabCounts,
      todaysFollowUps: allForTab("callback").filter((lead) => lead.followUp === todayIST()).length,
      hasAnyLeads: visibleLeads.length > 0,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const reference = newErrorReference();
    console.error("[api] lead page load failed", {
      reference,
      message: error instanceof Error ? error.message : String(error),
      status: error instanceof ZohoError ? error.status : undefined,
      code: error instanceof ZohoError ? error.code : undefined,
      field: error instanceof ZohoError ? error.field : undefined,
      details: error instanceof ZohoError ? error.details : undefined,
      operation: error instanceof ZohoError ? error.operation : undefined,
    });
    const message = error instanceof ZohoError
      ? friendlyZohoError(error.status, error.code, error.message, error.field, reference)
      : `Unable to load leads right now. (Ref: ${reference})`;
    return NextResponse.json({ error: message, reference }, { status: 500 });
  }
}
