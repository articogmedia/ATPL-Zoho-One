import { describe, expect, it } from "vitest";
import { financialYear, isAssignable, nextOfferNo, todayIST } from "@/lib/domain";
import { mapLead, mapRole, mapTask, mapTaskStatus, mapUser, normalizeSource, normalizeStatus, parseRoleOverrides } from "@/lib/zoho/mappers";
import { canAccess } from "@/lib/domain";
import { STATIC_USERS, verifyStaticCredentials } from "@/lib/auth/users";

describe("offer numbering", () => {
  it("derives the Indian financial year", () => {
    expect(financialYear("2026-10-29")).toBe("26-27");
    expect(financialYear("2027-03-31")).toBe("26-27");
    expect(financialYear("2027-04-01")).toBe("27-28");
  });
  it("continues from the highest number in the same financial year", () => {
    expect(nextOfferNo(["225/26-27", "227/26-27", "226/26-27"], "2026-10-29")).toBe("228/26-27");
  });
  it("restarts in a new financial year and ignores malformed numbers", () => {
    expect(nextOfferNo(["300/25-26", "abc"], "2026-10-29")).toBe("1/26-27");
  });
  it("uses India's date, not the server's", () => {
    // 20:00 UTC on 28 Oct is already 29 Oct, 01:30 in India.
    expect(todayIST(new Date("2026-10-28T20:00:00Z"))).toBe("2026-10-29");
  });
});

describe("zoho mapping", () => {
  const execs = new Set(["Anil Kumar"]);
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
        "1394515000000464001",
        "1394515000001147001",
        "1394515000001126001",
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
    expect(normalizeStatus("Junk Lead")).toBe("Lost");
    expect(normalizeStatus("Won")).toBe("Won");
    expect(normalizeStatus("something custom")).toBe("Fresh Lead");
  });
  it("treats assignable owners as assigned and the queue owner as the fresh queue", () => {
    const base = { id: "1", Last_Name: "Rao", Created_Time: "2026-10-25T10:15:00+05:30", Lead_Status: "Not Contacted" };
    const assignable = new Set(["Anil Kumar", "Manager"]);
    expect(mapLead({ ...base, Owner: { id: "u1", name: "Anil Kumar" } }, assignable).assignedTo).toBe("Anil Kumar");
    expect(mapLead({ ...base, Owner: { id: "manager-1", name: "Manager" } }, assignable).assignedTo).toBe("Manager");
    expect(mapLead({ ...base, Owner: { id: "u2", name: "Divya" } }, execs).assignedTo).toBeNull();
    expect(mapLead({ ...base, Owner: { id: "queue-1", name: "Queue Owner" } }, assignable).assignedTo).toBeNull();
    expect(mapLead({ ...base, Owner: { id: "u2", name: "Divya" } }, execs).createdOn).toBe("2026-10-25");
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
});
