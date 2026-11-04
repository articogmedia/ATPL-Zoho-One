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

// TODO(client): Add an Upstash Redis implementation when UPSTASH_REDIS_REST_URL
// and UPSTASH_REDIS_REST_TOKEN are configured. Keep memory disabled when absent.
export const loginAttemptStore: LoginAttemptStore = new MemoryLoginAttemptStore();
