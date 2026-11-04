import { describe, expect, it } from "vitest";
import { canAdvanceLeadStatus, financialYear, isAssignable, nextOfferNo, normalizePhone, quoteTotals, todayIST } from "@/lib/domain";
import { CALL_STATUS_BY_OUTCOME } from "@/lib/zoho/fields";
import { mapLead, mapRole, mapTask, mapTaskStatus, mapUser, normalizeSource, normalizeStatus, parseRoleOverrides } from "@/lib/zoho/mappers";
import { canAccess } from "@/lib/domain";
import { matchPortalUserToZohoUser, missingPortalUsers, resolvePortalUserZohoId, STATIC_USERS, verifyStaticCredentials } from "@/lib/auth/users";

describe("offer numbering", () => {
  it("applies discounts before GST and totals correctly", () => {
    expect(quoteTotals([
      { model: "AC", unit: "Nos", qty: 2, price: 50000, discount: 5000 },
      { model: "Stand", unit: "Nos", qty: 1, price: 10000, discount: 0 },
    ])).toEqual({ subtotal: 110000, discount: 5000, gst: 0, total: 105000 });
  });
  it("derives the Indian financial year", () => {
    expect(financialYear("2026-10-29")).toBe("26-27");
    expect(financialYear("2027-03-31")).toBe("26-27");
    expect(financialYear("2027-04-01")).toBe("27-28");
  });

  describe("mock lead pipeline advancement", () => {
    it("advances visits and quotations forward only", () => {
      expect(canAdvanceLeadStatus("Assigned to Sales", "Site Visit Scheduled")).toBe(true);
      expect(canAdvanceLeadStatus("Site Visit Scheduled", "Quotation Sent")).toBe(true);
      expect(canAdvanceLeadStatus("Quotation Sent", "Site Visit Scheduled")).toBe(false);
    });

    it("never changes terminal leads", () => {
      for (const status of ["Won", "Lost Lead", "Junk Lead", "Not Qualified"] as const) {
        expect(canAdvanceLeadStatus(status, "Quotation Sent")).toBe(false);
      }
    });
  });
  it("continues from the highest number in the same financial year", () => {
    expect(nextOfferNo(["225/26-27", "227/26-27", "226/26-27"], "2026-10-29")).toBe("228/26-27");
  });
  it("restarts in a new financial year and ignores malformed numbers", () => {
    expect(nextOfferNo(["300/25-26", "abc"], "2026-10-29")).toBe("239/26-27");
  });
  it("uses India's date, not the server's", () => {
    // 20:00 UTC on 28 Oct is already 29 Oct, 01:30 in India.
    expect(todayIST(new Date("2026-10-28T20:00:00Z"))).toBe("2026-10-29");
  });
});

describe("zoho mapping", () => {
  const execs = new Set(["u1", "manager-1"]);
  it("folds free-form lead sources into ATPL's three", () => {
    expect(normalizeSource("Facebook")).toBe("Meta Ads");
    expect(normalizeSource("Instagram Lead Ads")).toBe("Meta Ads");
    expect(normalizeSource("Google AdWords")).toBe("Google Ads");
    expect(normalizeSource("Cold Call")).toBe("Direct Call");
    expect(normalizeSource(undefined)).toBe("Direct Call");
  });

  describe("static login", () => {
    it("uses the configured Zoho IDs for the static users", () => {
      expect(STATIC_USERS.map((user) => user.zohoUserId)).toEqual([
        process.env.ATPL_RESHMA_ZOHO_USER_ID,
        process.env.ATPL_PAVAN_ZOHO_USER_ID,
        process.env.ATPL_SAIKIRAN_ZOHO_USER_ID,
      ]);
    });
    it("accepts a configured password and rejects invalid credentials", () => {
      process.env.ATPL_PAVAN_PASSWORD = "correct-password";
      expect(verifyStaticCredentials("pavan", "correct-password")?.username).toBe("pavan");
      expect(verifyStaticCredentials("pavan", "wrong-password")).toBeNull();
      expect(verifyStaticCredentials("unknown", "correct-password")).toBeNull();
    });
    it("keeps section access role-based", () => {
      expect(canAccess("Manager", "performance")).toBe(true);
      expect(canAccess("Sales Executive", "visits")).toBe(true);
      expect(canAccess("Calling Team", "quotations")).toBe(false);
    });
  });
  it("maps Zoho's stock statuses to portal statuses", () => {
    expect(normalizeStatus("Not Contacted")).toBe("Fresh Lead");
    expect(normalizeStatus("Contact in Future")).toBe("Callback in Future");
    expect(normalizeStatus("Junk Lead")).toBe("Junk Lead");
    expect(normalizeStatus("Won")).toBe("Won");
    expect(normalizeStatus("something custom")).toBe("Fresh Lead");
  });
  it("normalizes duplicate phone numbers and maps every call outcome", () => {
    expect(normalizePhone("+91 98765 43210")).toBe("9876543210");
    expect(CALL_STATUS_BY_OUTCOME).toMatchObject({
      Connected: "Contacted", "No Answer": "Attempted to Contact", Busy: "Attempted to Contact",
      "Call Back Later": "Callback in Future", "Wrong Number": "Junk Lead",
    });
  });
  it("treats assignable owners as assigned and the queue owner as the fresh queue", () => {
    const base = { id: "1", Last_Name: "Rao", Created_Time: "2026-10-25T10:15:00+05:30", Lead_Status: "Not Contacted" };
    const assignable = new Set(["u1", "manager-1"]);
    expect(mapLead({ ...base, Owner: { id: "u1", name: "Anil Kumar" } }, assignable).assignedTo).toBe("Anil Kumar");
    expect(mapLead({ ...base, Owner: { id: "manager-1", name: "Manager" } }, assignable).assignedTo).toBe("Manager");
    expect(mapLead({ ...base, Owner: { id: "u2", name: "Divya" } }, execs).assignedTo).toBeNull();
    expect(mapLead({ ...base, Owner: { id: "queue-1", name: "Queue Owner" } }, assignable).assignedTo).toBeNull();
    expect(mapLead({ ...base, Owner: { id: "u2", name: "Divya" } }, execs).createdOn).toBe("2026-10-25");
  });
  it("keeps manager-owned Fresh Leads in the fresh queue when sales executives are supplied", () => {
    const salesExecutives = new Set(["exec-1"]);
    const base = { id: "fresh-manager", Last_Name: "Rao", Lead_Status: "Fresh Lead", Created_Time: "2026-10-25T10:15:00+05:30" };
    const managerOwned = mapLead({ ...base, Owner: { id: "manager-1", name: "Manager" } }, new Set(["manager-1"]), salesExecutives);
    const executiveOwned = mapLead({ ...base, Owner: { id: "exec-1", name: "Executive" } }, new Set(["exec-1"]), salesExecutives);
    expect(managerOwned.assignedTo).toBeNull();
    expect(managerOwned.assignedToId).toBeUndefined();
    expect(executiveOwned.assignedTo).toBe("Executive");
  });
  it("matches portal users to Zoho users by normalized email", () => {
    const portal = { username: "pavan", name: "Pavan", role: "Sales" as const, email: " PAVAN@ATPL.COM ", zohoUserId: "fallback", passwordEnv: "P" };
    const match = matchPortalUserToZohoUser(portal, [{ id: " live-1 ", name: "Pavan", role: "Sales Executive", email: "pavan@atpl.com" }]);
    expect(match?.id.trim()).toBe("live-1");
    expect(matchPortalUserToZohoUser({ ...portal, name: "Different User", email: "missing@atpl.com" }, [{ id: "live-1", name: "Pavan", role: "Sales Executive", email: "pavan@atpl.com" }])).toBeNull();
  });
  it("resolves sandbox CRM ids by configured id, email, exact name, and first name", () => {
    const portal = { username: "pavan", name: "Pavan Kumar", role: "Sales" as const, email: "pavan@atpl.com", zohoUserId: "production-id", passwordEnv: "P" };
    expect(resolvePortalUserZohoId(portal, [{ id: "sandbox-email", name: "Pavan K", role: "Sales Executive", email: "pavan@atpl.com" }])).toBe("sandbox-email");
    expect(resolvePortalUserZohoId(portal, [{ id: "sandbox-name", name: "Pavan Kumar", role: "Sales Executive" }])).toBe("sandbox-name");
    expect(resolvePortalUserZohoId(portal, [{ id: "sandbox-prefix", name: "Pavan Singh", role: "Sales Executive" }])).toBe("sandbox-prefix");
  });
  it("reports portal users without a matching Zoho email", () => {
    const portal = [{ username: "pavan", name: "Pavan", role: "Sales" as const, email: "pavan@atpl.com", zohoUserId: "fallback", passwordEnv: "P" }];
    expect(missingPortalUsers(portal, [])).toHaveLength(1);
    expect(missingPortalUsers(portal, [{ id: "live-1", name: "Pavan", role: "Sales Executive", email: "PAVAN@ATPL.COM" }])).toHaveLength(0);
  });
  it("excludes the queue owner from assignable users", () => {
    expect(isAssignable({ id: "manager-1", name: "Manager", role: "Manager" }, "queue-1")).toBe(true);
    expect(isAssignable({ id: "queue-1", name: "Queue Owner", role: "Manager" }, "queue-1")).toBe(false);
  });
  it("maps CRM roles with tolerant keywords and rejects unknown ones", () => {
    expect(mapRole({ id: "1", full_name: "A", role: { name: "Sales Executive" } })).toBe("Sales Executive");
    expect(mapRole({ id: "1", full_name: "A", profile: { name: "Administrator" } })).toBe("Manager");
    expect(mapRole({ id: "1", full_name: "A", role: { name: "Business Development Specialist" } })).toBe("Sales Executive");
    expect(mapRole({ id: "1", full_name: "A", profile: { name: "Telecalling Agent" } })).toBe("Calling Team");
    expect(mapRole({ id: "1", full_name: "A", role: { name: "Intern" }, profile: { name: "NOT MAPPED" } })).toBeNull();
    expect(mapRole({ id: "1", full_name: "A", role: { name: "Intern" } })).toBeNull();
  });
  it("parses explicit role overrides and ignores malformed or unknown entries", () => {
    expect([...parseRoleOverrides("Anil@ATPL.com:sales executive, bad-entry, x@y.com:Superuser, boss@atpl.com:Manager")]).toEqual([
      ["anil@atpl.com", "Sales Executive"],
      ["boss@atpl.com", "Manager"],
    ]);
  });
  it("prefers an override over names and leaves unknown roles unmapped", () => {
    const overrides = parseRoleOverrides("a@example.com:Calling Team");
    expect(mapUser({ id: "1", full_name: "A", email: "A@EXAMPLE.COM", role: { name: "Manager" } }, overrides)?.role).toBe("Calling Team");
    expect(mapUser({ id: "2", full_name: "B", role: { name: "Unknown" } })).toBeNull();
  });
  it("maps tasks to visits using the linked lead's address", () => {
    const lead = mapLead({ id: "L1", Last_Name: "Ramesh", Company: "Clinic", Street: "Plot 45", City: "Kukatpally", Owner: { id: "u1", name: "Anil Kumar" } }, execs);
    const v = mapTask(
      { id: "T1", Status: "Not Started", Due_Date: "2026-10-29", Owner: { id: "u1", name: "Anil Kumar" }, Who_Id: { id: "L1" },
        Is_Site_Visit: true, Visit_Time: "11:00", Task_Type: "Site survey" },
      new Map([["L1", lead]]),
    );
    expect(v).toMatchObject({ status: "Assigned", isVisit: true, customer: "Clinic", address: "Plot 45", area: "Kukatpally", time: "11:00", done: false });
    expect(mapTaskStatus("Completed")).toBe("Completed");
  });
  it("maps lead-linked Tasks through What_Id", () => {
    const lead = mapLead({ id: "L9", Last_Name: "Ramesh", Company: "Clinic One", Owner: { id: "u1", name: "Anil Kumar" } }, execs);
    const visit = mapTask(
      { id: "T9", Subject: "Follow-up", Status: "Not Started", What_Id: { id: "L9" }, Owner: { id: "u1", name: "Anil Kumar" } },
      new Map([["L9", lead]]),
    );
    expect(visit.leadId).toBe("L9");
    expect(visit.customer).toBe("Clinic One");
  });
});
