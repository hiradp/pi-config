export const SLACK_MCP_ENDPOINT = "https://mcp.slack.com/mcp";
export const SLACK_MCP_RESOURCE = "https://mcp.slack.com";
export const SLACK_OAUTH_ISSUER = "https://mcp.slack.com";
export const SLACK_AUTHORIZATION_ENDPOINT = "https://slack.com/oauth/v2_user/authorize";
export const SLACK_TOKEN_ENDPOINT = "https://slack.com/api/oauth.v2.user.access";
export const SLACK_REDIRECT_URI = "http://localhost:3118/callback";

const SLACK_CLIENT_ID_PATTERN = /^\d+(?:\.\d+)+$/;

export const SLACK_SCOPES = [
  "search:read.public",
  "search:read.private",
  "search:read.im",
  "search:read.mpim",
  "search:read.users",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "chat:write",
] as const;

export interface SlackIdentity {
  teamId: string;
  enterpriseId?: string;
  userId: string;
}

export interface SlackCredentials {
  clientId: string;
  tokenType: "user";
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes: string[];
  identity: SlackIdentity;
}

export interface SlackConfig {
  clientId: string;
  expectedTeamId?: string;
  expectedEnterpriseId?: string;
  loginTimeoutMs: number;
  requestTimeoutMs: number;
  refreshLeewayMs: number;
  maxRetryAfterMs: number;
  maxToolPages: number;
}

export interface AccessGrant {
  accessToken: string;
  revision: number;
}

export interface OAuthAuthorizationMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  response_types_supported?: unknown;
  grant_types_supported?: unknown;
  code_challenge_methods_supported?: unknown;
  scopes_supported?: unknown;
}

export interface OAuthProtectedResourceMetadata {
  resource: string;
  authorization_servers?: unknown;
  scopes_supported?: unknown;
}

export interface SlackToolMetadata {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, object>;
    required?: string[];
    [key: string]: unknown;
  };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface SlackCallResult {
  content: Array<
    | { type: "text"; text: string; [key: string]: unknown }
    | { type: string; [key: string]: unknown }
  >;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

export function loadSlackConfig(environment: NodeJS.ProcessEnv = process.env): SlackConfig {
  const clientId = environment.SLACK_MCP_CLIENT_ID?.trim() ?? "";
  if (clientId && !isValidSlackClientId(clientId)) {
    throw new Error("SLACK_MCP_CLIENT_ID is not a valid Slack client ID.");
  }

  const expectedTeamId = optionalId(environment.SLACK_MCP_EXPECTED_TEAM_ID, /^T[A-Z0-9]+$/);
  const expectedEnterpriseId = optionalId(
    environment.SLACK_MCP_EXPECTED_ENTERPRISE_ID,
    /^E[A-Z0-9]+$/,
  );

  return {
    clientId,
    expectedTeamId,
    expectedEnterpriseId,
    loginTimeoutMs: 3 * 60_000,
    requestTimeoutMs: 20_000,
    refreshLeewayMs: 60_000,
    maxRetryAfterMs: 5_000,
    maxToolPages: 10,
  };
}

export function isValidSlackClientId(value: string): boolean {
  return SLACK_CLIENT_ID_PATTERN.test(value);
}

function optionalId(value: string | undefined, pattern: RegExp): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!pattern.test(trimmed)) throw new Error("A configured Slack identity ID is invalid.");
  return trimmed;
}
