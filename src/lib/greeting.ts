export type GreetingPart = "Good morning" | "Good afternoon" | "Good evening";

export function greetingPartAt(date: Date): GreetingPart {
  const hour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(date));
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}
