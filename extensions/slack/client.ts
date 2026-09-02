import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SlackAuth } from "./oauth.ts";
import { APPROVED_SLACK_TOOLS, verifyApprovedTools, type SlackOperation } from "./tools.ts";
import {
  SLACK_MCP_ENDPOINT,
  type SlackCallResult,
  type SlackConfig,
  type SlackToolMetadata,
} from "./types.ts";

const MAX_MCP_RESPONSE_BYTES = 2_000_000;
const SLACK_PROTOCOL_VERSION = "2025-06-18";
const TERMINATE_TIMEOUT_MS = 5_000;

export interface McpConnection {
  connect(signal?: AbortSignal): Promise<void>;
  listTools(
    cursor: string | undefined,
    signal?: AbortSignal,
  ): Promise<{
    tools: SlackToolMetadata[];
    nextCursor?: string;
  }>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<SlackCallResult>;
  terminate(): Promise<void>;
  close(): Promise<void>;
}

export type McpConnectionFactory = (accessToken: string) => McpConnection;

interface ActiveConnection {
  connection: McpConnection;
  revision: number;
}

export class SlackMcpClient {
  private readonly auth: SlackAuth;
  private readonly config: SlackConfig;
  private readonly factory: McpConnectionFactory;
  private active?: ActiveConnection;
  private connectFlight?: Promise<ActiveConnection>;
  private lifecycle = 0;

  constructor(options: {
    auth: SlackAuth;
    config: SlackConfig;
    connectionFactory?: McpConnectionFactory;
    fetch?: typeof fetch;
  }) {
    this.auth = options.auth;
    this.config = options.config;
    this.factory =
      options.connectionFactory ??
      ((accessToken) => new SdkMcpConnection(accessToken, options.config, options.fetch ?? fetch));
  }

  async call(
    operation: SlackOperation,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<SlackCallResult> {
    signal?.throwIfAborted();
    for (let attempt = 0; attempt < 2; attempt++) {
      let active: ActiveConnection | undefined;
      try {
        active = await this.getActive(signal);
        const result = await active.connection.callTool(
          operationName(operation),
          args,
          combinedSignal(signal, this.config.requestTimeoutMs),
        );
        if (result.isError) throw new Error("Slack returned an unsuccessful read result.");
        return result;
      } catch (error) {
        if (signal?.aborted) throw new Error("Slack request was cancelled.");
        if (attempt > 0) throw sanitizedCallError(error);

        if (error instanceof SlackHttpError && error.status === 429) {
          if (
            error.retryAfterMs === undefined ||
            error.retryAfterMs > this.config.maxRetryAfterMs
          ) {
            throw new Error("Slack is rate limited. Retry the request later.");
          }
          await abortableDelay(error.retryAfterMs, signal);
          continue;
        }
        if (error instanceof SlackHttpError && error.status === 401) {
          // A concurrent refresh may already have rotated the token; reconnect with it rather
          // than spending another single-use refresh token.
          if (!active || active.revision === this.auth.revision) {
            await this.auth.forceRefresh(signal);
          }
          await this.closeActive();
          continue;
        }
        if (isStaleSessionError(error)) {
          await this.closeActive();
          continue;
        }
        throw sanitizedCallError(error);
      }
    }
    throw new Error("Slack read failed.");
  }

  async discover(signal?: AbortSignal): Promise<SlackToolMetadata[]> {
    const grant = await this.auth.getAccessGrant(signal);
    const connection = this.factory(grant.accessToken);
    try {
      await connection.connect(combinedSignal(signal, this.config.requestTimeoutMs));
      return await listAllTools(connection, this.config, signal);
    } catch (error) {
      if (signal?.aborted) throw new Error("Slack discovery was cancelled.");
      throw sanitizedCallError(error, "Slack tool discovery failed.");
    } finally {
      await safeClose(connection);
    }
  }

  async close(): Promise<void> {
    this.lifecycle++;
    const connecting = this.connectFlight;
    this.connectFlight = undefined;
    await this.closeActive();
    if (connecting) {
      try {
        const active = await connecting;
        await safeClose(active.connection);
      } catch {}
    }
  }

  private async getActive(signal?: AbortSignal): Promise<ActiveConnection> {
    const grant = await this.auth.getAccessGrant(signal);
    if (this.active?.revision === grant.revision) return this.active;
    if (this.active) await this.closeActive();
    if (this.connectFlight) return awaitWithSignal(this.connectFlight, signal);

    const lifecycle = this.lifecycle;
    const connection = this.factory(grant.accessToken);
    let flight!: Promise<ActiveConnection>;
    flight = (async () => {
      try {
        await connection.connect(combinedSignal(undefined, this.config.requestTimeoutMs));
        const tools = await listAllTools(connection, this.config);
        verifyApprovedTools(tools);
        if (lifecycle !== this.lifecycle || grant.revision !== this.auth.revision) {
          throw new Error("Slack authentication changed while connecting.");
        }
        const active = { connection, revision: grant.revision };
        this.active = active;
        return active;
      } catch (error) {
        await safeClose(connection);
        if (isApprovedToolError(error) || error instanceof SlackHttpError) throw error;
        throw sanitizedCallError(error, "Slack MCP connection failed.");
      }
    })().finally(() => {
      if (this.connectFlight === flight) this.connectFlight = undefined;
    });
    this.connectFlight = flight;
    return awaitWithSignal(flight, signal);
  }

  private async closeActive(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    if (active) await safeClose(active.connection);
  }
}

export class SlackHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(status: number, retryAfterMs?: number) {
    super("Slack MCP HTTP request failed.");
    this.name = "SlackHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

class SdkMcpConnection implements McpConnection {
  private readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;
  private readonly config: SlackConfig;

  constructor(accessToken: string, config: SlackConfig, fetchImpl: typeof fetch) {
    const endpoint = new URL(SLACK_MCP_ENDPOINT);
    if (endpoint.protocol !== "https:" || endpoint.hostname !== "mcp.slack.com") {
      throw new Error("Refusing to connect to an unpinned Slack MCP endpoint.");
    }
    this.config = config;
    this.client = new Client(
      { name: "pi-slack-read-only", version: "1.0.0" },
      { capabilities: {}, enforceStrictCapabilities: true },
    );
    this.client.onerror = () => {};
    this.transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: {
        headers: { Authorization: `Bearer ${accessToken}` },
        redirect: "error",
      },
      fetch: guardedFetch(fetchImpl),
      reconnectionOptions: {
        initialReconnectionDelay: 250,
        maxReconnectionDelay: 1_000,
        reconnectionDelayGrowFactor: 1.5,
        maxRetries: 0,
      },
    });
    const send = this.transport.send.bind(this.transport);
    this.transport.send = (message, options) => send(pinSlackProtocolVersion(message), options);
  }

  async connect(signal?: AbortSignal): Promise<void> {
    await this.client.connect(this.transport, {
      signal,
      timeout: this.config.requestTimeoutMs,
      maxTotalTimeout: this.config.requestTimeoutMs,
    });
  }

  async listTools(
    cursor: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ tools: SlackToolMetadata[]; nextCursor?: string }> {
    const result = await this.client.listTools(cursor ? { cursor } : undefined, {
      signal,
      timeout: this.config.requestTimeoutMs,
      maxTotalTimeout: this.config.requestTimeoutMs,
    });
    return {
      tools: result.tools as SlackToolMetadata[],
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<SlackCallResult> {
    return (await this.client.callTool({ name, arguments: args }, undefined, {
      signal,
      timeout: this.config.requestTimeoutMs,
      maxTotalTimeout: this.config.requestTimeoutMs,
    })) as SlackCallResult;
  }

  async terminate(): Promise<void> {
    await this.transport.terminateSession();
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

function guardedFetch(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const requestUrl = new URL(input instanceof Request ? input.url : String(input));
    if (
      requestUrl.protocol !== "https:" ||
      requestUrl.hostname !== "mcp.slack.com" ||
      requestUrl.pathname !== "/mcp"
    ) {
      throw new Error("Refusing to send Slack credentials to an unpinned endpoint.");
    }
    const response = await fetchImpl(input, { ...init, redirect: "error" });
    if (response.url) {
      const responseUrl = new URL(response.url);
      if (responseUrl.protocol !== "https:" || responseUrl.hostname !== "mcp.slack.com") {
        throw new Error("Slack MCP returned an unexpected response origin.");
      }
    }
    if (!response.ok) {
      throw new SlackHttpError(
        response.status,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MCP_RESPONSE_BYTES) {
      throw new Error("Slack MCP response exceeded the size limit.");
    }
    return limitedResponse(response);
  }) as typeof fetch;
}

export function pinSlackProtocolVersion<T>(message: T): T {
  if (Array.isArray(message)) return message.map(pinSlackProtocolVersion) as T;
  if (!isRecord(message) || message.method !== "initialize" || !isRecord(message.params)) {
    return message;
  }
  return {
    ...message,
    params: { ...message.params, protocolVersion: SLACK_PROTOCOL_VERSION },
  } as T;
}

function limitedResponse(response: Response): Response {
  if (!response.body) return response;
  let bytes = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > MAX_MCP_RESPONSE_BYTES) {
          controller.error(new Error("Slack MCP response exceeded the size limit."));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function operationName(operation: SlackOperation): string {
  return APPROVED_SLACK_TOOLS[operation].name;
}

async function listAllTools(
  connection: McpConnection,
  config: SlackConfig,
  signal?: AbortSignal,
): Promise<SlackToolMetadata[]> {
  const tools: SlackToolMetadata[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < config.maxToolPages; page++) {
    const result = await connection.listTools(
      cursor,
      combinedSignal(signal, config.requestTimeoutMs),
    );
    tools.push(...result.tools);
    if (!result.nextCursor) return tools;
    if (cursors.has(result.nextCursor)) throw new Error("Slack tool pagination repeated a cursor.");
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error("Slack tool discovery exceeded the page limit.");
}

async function safeClose(connection: McpConnection): Promise<void> {
  try {
    // Termination is best effort and may run under the auth transition lock; close() aborts a
    // DELETE that outlives the deadline.
    await withDeadline(connection.terminate(), TERMINATE_TIMEOUT_MS);
  } catch {}
  try {
    await connection.close();
  } catch {}
}

function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Slack MCP session termination timed out.")),
      milliseconds,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function isStaleSessionError(error: unknown): boolean {
  if (error instanceof SlackHttpError) return error.status === 404 || error.status === 409;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("session") && (message.includes("invalid") || message.includes("stale"));
}

function isApprovedToolError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Slack's approved ");
}

function sanitizedCallError(error: unknown, fallback = "Slack read failed."): Error {
  if (error instanceof Error) {
    if (isApprovedToolError(error) || isActionableAuthError(error.message)) {
      return new Error(error.message);
    }
    if (error.name === "AbortError" || error.message.toLowerCase().includes("cancel")) {
      return new Error("Slack request was cancelled.");
    }
  }
  return new Error(fallback);
}

function isActionableAuthError(message: string): boolean {
  return [
    "Slack is not authenticated.",
    "Slack authentication expired.",
    "Slack credentials could not be refreshed",
    "Slack OAuth metadata could not",
    "Slack's token endpoint",
    "Slack rejected the OAuth token request.",
    "Stored Slack credentials",
    "The OS credential store",
  ].some((prefix) => message.startsWith(prefix));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Slack request was cancelled."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
