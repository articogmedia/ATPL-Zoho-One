import "server-only";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { STATIC_USERS, verifyStaticCredentials } from "./users";
import { loginAttemptStore } from "./login-attempt-store";

const scryptAsync = promisify(scrypt);
const PASSWORD_KEY_PREFIX = "atpl:auth:password:";
const VERSION_KEY_PREFIX = "atpl:auth:session-version:";
const RESET_KEY_PREFIX = "atpl:auth:reset:";
const RATE_KEY_PREFIX = "atpl:auth:reset-rate:";
const RESET_TOKEN_TTL_SECONDS = 30 * 60;
const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
`;
const SET_PASSWORD_SCRIPT = `
redis.call('SET', KEYS[1], ARGV[1])
local version = redis.call('INCR', KEYS[2])
redis.call('DEL', KEYS[3])
return version
`;
const RESET_PASSWORD_SCRIPT = `
local details = redis.call('GET', KEYS[1])
if not details then return false end
local reset = cjson.decode(details)
redis.call('SET', reset.passwordKey, ARGV[1])
redis.call('INCR', reset.versionKey)
redis.call('DEL', KEYS[1], reset.loginAttemptKey)
return reset.username
`;

export type PasswordStore = {
  getPasswordHash(username: string): Promise<string | undefined>;
  seedPasswordHash(username: string, passwordHash: string): Promise<void>;
  setPasswordHash(username: string, passwordHash: string): Promise<void>;
  getSessionVersion(username: string): Promise<number>;
  createResetToken(tokenHash: string, username: string): Promise<void>;
  deleteResetToken(tokenHash: string): Promise<void>;
  consumeResetToken(tokenHash: string, passwordHash: string): Promise<string | undefined>;
  takeResetRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean>;
};

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function usernameKey(prefix: string, username: string) {
  return `${prefix}${digest(username.trim().toLowerCase())}`;
}

function resetRateKey(key: string) {
  return `${RATE_KEY_PREFIX}${digest(key)}`;
}

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim().replace(/\/$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  return url && token ? { url, token } : undefined;
}

async function derivePassword(password: string, salt: string) {
  return await scryptAsync(password, salt, 64) as Buffer;
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = await derivePassword(password, salt);
  return `scrypt$${salt}$${derivedKey.toString("hex")}`;
}

export async function verifyPasswordHash(password: string, encoded: string) {
  const [algorithm, salt, expectedHex] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt || !expectedHex || !/^[a-f\d]{128}$/i.test(expectedHex)) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = await derivePassword(password, salt);
  return timingSafeEqual(actual, expected);
}

export function newResetToken() {
  return randomBytes(32).toString("base64url");
}

export function hashResetToken(token: string) {
  return digest(token);
}

class SharedPasswordStore implements PasswordStore {
  private readonly passwords = new Map<string, string>();
  private readonly versions = new Map<string, number>();
  private readonly resetTokens = new Map<string, { username: string; expiresAt: number }>();
  private readonly rateLimits = new Map<string, { count: number; expiresAt: number }>();

  private async command(args: (string | number)[]) {
    const config = redisConfig();
    if (!config) {
      if (process.env.NODE_ENV === "production") {
        throw new Error("Upstash Redis must be configured for production password storage.");
      }
      return undefined;
    }
    const [command, ...commandArgs] = args;
    const response = await fetch(config.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify([command, ...commandArgs]),
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`Upstash password store returned ${response.status}.`);
    const result = await response.json() as { result?: unknown; error?: string };
    if (result.error) throw new Error(`Upstash password store command failed: ${result.error}`);
    return result.result;
  }

  async getPasswordHash(username: string) {
    const key = usernameKey(PASSWORD_KEY_PREFIX, username);
    const result = await this.command(["GET", key]);
    if (typeof result === "string") return result;
    if (result !== undefined) return undefined;
    return this.passwords.get(key);
  }

  async seedPasswordHash(username: string, passwordHash: string) {
    const key = usernameKey(PASSWORD_KEY_PREFIX, username);
    const result = await this.command(["SET", key, passwordHash, "NX"]);
    if (result !== undefined) return;
    if (!this.passwords.has(key)) this.passwords.set(key, passwordHash);
  }

  async setPasswordHash(username: string, passwordHash: string) {
    const passwordKey = usernameKey(PASSWORD_KEY_PREFIX, username);
    const versionKey = usernameKey(VERSION_KEY_PREFIX, username);
    const result = await this.command([
      "EVAL", SET_PASSWORD_SCRIPT, 3, passwordKey, versionKey, `login-attempt:${username}`, passwordHash,
    ]);
    if (result !== undefined) return;
    this.passwords.set(passwordKey, passwordHash);
    this.versions.set(versionKey, (this.versions.get(versionKey) ?? 0) + 1);
  }

  async getSessionVersion(username: string) {
    const key = usernameKey(VERSION_KEY_PREFIX, username);
    const result = await this.command(["GET", key]);
    if (typeof result === "string") return Number(result) || 0;
    if (result !== undefined) return 0;
    return this.versions.get(key) ?? 0;
  }

  async createResetToken(tokenHash: string, username: string) {
    const key = `${RESET_KEY_PREFIX}${tokenHash}`;
    const reset = JSON.stringify({
      username,
      passwordKey: usernameKey(PASSWORD_KEY_PREFIX, username),
      versionKey: usernameKey(VERSION_KEY_PREFIX, username),
      loginAttemptKey: `login-attempt:${username}`,
    });
    const result = await this.command(["SET", key, reset, "EX", RESET_TOKEN_TTL_SECONDS]);
    if (result !== undefined) return;
    this.resetTokens.set(tokenHash, { username, expiresAt: Date.now() + RESET_TOKEN_TTL_SECONDS * 1000 });
  }

  async deleteResetToken(tokenHash: string) {
    const result = await this.command(["DEL", `${RESET_KEY_PREFIX}${tokenHash}`]);
    if (result !== undefined) return;
    this.resetTokens.delete(tokenHash);
  }

  async consumeResetToken(tokenHash: string, passwordHash: string) {
    const resetKey = `${RESET_KEY_PREFIX}${tokenHash}`;
    const result = await this.command([
      "EVAL", RESET_PASSWORD_SCRIPT, 1, resetKey, passwordHash,
    ]);
    if (typeof result === "string") return result;
    if (result !== undefined) return undefined;

    const reset = this.resetTokens.get(tokenHash);
    if (!reset || reset.expiresAt <= Date.now()) {
      this.resetTokens.delete(tokenHash);
      return undefined;
    }
    this.resetTokens.delete(tokenHash);
    const passwordKey = usernameKey(PASSWORD_KEY_PREFIX, reset.username);
    const versionKey = usernameKey(VERSION_KEY_PREFIX, reset.username);
    this.passwords.set(passwordKey, passwordHash);
    this.versions.set(versionKey, (this.versions.get(versionKey) ?? 0) + 1);
    return reset.username;
  }

  async takeResetRateLimit(key: string, limit: number, windowSeconds: number) {
    const redisKey = resetRateKey(key);
    const result = await this.command(["EVAL", RATE_LIMIT_SCRIPT, 1, redisKey, windowSeconds]);
    if (result !== undefined) return Number(result) <= limit;
    const current = this.rateLimits.get(redisKey);
    if (!current || current.expiresAt <= Date.now()) {
      this.rateLimits.set(redisKey, { count: 1, expiresAt: Date.now() + windowSeconds * 1000 });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  }
}

export function createMemoryPasswordStore(): PasswordStore {
  const store = new SharedPasswordStore();
  return store;
}

export const passwordStore: PasswordStore = new SharedPasswordStore();

export async function authenticateStaticCredentials(
  username: string,
  password: string,
  store: PasswordStore = passwordStore,
) {
  const user = STATIC_USERS.find((candidate) => candidate.username === username.trim().toLowerCase());
  if (!user) {
    verifyStaticCredentials(username, password);
    return null;
  }

  let encoded = await store.getPasswordHash(user.username);
  if (!encoded) {
    if (!verifyStaticCredentials(user.username, password)) return null;
    await store.seedPasswordHash(user.username, await hashPassword(password));
    encoded = await store.getPasswordHash(user.username);
  }
  return encoded && await verifyPasswordHash(password, encoded) ? user : null;
}

export async function setStaticUserPassword(
  username: string,
  password: string,
  store: PasswordStore = passwordStore,
  attempts = loginAttemptStore,
) {
  await store.setPasswordHash(username, await hashPassword(password));
  await attempts.delete(username);
}

export async function resetPasswordWithToken(
  token: string,
  password: string,
  store: PasswordStore = passwordStore,
  attempts = loginAttemptStore,
) {
  const username = await store.consumeResetToken(hashResetToken(token), await hashPassword(password));
  if (!username) return false;
  await attempts.delete(username);
  return true;
}

export async function resetStaticUserPassword(token: string, password: string) {
  return resetPasswordWithToken(token, password);
}
