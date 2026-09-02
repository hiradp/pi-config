import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { isIP } from "node:net";
import type { ClientIdStore, CredentialStore } from "./credentials.ts";
import {
  SLACK_AUTHORIZATION_ENDPOINT,
  SLACK_MCP_RESOURCE,
  SLACK_OAUTH_ISSUER,
  SLACK_REDIRECT_URI,
  SLACK_SCOPES,
  SLACK_TOKEN_ENDPOINT,
  type AccessGrant,
  type OAuthAuthorizationMetadata,
  type OAuthProtectedResourceMetadata,
  type SlackConfig,
  type SlackCredentials,
  type SlackIdentity,
  isValidSlackClientId,
} from "./types.ts";

const AUTHORIZATION_METADATA_URL = `${SLACK_OAUTH_ISSUER}/.well-known/oauth-authorization-server`;
const RESOURCE_METADATA_URL = `${SLACK_MCP_RESOURCE}/.well-known/oauth-protected-resource`;
const MAX_OAUTH_RESPONSE_BYTES = 100_000;
const SLACK_AUTH_TEST_ENDPOINT = "https://slack.com/api/auth.test";
/**
 * Token-endpoint errors after which the grant or refresh token is unusable. Slack reports service
 * failures such as internal_error as HTTP 200 with ok:false, so every other error is transient.
 */
const TERMINAL_TOKEN_ERRORS = new Set([
  "invalid_refresh_token",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "invalid_grant",
  "invalid_grant_type",
  "invalid_code",
  "invalid_client",
  "invalid_client_id",
  "bad_client_secret",
  "unauthorized_client",
  "bad_redirect_uri",
  "oauth_authorization_url_mismatch",
  "invalid_scope",
  "access_denied",
]);

export type BrowserOpener = (url: URL) => Promise<void>;

interface OAuthMetadata {
  authorization: OAuthAuthorizationMetadata;
  resource: OAuthProtectedResourceMetadata;
}

interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scopes?: string[];
  identity?: Partial<SlackIdentity>;
  tokenType?: unknown;
}

class SlackTokenRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackTokenRejectedError";
  }
}

class SlackTokenValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackTokenValidationError";
  }
}

export interface SlackAuthOptions {
  config: SlackConfig;
  store: CredentialStore;
  clientIdStore: ClientIdStore;
  fetch?: typeof fetch;
  openBrowser?: BrowserOpener;
  now?: () => number;
  onInvalidCredentials?: () => void | Promise<void>;
}

export interface SlackAuthStatus {
  authenticated: boolean;
  expiresAt?: number;
  scopes?: string[];
  identity?: SlackIdentity;
}

class SerialLock {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class SlackAuth {
  private readonly config: SlackConfig;
  private readonly store: CredentialStore;
  private readonly clientIdStore: ClientIdStore;
  private readonly fetchImpl: typeof fetch;
  private readonly browser: BrowserOpener;
  private readonly now: () => number;
  private readonly onInvalidCredentials?: () => void | Promise<void>;
  private readonly transitionLock = new SerialLock();
  private credentials?: SlackCredentials;
  private loaded = false;
  private loadFlight?: Promise<SlackCredentials | undefined>;
  private refreshFlight?: Promise<SlackCredentials>;
  private metadata?: OAuthMetadata;
  private loginController?: AbortController;
  private loginSettled?: Promise<void>;
  private revisionValue = 0;
  private generation = 0;

  constructor(options: SlackAuthOptions) {
    this.config = options.config;
    this.store = options.store;
    this.clientIdStore = options.clientIdStore;
    this.fetchImpl = options.fetch ?? fetch;
    this.browser = options.openBrowser ?? openBrowser;
    this.now = options.now ?? Date.now;
    this.onInvalidCredentials = options.onInvalidCredentials;
  }

  get revision(): number {
    return this.revisionValue;
  }

  get loginActive(): boolean {
    return this.loginController !== undefined;
  }

  async hasClientId(): Promise<boolean> {
    return (await this.configuredClientId()) !== undefined;
  }

  async status(): Promise<SlackAuthStatus> {
    const credentials = await this.load();
    return credentials
      ? {
          authenticated: true,
          expiresAt: credentials.expiresAt,
          scopes: [...credentials.scopes],
          identity: { ...credentials.identity },
        }
      : { authenticated: false };
  }

  async login(providedClientId?: string): Promise<SlackCredentials> {
    if (this.loginController) throw new Error("A Slack login is already in progress.");

    const controller = new AbortController();
    const deadline = AbortSignal.timeout(this.config.loginTimeoutMs);
    const flowSignal = AbortSignal.any([controller.signal, deadline]);
    const loginGeneration = this.generation;
    let credentialWriteAttempted = false;
    let markSettled!: () => void;
    this.loginSettled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    this.loginController = controller;
    try {
      if (await this.load()) {
        throw new Error("Slack is already authenticated. Run /slack-logout first.");
      }
      const loginConfig = await this.configForLogin(providedClientId);
      flowSignal.throwIfAborted();
      const metadata = await discoverOAuthMetadata(this.fetchImpl, flowSignal);
      this.metadata = metadata;
      const verifier = createPkceVerifier();
      const challenge = createPkceChallenge(verifier);
      const state = randomBytes(32).toString("base64url");
      const authorizationUrl = createAuthorizationUrl(
        metadata.authorization,
        loginConfig,
        state,
        challenge,
      );
      const code = await receiveAuthorizationCode({
        authorizationUrl,
        expectedState: state,
        timeoutMs: this.config.loginTimeoutMs,
        signal: flowSignal,
        openBrowser: this.browser,
      });
      const token = await exchangeAuthorizationCode(
        this.fetchImpl,
        metadata.authorization,
        loginConfig,
        code,
        verifier,
        flowSignal,
      );
      const credentials = validateInitialToken(token, loginConfig, this.now());

      await this.transitionLock.run(async () => {
        if (flowSignal.aborted || loginGeneration !== this.generation) {
          throw new Error(
            deadline.aborted ? "Slack login timed out." : "Slack login was cancelled.",
          );
        }
        await this.clientIdStore.save(credentials.clientId);
        credentialWriteAttempted = true;
        await this.store.save(credentials);
        if (flowSignal.aborted || loginGeneration !== this.generation) {
          await this.store.delete();
          throw new Error(
            deadline.aborted ? "Slack login timed out." : "Slack login was cancelled.",
          );
        }
        this.credentials = credentials;
        this.loaded = true;
        this.revisionValue++;
      });
      return structuredClone(credentials);
    } catch (error) {
      if (credentialWriteAttempted && !this.credentials) {
        try {
          await this.store.delete();
        } catch {}
      }
      if (controller.signal.aborted) throw new Error("Slack login was cancelled.");
      if (deadline.aborted) throw new Error("Slack login timed out.");
      if (isSafeOAuthError(error)) throw error;
      throw new Error("Slack login failed before credentials could be stored.");
    } finally {
      markSettled();
      if (this.loginController === controller) {
        this.loginController = undefined;
        this.loginSettled = undefined;
      }
    }
  }

  async getAccessGrant(signal?: AbortSignal): Promise<AccessGrant> {
    signal?.throwIfAborted();
    let credentials = await this.load();
    if (!credentials) throw new Error("Slack is not authenticated. Run /slack-login in the TUI.");
    if (this.isExpiring(credentials)) credentials = await this.refresh(credentials, signal);
    signal?.throwIfAborted();
    return { accessToken: credentials.accessToken, revision: this.revisionValue };
  }

  async forceRefresh(signal?: AbortSignal): Promise<AccessGrant> {
    signal?.throwIfAborted();
    const credentials = await this.load();
    if (!credentials) throw new Error("Slack is not authenticated. Run /slack-login in the TUI.");
    const refreshed = await this.refresh(credentials, signal, true);
    return { accessToken: refreshed.accessToken, revision: this.revisionValue };
  }

  async logout(): Promise<boolean> {
    this.generation++;
    this.loginController?.abort();
    await this.loginSettled;
    const credentials = await this.load();
    return this.transitionLock.run(async () => {
      this.credentials = undefined;
      this.loaded = true;
      this.revisionValue++;
      if (!credentials) return false;
      await this.onInvalidCredentials?.();
      await this.store.delete();
      return true;
    });
  }

  async shutdown(): Promise<void> {
    if (this.loginController) {
      this.generation++;
      this.loginController.abort();
      await this.loginSettled;
      return;
    }
    try {
      await this.refreshFlight;
    } catch {}
    this.generation++;
  }

  private async load(): Promise<SlackCredentials | undefined> {
    if (this.loaded) return this.credentials;
    this.loadFlight ??= this.store
      .load()
      .then(async (credentials) => {
        if (credentials) {
          const storedClientId = await this.clientIdStore.load();
          const configuredClientId = this.config.clientId || storedClientId;
          const validationConfig = configuredClientId
            ? { ...this.config, clientId: configuredClientId }
            : this.config;
          try {
            validateStoredCredentials(credentials, validationConfig);
          } catch {
            await this.invalidate();
            throw new Error("Stored Slack credentials failed security validation.");
          }
          if (!storedClientId) await this.clientIdStore.save(credentials.clientId);
        }
        this.credentials = credentials;
        this.loaded = true;
        return credentials;
      })
      .finally(() => {
        this.loadFlight = undefined;
      });
    return this.loadFlight;
  }

  private async configuredClientId(): Promise<string | undefined> {
    return this.config.clientId || (await this.clientIdStore.load());
  }

  private async configForLogin(providedClientId?: string): Promise<SlackConfig> {
    const provided = providedClientId?.trim();
    if (provided && !isValidSlackClientId(provided)) {
      throw new Error("Slack client ID is invalid.");
    }
    if (provided && this.config.clientId && provided !== this.config.clientId) {
      throw new Error("Slack client ID does not match SLACK_MCP_CLIENT_ID.");
    }
    const clientId = this.config.clientId || provided || (await this.clientIdStore.load());
    if (!clientId) {
      throw new Error("Enter the organization's public Slack app client ID.");
    }
    return { ...this.config, clientId };
  }

  private async configForStoredCredentials(credentials: SlackCredentials): Promise<SlackConfig> {
    const clientId = (await this.configuredClientId()) ?? credentials.clientId;
    return { ...this.config, clientId };
  }

  private async refresh(
    current: SlackCredentials,
    signal?: AbortSignal,
    force = false,
  ): Promise<SlackCredentials> {
    if (!force && current.expiresAt === undefined) return current;
    if (!current.refreshToken) {
      if (force && !this.isExpiring(current)) {
        throw new Error(
          "Slack rejected the stored access token. Run /slack-logout and /slack-login if it persists.",
        );
      }
      await this.invalidate();
      throw new Error("Slack authentication expired. Run /slack-login again.");
    }
    // One flight serves every concurrent caller; a caller's abort only detaches that caller.
    this.refreshFlight ??= this.runRefresh(current).finally(() => {
      this.refreshFlight = undefined;
    });
    return awaitWithSignal(this.refreshFlight, signal);
  }

  private async runRefresh(current: SlackCredentials): Promise<SlackCredentials> {
    const refreshGeneration = this.generation;
    // Slack refresh tokens are single-use, and another Pi process sharing the credential store
    // may have rotated them already; adopt its result instead of repeating the refresh.
    const stored = await this.store.load();
    if (stored?.refreshToken !== current.refreshToken) {
      await this.adopt(stored);
      if (!stored) throw new Error("Slack is not authenticated. Run /slack-login in the TUI.");
      if (!stored.refreshToken || !this.isExpiring(stored)) return stored;
      current = stored;
    }

    const requestSignal = AbortSignal.timeout(this.config.requestTimeoutMs);
    let terminal = false;
    try {
      const metadata = await this.oauthMetadata(requestSignal);
      const effectiveConfig = await this.configForStoredCredentials(current);
      let token: TokenResponse;
      try {
        token = await refreshAccessToken(
          this.fetchImpl,
          metadata.authorization,
          effectiveConfig,
          current.refreshToken!,
          requestSignal,
        );
      } catch (error) {
        terminal =
          error instanceof SlackTokenRejectedError || error instanceof SlackTokenValidationError;
        throw error;
      }
      // Slack has consumed the refresh token; a failure from here leaves the stored one unusable.
      terminal = true;
      const refreshed = validateRefreshedToken(token, current, effectiveConfig, this.now());
      await this.transitionLock.run(async () => {
        if (refreshGeneration !== this.generation) {
          throw new Error("Slack authentication changed while refreshing.");
        }
        await this.store.save(refreshed);
        if (refreshGeneration !== this.generation) {
          await this.store.delete();
          throw new Error("Slack authentication changed while refreshing.");
        }
        this.credentials = refreshed;
        this.loaded = true;
        this.revisionValue++;
      });
      return refreshed;
    } catch (error) {
      if (refreshGeneration !== this.generation) {
        throw new Error("Slack authentication changed while refreshing.");
      }
      if (terminal) {
        const rotated = await this.invalidateUnlessRotated(current);
        if (rotated) return rotated;
      }
      if (isSafeOAuthError(error)) throw error;
      throw new Error(
        terminal
          ? "Slack credentials could not be refreshed and were removed."
          : "Slack credentials could not be refreshed. Retry later.",
      );
    }
  }

  /** The token endpoint is pinned, so refreshes reuse metadata discovered earlier in this process. */
  private async oauthMetadata(signal: AbortSignal): Promise<OAuthMetadata> {
    this.metadata ??= await discoverOAuthMetadata(this.fetchImpl, signal);
    return this.metadata;
  }

  private isExpiring(credentials: SlackCredentials): boolean {
    return (
      credentials.expiresAt !== undefined &&
      credentials.expiresAt - this.now() <= this.config.refreshLeewayMs
    );
  }

  /** Replaces the cached credentials with whatever another Pi process left in the store. */
  private async adopt(stored: SlackCredentials | undefined): Promise<void> {
    if (stored) {
      try {
        validateStoredCredentials(stored, await this.configForStoredCredentials(stored));
      } catch {
        await this.invalidate();
        throw new Error("Stored Slack credentials failed security validation.");
      }
    }
    await this.transitionLock.run(async () => {
      this.credentials = stored;
      this.loaded = true;
      this.revisionValue++;
      if (!stored) await this.onInvalidCredentials?.();
    });
  }

  /** Removes credentials after a terminal refresh failure unless another process replaced them. */
  private async invalidateUnlessRotated(
    rejected: SlackCredentials,
  ): Promise<SlackCredentials | undefined> {
    const stored = await this.store.load();
    if (stored?.refreshToken === rejected.refreshToken) {
      await this.invalidate();
      return undefined;
    }
    await this.adopt(stored);
    return stored;
  }

  private async invalidate(): Promise<void> {
    this.generation++;
    await this.transitionLock.run(async () => {
      this.credentials = undefined;
      this.loaded = true;
      this.revisionValue++;
      await this.onInvalidCredentials?.();
      await this.store.delete();
    });
  }
}

export async function discoverOAuthMetadata(
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<OAuthMetadata> {
  const [authorization, resource] = await Promise.all([
    fetchJson(fetchImpl, AUTHORIZATION_METADATA_URL, signal),
    fetchJson(fetchImpl, RESOURCE_METADATA_URL, signal),
  ]);
  if (!isRecord(authorization) || !isRecord(resource)) {
    throw new Error("Slack OAuth metadata was malformed.");
  }
  if (
    authorization.issuer !== SLACK_OAUTH_ISSUER ||
    authorization.authorization_endpoint !== SLACK_AUTHORIZATION_ENDPOINT ||
    authorization.token_endpoint !== SLACK_TOKEN_ENDPOINT
  ) {
    throw new Error("Slack OAuth metadata did not match the pinned Slack endpoints.");
  }
  requireArrayValue(authorization.response_types_supported, "code");
  requireArrayValue(authorization.grant_types_supported, "authorization_code");
  requireArrayValue(authorization.grant_types_supported, "refresh_token");
  requireArrayValue(authorization.code_challenge_methods_supported, "S256");
  for (const scope of SLACK_SCOPES) requireArrayValue(authorization.scopes_supported, scope);

  if (resource.resource !== SLACK_MCP_RESOURCE) {
    throw new Error("Slack OAuth metadata advertised an unexpected resource.");
  }
  if (
    !Array.isArray(resource.authorization_servers) ||
    resource.authorization_servers.length !== 1 ||
    resource.authorization_servers[0] !== SLACK_OAUTH_ISSUER
  ) {
    throw new Error("Slack OAuth metadata advertised an unexpected authorization server.");
  }
  for (const scope of SLACK_SCOPES) requireArrayValue(resource.scopes_supported, scope);

  return {
    authorization: authorization as unknown as OAuthAuthorizationMetadata,
    resource: resource as unknown as OAuthProtectedResourceMetadata,
  };
}

export function createAuthorizationUrl(
  metadata: OAuthAuthorizationMetadata,
  config: SlackConfig,
  state: string,
  codeChallenge: string,
): URL {
  if (metadata.authorization_endpoint !== SLACK_AUTHORIZATION_ENDPOINT) {
    throw new Error("Refusing to use an unpinned Slack authorization endpoint.");
  }
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", SLACK_REDIRECT_URI);
  url.searchParams.set("scope", SLACK_SCOPES.join(" "));
  url.searchParams.set("resource", SLACK_MCP_RESOURCE);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

export function createPkceVerifier(): string {
  return randomBytes(64).toString("base64url");
}

export function createPkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

async function exchangeAuthorizationCode(
  fetchImpl: typeof fetch,
  metadata: OAuthAuthorizationMetadata,
  config: SlackConfig,
  code: string,
  verifier: string,
  signal?: AbortSignal,
): Promise<TokenResponse> {
  return requestToken(
    fetchImpl,
    metadata,
    config,
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: SLACK_REDIRECT_URI,
      resource: SLACK_MCP_RESOURCE,
    }),
    signal,
  );
}

async function refreshAccessToken(
  fetchImpl: typeof fetch,
  metadata: OAuthAuthorizationMetadata,
  config: SlackConfig,
  refreshToken: string,
  signal?: AbortSignal,
): Promise<TokenResponse> {
  return requestToken(
    fetchImpl,
    metadata,
    config,
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.clientId,
      refresh_token: refreshToken,
      resource: SLACK_MCP_RESOURCE,
    }),
    signal,
  );
}

async function requestToken(
  fetchImpl: typeof fetch,
  metadata: OAuthAuthorizationMetadata,
  _config: SlackConfig,
  body: URLSearchParams,
  signal?: AbortSignal,
): Promise<TokenResponse> {
  if (metadata.token_endpoint !== SLACK_TOKEN_ENDPOINT) {
    throw new Error("Refusing to use an unpinned Slack token endpoint.");
  }
  let response: Response;
  try {
    response = await fetchImpl(metadata.token_endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body,
      signal,
      redirect: "error",
    });
  } catch {
    throw new Error("Slack's token endpoint could not be reached.");
  }
  const value = await responseJson(response);
  if (!response.ok || !isRecord(value) || value.ok !== true) {
    if (response.status === 429 || response.status >= 500) {
      throw new Error("Slack's token endpoint is temporarily unavailable. Retry later.");
    }
    const error = isRecord(value) && typeof value.error === "string" ? value.error : undefined;
    if (error === "bad_client_secret" || error === "invalid_client_id") {
      throw new SlackTokenRejectedError(
        "Slack rejected the public PKCE client. Verify that the app has PKCE enabled; do not add a client secret to this repository.",
      );
    }
    if (error !== undefined && TERMINAL_TOKEN_ERRORS.has(error)) {
      throw new SlackTokenRejectedError("Slack rejected the OAuth token request.");
    }
    throw new Error("Slack's token endpoint returned a temporary error. Retry later.");
  }

  try {
    const authedUser = isRecord(value.authed_user) ? value.authed_user : undefined;
    const user = isRecord(value.user) ? value.user : undefined;
    const team = isRecord(value.team) ? value.team : undefined;
    const enterprise = isRecord(value.enterprise) ? value.enterprise : undefined;
    const topAccessToken = typeof value.access_token === "string" ? value.access_token : undefined;
    const userAccessToken =
      typeof authedUser?.access_token === "string" ? authedUser.access_token : undefined;
    if (topAccessToken && userAccessToken && topAccessToken !== userAccessToken) {
      throw new Error("Slack returned conflicting user access tokens.");
    }
    const tokenRecord = topAccessToken ? value : authedUser;
    const topTokenType = typeof value.token_type === "string" ? value.token_type : undefined;
    const userTokenType =
      typeof authedUser?.token_type === "string" ? authedUser.token_type : undefined;
    const normalizedTopTokenType = topTokenType?.toLowerCase();
    const normalizedUserTokenType = userTokenType?.toLowerCase();
    const bearerUserPair =
      new Set([normalizedTopTokenType, normalizedUserTokenType]).size === 2 &&
      [normalizedTopTokenType, normalizedUserTokenType].every(
        (tokenType) => tokenType === "bearer" || tokenType === "user",
      );
    if (topTokenType && userTokenType && topTokenType !== userTokenType && !bearerUserPair) {
      throw new Error("Slack returned conflicting access-token types.");
    }
    const tokenType =
      normalizedTopTokenType === "user" || normalizedUserTokenType === "user"
        ? "user"
        : (topTokenType ?? userTokenType);
    const accessToken = topAccessToken ?? userAccessToken ?? "";
    validateUserAccessToken(accessToken, tokenType);

    const topScopes = parseOptionalScopes(value.scope);
    const userScopes = parseOptionalScopes(authedUser?.scope);
    const scopes = topAccessToken ? (topScopes ?? userScopes) : userScopes;
    const teamId = firstString(team?.id, value.team_id, authedUser?.team_id, value.team);
    const enterpriseId = firstString(
      enterprise?.id,
      value.enterprise_id,
      authedUser?.enterprise_id,
    );
    const userId = firstString(
      authedUser?.id,
      value.authed_user_id,
      value.user_id,
      user?.id,
      value.authed_user,
    );
    const returnedIdentity: Partial<SlackIdentity> = {
      ...(teamId ? { teamId } : {}),
      ...(enterpriseId ? { enterpriseId } : {}),
      ...(userId ? { userId } : {}),
    };
    const identity =
      returnedIdentity.teamId && returnedIdentity.userId
        ? returnedIdentity
        : body.get("grant_type") === "authorization_code"
          ? mergeReturnedIdentity(
              returnedIdentity,
              await verifySlackAccessTokenIdentity(fetchImpl, accessToken, signal),
            )
          : returnedIdentity;

    return {
      accessToken,
      ...(typeof tokenRecord?.refresh_token === "string"
        ? { refreshToken: tokenRecord.refresh_token }
        : {}),
      ...(typeof tokenRecord?.expires_in === "number" ? { expiresIn: tokenRecord.expires_in } : {}),
      ...(scopes ? { scopes } : {}),
      identity,
      tokenType,
    };
  } catch (error) {
    throw new SlackTokenValidationError(
      isSafeOAuthError(error) ? error.message : "Slack returned a malformed OAuth token response.",
    );
  }
}

export function validateInitialToken(
  response: TokenResponse & { tokenType?: unknown },
  config: SlackConfig,
  now: number,
): SlackCredentials {
  if (!config.clientId) {
    throw new Error("Set SLACK_MCP_CLIENT_ID to the organization's public Slack app client ID.");
  }
  validateUserAccessToken(response.accessToken, response.tokenType);
  if (!response.scopes) throw new Error("Slack did not return a verifiable OAuth scope list.");
  const scopes = validateEffectiveScopes(response.scopes);
  const identity = validateIdentity(response.identity, undefined, config);
  if (response.expiresIn !== undefined && !validExpiresIn(response.expiresIn)) {
    throw new Error("Slack returned an invalid access-token lifetime.");
  }
  if (
    response.refreshToken !== undefined &&
    (!response.refreshToken.startsWith("xoxe-") || !validExpiresIn(response.expiresIn))
  ) {
    throw new Error("Slack returned incomplete rotating-token credentials.");
  }
  return {
    clientId: config.clientId,
    tokenType: "user",
    accessToken: response.accessToken,
    ...(response.refreshToken ? { refreshToken: response.refreshToken } : {}),
    ...(validExpiresIn(response.expiresIn) ? { expiresAt: now + response.expiresIn * 1000 } : {}),
    scopes,
    identity,
  };
}

export function validateRefreshedToken(
  response: TokenResponse & { tokenType?: unknown },
  previous: SlackCredentials,
  config: SlackConfig,
  now: number,
): SlackCredentials {
  if (previous.clientId !== config.clientId) {
    throw new Error("Stored Slack credentials belong to a different client ID.");
  }
  validateUserAccessToken(response.accessToken, response.tokenType);
  if (
    !response.refreshToken ||
    !response.refreshToken.startsWith("xoxe-") ||
    !validExpiresIn(response.expiresIn)
  ) {
    throw new Error("Slack returned incomplete rotating-token credentials.");
  }
  const scopes = response.scopes ? validateEffectiveScopes(response.scopes) : [...previous.scopes];
  const identity = validateIdentity(response.identity, previous.identity, config);
  return {
    clientId: previous.clientId,
    tokenType: "user",
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    expiresAt: now + response.expiresIn * 1000,
    scopes,
    identity,
  };
}

export function validateEffectiveScopes(scopes: string[]): string[] {
  const actual = new Set(scopes);
  const approved = new Set<string>(SLACK_SCOPES);
  const missing = SLACK_SCOPES.filter((scope) => !actual.has(scope));
  const unexpected = [...actual].filter((scope) => !approved.has(scope));
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [
      ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
      ...(unexpected.length > 0 ? [`unexpected: ${formatScopes(unexpected)}`] : []),
    ];
    throw new Error(`Slack returned an unapproved OAuth scope set (${details.join("; ")}).`);
  }
  return [...SLACK_SCOPES];
}

function formatScopes(scopes: string[]): string {
  const shown = scopes.slice(0, 10).map((scope) => JSON.stringify(scope.slice(0, 100)));
  return `${shown.join(", ")}${scopes.length > shown.length ? `, and ${scopes.length - shown.length} more` : ""}`;
}

interface CallbackOptions {
  authorizationUrl: URL;
  expectedState: string;
  timeoutMs: number;
  signal: AbortSignal;
  openBrowser: BrowserOpener;
}

export async function receiveAuthorizationCode(options: CallbackOptions): Promise<string> {
  options.signal.throwIfAborted();
  const redirect = new URL(SLACK_REDIRECT_URI);
  let server: Server | undefined;
  try {
    const result = new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal.removeEventListener("abort", onAbort);
        operation();
      };
      const onAbort = () => finish(() => reject(new Error("Slack login was cancelled.")));
      const timeout = setTimeout(
        () => finish(() => reject(new Error("Slack login timed out."))),
        options.timeoutMs,
      );
      options.signal.addEventListener("abort", onAbort, { once: true });

      server = createServer((request, response) => {
        const respond = (status: number, browserMessage: string) => {
          response.writeHead(status, {
            "Cache-Control": "no-store",
            "Content-Type": "text/plain; charset=utf-8",
          });
          response.end(browserMessage);
        };
        // Only a well-formed callback carrying this login's state may settle the flow; a restored
        // browser tab or any other stray local request is answered and otherwise ignored.
        if (!isLoopbackAddress(request.socket.remoteAddress)) {
          respond(403, "Forbidden.");
          return;
        }
        if (
          request.method !== "GET" ||
          request.headers.host !== `${redirect.hostname}:${redirect.port}`
        ) {
          respond(400, "Invalid OAuth callback.");
          return;
        }
        let callback: URL;
        try {
          callback = new URL(request.url ?? "", SLACK_REDIRECT_URI);
        } catch {
          respond(400, "Invalid OAuth callback.");
          return;
        }
        if (callback.pathname !== redirect.pathname) {
          respond(404, "Not found.");
          return;
        }
        const state = callback.searchParams.get("state");
        if (!state || !safeEqual(state, options.expectedState)) {
          respond(400, "Invalid OAuth state.");
          return;
        }
        if (callback.searchParams.has("error")) {
          respond(400, "Slack authorization was denied.");
          finish(() => reject(new Error("Slack authorization was denied.")));
          return;
        }
        const code = callback.searchParams.get("code");
        if (!code) {
          respond(400, "Missing OAuth code.");
          finish(() => reject(new Error("Slack OAuth callback did not include a code.")));
          return;
        }
        respond(200, "Slack authentication completed. You may close this tab.");
        finish(() => resolve(code));
      });
      server.once("error", () =>
        finish(() => reject(new Error("Slack login could not bind the localhost callback port."))),
      );
      server.listen(
        { host: redirect.hostname, port: Number(redirect.port), exclusive: true },
        () => {
          if (settled) {
            // The login was cancelled or timed out while binding; release the port now.
            server?.close();
            return;
          }
          const address = server?.address();
          if (!address || typeof address === "string" || !isLoopbackAddress(address.address)) {
            finish(() => reject(new Error("Slack login could not bind a loopback address.")));
            return;
          }
          options
            .openBrowser(options.authorizationUrl)
            .catch(() =>
              finish(() => reject(new Error("The browser could not be opened for Slack login."))),
            );
        },
      );
    });
    return await result;
  } finally {
    await closeServer(server);
  }
}

function validateStoredCredentials(credentials: SlackCredentials, config: SlackConfig): void {
  if (config.clientId && credentials.clientId !== config.clientId) {
    throw new Error("Stored Slack credentials belong to a different client ID.");
  }
  validateUserAccessToken(credentials.accessToken, credentials.tokenType);
  if (
    (credentials.refreshToken !== undefined && credentials.expiresAt === undefined) ||
    (credentials.refreshToken !== undefined && !credentials.refreshToken.startsWith("xoxe-")) ||
    (credentials.expiresAt !== undefined && !Number.isFinite(credentials.expiresAt))
  ) {
    throw new Error("Stored Slack rotating-token credentials are invalid.");
  }
  validateEffectiveScopes(credentials.scopes);
  validateIdentity(credentials.identity, undefined, config);
}

function validateUserAccessToken(accessToken: string, tokenType: unknown): void {
  if (
    accessToken.length === 0 ||
    accessToken.length > 8_192 ||
    accessToken.includes("\r") ||
    accessToken.includes("\n") ||
    accessToken.includes("\0")
  ) {
    throw new Error("Slack returned an invalid user access token.");
  }

  const recognizedUserToken =
    accessToken.startsWith("xoxp-") || accessToken.startsWith("xoxe.xoxp-");
  const recognizedBotToken =
    accessToken.startsWith("xoxb-") || accessToken.startsWith("xoxe.xoxb-");
  const normalizedType = typeof tokenType === "string" ? tokenType.toLowerCase() : undefined;
  const compatibleBearerType = normalizedType === undefined || normalizedType === "bearer";
  if (
    recognizedBotToken ||
    (normalizedType !== "user" && !(recognizedUserToken && compatibleBearerType))
  ) {
    throw new Error("Slack OAuth response did not contain a verified user access token.");
  }
}

function validateIdentity(
  returned: Partial<SlackIdentity> | undefined,
  previous: SlackIdentity | undefined,
  config: SlackConfig,
): SlackIdentity {
  const teamId = returned?.teamId ?? previous?.teamId;
  const enterpriseId = returned?.enterpriseId ?? previous?.enterpriseId;
  const userId = returned?.userId ?? previous?.userId;
  if (
    !teamId ||
    !/^T[A-Z0-9]+$/.test(teamId) ||
    !userId ||
    !/^[UW][A-Z0-9]+$/.test(userId) ||
    (enterpriseId !== undefined && !/^E[A-Z0-9]+$/.test(enterpriseId))
  ) {
    throw new Error("Slack did not return a verifiable team and user identity.");
  }
  if (previous?.teamId && returned?.teamId && returned.teamId !== previous.teamId) {
    throw new Error("Slack returned a different team identity during refresh.");
  }
  if (previous?.userId && returned?.userId && returned.userId !== previous.userId) {
    throw new Error("Slack returned a different user identity during refresh.");
  }
  if (
    previous?.enterpriseId &&
    returned?.enterpriseId &&
    returned.enterpriseId !== previous.enterpriseId
  ) {
    throw new Error("Slack returned a different enterprise identity during refresh.");
  }
  if (config.expectedTeamId && teamId !== config.expectedTeamId) {
    throw new Error("Slack authorization came from an unexpected team.");
  }
  if (config.expectedEnterpriseId && enterpriseId !== config.expectedEnterpriseId) {
    throw new Error("Slack authorization came from an unexpected enterprise.");
  }
  return { teamId, userId, ...(enterpriseId ? { enterpriseId } : {}) };
}

async function verifySlackAccessTokenIdentity(
  fetchImpl: typeof fetch,
  accessToken: string,
  signal?: AbortSignal,
): Promise<SlackIdentity> {
  let response: Response;
  try {
    response = await fetchImpl(SLACK_AUTH_TEST_ENDPOINT, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      signal,
      redirect: "error",
    });
  } catch {
    throw new Error("Slack could not verify the access-token identity.");
  }
  const value = await responseJson(response);
  if (!response.ok || !isRecord(value) || value.ok !== true) {
    throw new Error("Slack could not verify the access-token identity.");
  }
  if (typeof value.bot_id === "string" && value.bot_id.length > 0) {
    throw new Error("Slack returned a bot identity for the OAuth access token.");
  }
  const teamId = firstString(value.team_id);
  const enterpriseId = firstString(value.enterprise_id);
  const userId = firstString(value.user_id);
  if (!teamId || !userId) {
    throw new Error("Slack did not verify a team and user identity for the access token.");
  }
  return { teamId, userId, ...(enterpriseId ? { enterpriseId } : {}) };
}

function mergeReturnedIdentity(
  returned: Partial<SlackIdentity>,
  verified: SlackIdentity,
): Partial<SlackIdentity> {
  if (
    (returned.teamId && returned.teamId !== verified.teamId) ||
    (returned.userId && returned.userId !== verified.userId) ||
    (returned.enterpriseId &&
      verified.enterpriseId &&
      returned.enterpriseId !== verified.enterpriseId)
  ) {
    throw new Error("Slack returned conflicting OAuth and access-token identities.");
  }
  return {
    teamId: returned.teamId ?? verified.teamId,
    userId: returned.userId ?? verified.userId,
    ...(returned.enterpriseId || verified.enterpriseId
      ? { enterpriseId: returned.enterpriseId ?? verified.enterpriseId }
      : {}),
  };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function parseOptionalScopes(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Slack returned a malformed OAuth scope list.");
  return value
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function validExpiresIn(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal,
      redirect: "error",
    });
  } catch {
    throw new Error("Slack OAuth metadata could not be reached.");
  }
  if (!response.ok) throw new Error("Slack OAuth metadata could not be loaded.");
  return responseJson(response);
}

async function responseJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_OAUTH_RESPONSE_BYTES) {
    throw new Error("Slack OAuth response exceeded the size limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Slack OAuth response was malformed.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_OAUTH_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Slack OAuth response exceeded the size limit.");
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Slack OAuth response was malformed.");
  }
}

function requireArrayValue(value: unknown, expected: string): void {
  if (!Array.isArray(value) || !value.includes(expected)) {
    throw new Error("Slack OAuth metadata did not advertise a required capability.");
  }
}

function isSafeOAuthError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message.startsWith("Slack ") ||
      error.message.startsWith("Slack's ") ||
      error.message.startsWith("Set SLACK_") ||
      error.message.startsWith("The OS credential store") ||
      error.message.startsWith("Stored Slack") ||
      error.message.startsWith("A Slack login") ||
      error.message.startsWith("The browser"))
  );
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  if (address === "::1" || address === "127.0.0.1") return true;
  if (address.startsWith("::ffff:")) return address.slice(7) === "127.0.0.1";
  return isIP(address) !== 0 && address.startsWith("127.");
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  // Close even before listen() completes: a server that never ran only reports
  // ERR_SERVER_NOT_RUNNING, and a bind that lands afterwards is closed by the listen callback.
  return new Promise((resolve) => server.close(() => resolve()));
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Slack request was cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function openBrowser(url: URL): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("open", [url.toString()], { timeout: 10_000 }, (error) => {
      if (error) reject(new Error("The browser could not be opened for Slack login."));
      else resolve();
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
