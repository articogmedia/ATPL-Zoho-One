export type LoginAttempt = { count: number; lockedUntil: number };

export interface LoginAttemptStore {
  get(username: string): Promise<LoginAttempt | undefined>;
  set(username: string, attempt: LoginAttempt): Promise<void>;
  delete(username: string): Promise<void>;
}

export class MemoryLoginAttemptStore implements LoginAttemptStore {
  private readonly attempts = new Map<string, LoginAttempt>();

  async get(username: string) {
    return this.attempts.get(username);
  }

  async set(username: string, attempt: LoginAttempt) {
    this.attempts.set(username, attempt);
  }

  async delete(username: string) {
    this.attempts.delete(username);
  }
}

class UpstashLoginAttemptStore implements LoginAttemptStore {
  constructor(private readonly url: string, private readonly token: string) {}

  private async request(args: string[]) {
    const [command, ...commandArgs] = args;
    const response = await fetch(this.url.replace(/\/$/, ""), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify([command, ...commandArgs]),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Upstash login attempt store returned ${response.status}.`);
    return response.json() as Promise<{ result: unknown }>;
  }

  async get(username: string) {
    const { result } = await this.request(["GET", `login-attempt:${username}`]);
    return typeof result === "string" ? JSON.parse(result) as LoginAttempt : undefined;
  }

  async set(username: string, attempt: LoginAttempt) {
    await this.request(["SET", `login-attempt:${username}`, JSON.stringify(attempt)]);
  }

  async delete(username: string) {
    await this.request(["DEL", `login-attempt:${username}`]);
  }
}

const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

export const loginAttemptStore: LoginAttemptStore =
  redisUrl && redisToken
    ? new UpstashLoginAttemptStore(redisUrl, redisToken)
    : new MemoryLoginAttemptStore();
