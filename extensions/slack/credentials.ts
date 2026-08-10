import { SLACK_SCOPES, type SlackCredentials } from "./types.ts";

const KEYRING_SERVICE = "pi-slack-mcp";
const KEYRING_ACCOUNT = "read-only-oauth";
const ALLOWED_SCOPES = new Set<string>(SLACK_SCOPES);

export interface CredentialStore {
  load(): Promise<SlackCredentials | undefined>;
  save(credentials: SlackCredentials): Promise<void>;
  delete(): Promise<void>;
}

interface KeyringEntry {
  getPassword(signal?: AbortSignal): Promise<string | undefined>;
  setPassword(password: string, signal?: AbortSignal): Promise<void>;
  deletePassword(signal?: AbortSignal): Promise<unknown>;
}

export class CredentialStoreError extends Error {
  constructor(operation: "read" | "write" | "delete") {
    super(`The OS credential store could not ${operation} Slack credentials.`);
    this.name = "CredentialStoreError";
  }
}

export class OsCredentialStore implements CredentialStore {
  private entryPromise?: Promise<KeyringEntry>;

  async load(): Promise<SlackCredentials | undefined> {
    let serialized: string | undefined;
    try {
      serialized = await (await this.entry()).getPassword();
    } catch {
      throw new CredentialStoreError("read");
    }
    if (serialized === undefined) return undefined;

    const credentials = parseCredentials(serialized);
    if (!credentials) {
      await this.delete();
      return undefined;
    }
    return credentials;
  }

  async save(credentials: SlackCredentials): Promise<void> {
    try {
      await (await this.entry()).setPassword(JSON.stringify(credentials));
    } catch {
      throw new CredentialStoreError("write");
    }
  }

  async delete(): Promise<void> {
    try {
      await (await this.entry()).deletePassword();
    } catch {
      throw new CredentialStoreError("delete");
    }
  }

  private entry(): Promise<KeyringEntry> {
    this.entryPromise ??= import("@napi-rs/keyring")
      .then(({ AsyncEntry }) => new AsyncEntry(KEYRING_SERVICE, KEYRING_ACCOUNT))
      .catch(() => {
        throw new CredentialStoreError("read");
      });
    return this.entryPromise;
  }
}

export class MemoryCredentialStore implements CredentialStore {
  credentials?: SlackCredentials;
  fail?: "read" | "write" | "delete";
  reads = 0;
  writes = 0;
  deletes = 0;

  async load(): Promise<SlackCredentials | undefined> {
    this.reads++;
    if (this.fail === "read") throw new CredentialStoreError("read");
    return this.credentials ? structuredClone(this.credentials) : undefined;
  }

  async save(credentials: SlackCredentials): Promise<void> {
    this.writes++;
    if (this.fail === "write") throw new CredentialStoreError("write");
    this.credentials = structuredClone(credentials);
  }

  async delete(): Promise<void> {
    this.deletes++;
    if (this.fail === "delete") throw new CredentialStoreError("delete");
    this.credentials = undefined;
  }
}

function parseCredentials(serialized: string): SlackCredentials | undefined {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (typeof value.clientId !== "string" || !/^\d+(?:\.\d+)+$/.test(value.clientId)) {
    return undefined;
  }
  if (value.tokenType !== "user") return undefined;
  if (typeof value.accessToken !== "string" || !isValidAccessToken(value.accessToken)) {
    return undefined;
  }
  if (
    value.refreshToken !== undefined &&
    (typeof value.refreshToken !== "string" || !value.refreshToken.startsWith("xoxe-"))
  ) {
    return undefined;
  }
  if (value.expiresAt !== undefined && !isFiniteNumber(value.expiresAt)) return undefined;
  if (value.refreshToken !== undefined && value.expiresAt === undefined) return undefined;
  if (!Array.isArray(value.scopes) || !value.scopes.every(isAllowedScope)) return undefined;
  if (value.scopes.length !== SLACK_SCOPES.length) return undefined;
  if (new Set(value.scopes).size !== SLACK_SCOPES.length) return undefined;
  if (!isRecord(value.identity)) return undefined;
  if (typeof value.identity.teamId !== "string" || !value.identity.teamId) return undefined;
  if (typeof value.identity.userId !== "string" || !value.identity.userId) return undefined;
  if (
    value.identity.enterpriseId !== undefined &&
    (typeof value.identity.enterpriseId !== "string" || !value.identity.enterpriseId)
  ) {
    return undefined;
  }

  return {
    clientId: value.clientId,
    tokenType: "user",
    accessToken: value.accessToken,
    ...(typeof value.refreshToken === "string" ? { refreshToken: value.refreshToken } : {}),
    ...(typeof value.expiresAt === "number" ? { expiresAt: value.expiresAt } : {}),
    scopes: [...value.scopes],
    identity: {
      teamId: value.identity.teamId,
      userId: value.identity.userId,
      ...(typeof value.identity.enterpriseId === "string"
        ? { enterpriseId: value.identity.enterpriseId }
        : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isAllowedScope(value: unknown): value is string {
  return typeof value === "string" && ALLOWED_SCOPES.has(value);
}

function isValidAccessToken(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 8_192 &&
    !value.includes("\r") &&
    !value.includes("\n") &&
    !value.includes("\0")
  );
}
