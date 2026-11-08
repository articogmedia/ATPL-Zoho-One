type PerfDetails = Record<string, string | number | boolean | null | undefined>;

export function logPerf(operation: string, durationMs: number, details: PerfDetails = {}) {
  console.info("[perf]", {
    operation,
    durationMs: Math.max(0, Math.round(durationMs * 100) / 100),
    ...details,
  });
}
