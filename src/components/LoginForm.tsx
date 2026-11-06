"use client";

import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { toast } from "sonner";
import { loginAction } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, null);
  const [showPassword, setShowPassword] = useState(false);
  const [username, setUsername] = useState("");
  const [rememberUsername, setRememberUsername] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [retried, setRetried] = useState(false);
  const [returnTo, setReturnTo] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    void fetch("/api/warm", { method: "GET", cache: "no-store" }).catch(() => undefined);
    const params = new URLSearchParams(window.location.search);
    const destination = params.get("returnTo");
    if (destination) setReturnTo(destination);
    if (params.get("expired") === "1") {
      toast.error("Session expired, please sign in again");
      window.history.replaceState(null, "", "/login");
    }
  }, []);

  useEffect(() => {
    if (!pending) return;
    setTimedOut(false);
    const timer = window.setTimeout(() => {
      if (!retried && formRef.current) {
        setRetried(true);
        action(new FormData(formRef.current));
      } else {
        setTimedOut(true);
      }
    }, 20_000);
    return () => window.clearTimeout(timer);
  }, [action, pending, retried]);

  useEffect(() => {
    try {
      const savedUsername = window.localStorage.getItem("atpl-remembered-username");
      if (savedUsername) {
        setUsername(savedUsername);
        setRememberUsername(true);
      }
    } catch {
      // Storage may be unavailable in private browsing or restricted environments.
    }
  }, []);

  function handleSubmit() {
    setTimedOut(false);
    setRetried(false);
    if (rememberUsername) {
      try {
        window.localStorage.setItem("atpl-remembered-username", username.trim());
      } catch {
        // Storage may be unavailable in private browsing or restricted environments.
      }
    } else {
      try {
        window.localStorage.removeItem("atpl-remembered-username");
      } catch {
        // Storage may be unavailable in private browsing or restricted environments.
      }
    }
  }

  return (
    <form ref={formRef} action={action} onSubmit={handleSubmit} className="space-y-4" noValidate>
      <input type="hidden" name="returnTo" value={returnTo} />
      <label htmlFor="login-username" className="block text-sm font-medium text-slate-700">
        Username
        <input id="login-username" name="username" value={username} onChange={(event) => setUsername(event.target.value)} required placeholder="Enter your username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} className="mt-1 h-12 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 text-base focus:bg-white focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" />
      </label>
      <label htmlFor="login-password" className="block text-sm font-medium text-slate-700">
        Password
        <div className="relative mt-1">
          <input id="login-password" name="password" required placeholder="Enter your password" type={showPassword ? "text" : "password"} autoComplete="current-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} onKeyDown={(event) => setCapsLockOn(event.getModifierState("CapsLock"))} onKeyUp={(event) => setCapsLockOn(event.getModifierState("CapsLock"))} onBlur={() => setCapsLockOn(false)} className="h-12 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 pr-14 text-base focus:bg-white focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" />
          <button type="button" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((value) => !value)} className="absolute inset-y-0 right-0 grid w-12 place-items-center text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            {showPassword ? <EyeOff aria-hidden="true" className="h-5 w-5" /> : <Eye aria-hidden="true" className="h-5 w-5" />}
          </button>
        </div>
        {capsLockOn && <p className="mt-1 text-xs font-medium text-amber-700">Caps Lock is on</p>}
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-600">
        <input type="checkbox" checked={rememberUsername} onChange={(event) => setRememberUsername(event.target.checked)} className="h-4 w-4 rounded border-slate-300 text-primary focus:ring-2 focus:ring-primary" />
        Remember my username
      </label>
      {state?.error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{state.error}</p>}
      {timedOut && <div role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">Sign-in is taking too long. Check your connection and try again.<Button type="button" variant="link" className="h-auto px-1 text-sm" onClick={() => { setTimedOut(false); setRetried(true); if (formRef.current) action(new FormData(formRef.current)); }}>Retry</Button></div>}
      <LoginSubmit pending={pending} />
      <p className="text-center text-[13px] text-slate-500">Forgot your password? Contact your manager.</p>
    </form>
  );
}

function LoginSubmit({ pending: actionPending }: { pending: boolean }) {
  const { pending } = useFormStatus();
  const isPending = pending || actionPending;
  return <Button type="submit" disabled={isPending} className="w-full rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary">{isPending && <LoaderCircle className="animate-spin" aria-hidden="true" />}{isPending ? "Signing in..." : "Sign in"}</Button>;
}
