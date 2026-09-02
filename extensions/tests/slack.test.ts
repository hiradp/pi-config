import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SlackMcpClient, pinSlackProtocolVersion, type McpConnection } from "../slack/client.ts";
import { MemoryClientIdStore, MemoryCredentialStore } from "../slack/credentials.ts";
import { formatSlackResult } from "../slack/format.ts";
import { registerSlackExtension } from "../slack/index.ts";
import {
  SlackAuth,
  createAuthorizationUrl,
  createPkceChallenge,
  createPkceVerifier,
  discoverOAuthMetadata,
  validateEffectiveScopes,
  validateInitialToken,
  validateRefreshedToken,
} from "../slack/oauth.ts";
import {
  mapReadChannelArguments,
  mapReadThreadArguments,
  mapSearchArguments,
  verifyApprovedTools,
} from "../slack/tools.ts";
import {
  SLACK_AUTHORIZATION_ENDPOINT,
  SLACK_MCP_RESOURCE,
  SLACK_OAUTH_ISSUER,
  SLACK_REDIRECT_URI,
  SLACK_SCOPES,
  SLACK_TOKEN_ENDPOINT,
  type SlackCallResult,
  type SlackConfig,
  type SlackCredentials,
  type SlackToolMetadata,
} from "../slack/types.ts";

const config: SlackConfig = {
  clientId: "123456789.987654321",
  expectedTeamId: "TEXPECTED",
  loginTimeoutMs: 2_000,
  requestTimeoutMs: 2_000,
  refreshLeewayMs: 60_000,
  maxRetryAfterMs: 50,
  maxToolPages: 3,
};

const credentials: SlackCredentials = {
  clientId: config.clientId,
  tokenType: "user",
  accessToken: "xoxp-access-value",
  refreshToken: "xoxe-refresh-value",
  expiresAt: Date.now() + 3_600_000,
  scopes: [...SLACK_SCOPES],
  identity: { teamId: "TEXPECTED", userId: "U123" },
};

function authorizationMetadata() {
  return {
    issuer: SLACK_OAUTH_ISSUER,
    authorization_endpoint: SLACK_AUTHORIZATION_ENDPOINT,
    token_endpoint: SLACK_TOKEN_ENDPOINT,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...SLACK_SCOPES],
  };
}

function resourceMetadata() {
  return {
    resource: SLACK_MCP_RESOURCE,
    authorization_servers: [SLACK_OAUTH_ISSUER],
    scopes_supported: [...SLACK_SCOPES],
  };
}

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function metadataFetch(
  token?: (body: URLSearchParams) => Response | Promise<Response>,
  authTest?: (init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return json(authorizationMetadata());
    }
    if (url.endsWith("/.well-known/oauth-protected-resource")) return json(resourceMetadata());
    if (url === SLACK_TOKEN_ENDPOINT && token) {
      return token(new URLSearchParams(String(init?.body)));
    }
    if (url === "https://slack.com/api/auth.test" && authTest) return authTest(init);
    throw new Error("unexpected request");
  }) as typeof fetch;
}

function property(type: string, extra: Record<string, unknown> = {}): object {
  return { type, ...extra };
}

function approvedTools(): SlackToolMetadata[] {
  return [
    {
      name: "slack_search_public_and_private",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          query: property("string"),
          content_types: property("string"),
          limit: property("integer"),
          cursor: property("string"),
        },
        required: ["query"],
      },
    },
    {
      name: "slack_search_channels",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          query: property("string"),
          limit: property("integer"),
          cursor: property("string"),
        },
        required: ["query"],
      },
    },
    {
      name: "slack_read_channel",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          channel_id: property("string"),
          limit: property("integer"),
          cursor: property("string"),
        },
        required: ["channel_id"],
      },
    },
    {
      name: "slack_read_thread",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          channel_id: property("string"),
          message_ts: property("string"),
          limit: property("integer"),
          cursor: property("string"),
        },
        required: ["channel_id", "message_ts"],
      },
    },
    {
      name: "slack_search_users",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          query: property("string"),
          limit: property("integer"),
          cursor: property("string"),
        },
        required: ["query"],
      },
    },
  ];
}

class FakeConnection implements McpConnection {
  connects = 0;
  calls: Array<{ name: string; args: Record<string, unknown>; signal?: AbortSignal }> = [];
  terminates = 0;
  closes = 0;
  result: SlackCallResult = { content: [{ type: "text", text: "ok" }] };

  async connect(): Promise<void> {
    this.connects++;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  async listTools(): Promise<{ tools: SlackToolMetadata[] }> {
    return { tools: approvedTools() };
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<SlackCallResult> {
    this.calls.push({ name, args, signal });
    return this.result;
  }

  async terminate(): Promise<void> {
    this.terminates++;
  }

  async close(): Promise<void> {
    this.closes++;
  }
}

test("pins Slack OAuth metadata and builds a resource-bound PKCE authorization URL", async () => {
  const metadata = await discoverOAuthMetadata(metadataFetch());
  const verifier = createPkceVerifier();
  const challenge = createPkceChallenge(verifier);
  const url = createAuthorizationUrl(metadata.authorization, config, "state-value", challenge);

  assert.equal(url.origin + url.pathname, SLACK_AUTHORIZATION_ENDPOINT);
  assert.equal(url.searchParams.get("client_id"), config.clientId);
  assert.equal(url.searchParams.get("redirect_uri"), SLACK_REDIRECT_URI);
  assert.equal(url.searchParams.get("resource"), SLACK_MCP_RESOURCE);
  assert.equal(url.searchParams.get("state"), "state-value");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.deepEqual(new Set(url.searchParams.get("scope")?.split(" ")), new Set(SLACK_SCOPES));
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.equal(challenge.length, 43);
});

test("rejects changed OAuth issuer, resource, and required metadata", async () => {
  for (const change of [
    { authorization: { issuer: "https://evil.example" } },
    { resource: { resource: "https://evil.example" } },
    { authorization: { code_challenge_methods_supported: ["plain"] } },
  ]) {
    const fake = (async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("oauth-authorization-server")) {
        return json({ ...authorizationMetadata(), ...change.authorization });
      }
      return json({ ...resourceMetadata(), ...change.resource });
    }) as typeof fetch;
    await assert.rejects(discoverOAuthMetadata(fake), /Slack OAuth metadata/);
  }
});

test("validates exact scopes, user-token evidence, and configured identity", () => {
  const token = validateInitialToken(
    {
      accessToken: "xoxp-new-access",
      refreshToken: "xoxe-new-refresh",
      expiresIn: 3600,
      tokenType: "user",
      scopes: [...SLACK_SCOPES],
      identity: { teamId: "TEXPECTED", userId: "U123" },
    },
    config,
    1_000,
  );
  assert.equal(token.clientId, config.clientId);
  assert.equal(token.expiresAt, 3_601_000);
  assert.deepEqual(token.scopes, SLACK_SCOPES);
  assert.doesNotThrow(() =>
    validateInitialToken(
      {
        accessToken: "xoxe.xoxp-1-rotating-access",
        refreshToken: "xoxe-1-rotating-refresh",
        expiresIn: 3600,
        tokenType: "user",
        scopes: [...SLACK_SCOPES],
        identity: { teamId: "TEXPECTED", userId: "U123" },
      },
      config,
      0,
    ),
  );
  const expiring = validateInitialToken(
    {
      accessToken: "opaque-user-access-token",
      expiresIn: 3599,
      tokenType: "user",
      scopes: [...SLACK_SCOPES],
      identity: { teamId: "TEXPECTED", userId: "U123" },
    },
    config,
    0,
  );
  assert.equal(expiring.refreshToken, undefined);
  assert.equal(expiring.expiresAt, 3_599_000);
  assert.doesNotThrow(() =>
    validateInitialToken(
      {
        accessToken: "xoxp-user-with-omitted-type",
        scopes: [...SLACK_SCOPES],
        identity: { teamId: "TEXPECTED", userId: "U123" },
      },
      config,
      0,
    ),
  );
  assert.doesNotThrow(() =>
    validateInitialToken(
      {
        accessToken: "xoxp-user-with-bearer-type",
        tokenType: "Bearer",
        scopes: [...SLACK_SCOPES],
        identity: { teamId: "TEXPECTED", userId: "U123" },
      },
      config,
      0,
    ),
  );

  assert.deepEqual(validateEffectiveScopes([...SLACK_SCOPES, SLACK_SCOPES[0]]), SLACK_SCOPES);
  assert.throws(
    () => validateEffectiveScopes([...SLACK_SCOPES, "channels:read"]),
    /unapproved OAuth scope set \(unexpected: "channels:read"\)/,
  );
  assert.throws(
    () => validateEffectiveScopes(SLACK_SCOPES.filter((scope) => scope !== "groups:history")),
    /unapproved OAuth scope set \(missing: groups:history\)/,
  );
  assert.throws(
    () =>
      validateInitialToken(
        {
          accessToken: "xoxb-bot",
          tokenType: "bot",
          scopes: [...SLACK_SCOPES],
          identity: { teamId: "TEXPECTED", userId: "U123" },
        },
        config,
        0,
      ),
    /user access token/,
  );
  assert.throws(
    () =>
      validateInitialToken(
        {
          accessToken: "xoxb-bot-marked-as-user",
          tokenType: "user",
          scopes: [...SLACK_SCOPES],
          identity: { teamId: "TEXPECTED", userId: "U123" },
        },
        config,
        0,
      ),
    /user access token/,
  );
  assert.throws(
    () =>
      validateInitialToken(
        {
          accessToken: "opaque-token-without-type",
          scopes: [...SLACK_SCOPES],
          identity: { teamId: "TEXPECTED", userId: "U123" },
        },
        config,
        0,
      ),
    /user access token/,
  );
  assert.throws(
    () =>
      validateInitialToken(
        {
          accessToken: "xoxp-access",
          tokenType: "user",
          scopes: [...SLACK_SCOPES],
          identity: { teamId: "TOTHER", userId: "U123" },
        },
        config,
        0,
      ),
    /unexpected team/,
  );
});

test("refresh retains omitted scopes and identity but rejects returned mismatches", () => {
  const refreshed = validateRefreshedToken(
    { accessToken: "xoxp-next", refreshToken: "xoxe-next", tokenType: "user", expiresIn: 60 },
    credentials,
    config,
    5_000,
  );
  assert.deepEqual(refreshed.scopes, credentials.scopes);
  assert.deepEqual(refreshed.identity, credentials.identity);
  assert.equal(refreshed.expiresAt, 65_000);

  assert.throws(
    () =>
      validateRefreshedToken(
        {
          accessToken: "xoxp-next",
          refreshToken: "xoxe-next",
          expiresIn: 60,
          tokenType: "user",
          identity: { teamId: "TOTHER" },
        },
        credentials,
        config,
        0,
      ),
    /different team identity/,
  );
});

test("public PKCE login exchanges without a secret and stores only validated credentials", async () => {
  const store = new MemoryCredentialStore();
  let tokenBody: URLSearchParams | undefined;
  let authorizationUrl: URL | undefined;
  const clientIdStore = new MemoryClientIdStore();
  const auth = new SlackAuth({
    config: { ...config, clientId: "" },
    store,
    clientIdStore,
    fetch: metadataFetch(
      (body) => {
        tokenBody = body;
        return json({
          ok: true,
          access_token: "xoxp-login-access",
          refresh_token: "xoxe-login-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          authed_user: {
            token_type: "user",
            scope: SLACK_SCOPES.join(","),
          },
        });
      },
      (init) => {
        assert.equal(init?.method, "GET");
        assert.equal(
          (init?.headers as Record<string, string>)?.Authorization,
          "Bearer xoxp-login-access",
        );
        return json({ ok: true, team_id: "TEXPECTED", user_id: "U123" });
      },
    ),
    openBrowser: async (url) => {
      authorizationUrl = url;
      const state = url.searchParams.get("state");
      const response = await fetch(`${SLACK_REDIRECT_URI}?code=temporary-code&state=${state}`);
      assert.equal(response.status, 200);
    },
  });

  const result = await auth.login(config.clientId);
  assert.equal(result.accessToken, "xoxp-login-access");
  assert.equal(store.writes, 1);
  assert.equal(clientIdStore.clientId, config.clientId);
  assert.equal(tokenBody?.get("resource"), SLACK_MCP_RESOURCE);
  assert.equal(tokenBody?.get("grant_type"), "authorization_code");
  assert.equal(tokenBody?.get("code"), "temporary-code");
  assert.ok(tokenBody?.get("code_verifier"));
  assert.equal(tokenBody?.has("client_secret"), false);
  assert.equal(authorizationUrl?.searchParams.get("resource"), SLACK_MCP_RESOURCE);
});

test("credential write failure never falls back or exposes OAuth values", async () => {
  const store = new MemoryCredentialStore();
  store.fail = "write";
  const auth = new SlackAuth({
    config,
    store,
    clientIdStore: new MemoryClientIdStore(),
    fetch: metadataFetch(() =>
      json({
        ok: true,
        access_token: "xoxp-must-not-escape",
        token_type: "user",
        scope: SLACK_SCOPES.join(","),
        authed_user: { id: "U123" },
        team: { id: "TEXPECTED" },
      }),
    ),
    openBrowser: async (url) => {
      const state = url.searchParams.get("state");
      await fetch(`${SLACK_REDIRECT_URI}?code=must-not-escape&state=${state}`);
    },
  });

  await assert.rejects(auth.login(), (error: Error) => {
    assert.equal(error.message, "The OS credential store could not write Slack credentials.");
    assert.doesNotMatch(error.message, /xoxp|must-not-escape/);
    return true;
  });
  assert.equal(store.credentials, undefined);
});

test("serialized refresh sends the resource and retains omitted verified fields", async () => {
  const now = 10_000;
  const store = new MemoryCredentialStore();
  store.credentials = { ...credentials, expiresAt: now - 1 };
  let tokenRequests = 0;
  let refreshBody: URLSearchParams | undefined;
  const auth = new SlackAuth({
    config: { ...config, clientId: "" },
    store,
    clientIdStore: new MemoryClientIdStore(),
    now: () => now,
    fetch: metadataFetch(async (body) => {
      tokenRequests++;
      refreshBody = body;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return json({
        ok: true,
        access_token: "xoxp-refreshed",
        refresh_token: "xoxe-replacement",
        expires_in: 3600,
        token_type: "user",
      });
    }),
  });

  const grants = await Promise.all([
    auth.getAccessGrant(),
    auth.getAccessGrant(),
    auth.getAccessGrant(),
  ]);
  assert.equal(tokenRequests, 1);
  assert.ok(grants.every((grant) => grant.accessToken === "xoxp-refreshed"));
  assert.equal(refreshBody?.get("resource"), SLACK_MCP_RESOURCE);
  assert.equal(refreshBody?.get("client_id"), credentials.clientId);
  assert.equal(refreshBody?.get("refresh_token"), "xoxe-refresh-value");
  assert.equal(store.credentials?.refreshToken, "xoxe-replacement");
  assert.deepEqual(store.credentials?.identity, credentials.identity);
  assert.deepEqual(store.credentials?.scopes, credentials.scopes);
});

test("stored credentials work without exporting the client ID again", async () => {
  const store = new MemoryCredentialStore();
  store.credentials = { ...credentials };
  const clientIdStore = new MemoryClientIdStore();
  const auth = new SlackAuth({
    config: { ...config, clientId: "" },
    store,
    clientIdStore,
  });

  const status = await auth.status();
  assert.equal(status.authenticated, true);
  assert.deepEqual(status.identity, credentials.identity);
  assert.equal(clientIdStore.clientId, credentials.clientId);
  assert.equal(store.deletes, 0);
});

test("an expired token is removed without forgetting the public client ID", async () => {
  const store = new MemoryCredentialStore();
  store.credentials = {
    ...credentials,
    refreshToken: undefined,
    expiresAt: 0,
  };
  const clientIdStore = new MemoryClientIdStore();
  clientIdStore.clientId = credentials.clientId;
  const auth = new SlackAuth({
    config: { ...config, clientId: "" },
    store,
    clientIdStore,
    now: () => 10_000,
  });

  await assert.rejects(auth.getAccessGrant(), /authentication expired/);
  assert.equal(store.credentials, undefined);
  assert.equal(clientIdStore.clientId, credentials.clientId);
  assert.equal(await auth.hasClientId(), true);
});

test("a transient refresh failure retains credentials for a later retry", async () => {
  const store = new MemoryCredentialStore();
  store.credentials = { ...credentials, expiresAt: 0 };
  const clientIdStore = new MemoryClientIdStore();
  clientIdStore.clientId = credentials.clientId;
  const auth = new SlackAuth({
    config: { ...config, clientId: "" },
    store,
    clientIdStore,
    now: () => 10_000,
    fetch: metadataFetch(() => json({ ok: false, error: "server_error" }, { status: 503 })),
  });

  await assert.rejects(auth.getAccessGrant(), /temporarily unavailable/);
  assert.deepEqual(store.credentials, { ...credentials, expiresAt: 0 });
  assert.equal(store.deletes, 0);
  assert.equal(clientIdStore.clientId, credentials.clientId);
});

test("an invalid refreshed token removes credentials without forgetting the client ID", async () => {
  const store = new MemoryCredentialStore();
  store.credentials = { ...credentials, expiresAt: 0 };
  const clientIdStore = new MemoryClientIdStore();
  clientIdStore.clientId = credentials.clientId;
  let invalidations = 0;
  const auth = new SlackAuth({
    config,
    store,
    clientIdStore,
    now: () => 10_000,
    onInvalidCredentials: () => {
      invalidations++;
    },
    fetch: metadataFetch(() =>
      json({
        ok: true,
        access_token: "xoxb-refreshed-bot",
        refresh_token: "xoxe-replacement",
        expires_in: 3600,
        token_type: "bot",
      }),
    ),
  });

  await assert.rejects(auth.getAccessGrant(), /verified user access token/);
  assert.equal(store.credentials, undefined);
  assert.equal(store.deletes, 1);
  assert.equal(clientIdStore.clientId, credentials.clientId);
  assert.equal(invalidations, 1);
});

test("stored credentials are bound to the configured OAuth client", async () => {
  const store = new MemoryCredentialStore();
  store.credentials = { ...credentials, clientId: "111.222" };
  let invalidations = 0;
  const auth = new SlackAuth({
    config,
    store,
    clientIdStore: new MemoryClientIdStore(),
    onInvalidCredentials: () => {
      invalidations++;
    },
  });

  await assert.rejects(auth.status(), /failed security validation/);
  assert.equal(store.credentials, undefined);
  assert.equal(store.deletes, 1);
  assert.equal(invalidations, 1);
});

test("invalid refresh scope removes prior credentials and closes the session", async () => {
  const store = new MemoryCredentialStore();
  store.credentials = { ...credentials, expiresAt: 0 };
  const clientIdStore = new MemoryClientIdStore();
  clientIdStore.clientId = credentials.clientId;
  let invalidations = 0;
  const auth = new SlackAuth({
    config,
    store,
    clientIdStore,
    now: () => 10_000,
    onInvalidCredentials: () => {
      invalidations++;
    },
    fetch: metadataFetch(() =>
      json({
        ok: true,
        access_token: "xoxp-refreshed",
        refresh_token: "xoxe-replacement",
        expires_in: 3600,
        token_type: "user",
        scope: [...SLACK_SCOPES, "channels:read"].join(","),
      }),
    ),
  });

  await assert.rejects(auth.getAccessGrant(), /unapproved OAuth scope set/);
  assert.equal(store.credentials, undefined);
  assert.equal(store.deletes, 1);
  assert.equal(clientIdStore.clientId, credentials.clientId);
  assert.equal(invalidations, 1);
});

test("fixed mappings cannot inject tool names, arbitrary fields, or file search", () => {
  assert.deepEqual(
    mapSearchArguments({ kind: "messages", query: " launch ", limit: 5, cursor: "next" }),
    { query: "launch", content_types: "messages", limit: 5, cursor: "next" },
  );
  assert.deepEqual(mapSearchArguments({ kind: "channels", query: "eng" }), {
    query: "eng",
    limit: 20,
  });
  assert.equal(mapSearchArguments({ kind: "messages", query: "launch", limit: 10_000 }).limit, 20);
  assert.deepEqual(mapReadChannelArguments({ channelId: "C123" }), {
    channel_id: "C123",
    limit: 50,
  });
  assert.deepEqual(mapReadThreadArguments({ channelId: "C123", threadTs: "1.2" }), {
    channel_id: "C123",
    message_ts: "1.2",
    limit: 50,
  });
});

test("approved tool verification rejects missing, writable, and incompatible tools", () => {
  assert.doesNotThrow(() =>
    verifyApprovedTools([
      ...approvedTools(),
      {
        name: "slack_send_message",
        annotations: { readOnlyHint: false },
        inputSchema: { type: "object" },
      },
    ]),
  );

  const missing = approvedTools().slice(1);
  assert.throws(() => verifyApprovedTools(missing), /unavailable/);

  const writable = structuredClone(approvedTools());
  writable[0]!.annotations!.readOnlyHint = false;
  assert.throws(() => verifyApprovedTools(writable), /not marked read-only/);

  const incompatible = structuredClone(approvedTools());
  incompatible[2]!.inputSchema.required = ["channel_id", "include_deleted"];
  assert.throws(() => verifyApprovedTools(incompatible), /unmapped argument/);
});

test("Slack initialize requests use the protocol version accepted by the hosted server", () => {
  const original = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {} },
  };
  const pinned = pinSlackProtocolVersion(original);
  assert.equal(pinned.params.protocolVersion, "2025-06-18");
  assert.equal(original.params.protocolVersion, "2025-11-25");
});

test("Slack tool errors explain when interactive authentication is required", async () => {
  const fakeAuth = {
    revision: 0,
    async getAccessGrant() {
      throw new Error("Slack is not authenticated. Run /slack-login in the TUI.");
    },
  } as unknown as SlackAuth;
  let connectionCreations = 0;
  const client = new SlackMcpClient({
    auth: fakeAuth,
    config,
    connectionFactory: () => {
      connectionCreations++;
      return new FakeConnection();
    },
  });

  await assert.rejects(
    client.call("readThread", { channel_id: "C1", message_ts: "1.2", limit: 1 }),
    /Run \/slack-login in the TUI/,
  );
  assert.equal(connectionCreations, 0);
});

test("parallel first calls initialize one client and dispatch only fixed names", async () => {
  const fakeAuth = {
    revision: 0,
    async getAccessGrant() {
      return { accessToken: credentials.accessToken, revision: 0 };
    },
    async forceRefresh() {
      throw new Error("not expected");
    },
  } as unknown as SlackAuth;
  const connection = new FakeConnection();
  let creations = 0;
  const client = new SlackMcpClient({
    auth: fakeAuth,
    config,
    connectionFactory: () => {
      creations++;
      return connection;
    },
  });
  assert.equal(creations, 0);

  await Promise.all([
    client.call("readChannel", { channel_id: "C1", limit: 1 }),
    client.call("readThread", { channel_id: "C1", message_ts: "1.2", limit: 1 }),
  ]);
  assert.equal(creations, 1);
  assert.equal(connection.connects, 1);
  assert.deepEqual(connection.calls.map((call) => call.name).sort(), [
    "slack_read_channel",
    "slack_read_thread",
  ]);
  await client.close();
  assert.ok(connection.terminates >= 1);
  assert.ok(connection.closes >= 1);
});

test("a stale MCP session reconnects at most once", async () => {
  const fakeAuth = {
    revision: 0,
    async getAccessGrant() {
      return { accessToken: credentials.accessToken, revision: 0 };
    },
  } as unknown as SlackAuth;
  const first = new FakeConnection();
  first.callTool = async () => {
    throw new Error("invalid session");
  };
  const second = new FakeConnection();
  const connections = [first, second];
  const client = new SlackMcpClient({
    auth: fakeAuth,
    config,
    connectionFactory: () => connections.shift()!,
  });

  const result = await client.call("readChannel", { channel_id: "C1", limit: 1 });
  assert.equal(result.content[0]?.type, "text");
  assert.equal(first.calls.length, 0);
  assert.equal(second.calls.length, 1);
  assert.equal(connections.length, 0);
});

test("tool cancellation reaches the MCP call and is reported without remote error content", async () => {
  const fakeAuth = {
    revision: 0,
    async getAccessGrant() {
      return { accessToken: credentials.accessToken, revision: 0 };
    },
  } as unknown as SlackAuth;
  const connection = new FakeConnection();
  connection.callTool = async (_name, _args, signal) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("remote secret error")), {
        once: true,
      });
    });
  const client = new SlackMcpClient({
    auth: fakeAuth,
    config,
    connectionFactory: () => connection,
  });
  const controller = new AbortController();
  const call = client.call("searchUsers", { query: "alice" }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(call, (error: Error) => {
    assert.equal(error.message, "Slack request was cancelled.");
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});

test("formatting bounds fields, redacts Slack tokens, and keeps details content-free", () => {
  const result = formatSlackResult("searchMessages", {
    content: [{ type: "text", text: "unused" }],
    structuredContent: {
      results: [
        {
          text: `secret xoxp-${"a".repeat(40)} xoxe.xoxp-1-${"b".repeat(40)} ${"x".repeat(10_000)}`,
        },
      ],
      next_cursor: "cursor-2",
      access_token: "xoxp-never-show",
    },
  });
  assert.match(result.text, /redacted Slack token/);
  assert.doesNotMatch(result.text, /xoxp-|xoxe\./);
  assert.match(result.text, /truncated/);
  assert.equal(result.details.count, 1);
  assert.equal(result.details.cursor, "cursor-2");
  assert.doesNotMatch(JSON.stringify(result.details), /secret|xoxp|results/);
});

test("extension registers only four fixed Slack tools and user-only commands", async () => {
  const tools: Array<Record<string, unknown>> = [];
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const events = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    registerTool(tool: Record<string, unknown>) {
      tools.push(tool);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, command);
    },
    on(name: string, handler: (...args: any[]) => unknown) {
      events.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  let browserCalls = 0;
  let connectionCreations = 0;
  registerSlackExtension(pi, {
    config,
    store: new MemoryCredentialStore(),
    openBrowser: async () => {
      browserCalls++;
    },
    connectionFactory: () => {
      connectionCreations++;
      return new FakeConnection();
    },
  });

  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "slack_read_channel",
    "slack_read_thread",
    "slack_search",
    "slack_search_users",
  ]);
  assert.deepEqual([...commands.keys()].sort(), [
    "slack-discover",
    "slack-login",
    "slack-logout",
    "slack-status",
  ]);
  assert.equal(
    tools.some((tool) => /mcp|script|write|send/i.test(String(tool.name))),
    false,
  );
  assert.equal(connectionCreations, 0);
  for (const tool of tools) {
    assert.equal(
      (tool.parameters as { additionalProperties?: boolean }).additionalProperties,
      false,
    );
  }

  const notifications: string[] = [];
  const context = {
    mode: "print",
    hasUI: false,
    isIdle: () => true,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  };
  await commands.get("slack-login")!.handler("", context);
  assert.equal(browserCalls, 0);
  assert.equal(connectionCreations, 0);
  assert.match(notifications[0]!, /only in TUI mode/);
});
