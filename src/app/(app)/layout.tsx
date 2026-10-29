import { AppShell } from "@/components/AppShell";
import { requireUser } from "@/lib/auth/guard";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return <AppShell user={{ name: user.name, role: user.role }}>{children}</AppShell>;
}
