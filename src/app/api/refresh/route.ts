import { NextResponse } from "next/server";
import { canAccess } from "@/lib/domain";
import { currentUser } from "@/lib/auth/guard";
import { invalidate } from "@/lib/cache";

export const dynamic = "force-dynamic";
export const preferredRegion = "bom1";

const REFRESH_PREFIXES: Record<"leads" | "invoices", string[]> = {
  leads: ["leads", "users", "visits"],
  invoices: ["invoices", "quotes", "leads"],
};

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "A valid JSON body is required." }, { status: 400 });
  }
  const section = payload && typeof payload === "object" && "section" in payload
    ? payload.section
    : undefined;
  if (section !== "leads" && section !== "invoices") {
    return NextResponse.json({ error: "Unknown refresh section." }, { status: 400 });
  }
  if (!canAccess(user.role, section)) {
    return NextResponse.json({ error: "You are not allowed to refresh this section." }, { status: 403 });
  }

  try {
    await invalidate(...REFRESH_PREFIXES[section]);
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error("[api] manual CRM cache refresh failed", {
      section,
      errorName: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Could not refresh CRM data. Please try again." }, { status: 500 });
  }
}
