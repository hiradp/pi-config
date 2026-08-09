import { execFileSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";

const API_TIMEOUT_MS = 20_000;
const MAX_BLOCK_DEPTH = 5;
const MAX_DATABASE_ROWS = 100;
const MAX_PAGE_CHUNKS = 10;
const SEARCH_RESULTS_PER_SPACE = 20;

type ReadEndpoint =
  | "getSpaces"
  | "loadPageChunk"
  | "queryCollection"
  | "search"
  | "syncRecordValues";

interface StoredRecord<T> {
  value?: T | { value?: T };
  spaceId?: string;
}

interface NotionBlock {
  type?: string;
  properties?: Record<string, unknown>;
  content?: unknown;
  format?: Record<string, unknown>;
  collection_id?: string;
  view_ids?: unknown;
  space_id?: string;
}

interface NotionCollection {
  name?: unknown;
  schema?: Record<string, { name?: string }>;
}

interface NotionSpace {
  name?: string;
}

interface RecordMap {
  block?: Record<string, StoredRecord<NotionBlock>>;
  collection?: Record<string, StoredRecord<NotionCollection>>;
  space?: Record<string, StoredRecord<NotionSpace>>;
}

interface NotionResponse {
  recordMap?: RecordMap;
}

interface PageChunkResponse extends NotionResponse {
  cursor?: { stack?: unknown[] };
}

interface SearchResponse extends NotionResponse {
  results?: Array<{ id?: unknown }>;
}

interface QueryCollectionResponse extends NotionResponse {
  result?: {
    reducerResults?: {
      collection_group_results?: { blockIds?: unknown };
    };
  };
}

interface SpaceInfo {
  id: string;
  name: string;
}

interface SearchResult {
  id: string;
  title: string;
  type: string;
  url: string;
  space: string;
}

interface ReadResult {
  title: string;
  type: "database" | "page";
  url: string;
  markdown: string;
}

let cachedToken: string | undefined;
let cachedSpaces: SpaceInfo[] | undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function unwrap<T>(record: StoredRecord<T> | undefined): T | undefined {
  const value = record?.value;
  const wrapper = asRecord(value);
  return (wrapper && "value" in wrapper ? wrapper.value : value) as T | undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringValue(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function commandOutput(command: string, args: string[], failure: string): string {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(failure);
  }
}

function extractToken(): string {
  if (cachedToken) return cachedToken;

  const environmentToken = process.env.NOTION_TOKEN?.trim();
  if (environmentToken) {
    if (/[\r\n]/.test(environmentToken)) throw new Error("NOTION_TOKEN contains a newline.");
    cachedToken = environmentToken;
    return environmentToken;
  }

  if (process.platform !== "darwin") {
    throw new Error("Automatic Notion authentication requires macOS. Set NOTION_TOKEN instead.");
  }

  const safeStoragePassword = commandOutput(
    "security",
    ["find-generic-password", "-s", "Notion Safe Storage", "-w"],
    "Could not read Notion Safe Storage from the macOS Keychain. Make sure Notion.app is installed and logged in.",
  );
  const cookieDatabase = join(
    homedir(),
    "Library",
    "Application Support",
    "Notion",
    "Partitions",
    "notion",
    "Cookies",
  );
  const encryptedHex = commandOutput(
    "sqlite3",
    [
      cookieDatabase,
      "SELECT hex(encrypted_value) FROM cookies WHERE name='token_v2' AND host_key LIKE '%notion%' ORDER BY length(host_key) LIMIT 1;",
    ],
    "Could not read Notion.app's cookie database. Install sqlite3 or set NOTION_TOKEN.",
  );
  if (!encryptedHex) {
    throw new Error("Notion's token_v2 cookie was not found. Make sure Notion.app is logged in.");
  }

  const encrypted = Buffer.from(encryptedHex, "hex");
  const version = encrypted.subarray(0, 3).toString("ascii");
  if (version !== "v10" && version !== "v11") {
    throw new Error(
      "Notion's cookie encryption format is not supported. Set NOTION_TOKEN instead.",
    );
  }

  const key = pbkdf2Sync(safeStoragePassword, "saltysalt", 1003, 16, "sha1");
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  const decoded = decrypted.toString("utf8");
  const tokenStart = decoded.indexOf("v0");
  if (tokenStart < 0) {
    throw new Error("Could not decrypt Notion's token_v2 cookie. Set NOTION_TOKEN instead.");
  }

  const rawToken = [...decoded.slice(tokenStart)]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code <= 0x7e;
    })
    .join("");
  try {
    cachedToken = decodeURIComponent(rawToken);
  } catch {
    throw new Error(
      "Notion's token_v2 cookie had an unexpected encoding. Set NOTION_TOKEN instead.",
    );
  }
  return cachedToken;
}

async function notionRead<T>(
  endpoint: ReadEndpoint,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const token = extractToken();
  const timeout = AbortSignal.timeout(API_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(`https://www.notion.so/api/v3/${endpoint}`, {
    method: "POST",
    headers: {
      Cookie: `token_v2=${encodeURIComponent(token)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: requestSignal,
  });

  if (!response.ok) {
    const responseText = (await response.text()).trim().slice(0, 500);
    throw new Error(
      `Notion read failed (${response.status})${responseText ? `: ${responseText}` : ""}`,
    );
  }
  return (await response.json()) as T;
}

function parseNotionId(input: string): string {
  let candidate = input.trim();
  try {
    const url = new URL(candidate);
    candidate = url.searchParams.get("p") ?? url.pathname;
  } catch {}

  const compact = candidate.match(/([a-f0-9]{32})/i)?.[1];
  if (compact) {
    return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
  }

  const uuid = candidate.match(
    /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
  )?.[1];
  if (uuid) return uuid;
  throw new Error(`Could not extract a Notion page or database ID from: ${input}`);
}

function notionUrl(id: string): string {
  return `https://www.notion.so/${id.replaceAll("-", "")}`;
}

function annotationValue(annotation: unknown[]): unknown {
  return annotation.length > 1 ? annotation[1] : undefined;
}

function richTextToMarkdown(value: unknown): string {
  if (!Array.isArray(value)) return "";

  return value
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (!Array.isArray(chunk)) return "";

      const rawText = chunk[0];
      if (rawText === undefined || rawText === null) return "";
      const text = String(rawText);
      const annotations = Array.isArray(chunk[1]) ? chunk[1] : [];
      let result = text;

      for (const rawAnnotation of annotations) {
        if (!Array.isArray(rawAnnotation)) continue;
        const type = rawAnnotation[0];
        const value = annotationValue(rawAnnotation);
        if (type === "b") result = `**${result}**`;
        else if (type === "i") result = `*${result}*`;
        else if (type === "s") result = `~~${result}~~`;
        else if (type === "c") result = `\`${result}\``;
        else if (type === "a" && typeof value === "string") result = `[${result}](${value})`;
        else if (type === "u" && typeof value === "string") result = `@${value}`;
        else if (type === "p" && typeof value === "string") {
          result = `[${text === "‣" ? "Notion page" : result}](${notionUrl(value)})`;
        } else if (type === "d") {
          const date = asRecord(value);
          const start = stringValue(date, "start_date");
          const end = stringValue(date, "end_date");
          if (start) result = end ? `${start} → ${end}` : start;
        } else if (type === "e") {
          result = `$${typeof value === "string" ? value : result}$`;
        }
      }
      return result;
    })
    .join("");
}

function richTextToPlainText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (!Array.isArray(chunk) || chunk[0] === undefined || chunk[0] === null) return "";
      return String(chunk[0]);
    })
    .join("");
}

function blockProperty(block: NotionBlock | undefined, name: string): unknown {
  return block?.properties?.[name];
}

function tableCell(value: unknown): string {
  return richTextToMarkdown(value).replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

function renderBlocks(
  ids: string[],
  blocks: Map<string, NotionBlock>,
  depth = 0,
  indent = "",
): string {
  if (depth > MAX_BLOCK_DEPTH) return `${indent}*(nested content omitted)*\n`;

  const lines: string[] = [];
  let numberedIndex = 0;

  for (const id of ids) {
    const block = blocks.get(id);
    if (!block) continue;

    const type = block.type ?? "unknown";
    if (type !== "numbered_list") numberedIndex = 0;
    const text = richTextToMarkdown(blockProperty(block, "title"));
    const children = stringArray(block.content);
    const format = block.format;

    if (type === "text") {
      if (text) lines.push(`${indent}${text}`, "");
    } else if (type === "header" || type === "sub_header" || type === "sub_sub_header") {
      const level = type === "header" ? "#" : type === "sub_header" ? "##" : "###";
      lines.push(`${indent}${level} ${text}`, "");
    } else if (type === "bulleted_list") {
      lines.push(`${indent}- ${text}`);
      if (children.length) lines.push(renderBlocks(children, blocks, depth + 1, `${indent}  `));
    } else if (type === "numbered_list") {
      numberedIndex++;
      lines.push(`${indent}${numberedIndex}. ${text}`);
      if (children.length) lines.push(renderBlocks(children, blocks, depth + 1, `${indent}   `));
    } else if (type === "to_do") {
      const checked = richTextToPlainText(blockProperty(block, "checked")) === "Yes";
      lines.push(`${indent}- [${checked ? "x" : " "}] ${text}`);
      if (children.length) lines.push(renderBlocks(children, blocks, depth + 1, `${indent}  `));
    } else if (type === "toggle") {
      lines.push(`${indent}<details>`, `${indent}<summary>${text}</summary>`, "");
      if (children.length) lines.push(renderBlocks(children, blocks, depth + 1, indent));
      lines.push(`${indent}</details>`, "");
    } else if (type === "code") {
      const language = richTextToPlainText(blockProperty(block, "language")).toLowerCase();
      lines.push(
        `${indent}\`\`\`${language}`,
        richTextToPlainText(blockProperty(block, "title")),
        `${indent}\`\`\``,
        "",
      );
    } else if (type === "quote" || type === "callout") {
      const icon = type === "callout" ? `${stringValue(format, "page_icon")} ` : "";
      lines.push(`${indent}> ${icon}${text}`);
      if (children.length) lines.push(renderBlocks(children, blocks, depth + 1, `${indent}> `));
      lines.push("");
    } else if (type === "divider") {
      lines.push(`${indent}---`, "");
    } else if (type === "image") {
      const source =
        stringValue(format, "display_source") ||
        richTextToPlainText(blockProperty(block, "source"));
      const caption = richTextToMarkdown(blockProperty(block, "caption"));
      lines.push(`${indent}![${caption}](${source})`, "");
    } else if (type === "bookmark") {
      const url = richTextToPlainText(blockProperty(block, "link"));
      const title = richTextToPlainText(blockProperty(block, "title"));
      const description = richTextToPlainText(blockProperty(block, "description"));
      lines.push(
        `${indent}${title ? `[${title}](${url})${description ? ` — ${description}` : ""}` : url}`,
        "",
      );
    } else if (["audio", "embed", "file", "pdf", "video"].includes(type)) {
      const source =
        stringValue(format, "display_source") ||
        richTextToPlainText(blockProperty(block, "source"));
      const caption = richTextToMarkdown(blockProperty(block, "caption"));
      lines.push(`${indent}[${caption || type}](${source})`, "");
    } else if (type === "equation") {
      lines.push(`${indent}$$${richTextToPlainText(blockProperty(block, "title"))}$$`, "");
    } else if (type === "column_list") {
      for (const columnId of children) {
        const column = blocks.get(columnId);
        lines.push(renderBlocks(stringArray(column?.content), blocks, depth + 1, indent));
      }
    } else if (type === "page" || type === "collection_view_page" || type === "collection_view") {
      const icon = type === "page" ? "📄" : "🗃️";
      const title = richTextToPlainText(blockProperty(block, "title")) || "(untitled)";
      lines.push(`${indent}${icon} [${title}](${notionUrl(id)})`, "");
    } else if (type === "alias") {
      const pointer = asRecord(format?.alias_pointer);
      const targetId = stringValue(pointer, "id");
      lines.push(`${indent}↗ ${targetId ? `[Linked page](${notionUrl(targetId)})` : text}`, "");
    } else if (type === "table") {
      let columns = stringArray(format?.table_block_column_order);
      if (!columns.length) {
        const firstRow = blocks.get(children[0] ?? "");
        columns = Object.keys(firstRow?.properties ?? {});
      }
      const hasHeader = format?.table_block_column_header === true;
      if (!hasHeader && columns.length) {
        lines.push(`${indent}| ${columns.map(() => "").join(" | ")} |`);
        lines.push(`${indent}| ${columns.map(() => "---").join(" | ")} |`);
      }
      let firstRow = true;
      for (const rowId of children) {
        const row = blocks.get(rowId);
        if (!row?.properties) continue;
        lines.push(
          `${indent}| ${columns.map((column) => tableCell(row.properties?.[column])).join(" | ")} |`,
        );
        if (firstRow && hasHeader) {
          lines.push(`${indent}| ${columns.map(() => "---").join(" | ")} |`);
        }
        firstRow = false;
      }
      lines.push("");
    } else {
      if (text) lines.push(`${indent}${text}`, "");
      if (children.length) lines.push(renderBlocks(children, blocks, depth + 1, indent));
    }
  }

  return lines.join("\n");
}

async function fetchBlockTree(id: string, signal?: AbortSignal): Promise<Map<string, NotionBlock>> {
  const blocks = new Map<string, NotionBlock>();
  let cursor: { stack: unknown[] } = { stack: [] };

  for (let chunkNumber = 0; chunkNumber < MAX_PAGE_CHUNKS; chunkNumber++) {
    const response = await notionRead<PageChunkResponse>(
      "loadPageChunk",
      {
        pageId: id,
        limit: 200,
        cursor,
        chunkNumber,
        verticalColumns: false,
      },
      signal,
    );
    for (const [blockId, stored] of Object.entries(response.recordMap?.block ?? {})) {
      const block = unwrap(stored);
      if (block) blocks.set(blockId, block);
    }

    if (!response.cursor?.stack?.length) break;
    cursor = { stack: response.cursor.stack };
  }
  return blocks;
}

async function readDatabase(
  pageId: string,
  block: NotionBlock,
  spaceId: string,
  signal?: AbortSignal,
): Promise<ReadResult> {
  const collectionId = block.collection_id;
  const viewId = stringArray(block.view_ids)[0];
  if (!collectionId || !viewId)
    throw new Error("Could not find this database's collection or view.");

  const collectionResponse = await notionRead<NotionResponse>(
    "syncRecordValues",
    {
      requests: [{ pointer: { table: "collection", id: collectionId, spaceId }, version: -1 }],
    },
    signal,
  );
  const collection = unwrap(collectionResponse.recordMap?.collection?.[collectionId]);
  if (!collection) throw new Error(`Database ${collectionId} was not found or is not accessible.`);

  const queryResponse = await notionRead<QueryCollectionResponse>(
    "queryCollection",
    {
      collection: { id: collectionId, spaceId },
      collectionView: { id: viewId, spaceId },
      loader: {
        type: "reducer",
        reducers: {
          collection_group_results: { type: "results", limit: MAX_DATABASE_ROWS },
        },
        searchQuery: "",
        userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    },
    signal,
  );

  const rowIds = stringArray(
    queryResponse.result?.reducerResults?.collection_group_results?.blockIds,
  );
  const schema = collection.schema ?? {};
  const schemaEntries = Object.entries(schema);
  const title = richTextToPlainText(collection.name) || "(untitled database)";
  const url = notionUrl(pageId);

  if (!rowIds.length) {
    return { title, url, type: "database", markdown: `# ${title}\n\n*No entries*` };
  }

  const names = schemaEntries.map(([, property]) => property.name || "(unnamed)");
  const header = `| ${names.map((name) => name.replaceAll("|", "\\|")).join(" | ")} |`;
  const separator = `| ${names.map(() => "---").join(" | ")} |`;
  const rows = rowIds.flatMap((rowId) => {
    const row = unwrap(queryResponse.recordMap?.block?.[rowId]);
    if (!row?.properties) return [];
    return [
      `| ${schemaEntries.map(([propertyId]) => tableCell(row.properties?.[propertyId])).join(" | ")} |`,
    ];
  });
  const limitNote =
    rowIds.length >= MAX_DATABASE_ROWS
      ? `\n\n*Showing the first ${MAX_DATABASE_ROWS} entries from this view.*`
      : "";

  return {
    title,
    url,
    type: "database",
    markdown: `# ${title}\n\n${header}\n${separator}\n${rows.join("\n")}${limitNote}`,
  };
}

async function readNotion(input: string, signal?: AbortSignal): Promise<ReadResult> {
  const id = parseNotionId(input);
  const response = await notionRead<NotionResponse>(
    "syncRecordValues",
    { requests: [{ pointer: { table: "block", id }, version: -1 }] },
    signal,
  );
  const stored = response.recordMap?.block?.[id];
  const block = unwrap(stored);
  if (!block) throw new Error(`Notion block ${id} was not found or is not accessible.`);

  if (block.type === "collection_view" || block.type === "collection_view_page") {
    const spaceId = stored?.spaceId ?? block.space_id;
    if (!spaceId) throw new Error(`Could not determine the workspace for database ${id}.`);
    return readDatabase(id, block, spaceId, signal);
  }

  const blocks = await fetchBlockTree(id, signal);
  const page = blocks.get(id) ?? block;
  const title = richTextToPlainText(blockProperty(page, "title")) || "(untitled)";
  const body = renderBlocks(stringArray(page.content), blocks).trimEnd();
  return {
    title,
    type: "page",
    url: notionUrl(id),
    markdown: `# ${title}${body ? `\n\n${body}` : ""}`,
  };
}

async function discoverSpaces(signal?: AbortSignal): Promise<SpaceInfo[]> {
  if (cachedSpaces) return cachedSpaces;

  const response = asRecord(await notionRead<unknown>("getSpaces", {}, signal));
  const ids = new Set<string>();
  for (const rawUser of Object.values(response ?? {})) {
    const user = asRecord(rawUser);
    const spaceViews = asRecord(user?.space_view);
    for (const rawView of Object.values(spaceViews ?? {})) {
      const view = unwrap(rawView as StoredRecord<Record<string, unknown>>);
      const id = typeof view?.space_id === "string" ? view.space_id : undefined;
      if (id) ids.add(id);
    }
    for (const id of Object.keys(asRecord(user?.space) ?? {})) ids.add(id);
  }

  if (!ids.size) {
    cachedSpaces = [];
    return cachedSpaces;
  }

  const names = await notionRead<NotionResponse>(
    "syncRecordValues",
    {
      requests: [...ids].map((id) => ({
        pointer: { table: "space", id },
        version: -1,
      })),
    },
    signal,
  );
  cachedSpaces = [...ids].map((id) => ({
    id,
    name: unwrap(names.recordMap?.space?.[id])?.name || "(unnamed workspace)",
  }));
  return cachedSpaces;
}

async function searchNotion(
  query: string,
  spaceId?: string,
  signal?: AbortSignal,
): Promise<{ results: SearchResult[]; spaces: number }> {
  const spaces = spaceId ? [{ id: spaceId, name: "" }] : await discoverSpaces(signal);
  const results: SearchResult[] = [];

  for (const space of spaces) {
    const response = await notionRead<SearchResponse>(
      "search",
      {
        type: "BlocksInSpace",
        query,
        spaceId: space.id,
        limit: SEARCH_RESULTS_PER_SPACE,
        filters: {
          isDeletedOnly: false,
          excludeTemplates: true,
          navigableBlockContentOnly: true,
          requireEditPermissions: false,
          ancestors: [],
          createdBy: [],
          editedBy: [],
          lastEditedTime: {},
          createdTime: {},
        },
        sort: { field: "relevance" },
        source: "quick_find",
      },
      signal,
    );

    for (const match of response.results ?? []) {
      if (typeof match.id !== "string") continue;
      const block = unwrap(response.recordMap?.block?.[match.id]);
      let title = richTextToMarkdown(blockProperty(block, "title"));
      if (!title && block?.collection_id) {
        title = richTextToMarkdown(
          unwrap(response.recordMap?.collection?.[block.collection_id])?.name,
        );
      }
      results.push({
        id: match.id,
        title: title || "(untitled)",
        type: block?.type ?? "unknown",
        url: notionUrl(match.id),
        space: space.name,
      });
    }
  }

  return { results, spaces: spaces.length };
}

function truncateToolOutput(output: string): { text: string; truncation?: TruncationResult } {
  const truncation = truncateHead(output);
  if (!truncation.truncated) return { text: truncation.content };

  const notice = truncation.firstLineExceedsLimit
    ? `[Output omitted because its first line exceeds ${formatSize(DEFAULT_MAX_BYTES)}.]`
    : `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
  return {
    text: `${truncation.content}${truncation.content ? "\n\n" : ""}${notice}`,
    truncation,
  };
}

const NotionSearchParams = Type.Object({
  query: Type.String({
    minLength: 1,
    description: "Keyword query for Notion pages and databases.",
  }),
  spaceId: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Optional Notion workspace ID. Omit it to search every accessible workspace.",
    }),
  ),
});

const NotionReadParams = Type.Object({
  url: Type.String({
    minLength: 1,
    description: "A Notion page/database URL or a raw 32-character/UUID ID.",
  }),
});

type NotionSearchInput = Static<typeof NotionSearchParams>;
type NotionReadInput = Static<typeof NotionReadParams>;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "notion_search",
    label: "Notion Search",
    description: [
      "Search accessible Notion workspaces for pages and databases without changing anything.",
      `Returns at most ${SEARCH_RESULTS_PER_SPACE} results per workspace and truncates output at ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
      "Authentication uses NOTION_TOKEN when set, otherwise the logged-in Notion.app account on macOS.",
    ].join("\n"),
    promptSnippet: "Search Notion for pages and databases (read-only)",
    promptGuidelines: [
      "Use notion_search to find a Notion page or database when its URL or ID is not known.",
    ],
    parameters: NotionSearchParams,
    async execute(_toolCallId, params: NotionSearchInput, signal) {
      const query = params.query.trim();
      if (!query) throw new Error("Notion search query cannot be empty.");
      const { results, spaces } = await searchNotion(query, params.spaceId?.trim(), signal);
      if (!results.length) {
        return {
          content: [{ type: "text" as const, text: "No Notion results found." }],
          details: { query, count: 0, spaces },
        };
      }

      const output = results
        .map(
          (result) =>
            `- **${result.title}** (${result.type})${result.space ? ` [${result.space}]` : ""} — ${result.url}`,
        )
        .join("\n");
      const truncated = truncateToolOutput(output);
      return {
        content: [{ type: "text" as const, text: truncated.text }],
        details: {
          query,
          count: results.length,
          spaces,
          ...(truncated.truncation ? { truncation: truncated.truncation } : {}),
        },
      };
    },
  });

  pi.registerTool({
    name: "notion_read",
    label: "Notion Read",
    description: [
      "Read a Notion page or database without changing anything.",
      "Pages are converted to Markdown; the first database view is returned as a Markdown table.",
      `Output is truncated at ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
      "Authentication uses NOTION_TOKEN when set, otherwise the logged-in Notion.app account on macOS.",
    ].join("\n"),
    promptSnippet: "Read Notion pages and databases as Markdown (read-only)",
    promptGuidelines: [
      "Use notion_read with a URL returned by notion_search when the user needs the page or database contents.",
    ],
    parameters: NotionReadParams,
    async execute(_toolCallId, params: NotionReadInput, signal) {
      const result = await readNotion(params.url, signal);
      const truncated = truncateToolOutput(result.markdown);
      return {
        content: [{ type: "text" as const, text: truncated.text }],
        details: {
          type: result.type,
          title: result.title,
          url: result.url,
          ...(truncated.truncation ? { truncation: truncated.truncation } : {}),
        },
      };
    },
  });
}
