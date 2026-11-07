import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/guard";
import { crm } from "@/lib/crm";
import { ZohoError } from "@/lib/zoho/client";
import { friendlyZohoError, newErrorReference } from "@/lib/crm-action-errors";
import { visibleFor } from "@/lib/domain";

export const dynamic = "force-dynamic";
export const preferredRegion = "bom1";

const customerFields = (lead: Awaited<ReturnType<ReturnType<typeof crm>["listLeads"]>>[number]) => ({
  id: lead.id,
  name: lead.name,
  company: lead.company,
  phone: lead.phone,
  area: lead.area,
  source: lead.source,
  status: lead.status,
  assignedTo: lead.assignedTo,
  assignedToId: lead.assignedToId,
  ownerId: lead.ownerId,
});

export async function GET(request: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  const page = Number(request.nextUrl.searchParams.get("page") ?? "1");
  if (query.length === 0) {
    if (!Number.isInteger(page) || page < 1 || page > 100) return NextResponse.json({ error: "Invalid customer page." }, { status: 400 });
    try {
      const pageSize = 100;
      const repository = crm();
      const result = repository.listLeadsPage
        ? await repository.listLeadsPage(page, pageSize, user.role === "Sales Executive" ? user.id : undefined)
        : await repository.listLeads().then((rows) => {
          const visible = visibleFor(user, rows);
          const offset = (page - 1) * pageSize;
          return {
            leads: visible.slice(offset, offset + pageSize),
            total: visible.length,
            hasMore: visible.length > offset + pageSize,
          };
        });
      return NextResponse.json({
        leads: visibleFor(user, result.leads).map(customerFields),
        hasMore: result.hasMore,
      }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      const reference = newErrorReference();
      console.error("[api] lead customer page failed", {
        reference,
        message: error instanceof Error ? error.message : String(error),
        status: error instanceof ZohoError ? error.status : undefined,
        code: error instanceof ZohoError ? error.code : undefined,
        operation: error instanceof ZohoError ? error.operation : undefined,
      });
      const message = error instanceof ZohoError
        ? friendlyZohoError(error.status, error.code, error.message, error.field, reference)
        : `Unable to load more customers right now. (Ref: ${reference})`;
      return NextResponse.json({ error: message, reference }, { status: 500 });
    }
  }
  if (query.length < 2) return NextResponse.json({ leads: [], hasMore: false });
  if (query.length > 100) return NextResponse.json({ error: "Search text is too long." }, { status: 400 });
  if (!Number.isInteger(page) || page < 1 || page > 100) return NextResponse.json({ error: "Invalid search page." }, { status: 400 });

  try {
    const result = await crm().searchLeads(query, page);
    const leads = visibleFor(user, result.leads);
    return NextResponse.json({
      leads: leads.map(customerFields),
      hasMore: result.hasMore,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const reference = newErrorReference();
    console.error("[api] lead customer search failed", {
      reference,
      message: error instanceof Error ? error.message : String(error),
      status: error instanceof ZohoError ? error.status : undefined,
      code: error instanceof ZohoError ? error.code : undefined,
      details: error instanceof ZohoError ? error.details : undefined,
      operation: error instanceof ZohoError ? error.operation : undefined,
    });
    const message = error instanceof ZohoError
      ? friendlyZohoError(error.status, error.code, error.message, error.field, reference)
      : `Unable to search customers right now. (Ref: ${reference})`;
    return NextResponse.json({ error: message, reference }, { status: 500 });
  }
}
