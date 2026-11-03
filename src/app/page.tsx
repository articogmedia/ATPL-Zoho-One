import { redirect } from "next/navigation";
import Image from "next/image";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { env } from "@/lib/env";
import { demoLoginAllowed } from "@/lib/auth/demo";
import { currentUser } from "@/lib/auth/guard";
import { demoLogin } from "@/app/actions/auth";
import { STATIC_USERS, portalRole } from "@/lib/auth/users";
import { Button } from "@/components/ui/button";
import { LoginForm } from "@/components/LoginForm";
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

export default async function Login({ searchParams }: { searchParams?: Promise<{ error?: string }> }) {
  if (await currentUser()) redirect("/home");
  const error = (await searchParams)?.error;
  const demo = demoLoginAllowed();
  const users = demo ? STATIC_USERS.map((user) => ({ id: user.zohoUserId, name: user.name, role: portalRole(user.role) })) : [];

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F3F6FA] px-4 py-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-[420px]">
        <main className="relative overflow-hidden rounded-2xl border border-[#E5EAF1] bg-white p-7 shadow-lg sm:p-10">
          <div className="absolute inset-x-0 top-0 flex h-1" aria-hidden="true">
            <span className="flex-1 bg-[#F5A623]" />
            <span className="flex-1 bg-[#1E7FD0]" />
            <span className="flex-1 bg-[#4CAF50]" />
          </div>
          <div className="mb-6 flex justify-center">
            <Image src="/brand/atpl-logo.webp" width={240} height={100} sizes="(max-width: 640px) 200px, 240px" priority alt="ATPL - Air Trendz Private Limited" className="h-auto w-[200px] object-contain sm:w-[240px]" />
          </div>
          <div className="mb-6">
            <div className="relative text-center">
              <h1 className="text-2xl font-semibold tracking-tight text-[#172554]">Sign in</h1>
              <p className="mt-1 text-sm text-slate-600">Access the ATPL Sales Portal</p>
              {demo && (
                <span className="absolute right-0 top-0 inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700 ring-1 ring-inset ring-slate-200">
                  <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                  Demo mode
                </span>
              )}
            </div>
          </div>

          {error && <p role="alert" className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{ERRORS[error] ?? ERRORS.server}</p>}

          {env().AUTH_MODE === "zoho" && (
            <Button asChild size="lg" className="mb-4 h-12 w-full justify-between rounded-lg bg-primary px-4 text-sm text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary">
              <a href="/api/auth/zoho/start" aria-label="Sign in with Zoho">
                <span>Sign in with Zoho</span>
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </Button>
          )}

          <LoginForm />

          {demo && (
            <>
              <div className="mt-6 space-y-4 border-t border-slate-100 pt-5">
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
                            className="group flex h-14 w-full items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-3 text-left hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 sm:px-3.5"
                          >
                            <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-bold ${ROLE_STYLES[u.role].avatar}`} aria-hidden="true">
                              {initials(u.name)}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">{u.name}</span>
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-tight ring-1 ring-inset ${ROLE_STYLES[u.role].badge}`}>
                                {u.role}
                            </span>
                            <ArrowRight className="h-4 w-4 shrink-0 text-slate-500 opacity-0 group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
                          </button>
                        </form>
                      ))}
                    </div>
                  </section>
                );
              })}
                </div>
                <p className="mt-4 text-center text-xs text-slate-500">Sample data only · No real accounts are affected</p>
            </>
          )}
        </main>
        <p className="mt-3 text-center text-xs text-slate-500">© 2026 Air Trendz Pvt Ltd · Hyderabad</p>
      </div>
    </div>
  );
}
