import { visibleFor, type Lead, type Quotation, type User, type Visit } from "@/lib/domain";

export type TodaySummary =
  | { kind: "executive"; followUpsDue: number; visitsToday: number; newAssignedLeads: number }
  | { kind: "calling"; freshUncalledLeads: number };

export function todaySummary(
  user: User,
  leads: Lead[],
  visits: Visit[],
  today: string,
): TodaySummary | null {
  const visibleLeads = visibleFor(user, leads);
  if (user.role === "Calling Team") {
    return {
      kind: "calling",
      freshUncalledLeads: visibleLeads.filter((lead) => lead.status === "Fresh Lead").length,
    };
  }
  if (user.role !== "Sales Executive") return null;

  const activeLeads = visibleLeads.filter((lead) =>
    !["Won", "Lost Lead", "Junk Lead", "Not Qualified"].includes(lead.status),
  );
  const visibleVisits = visibleFor(user, visits);
  return {
    kind: "executive",
    followUpsDue: activeLeads.filter((lead) => Boolean(lead.followUp && lead.followUp <= today)).length,
    visitsToday: visibleVisits.filter((visit) =>
      visit.isVisit && visit.date === today && !visit.done && visit.status !== "Completed",
    ).length,
    newAssignedLeads: activeLeads.filter((lead) =>
      lead.createdOn === today && Boolean(lead.assignedToId || lead.assignedTo || lead.ownerId),
    ).length,
  };
}

export function managerMonthSummary(leads: Lead[], quotes: Quotation[], today: string) {
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthLeads = leads.filter((lead) => lead.createdOn >= monthStart && lead.createdOn <= today);
  const won = monthLeads.filter((lead) => lead.status === "Won").length;
  return {
    leads: monthLeads.length,
    conversion: monthLeads.length ? Math.round((won / monthLeads.length) * 100) : 0,
    quotesSent: quotes.filter((quote) =>
      quote.date >= monthStart && quote.date <= today && quote.status?.trim().toLowerCase() === "sent",
    ).length,
  };
}
