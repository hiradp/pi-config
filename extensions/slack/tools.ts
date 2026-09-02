import type {
  SlackReadChannelInput,
  SlackReadThreadInput,
  SlackSearchInput,
  SlackSearchUsersInput,
} from "./schemas.ts";
import type { SlackToolMetadata } from "./types.ts";

export type SlackOperation =
  | "searchMessages"
  | "searchChannels"
  | "readChannel"
  | "readThread"
  | "searchUsers";

interface ToolContract {
  name: string;
  fields: Record<string, "string" | "integer">;
  mappedFields: ReadonlySet<string>;
  fixedString?: { field: string; value: string };
}

export const APPROVED_SLACK_TOOLS: Readonly<Record<SlackOperation, ToolContract>> = {
  searchMessages: {
    name: "slack_search_public_and_private",
    fields: {
      query: "string",
      content_types: "string",
      limit: "integer",
      cursor: "string",
    },
    mappedFields: new Set(["query", "content_types", "limit", "cursor"]),
    fixedString: { field: "content_types", value: "messages" },
  },
  searchChannels: {
    name: "slack_search_channels",
    fields: { query: "string", limit: "integer", cursor: "string" },
    mappedFields: new Set(["query", "limit", "cursor"]),
  },
  readChannel: {
    name: "slack_read_channel",
    fields: { channel_id: "string", limit: "integer", cursor: "string" },
    mappedFields: new Set(["channel_id", "limit", "cursor"]),
  },
  readThread: {
    name: "slack_read_thread",
    fields: { channel_id: "string", message_ts: "string", limit: "integer", cursor: "string" },
    mappedFields: new Set(["channel_id", "message_ts", "limit", "cursor"]),
  },
  searchUsers: {
    name: "slack_search_users",
    fields: { query: "string", limit: "integer", cursor: "string" },
    mappedFields: new Set(["query", "limit", "cursor"]),
  },
};

export function operationForSearch(input: SlackSearchInput): SlackOperation {
  return input.kind === "messages" ? "searchMessages" : "searchChannels";
}

export function mapSearchArguments(input: SlackSearchInput): Record<string, unknown> {
  const common = {
    query: input.query.trim().slice(0, 1_000),
    limit: boundedLimit(input.limit, 20, 20),
    ...(input.cursor ? { cursor: input.cursor.slice(0, 2_000) } : {}),
  };
  return input.kind === "messages" ? { ...common, content_types: "messages" } : common;
}

export function mapReadChannelArguments(input: SlackReadChannelInput): Record<string, unknown> {
  return {
    channel_id: input.channelId.slice(0, 64),
    limit: boundedLimit(input.limit, 50, 100),
    ...(input.cursor ? { cursor: input.cursor.slice(0, 2_000) } : {}),
  };
}

export function mapReadThreadArguments(input: SlackReadThreadInput): Record<string, unknown> {
  return {
    channel_id: input.channelId.slice(0, 64),
    message_ts: input.threadTs.slice(0, 41),
    limit: boundedLimit(input.limit, 50, 100),
    ...(input.cursor ? { cursor: input.cursor.slice(0, 2_000) } : {}),
  };
}

export function mapSearchUsersArguments(input: SlackSearchUsersInput): Record<string, unknown> {
  return {
    query: input.query.trim().slice(0, 320),
    limit: boundedLimit(input.limit, 20, 20),
    ...(input.cursor ? { cursor: input.cursor.slice(0, 2_000) } : {}),
  };
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.max(1, Math.min(maximum, value!));
}

export function verifyApprovedTools(tools: SlackToolMetadata[]): void {
  for (const [operation, contract] of Object.entries(APPROVED_SLACK_TOOLS) as Array<
    [SlackOperation, ToolContract]
  >) {
    const matches = tools.filter((tool) => tool.name === contract.name);
    if (matches.length === 0) {
      throw new Error(`Slack's approved ${operation} tool is unavailable.`);
    }
    if (matches.length !== 1) {
      throw new Error(`Slack's approved ${operation} tool name is ambiguous.`);
    }
    verifyToolContract(operation, contract, matches[0]!);
  }
}

function verifyToolContract(
  operation: SlackOperation,
  contract: ToolContract,
  tool: SlackToolMetadata,
): void {
  if (tool.annotations?.readOnlyHint !== true) {
    throw new Error(`Slack's approved ${operation} tool is not marked read-only.`);
  }
  if (!tool.inputSchema || tool.inputSchema.type !== "object") {
    throw new Error(`Slack's approved ${operation} tool has an incompatible schema.`);
  }
  const properties = tool.inputSchema.properties ?? {};
  for (const [field, expectedType] of Object.entries(contract.fields)) {
    const schema = properties[field];
    if (!schemaAcceptsType(schema, expectedType)) {
      throw new Error(`Slack's approved ${operation} tool has an incompatible schema.`);
    }
  }
  for (const required of tool.inputSchema.required ?? []) {
    if (!contract.mappedFields.has(required)) {
      throw new Error(`Slack's approved ${operation} tool requires an unmapped argument.`);
    }
  }
  if (contract.fixedString) {
    const schema = properties[contract.fixedString.field];
    if (!stringSchemaAllowsValue(schema, contract.fixedString.value)) {
      throw new Error(`Slack's approved ${operation} tool no longer accepts message-only search.`);
    }
  }
}

function schemaAcceptsType(schema: object | undefined, expected: "string" | "integer"): boolean {
  if (!schema) return false;
  const value = schema as Record<string, unknown>;
  if (expected === "integer") return value.type === "integer" || value.type === "number";
  return value.type === "string" || stringOptions(value).length > 0;
}

function stringSchemaAllowsValue(schema: object | undefined, expected: string): boolean {
  if (!schema) return false;
  const value = schema as Record<string, unknown>;
  const options = stringOptions(value);
  return value.type === "string" && options.length === 0 ? true : options.includes(expected);
}

function stringOptions(schema: Record<string, unknown>): string[] {
  if (Array.isArray(schema.enum)) {
    return schema.enum.filter((value): value is string => typeof value === "string");
  }
  if (typeof schema.const === "string") return [schema.const];
  return [];
}
