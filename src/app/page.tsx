import { redirect } from "next/navigation";
import { ArrowRight, CheckCircle2, ClipboardList, FileText, MapPin, Snowflake } from "lucide-react";
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
    <div className="grid min-h-screen place-items-center bg-slate-50 px-3 py-4 sm:px-6 sm:py-6">
      <div className="flex max-h-[calc(100vh-2rem)] min-h-0 w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_20px_60px_-30px_rgba(15,23,42,0.35)] md:grid md:grid-cols-[0.9fr_1.1fr]">
        <aside className="shrink-0 bg-slate-900 px-5 py-5 text-white sm:px-8 sm:py-7 md:flex md:flex-col md:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white/10 text-white ring-1 ring-white/15">
                <Snowflake className="h-6 w-6" aria-hidden="true" />
              </div>
              <div>
                <h1 className="text-lg font-bold tracking-tight">ATPL Sales Portal</h1>
                <p className="text-xs text-slate-300">Air Trendz Pvt Ltd · Hyderabad</p>
              </div>
            </div>
            <p className="mt-6 max-w-xs text-sm leading-6 text-slate-300 md:mt-10">
              Leads, quotations and site visits in one place
            </p>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-3 md:mt-10 md:grid-cols-1 md:gap-4">
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <ClipboardList className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
              <span>Manage Leads</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <FileText className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
              <span>Create Quotation</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <MapPin className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
              <span>My Work &amp; Site Visits</span>
            </div>
          </div>
        </aside>

        <main className="flex min-h-0 flex-1 flex-col px-5 py-5 sm:px-8 sm:py-7">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold tracking-tight text-slate-900">Sign in</h2>
              <p className="mt-1 text-sm text-slate-600">Select your profile to continue</p>
            </div>
            {demo && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700 ring-1 ring-inset ring-slate-200">
                <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                Demo mode
              </span>
            )}
          </div>

          {error && <p role="alert" className="mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{ERRORS[error] ?? ERRORS.server}</p>}

          {env().AUTH_MODE === "zoho" && (
            <Button asChild size="lg" className="h-12 w-full justify-between rounded-lg bg-slate-900 px-4 text-sm text-white hover:bg-slate-800">
              <a href="/api/auth/zoho/start" aria-label="Sign in with Zoho">
                <span>Sign in with Zoho</span>
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </Button>
          )}

          {demo && (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                <div className="space-y-4">
              {ROLE_GROUPS.map(({ heading, role }) => {
                const groupUsers = users.filter((user) => user.role === role);
                if (groupUsers.length === 0) return null;

                return (
                  <section key={role} aria-labelledby={`role-${role}`}>
                    <h3 id={`role-${role}`} className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                      {heading}
                    </h3>
                    <div className="flex flex-col gap-1.5">
                      {groupUsers.map((u) => (
                        <form key={u.id} action={demoLogin.bind(null, u.id)}>
                          <button
                            type="submit"
                            aria-label={`Continue as ${u.name}, ${u.role}`}
                            className="group flex h-14 w-full items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-3 text-left motion-safe:transition-colors motion-reduce:transition-none hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 sm:px-3.5"
                          >
                            <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-bold ${ROLE_STYLES[u.role].avatar}`} aria-hidden="true">
                              {initials(u.name)}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">{u.name}</span>
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-tight ring-1 ring-inset ${ROLE_STYLES[u.role].badge}`}>
                                {u.role}
                            </span>
                            <ArrowRight className="h-4 w-4 shrink-0 text-slate-500 opacity-0 motion-safe:transition-all motion-reduce:transition-none group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
                          </button>
                        </form>
                      ))}
                    </div>
                  </section>
                );
              })}
                </div>
              </div>
              <p className="mt-4 shrink-0 text-center text-xs text-slate-500">Sample data only · No real accounts are affected</p>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
