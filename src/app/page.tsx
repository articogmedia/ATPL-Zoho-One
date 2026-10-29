import { redirect } from "next/navigation";
import { Snowflake, UserRound } from "lucide-react";
import { crm } from "@/lib/crm";
import { env } from "@/lib/env";
import { demoLoginAllowed } from "@/lib/auth/demo";
import { currentUser } from "@/lib/auth/guard";
import { demoLogin } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  no_access: "Your Zoho account is not set up for this portal. Ask your manager to check your CRM role.",
  state: "Sign-in expired. Please try again.",
  token: "Zoho did not complete the sign-in. Please try again.",
  profile: "Could not read your Zoho profile. Please try again.",
  server: "Sign-in failed. Please try again or contact your administrator.",
};

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentUser()) redirect("/home");
  const { error } = await searchParams;
  const demo = demoLoginAllowed();
  const users = demo ? await crm().listUsers() : [];

  return (
    <div className="grid min-h-screen place-items-center bg-hero px-4 py-10">
      <div className="w-full max-w-md rounded-2xl bg-card p-6 shadow-elegant sm:p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground"><Snowflake className="h-7 w-7" /></div>
          <div>
            <h1 className="text-xl font-bold">ATPL Sales Portal</h1>
            <p className="text-sm text-muted-foreground">Air Trendz Pvt Ltd · Hyderabad</p>
          </div>
        </div>

        {error && <p role="alert" className="mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{ERRORS[error] ?? ERRORS.server}</p>}

        {env().AUTH_MODE === "zoho" && (
          <Button asChild size="lg" className="h-14 w-full text-base"><a href="/api/auth/zoho/start">Sign in with Zoho</a></Button>
        )}

        {demo && (
          <>
            <p className="mb-3 text-sm font-medium text-muted-foreground">Choose a demo user to sign in</p>
            <div className="flex flex-col gap-2">
              {users.map((u) => (
                <form key={u.id} action={demoLogin.bind(null, u.id)}>
                  <button className="flex min-h-14 w-full items-center gap-3 rounded-xl border bg-card px-4 text-left transition-colors hover:border-primary hover:bg-accent">
                    <UserRound className="h-5 w-5 shrink-0 text-primary" />
                    <span className="flex-1 font-semibold">{u.name}</span>
                    <span className="text-sm text-muted-foreground">{u.role}</span>
                  </button>
                </form>
              ))}
            </div>
            <p className="mt-5 text-xs text-muted-foreground">Demo mode — sample data only.</p>
          </>
        )}
      </div>
    </div>
  );
}
