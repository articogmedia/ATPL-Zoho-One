import { describe, expect, it } from "vitest";
import { financialYear, nextOfferNo, todayIST } from "@/lib/domain";
import { mapLead, mapRole, mapTask, mapTaskStatus, normalizeSource, normalizeStatus } from "@/lib/zoho/mappers";

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
  it("maps Zoho's stock statuses to portal statuses", () => {
    expect(normalizeStatus("Not Contacted")).toBe("Fresh Lead");
    expect(normalizeStatus("Contact in Future")).toBe("Callback in Future");
    expect(normalizeStatus("Junk Lead")).toBe("Lost");
    expect(normalizeStatus("Won")).toBe("Won");
    expect(normalizeStatus("something custom")).toBe("Fresh Lead");
  });
  it("treats an executive owner as 'assigned' and any other owner as the fresh queue", () => {
    const base = { id: "1", Last_Name: "Rao", Created_Time: "2026-10-25T10:15:00+05:30", Lead_Status: "Not Contacted" };
    expect(mapLead({ ...base, Owner: { id: "u1", name: "Anil Kumar" } }, execs).assignedTo).toBe("Anil Kumar");
    expect(mapLead({ ...base, Owner: { id: "u2", name: "Divya" } }, execs).assignedTo).toBeNull();
    expect(mapLead({ ...base, Owner: { id: "u2", name: "Divya" } }, execs).createdOn).toBe("2026-10-25");
  });
  it("maps CRM roles, rejecting unknown ones", () => {
    expect(mapRole({ id: "1", full_name: "A", role: { name: "Sales Executive" } })).toBe("Sales Executive");
    expect(mapRole({ id: "1", full_name: "A", profile: { name: "Administrator" } })).toBe("Manager");
    expect(mapRole({ id: "1", full_name: "A", role: { name: "Intern" } })).toBeNull();
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
