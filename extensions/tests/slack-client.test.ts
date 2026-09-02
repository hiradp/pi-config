import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SlackHttpError, SlackMcpClient, type McpConnection } from "../slack/client.ts";
import { MemoryClientIdStore, type CredentialStore } from "../slack/credentials.ts";
import { formatSlackResult } from "../slack/format.ts";
import { registerSlackExtension } from "../slack/index.ts";
import type { SlackAuth } from "../slack/oauth.ts";
import { APPROVED_SLACK_TOOLS } from "../slack/tools.ts";
import type { SlackCallResult, SlackConfig, SlackToolMetadata } from "../slack/types.ts";

const config: SlackConfig = {
  clientId: "123456789.987654321",
  expectedTeamId: "TEXPECTED",
  loginTimeoutMs: 2_000,
  requestTimeoutMs: 2_000,
  refreshLeewayMs: 60_000,
  maxRetryAfterMs: 50,
  maxToolPages: 3,
};

function approvedTools(): SlackToolMetadata[] {
  return Object.values(APPROVED_SLACK_TOOLS).map((contract) => ({
    name: contract.name,
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(contract.fields).map(([field, type]) => [field, { type }]),
      ),
    },
  }));
}

class FakeConnection implements McpConnection {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  terminates = 0;
  closes = 0;
  result: SlackCallResult = { content: [{ type: "text", text: "ok" }] };

  async connect(): Promise<void> {}

  async listTools(): Promise<{ tools: SlackToolMetadata[] }> {
    return { tools: approvedTools() };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<SlackCallResult> {
    this.calls.push({ name, args });
    return this.result;
  }

  async terminate(): Promise<void> {
    this.terminates++;
  }

  async close(): Promise<void> {
    this.closes++;
  }
}

/** Auth whose access token is derived from its revision, like a real refresh would rotate it. */
function revisionAuth() {
  return {
    revision: 0,
    forceRefreshes: 0,
    async getAccessGrant() {
      return { accessToken: `token-${this.revision}`, revision: this.revision };
    },
    async forceRefresh() {
      this.forceRefreshes++;
      this.revision++;
      return { accessToken: `token-${this.revision}`, revision: this.revision };
    },
  };
}

function clientFor(
  auth: ReturnType<typeof revisionAuth>,
  connections: FakeConnection[],
  tokens: string[] = [],
): SlackMcpClient {
  return new SlackMcpClient({
    auth: auth as unknown as SlackAuth,
    config,
    connectionFactory: (accessToken) => {
      tokens.push(accessToken);
      return connections.shift()!;
    },
  });
}

test("a 401 after a concurrent refresh reconnects without spending another refresh token", async () => {
  const auth = revisionAuth();
  const first = new FakeConnection();
  first.callTool = async () => {
    auth.revision = 1;
    throw new SlackHttpError(401);
  };
  const second = new FakeConnection();
  const tokens: string[] = [];
  const client = clientFor(auth, [first, second], tokens);

  const result = await client.call("readChannel", { channel_id: "C1", limit: 1 });

  assert.equal(result.content[0]?.type, "text");
  assert.equal(auth.forceRefreshes, 0);
  assert.deepEqual(tokens, ["token-0", "token-1"]);
  assert.equal(second.calls.length, 1);
});

test("a 401 with an unchanged revision refreshes once and reconnects", async () => {
  const auth = revisionAuth();
  const first = new FakeConnection();
  first.callTool = async () => {
    throw new SlackHttpError(401);
  };
  const second = new FakeConnection();
  const tokens: string[] = [];
  const client = clientFor(auth, [first, second], tokens);

  await client.call("readChannel", { channel_id: "C1", limit: 1 });

  assert.equal(auth.forceRefreshes, 1);
  assert.deepEqual(tokens, ["token-0", "token-1"]);
  assert.equal(second.calls.length, 1);
});

test(
  "closing a connection does not wait forever for session termination",
  { timeout: 2_000 },
  async (t) => {
    const connection = new FakeConnection();
    connection.terminate = () => new Promise(() => {});
    const client = clientFor(revisionAuth(), [connection]);
    await client.call("readChannel", { channel_id: "C1", limit: 1 });

    t.mock.timers.enable({ apis: ["setTimeout"] });
    const closing = client.close();
    t.mock.timers.tick(60_000);
    await closing;

    assert.equal(connection.closes, 1);
  },
);

test("app, session, and cookie tokens are redacted from results and errors", async () => {
  const leaked = "xapp-1-A0123-456-abcdef xoxc-1234-abcd xoxd-abcd1234";
  const result = formatSlackResult("searchMessages", {
    content: [{ type: "text", text: leaked }],
  });
  assert.doesNotMatch(result.text, /xapp-|xoxc-|xoxd-/);
  assert.match(result.text, /redacted Slack token/);

  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const pi = {
    registerTool() {},
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, command);
    },
    on() {},
  } as unknown as ExtensionAPI;
  const store: CredentialStore = {
    async load() {
      throw new Error(`Slack keyring failed: ${leaked}`);
    },
    async save() {},
    async delete() {},
  };
  registerSlackExtension(pi, { config, store, clientIdStore: new MemoryClientIdStore() });
  const notifications: string[] = [];
  await commands.get("slack-status")!.handler("", {
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  });

  assert.equal(notifications.length, 1);
  assert.doesNotMatch(notifications[0]!, /xapp-|xoxc-|xoxd-/);
  assert.match(notifications[0]!, /redacted Slack token/);
});
