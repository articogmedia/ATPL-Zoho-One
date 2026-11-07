import { describe, expect, it } from "vitest";
import { canAdvanceLeadStatus, canUpdateWorkItem, financialYear, isAssignable, leadsForTab, nextOfferNo, normalizePhone, quotationCustomers, quoteTotals, reassignLeadOptimistically, todayIST, uniqueProducts, validateQuoteLine } from "@/lib/domain";
import { CALL_STATUS_BY_OUTCOME, zohoLeadSource } from "@/lib/zoho/fields";
import { mapLead, mapQuote, mapRole, mapTask, mapTaskStatus, mapUser, normalizeSource, normalizeStatus, parseRoleOverrides } from "@/lib/zoho/mappers";
import { canAccess } from "@/lib/domain";
import { matchPortalUserToZohoUser, missingPortalUsers, resolvePortalUserZohoId, STATIC_USERS, verifyStaticCredentials } from "@/lib/auth/users";
import { productionDemoLoginAllowed } from "@/lib/auth/demo-policy";

describe("demo login safety", () => {
  it("hides demo buttons in production unless explicitly allowed", () => {
    expect(productionDemoLoginAllowed("production", "demo", true, false)).toBe(false);
    expect(productionDemoLoginAllowed("production", "demo", true, true)).toBe(true);
  });
});

describe("optimistic lead reassignment", () => {
  it("removes a reassigned lead from My Leads and updates tab counts", () => {
    const reshma = { id: "reshma", name: "Reshma", role: "Manager" as const };
    const lead = {
      id: "L1", name: "Customer", company: "", phone: "9876543210", area: "", source: "Direct Call" as const,
      status: "Fresh Lead" as const, assignedTo: null, ownerId: "reshma",
      remarks: "", createdOn: "2026-11-06", address: "", touchedBy: [],
    };
    const result = reassignLeadOptimistically(reshma, lead, { id: "saikiran", name: "Sai Kiran" }, {
      fresh: 1, assigned: 0, callback: 0, mine: 1, all: 1,
    });

    expect(result.lead).toMatchObject({
      assignedTo: "Sai Kiran", assignedToId: "saikiran", ownerId: "saikiran", status: "Assigned to Sales",
    });
    expect(leadsForTab(reshma, [result.lead], "mine")).toHaveLength(0);
    expect(leadsForTab(reshma, [result.lead], "all")).toHaveLength(1);
    expect(result.tabCounts).toEqual({ fresh: 0, assigned: 1, callback: 0, mine: 0, all: 1 });
  });
});

describe("quotation customer selection", () => {
  it("keeps every visible customer, including Assigned to Sales leads", () => {
    const leads = Array.from({ length: 24 }, (_, index) => ({
      id: `L${index}`, name: `Customer ${index}`, company: "", phone: `987654${String(index).padStart(4, "0")}`,
      area: "", source: "Direct Call" as const, status: index % 2 ? "Assigned to Sales" as const : "Fresh Lead" as const,
      assignedTo: null, ownerId: "manager-1", remarks: "", createdOn: "", address: "", touchedBy: [],
    }));
    expect(quotationCustomers(leads, "")).toHaveLength(24);
    expect(quotationCustomers(leads, "").filter((lead) => lead.status === "Assigned to Sales")).toHaveLength(12);
  });
});

describe("work update authorization", () => {
  const task = {
    id: "task-1", leadId: "lead-1", customer: "Customer", address: "", area: "", executive: "Sai Kiran",
    executiveId: "sai-id", type: "Call", isVisit: false, date: "2026-11-06", time: "10:00",
    status: "Assigned" as const, nextAction: "", followUp: "", notes: "", done: false,
  };

  it("allows managers to update another executive's task", () => {
    expect(canUpdateWorkItem({ id: "manager-id", name: "Manager", role: "Manager" }, task)).toBe(true);
  });

  it("prevents an executive from updating another executive's task", () => {
    expect(canUpdateWorkItem({ id: "other-id", name: "Other", role: "Sales Executive" }, task)).toBe(false);
    expect(canUpdateWorkItem({ id: "sai-id", name: "Sai Kiran", role: "Sales Executive" }, task)).toBe(true);
  });
});

describe("offer numbering", () => {
  it("de-duplicates products by normalized model and price, keeping the first", () => {
    const products = [
      { id: "1", model: "  Split AC ", price: 50000, unit: "Nos" },
      { id: "2", model: "split ac", price: 50000, unit: "Nos" },
      { id: "3", model: "Split AC", price: 55000, unit: "Nos" },
    ];
    expect(uniqueProducts(products).map((product) => product.id)).toEqual(["1", "3"]);
  });

  it("validates quantity and line discount", () => {
    expect(validateQuoteLine(0, 0, 100)).toBeTruthy();
    expect(validateQuoteLine(2, 201, 100)).toBe("Discount cannot exceed the line amount.");
    expect(validateQuoteLine(2, 200, 100)).toBeNull();
  });
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
    expect(normalizeSource("Walk-in")).toBe("Walk-in");
    expect(normalizeSource("Customer Referral")).toBe("Referral");
    expect(normalizeSource("Website")).toBe("Website");
    expect(normalizeSource("Other")).toBe("Other");
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
    expect(normalizeStatus("Not Contacted")).toBe("Not Contacted");
    expect(normalizeStatus("Contact in Future")).toBe("Callback in Future");
    expect(normalizeStatus("Junk Lead")).toBe("Junk Lead");
    expect(normalizeStatus("Won")).toBe("Won");
    expect(normalizeStatus("something custom")).toBe("Not Contacted");
  });
  it("normalizes duplicate phone numbers and maps every call outcome", () => {
    expect(normalizePhone("+91 98765 43210")).toBe("9876543210");
    expect(normalizePhone("91-98765-43210")).toBe("9876543210");
    expect(normalizePhone("098765 43210")).toBe("9876543210");
    expect(CALL_STATUS_BY_OUTCOME).toMatchObject({
      Connected: "Contacted", "No Answer": "Attempted to Contact", Busy: "Attempted to Contact",
      "Call Back Later": "Callback in Future", "Wrong Number": "Not Responsive",
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
  it("prefers Zoho full_name and cleans composed names", () => {
    expect(mapUser({
      id: "1", full_name: "Pavan Kumar", first_name: "Pavan", last_name: "Pavan Kumar",
      role: { name: "Sales Executive" },
    })?.name).toBe("Pavan Kumar");
    expect(mapUser({
      id: "2", full_name: "", first_name: "Sai", last_name: "Kiran",
      role: { name: "Sales Executive" },
    })?.name).toBe("Sai Kiran");
    expect(mapUser({
      id: "3", full_name: "  Pavan   Kumar  ", role: { name: "Sales Executive" },
    })?.name).toBe("Pavan Kumar");
  });
  it("maps portal sources to values configured in Zoho", () => {
    const values = ["Advertisement", "Web Research", "Cold Call", "Walk In", "Referral", "Website", "Other"];
    expect(zohoLeadSource("Meta Ads", values)).toBe("Advertisement");
    expect(zohoLeadSource("Google Ads", values)).toBe("Web Research");
    expect(zohoLeadSource("Direct Call", values)).toBe("Cold Call");
    expect(zohoLeadSource("Walk-in", values)).toBe("Walk In");
    expect(zohoLeadSource("Referral", values)).toBe("Referral");
    expect(zohoLeadSource("Website", values)).toBe("Website");
    expect(zohoLeadSource("Other", values)).toBe("Other");
    expect(zohoLeadSource("Meta Ads", ["Website"])).toBeNull();
    expect(zohoLeadSource("Meta Ads", ["Website", "Other"])).toBe("Other");
    expect(zohoLeadSource("Google Ads", ["Web Research", "Referral"])).toBe("Web Research");
  });
  it("maps tasks to visits using the linked lead's address", () => {
    const lead = mapLead({ id: "L1", Last_Name: "Ramesh", Company: "Clinic", Street: "Plot 45", City: "Kukatpally", Owner: { id: "u1", name: "Anil Kumar" } }, execs);
    const v = mapTask(
      { id: "T1", Status: "Not Started", Due_Date: "2026-10-29", Owner: { id: "u1", name: "Anil Kumar" }, Who_Id: { id: "L1" },
        Is_Site_Visit: true, Visit_Time: "11:00", Task_Type: "Site survey" },
      new Map([["L1", lead]]),
    );
    expect(v).toMatchObject({ status: "Assigned", isVisit: true, customer: "Clinic", address: "Plot 45", area: "Kukatpally", time: "11:00", done: false });
    expect(mapTaskStatus("Not Started")).toBe("Assigned");
    expect(mapTaskStatus("In Progress")).toBe("In Progress");
    expect(mapTaskStatus("Completed")).toBe("Completed");
    expect(mapTaskStatus("completed")).toBe("Completed");
  });
  it("normalizes the Zoho Owner reference used by the lead list", () => {
    const lead = mapLead({
      id: "L2", Last_Name: "Customer", Lead_Status: "Assigned to Sales",
      Owner: { id: "u1", name: "Pavan Pavan Kumar" },
    }, execs);
    expect(lead.assignedTo).toBe("Pavan Kumar");
  });
  it("uses the quotation subject when offer number and linked customer are unavailable", () => {
    const quote = mapQuote({
      id: "Q1",
      Subject: "Offer 239/26-27 - Example Customer",
    }, new Map());
    expect(quote).toMatchObject({ offerNo: "239/26-27", customer: "Example Customer" });
  });
  it("maps a text Lead_Ref value back to its selected lead", () => {
    const lead = mapLead({ id: "L10", Last_Name: "Ramesh", Company: "Clinic Two" }, execs);
    const quote = mapQuote({
      id: "Q10",
      Subject: "Offer 240/26-27 - Clinic Two",
      Lead_Ref: "L10",
    }, new Map([["L10", lead]]));
    expect(quote).toMatchObject({ leadId: "L10", customer: "Clinic Two" });
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
