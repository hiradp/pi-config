import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { SlackMcpClient, type McpConnectionFactory } from "./client.ts";
import { OsCredentialStore, type CredentialStore } from "./credentials.ts";
import { formatSlackResult } from "./format.ts";
import { SlackAuth, type BrowserOpener } from "./oauth.ts";
import {
  SlackReadChannelParams,
  SlackReadThreadParams,
  SlackSearchParams,
  SlackSearchUsersParams,
  type SlackReadChannelInput,
  type SlackReadThreadInput,
  type SlackSearchInput,
  type SlackSearchUsersInput,
} from "./schemas.ts";
import {
  mapReadChannelArguments,
  mapReadThreadArguments,
  mapSearchArguments,
  mapSearchUsersArguments,
  operationForSearch,
  type SlackOperation,
} from "./tools.ts";
import { loadSlackConfig, type SlackConfig, type SlackToolMetadata } from "./types.ts";

export interface SlackExtensionOptions {
  config?: SlackConfig;
  store?: CredentialStore;
  fetch?: typeof fetch;
  openBrowser?: BrowserOpener;
  connectionFactory?: McpConnectionFactory;
  now?: () => number;
}

export function registerSlackExtension(
  pi: ExtensionAPI,
  options: SlackExtensionOptions = {},
): void {
  const config = options.config ?? loadSlackConfig();
  const store = options.store ?? new OsCredentialStore();
  let client: SlackMcpClient;
  const auth = new SlackAuth({
    config,
    store,
    fetch: options.fetch,
    openBrowser: options.openBrowser,
    now: options.now,
    onInvalidCredentials: () => client?.close(),
  });
  client = new SlackMcpClient({
    auth,
    config,
    connectionFactory: options.connectionFactory,
    fetch: options.fetch,
  });

  registerCommands(pi, auth, client);
  registerTools(pi, client);

  pi.on("session_shutdown", async () => {
    await auth.shutdown();
    await client.close();
  });
}

function registerCommands(pi: ExtensionAPI, auth: SlackAuth, client: SlackMcpClient): void {
  pi.registerCommand("slack-login", {
    description: "Authenticate the read-only Slack MCP extension",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Slack login is available only in TUI mode.", "error");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait until Pi is idle before starting Slack login.", "error");
        return;
      }
      try {
        const existing = await auth.status();
        if (existing.authenticated) {
          ctx.ui.notify("Slack is already authenticated. Run /slack-logout first.", "error");
          return;
        }
        const credentials = await auth.login();
        ctx.ui.notify(
          `Authenticated Slack user ${credentials.identity.userId} in team ${credentials.identity.teamId}.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(safeMessage(error, "Slack login failed."), "error");
      }
    },
  });

  pi.registerCommand("slack-status", {
    description: "Show local Slack authentication status",
    handler: async (_args, ctx) => {
      try {
        const status = await auth.status();
        if (!status.authenticated || !status.identity || !status.scopes) {
          ctx.ui.notify("Slack is not authenticated.", "info");
          return;
        }
        const expiry = status.expiresAt
          ? new Date(status.expiresAt).toLocaleString()
          : "non-expiring access token";
        const enterprise = status.identity.enterpriseId
          ? `; enterprise ${status.identity.enterpriseId}`
          : "";
        ctx.ui.notify(
          `Slack authenticated: team ${status.identity.teamId}${enterprise}; user ${status.identity.userId}; expires ${expiry}; scopes ${status.scopes.join(", ")}.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(safeMessage(error, "Slack status could not be read."), "error");
      }
    },
  });

  pi.registerCommand("slack-logout", {
    description: "Disconnect Slack locally and remove stored credentials",
    handler: async (_args, ctx) => {
      try {
        await client.close();
        const removed = await auth.logout();
        ctx.ui.notify(
          removed
            ? "Slack credentials were removed locally. The Slack grant was not revoked."
            : "Slack was not authenticated.",
          "info",
        );
      } catch (error) {
        ctx.ui.notify(safeMessage(error, "Slack logout failed."), "error");
      }
    },
  });

  pi.registerCommand("slack-discover", {
    description: "Inspect sanitized Slack MCP tool metadata for development review",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Slack discovery requires an interactive UI.", "error");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait until Pi is idle before discovering Slack tools.", "error");
        return;
      }
      try {
        const tools = await client.discover();
        const output = formatDiscovery(tools);
        await ctx.ui.editor("Sanitized Slack MCP tool metadata", output);
      } catch (error) {
        ctx.ui.notify(safeMessage(error, "Slack tool discovery failed."), "error");
      }
    },
  });
}

function registerTools(pi: ExtensionAPI, client: SlackMcpClient): void {
  const descriptionSuffix = [
    "Uses only Slack's official hosted MCP server and never mutates Slack.",
    `Output is truncated at ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    "Slack output is sent to the selected model provider and may be stored in the Pi session.",
  ].join("\n");

  pi.registerTool({
    name: "slack_search",
    label: "Slack Search",
    description: `Search user-visible Slack messages or channels.\n${descriptionSuffix}`,
    promptSnippet: "Search Slack messages and channels (read-only)",
    promptGuidelines: [
      "Use slack_search only for read-only searches of Slack messages or channels.",
    ],
    parameters: SlackSearchParams,
    async execute(_toolCallId, input: SlackSearchInput, signal) {
      if (!input.query.trim()) throw new Error("Slack search query cannot be empty.");
      const operation = operationForSearch(input);
      return executeRead(client, operation, mapSearchArguments(input), signal);
    },
  });

  pi.registerTool({
    name: "slack_read_channel",
    label: "Slack Read Channel",
    description: `Read a bounded page of Slack channel, private-channel, DM, or MPIM history.\n${descriptionSuffix}`,
    promptSnippet: "Read Slack conversation history (read-only)",
    promptGuidelines: [
      "Use slack_read_channel to read bounded Slack conversation history without changing Slack.",
    ],
    parameters: SlackReadChannelParams,
    async execute(_toolCallId, input: SlackReadChannelInput, signal) {
      return executeRead(client, "readChannel", mapReadChannelArguments(input), signal);
    },
  });

  pi.registerTool({
    name: "slack_read_thread",
    label: "Slack Read Thread",
    description: `Read a bounded Slack message thread.\n${descriptionSuffix}`,
    promptSnippet: "Read a Slack thread (read-only)",
    promptGuidelines: [
      "Use slack_read_thread to read a bounded Slack thread without changing Slack.",
    ],
    parameters: SlackReadThreadParams,
    async execute(_toolCallId, input: SlackReadThreadInput, signal) {
      return executeRead(client, "readThread", mapReadThreadArguments(input), signal);
    },
  });

  pi.registerTool({
    name: "slack_search_users",
    label: "Slack Search Users",
    description: `Search Slack users by name, email, or user ID.\n${descriptionSuffix}`,
    promptSnippet: "Search Slack users (read-only)",
    promptGuidelines: ["Use slack_search_users only for read-only Slack user lookup."],
    parameters: SlackSearchUsersParams,
    async execute(_toolCallId, input: SlackSearchUsersInput, signal) {
      if (!input.query.trim()) throw new Error("Slack user search query cannot be empty.");
      return executeRead(client, "searchUsers", mapSearchUsersArguments(input), signal);
    },
  });
}

async function executeRead(
  client: SlackMcpClient,
  operation: SlackOperation,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const result = await client.call(operation, args, signal);
  const formatted = formatSlackResult(operation, result);
  return {
    content: [{ type: "text" as const, text: formatted.text }],
    details: formatted.details,
  };
}

function formatDiscovery(tools: SlackToolMetadata[]): string {
  const sanitized = tools.map((tool) => ({
    name: tool.name.slice(0, 200),
    annotations: tool.annotations
      ? {
          readOnlyHint: tool.annotations.readOnlyHint === true,
          destructiveHint: tool.annotations.destructiveHint === true,
          idempotentHint: tool.annotations.idempotentHint === true,
          openWorldHint: tool.annotations.openWorldHint === true,
        }
      : undefined,
    inputSchema: tool.inputSchema,
  }));
  const truncation = truncateHead(JSON.stringify(sanitized, null, 2), {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  return truncation.truncated
    ? `${truncation.content}\n\n[Discovery output truncated; ${tools.length} tools were advertised.]`
    : truncation.content;
}

function safeMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return error.message
    .replace(/\b(?:xoxe\.xox[abp]|xox[abeprs])-[A-Za-z0-9-]+\b/g, "[redacted Slack token]")
    .slice(0, 500);
}

export default function (pi: ExtensionAPI): void {
  registerSlackExtension(pi);
}
