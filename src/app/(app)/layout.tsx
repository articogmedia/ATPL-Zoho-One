import { AppShell } from "@/components/AppShell";
import { requireUser } from "@/lib/auth/guard";
import { env } from "@/lib/env";

export const preferredRegion = "bom1";
export const maxDuration = 30;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return <AppShell user={{ name: user.name, role: user.role }} inactivityMinutes={env().SESSION_INACTIVITY_MINUTES}>{children}</AppShell>;
}
