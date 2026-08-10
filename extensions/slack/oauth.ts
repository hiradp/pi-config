import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { isIP } from "node:net";
import type { CredentialStore } from "./credentials.ts";
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
} from "./types.ts";

const AUTHORIZATION_METADATA_URL = `${SLACK_OAUTH_ISSUER}/.well-known/oauth-authorization-server`;
const RESOURCE_METADATA_URL = `${SLACK_MCP_RESOURCE}/.well-known/oauth-protected-resource`;
const MAX_OAUTH_RESPONSE_BYTES = 100_000;
const SLACK_AUTH_TEST_ENDPOINT = "https://slack.com/api/auth.test";

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

export interface SlackAuthOptions {
  config: SlackConfig;
  store: CredentialStore;
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
  private readonly fetchImpl: typeof fetch;
  private readonly browser: BrowserOpener;
  private readonly now: () => number;
  private readonly onInvalidCredentials?: () => void | Promise<void>;
  private readonly transitionLock = new SerialLock();
  private credentials?: SlackCredentials;
  private loaded = false;
  private loadFlight?: Promise<SlackCredentials | undefined>;
  private refreshFlight?: Promise<SlackCredentials>;
  private loginController?: AbortController;
  private loginSettled?: Promise<void>;
  private revisionValue = 0;
  private generation = 0;

  constructor(options: SlackAuthOptions) {
    this.config = options.config;
    this.store = options.store;
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

  async login(): Promise<SlackCredentials> {
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
      if (!this.config.clientId) {
        throw new Error(
          "Set SLACK_MCP_CLIENT_ID to the organization's public Slack app client ID.",
        );
      }
      flowSignal.throwIfAborted();
      const metadata = await discoverOAuthMetadata(this.fetchImpl, flowSignal);
      const verifier = createPkceVerifier();
      const challenge = createPkceChallenge(verifier);
      const state = randomBytes(32).toString("base64url");
      const authorizationUrl = createAuthorizationUrl(
        metadata.authorization,
        this.config,
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
        this.config,
        code,
        verifier,
        flowSignal,
      );
      const credentials = validateInitialToken(token, this.config, this.now());

      await this.transitionLock.run(async () => {
        if (flowSignal.aborted || loginGeneration !== this.generation) {
          throw new Error(
            deadline.aborted ? "Slack login timed out." : "Slack login was cancelled.",
          );
        }
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
    if (
      credentials.expiresAt !== undefined &&
      credentials.expiresAt - this.now() <= this.config.refreshLeewayMs
    ) {
      credentials = await this.refresh(credentials, signal);
    }
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
          try {
            validateStoredCredentials(credentials, this.config);
          } catch {
            await this.invalidate();
            throw new Error("Stored Slack credentials failed security validation.");
          }
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

  private async refresh(
    current: SlackCredentials,
    signal?: AbortSignal,
    force = false,
  ): Promise<SlackCredentials> {
    if (!force && current.expiresAt === undefined) return current;
    if (!current.refreshToken) {
      await this.invalidate();
      throw new Error("Slack authentication expired. Run /slack-login again.");
    }
    if (this.refreshFlight) return this.refreshFlight;

    const refreshGeneration = this.generation;
    this.refreshFlight = (async () => {
      const requestSignal = combinedSignal(signal, this.config.requestTimeoutMs);
      try {
        const metadata = await discoverOAuthMetadata(this.fetchImpl, requestSignal);
        const effectiveConfig = configForStoredCredentials(this.config, current);
        const token = await refreshAccessToken(
          this.fetchImpl,
          metadata.authorization,
          effectiveConfig,
          current.refreshToken!,
          requestSignal,
        );
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
        if (signal?.aborted) throw new Error("Slack request was cancelled.");
        if (refreshGeneration !== this.generation) {
          throw new Error("Slack authentication changed while refreshing.");
        }
        await this.invalidate();
        if (isSafeOAuthError(error)) throw error;
        throw new Error("Slack credentials could not be refreshed and were removed.");
      }
    })().finally(() => {
      this.refreshFlight = undefined;
    });
    return this.refreshFlight;
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
    const error = isRecord(value) && typeof value.error === "string" ? value.error : undefined;
    if (error === "bad_client_secret" || error === "invalid_client_id") {
      throw new Error(
        "Slack rejected the public PKCE client. Verify that the app has PKCE enabled; do not add a client secret to this repository.",
      );
    }
    throw new Error("Slack rejected the OAuth token request.");
  }

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
  const enterpriseId = firstString(enterprise?.id, value.enterprise_id, authedUser?.enterprise_id);
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
  if (actual.size !== scopes.length || actual.size !== SLACK_SCOPES.length) {
    throw new Error("Slack returned an unapproved OAuth scope set.");
  }
  for (const scope of SLACK_SCOPES) {
    if (!actual.has(scope)) throw new Error("Slack returned an unapproved OAuth scope set.");
  }
  return [...SLACK_SCOPES];
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
        const rejectRequest = (status: number, message: string, browserMessage: string) => {
          response.writeHead(status, {
            "Cache-Control": "no-store",
            "Content-Type": "text/plain; charset=utf-8",
          });
          response.end(browserMessage);
          finish(() => reject(new Error(message)));
        };
        if (!isLoopbackAddress(request.socket.remoteAddress)) {
          rejectRequest(403, "Slack OAuth callback was not received over loopback.", "Forbidden.");
          return;
        }
        if (
          request.method !== "GET" ||
          request.headers.host !== `${redirect.hostname}:${redirect.port}`
        ) {
          rejectRequest(400, "Slack OAuth callback was malformed.", "Invalid OAuth callback.");
          return;
        }
        let callback: URL;
        try {
          callback = new URL(request.url ?? "", SLACK_REDIRECT_URI);
        } catch {
          rejectRequest(400, "Slack OAuth callback was malformed.", "Invalid OAuth callback.");
          return;
        }
        if (callback.pathname !== redirect.pathname) {
          rejectRequest(404, "Slack OAuth callback used an unexpected path.", "Not found.");
          return;
        }
        const state = callback.searchParams.get("state");
        if (!state || !safeEqual(state, options.expectedState)) {
          rejectRequest(400, "Slack OAuth callback state did not match.", "Invalid OAuth state.");
          return;
        }
        if (callback.searchParams.has("error")) {
          rejectRequest(400, "Slack authorization was denied.", "Slack authorization was denied.");
          return;
        }
        const code = callback.searchParams.get("code");
        if (!code) {
          rejectRequest(400, "Slack OAuth callback did not include a code.", "Missing OAuth code.");
          return;
        }
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end("Slack authentication completed. You may close this tab.");
        finish(() => resolve(code));
      });
      server.once("error", () =>
        finish(() => reject(new Error("Slack login could not bind the localhost callback port."))),
      );
      server.listen(
        { host: redirect.hostname, port: Number(redirect.port), exclusive: true },
        () => {
          const address = server?.address();
          if (!address || typeof address === "string" || !isLoopbackAddress(address.address)) {
            finish(() => reject(new Error("Slack login could not bind a loopback address.")));
            return;
          }
          if (options.signal.aborted) {
            finish(() => reject(new Error("Slack login was cancelled.")));
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

function configForStoredCredentials(
  config: SlackConfig,
  credentials: SlackCredentials,
): SlackConfig {
  return config.clientId ? config : { ...config, clientId: credentials.clientId };
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

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  if (address === "::1" || address === "127.0.0.1") return true;
  if (address.startsWith("::ffff:")) return address.slice(7) === "127.0.0.1";
  return isIP(address) !== 0 && address.startsWith("127.");
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
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
