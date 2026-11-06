export class PageDataTimeoutError extends Error {
  constructor() {
    super("Page data loading exceeded the request time limit.");
    this.name = "PageDataTimeoutError";
  }
}

export async function withPageTimeout<T>(promise: Promise<T>, timeoutMs = 12_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new PageDataTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
