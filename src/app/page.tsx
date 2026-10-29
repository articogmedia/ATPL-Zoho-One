import { redirect } from "next/navigation";
import { ArrowRight, CheckCircle2, Snowflake } from "lucide-react";
import { crm } from "@/lib/crm";
import { env } from "@/lib/env";
import { demoLoginAllowed } from "@/lib/auth/demo";
import { currentUser } from "@/lib/auth/guard";
import { demoLogin } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import type { Role } from "@/lib/domain";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  no_access: "Your Zoho account is not set up for this portal. Ask your manager to check your CRM role.",
  state: "Sign-in expired. Please try again.",
  token: "Zoho did not complete the sign-in. Please try again.",
  profile: "Could not read your Zoho profile. Please try again.",
  server: "Sign-in failed. Please try again or contact your administrator.",
};

const ROLE_GROUPS: { heading: string; role: Role }[] = [
  { heading: "Management", role: "Manager" },
  { heading: "Sales", role: "Sales Executive" },
  { heading: "Calling Team", role: "Calling Team" },
];

const ROLE_STYLES: Record<Role, { avatar: string; badge: string }> = {
  Manager: {
    avatar: "bg-violet-100 text-violet-700",
    badge: "bg-violet-50 text-violet-700 ring-violet-200",
  },
  "Sales Executive": {
    avatar: "bg-blue-100 text-blue-700",
    badge: "bg-blue-50 text-blue-700 ring-blue-200",
  },
  "Calling Team": {
    avatar: "bg-emerald-100 text-emerald-700",
    badge: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
};

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentUser()) redirect("/home");
  const { error } = await searchParams;
  const demo = demoLoginAllowed();
  const users = demo ? await crm().listUsers() : [];

  return (
    <div className="grid min-h-screen place-items-center bg-hero px-4 py-8 sm:py-10">
      <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-elegant sm:p-8">
        <div className="mb-7 flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground"><Snowflake className="h-7 w-7" /></div>
          <div>
            <h1 className="text-xl font-bold">ATPL Sales Portal</h1>
            <p className="text-sm text-muted-foreground">Air Trendz Pvt Ltd · Hyderabad</p>
          </div>
          </div>
          {demo && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700 ring-1 ring-inset ring-blue-200">
              <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
              Demo mode
            </span>
          )}
        </div>

        {error && <p role="alert" className="mb-5 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{ERRORS[error] ?? ERRORS.server}</p>}

        {env().AUTH_MODE === "zoho" && (
          <Button asChild size="lg" className="h-14 w-full justify-between rounded-xl px-5 text-base">
            <a href="/api/auth/zoho/start" aria-label="Sign in with Zoho">
              <span>Sign in with Zoho</span>
              <ArrowRight className="h-5 w-5" aria-hidden="true" />
            </a>
          </Button>
        )}

        {demo && (
          <>
            <p className="mb-5 text-sm text-muted-foreground">Select your profile to continue</p>
            <div className="space-y-5">
              {ROLE_GROUPS.map(({ heading, role }) => {
                const groupUsers = users.filter((user) => user.role === role);
                if (groupUsers.length === 0) return null;

                return (
                  <section key={role} aria-labelledby={`role-${role}`}>
                    <h2 id={`role-${role}`} className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                      {heading}
                    </h2>
                    <div className="flex flex-col gap-2">
                      {groupUsers.map((u) => (
                        <form key={u.id} action={demoLogin.bind(null, u.id)}>
                          <button
                            type="submit"
                            aria-label={`Continue as ${u.name}, ${u.role}`}
                            className="group flex min-h-14 w-full items-center gap-3 rounded-xl border border-border bg-card px-3.5 text-left transition-all hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:px-4"
                          >
                            <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-bold ${ROLE_STYLES[u.role].avatar}`} aria-hidden="true">
                              {initials(u.name)}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium text-foreground">{u.name}</span>
                              <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold leading-tight ring-1 ring-inset ${ROLE_STYLES[u.role].badge}`}>
                                {u.role}
                              </span>
                            </span>
                            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
                          </button>
                        </form>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
            <p className="mt-6 text-center text-xs text-muted-foreground">Sample data only · No real accounts are affected</p>
          </>
        )}
      </div>
    </div>
  );
}
