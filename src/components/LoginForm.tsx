"use client";

import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import { useActionState, useState } from "react";
import { loginAction } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, null);
  const [showPassword, setShowPassword] = useState(false);
  return (
    <form action={action} className="space-y-4" noValidate>
      <label htmlFor="login-username" className="block text-sm font-medium text-slate-700">
        Username
        <input id="login-username" name="username" required placeholder="Enter your username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} className="mt-1 h-12 w-full rounded-lg border px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900" />
      </label>
      <label htmlFor="login-password" className="block text-sm font-medium text-slate-700">
        Password
        <div className="relative mt-1">
          <input id="login-password" name="password" required placeholder="Enter your password" type={showPassword ? "text" : "password"} autoComplete="current-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} className="h-12 w-full rounded-lg border px-3 pr-14 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900" />
          <button type="button" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((value) => !value)} className="absolute inset-y-0 right-0 grid w-12 place-items-center text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900">
            {showPassword ? <EyeOff aria-hidden="true" className="h-5 w-5" /> : <Eye aria-hidden="true" className="h-5 w-5" />}
          </button>
        </div>
      </label>
      {state?.error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{state.error}</p>}
      <Button type="submit" disabled={pending} className="min-h-12 w-full rounded-lg bg-[#2454c5] hover:bg-[#1d46a5]">{pending && <LoaderCircle className="animate-spin" aria-hidden="true" />}{pending ? "Signing in..." : "Sign in"}</Button>
      <p className="text-center text-[13px] text-slate-500">Forgot your password? Contact your manager.</p>
    </form>
  );
}
