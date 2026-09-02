import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryClientIdStore, MemoryCredentialStore } from "../slack/credentials.ts";
import { SlackAuth, type SlackAuthOptions } from "../slack/oauth.ts";
import {
  SLACK_AUTHORIZATION_ENDPOINT,
  SLACK_MCP_RESOURCE,
  SLACK_OAUTH_ISSUER,
  SLACK_SCOPES,
  SLACK_TOKEN_ENDPOINT,
  type SlackConfig,
  type SlackCredentials,
} from "../slack/types.ts";

const now = 10_000;

const config: SlackConfig = {
  clientId: "123456789.987654321",
  expectedTeamId: "TEXPECTED",
  loginTimeoutMs: 2_000,
  requestTimeoutMs: 2_000,
  refreshLeewayMs: 60_000,
  maxRetryAfterMs: 50,
  maxToolPages: 3,
};

const expiring: SlackCredentials = {
  clientId: config.clientId,
  tokenType: "user",
  accessToken: "xoxp-stale",
  refreshToken: "xoxe-stale",
  expiresAt: now,
  scopes: [...SLACK_SCOPES],
  identity: { teamId: "TEXPECTED", userId: "U123" },
};

interface FetchStub {
  fetch: typeof fetch;
  metadataRequests: number;
  tokenRequests: URLSearchParams[];
}

type TokenHandler = (body: URLSearchParams, init?: RequestInit) => Response | Promise<Response>;

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function stubFetch(token: TokenHandler): FetchStub {
  const stub: FetchStub = { fetch: undefined!, metadataRequests: 0, tokenRequests: [] };
  stub.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      stub.metadataRequests++;
      return json({
        issuer: SLACK_OAUTH_ISSUER,
        authorization_endpoint: SLACK_AUTHORIZATION_ENDPOINT,
        token_endpoint: SLACK_TOKEN_ENDPOINT,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: [...SLACK_SCOPES],
      });
    }
    if (url.endsWith("/.well-known/oauth-protected-resource")) {
      stub.metadataRequests++;
      return json({
        resource: SLACK_MCP_RESOURCE,
        authorization_servers: [SLACK_OAUTH_ISSUER],
        scopes_supported: [...SLACK_SCOPES],
      });
    }
    if (url === SLACK_TOKEN_ENDPOINT) {
      const body = new URLSearchParams(String(init?.body));
      stub.tokenRequests.push(body);
      return token(body, init);
    }
    throw new Error("unexpected request");
  }) as typeof fetch;
  return stub;
}

function rotated(refreshToken: string): Response {
  return json({
    ok: true,
    access_token: `xoxp-${refreshToken.slice("xoxe-".length)}`,
    refresh_token: refreshToken,
    expires_in: 3600,
    token_type: "user",
  });
}

/** Slack refresh tokens are single-use: a second presentation is rejected. */
function singleUseRotation(): TokenHandler {
  const used = new Set<string>();
  let issued = 0;
  return (body) => {
    const presented = body.get("refresh_token") ?? "";
    if (used.has(presented)) return json({ ok: false, error: "invalid_refresh_token" });
    used.add(presented);
    issued++;
    return rotated(`xoxe-rotation-${issued}`);
  };
}

function delay(milliseconds: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

function makeAuth(
  store: MemoryCredentialStore,
  stub: FetchStub,
  overrides: Partial<SlackAuthOptions> = {},
): SlackAuth {
  const clientIdStore = new MemoryClientIdStore();
  clientIdStore.clientId = config.clientId;
  return new SlackAuth({
    config,
    store,
    clientIdStore,
    now: () => now,
    fetch: stub.fetch,
    ...overrides,
  });
}

test("a Slack error delivered as HTTP 200 keeps credentials for a later retry", async () => {
  for (const error of ["internal_error", "service_unavailable", "fatal_error", "request_timeout"]) {
    const store = new MemoryCredentialStore();
    store.credentials = { ...expiring };
    let invalidations = 0;
    const auth = makeAuth(
      store,
      stubFetch(() => json({ ok: false, error })),
      {
        onInvalidCredentials: () => {
          invalidations++;
        },
      },
    );

    await assert.rejects(auth.getAccessGrant(), /Retry later/, error);
    assert.deepEqual(store.credentials, expiring, error);
    assert.equal(store.deletes, 0, error);
    assert.equal(invalidations, 0, error);
    assert.equal((await auth.status()).authenticated, true, error);
  }
});

test("a terminal token error still removes credentials", async () => {
  for (const error of ["invalid_refresh_token", "token_revoked"]) {
    const store = new MemoryCredentialStore();
    store.credentials = { ...expiring };
    let invalidations = 0;
    const auth = makeAuth(
      store,
      stubFetch(() => json({ ok: false, error })),
      {
        onInvalidCredentials: () => {
          invalidations++;
        },
      },
    );

    await assert.rejects(auth.getAccessGrant(), /Slack rejected the OAuth token request/, error);
    assert.equal(store.credentials, undefined, error);
    assert.equal(store.deletes, 1, error);
    assert.equal(invalidations, 1, error);
  }
});

test("a refresh adopts tokens another process already rotated", async () => {
  const store = new MemoryCredentialStore();
  store.credentials = { ...expiring };
  const stub = stubFetch(singleUseRotation());
  const first = makeAuth(store, stub);
  const second = makeAuth(store, stub);
  await first.status();
  await second.status();

  const firstGrant = await first.getAccessGrant();
  assert.equal(store.credentials?.refreshToken, "xoxe-rotation-1");
  const secondGrant = await second.getAccessGrant();

  assert.equal(stub.tokenRequests.length, 1);
  assert.equal(secondGrant.accessToken, firstGrant.accessToken);
  assert.equal(store.credentials?.refreshToken, "xoxe-rotation-1");
  assert.equal(store.deletes, 0);
  assert.equal(secondGrant.revision, 1);
});

test("losing a refresh race adopts the winner's credentials instead of deleting them", async () => {
  const store = new MemoryCredentialStore();
  store.credentials = { ...expiring };
  const winner: SlackCredentials = {
    ...expiring,
    accessToken: "xoxp-winner",
    refreshToken: "xoxe-winner",
    expiresAt: now + 3_600_000,
  };
  let invalidations = 0;
  const stub = stubFetch(() => {
    store.credentials = structuredClone(winner);
    return json({ ok: false, error: "invalid_refresh_token" });
  });
  const auth = makeAuth(store, stub, {
    onInvalidCredentials: () => {
      invalidations++;
    },
  });

  const grant = await auth.getAccessGrant();

  assert.equal(grant.accessToken, "xoxp-winner");
  assert.deepEqual(store.credentials, winner);
  assert.equal(store.deletes, 0);
  assert.equal(invalidations, 0);
  assert.equal(stub.tokenRequests.length, 1);
});

test("credentials removed by another process are not resurrected by a refresh", async () => {
  const store = new MemoryCredentialStore();
  store.credentials = { ...expiring };
  const stub = stubFetch(singleUseRotation());
  const auth = makeAuth(store, stub);
  await auth.status();
  store.credentials = undefined;

  await assert.rejects(auth.getAccessGrant(), /Slack is not authenticated/);
  assert.equal(stub.tokenRequests.length, 0);
  assert.equal(store.writes, 0);
  assert.equal(store.credentials, undefined);
  assert.equal((await auth.status()).authenticated, false);
});

test("a caller's cancellation does not abort a shared refresh", async () => {
  const store = new MemoryCredentialStore();
  store.credentials = { ...expiring };
  const stub = stubFetch(async (_body, init) => {
    await delay(30, init?.signal);
    return rotated("xoxe-next");
  });
  const auth = makeAuth(store, stub);

  const controller = new AbortController();
  const cancelled = auth.getAccessGrant(controller.signal);
  const kept = auth.getAccessGrant();
  await delay(5);
  controller.abort();

  await assert.rejects(cancelled, /Slack request was cancelled/);
  const grant = await kept;
  assert.equal(grant.accessToken, "xoxp-next");
  assert.equal(store.credentials?.refreshToken, "xoxe-next");
  assert.equal(stub.tokenRequests.length, 1);
});

test("a rejected non-expiring token without a refresh token is kept", async () => {
  const store = new MemoryCredentialStore();
  const nonExpiring: SlackCredentials = {
    clientId: config.clientId,
    tokenType: "user",
    accessToken: "xoxp-non-expiring",
    scopes: [...SLACK_SCOPES],
    identity: { teamId: "TEXPECTED", userId: "U123" },
  };
  store.credentials = { ...nonExpiring };
  const stub = stubFetch(() => {
    throw new Error("unexpected token request");
  });
  const auth = makeAuth(store, stub);

  await assert.rejects(auth.forceRefresh(), /slack-logout/);
  assert.deepEqual(store.credentials, nonExpiring);
  assert.equal(store.deletes, 0);
  assert.equal(stub.tokenRequests.length, 0);
});

test("OAuth metadata is discovered once for repeated refreshes", async () => {
  const store = new MemoryCredentialStore();
  store.credentials = { ...expiring };
  let clock = now;
  const stub = stubFetch(singleUseRotation());
  const auth = makeAuth(store, stub, { now: () => clock });

  await auth.getAccessGrant();
  clock += 3_600_000;
  await auth.getAccessGrant();

  assert.equal(stub.tokenRequests.length, 2);
  assert.equal(stub.metadataRequests, 2);
  assert.equal(store.credentials?.refreshToken, "xoxe-rotation-2");
});
