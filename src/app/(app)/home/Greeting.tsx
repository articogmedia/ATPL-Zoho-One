"use client";

import { useEffect, useState } from "react";
import { greetingPartAt, type GreetingPart } from "@/lib/greeting";

export function Greeting({ name }: { name: string }) {
  const [part, setPart] = useState<GreetingPart | null>(null);

  useEffect(() => {
    const updateGreeting = () => setPart(greetingPartAt(new Date()));
    updateGreeting();
    const interval = window.setInterval(updateGreeting, 60_000);
    document.addEventListener("visibilitychange", updateGreeting);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", updateGreeting);
    };
  }, []);

  return <h1 className="mt-1 text-[28px] font-bold leading-tight">{part ? `${part}, ${name}` : `Welcome, ${name}`}</h1>;
}
