import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { mapSiteVisitUpdate, type SiteVisitsSchema } from "@/lib/zoho/site-visits";

const schema: SiteVisitsSchema = {
  module: "Site_Visits",
  date: "Visit_Date",
  time: "Visit_Time",
  status: "Visit_Status",
  notes: "Notes",
  followUp: "Follow_Up_Date",
  statusValues: {
    Assigned: "Scheduled",
    "In Progress": "Started",
    Completed: "Done",
  },
};

describe("Site Visits module mapping", () => {
  it("maps portal status and schedule fields to custom module API names", () => {
    expect(mapSiteVisitUpdate(schema, {
      status: "Completed",
      date: "2026-11-04",
      time: "14:30",
      notes: "Completed at client",
      followUp: "2026-11-06",
    })).toEqual({
      Visit_Status: "Done",
      Visit_Date: "2026-11-04",
      Visit_Time: "14:30",
      Notes: "Completed at client",
      Follow_Up_Date: "2026-11-06",
    });
  });

  it("omits fields that are not mapped in the discovered schema", () => {
    expect(mapSiteVisitUpdate({ module: "Site_Visits", statusValues: { Assigned: "", "In Progress": "", Completed: "" } }, {
      status: "In Progress",
      notes: "ignored",
    })).toEqual({});
  });
});
