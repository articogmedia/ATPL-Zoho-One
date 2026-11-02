"use client";

import { useActionState, useState } from "react";
import { loginAction } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, null);
  const [showPassword, setShowPassword] = useState(false);
  return (
    <form action={action} className="space-y-4" noValidate>
      {state?.error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{state.error}</p>}
      <label className="block text-sm font-medium text-slate-700">
        Username
        <input name="username" required autoComplete="username" className="mt-1 h-11 w-full rounded-lg border px-3 text-base" />
      </label>
      <label className="block text-sm font-medium text-slate-700">
        Password
        <div className="relative mt-1">
          <input name="password" required type={showPassword ? "text" : "password"} autoComplete="current-password" className="h-11 w-full rounded-lg border px-3 pr-20 text-base" />
          <button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute inset-y-0 right-0 min-w-16 px-3 text-sm font-medium text-slate-600">
            {showPassword ? "Hide" : "Show"}
          </button>
        </div>
      </label>
      <Button type="submit" disabled={pending} className="h-11 w-full">{pending ? "Signing in..." : "Sign in"}</Button>
    </form>
  );
}
