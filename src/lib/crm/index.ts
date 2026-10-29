import "server-only";
import { env } from "@/lib/env";
import type { CrmRepository } from "./repository";
import { mockRepository } from "./mock";
import { zohoRepository } from "@/lib/zoho/repository";

/** Single switch point between demo data and live Zoho CRM. */
export const crm = (): CrmRepository => (env().DATA_SOURCE === "zoho" ? zohoRepository : mockRepository);
