import { extractToken, invalidateToken } from "./auth.ts";
import {
  MAX_BLOCK_DEPTH,
  renderBlocks,
  richTextToMarkdown,
  richTextToPlainText,
  tableCell,
} from "./markdown.ts";
import type {
  NotionBlock,
  NotionResponse,
  PageChunkResponse,
  QueryCollectionResponse,
  ReadEndpoint,
  ReadResult,
  SearchResponse,
  SearchResult,
  SpaceInfo,
  StoredRecord,
} from "./types.ts";
import {
  asRecord,
  blockProperty,
  notionUrl,
  parseNotionId,
  sanitizeDisplayText,
  stringArray,
  unwrap,
} from "./utils.ts";

const API_TIMEOUT_MS = 20_000;
export const MAX_DATABASE_ROWS = 100;
export const MAX_PAGE_CHUNKS = 10;
export const MAX_MISSING_BLOCK_REQUESTS = 10;
const SYNC_BLOCK_BATCH_SIZE = 100;
export const SEARCH_RESULTS_PER_SPACE = 20;

let cachedSpaces: SpaceInfo[] | undefined;

function postNotion(
  endpoint: ReadEndpoint,
  body: unknown,
  token: string,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(API_TIMEOUT_MS);
  return fetch(`https://www.notion.so/api/v3/${endpoint}`, {
    method: "POST",
    headers: {
      Cookie: `token_v2=${encodeURIComponent(token)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
}

async function notionRead<T>(
  endpoint: ReadEndpoint,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const token = await extractToken({ signal });
  let response = await postNotion(endpoint, body, token, signal);
  if (response.status === 401) {
    // Logging in again changes the cookie, so re-extract it once before giving up.
    invalidateToken();
    const freshToken = await extractToken({ signal });
    if (freshToken !== token) response = await postNotion(endpoint, body, freshToken, signal);
  }

  if (!response.ok) {
    const responseText = sanitizeDisplayText((await response.text()).trim()).slice(0, 500);
    throw new Error(
      `Notion read failed (${response.status})${responseText ? `: ${responseText}` : ""}`,
    );
  }
  return (await response.json()) as T;
}

function mergeBlocks(
  blocks: Map<string, NotionBlock>,
  records: Record<string, StoredRecord<NotionBlock>> | undefined,
): void {
  for (const [blockId, stored] of Object.entries(records ?? {})) {
    const block = unwrap(stored);
    if (block) blocks.set(blockId, block);
  }
}

function referencedBlockIds(rootId: string, blocks: Map<string, NotionBlock>): string[] {
  const depths = new Map<string, number>();

  const visit = (id: string, depth: number): void => {
    if (depth > MAX_BLOCK_DEPTH) return;
    const previousDepth = depths.get(id);
    if (previousDepth !== undefined && previousDepth <= depth) return;
    depths.set(id, depth);

    const block = blocks.get(id);
    if (!block) return;
    if (id !== rootId && (block.type === "page" || block.type === "collection_view_page")) {
      return;
    }

    const childDepth =
      id === rootId
        ? 0
        : block.type === "column_list" || block.type === "table"
          ? depth
          : depth + 1;
    for (const childId of stringArray(block.content)) visit(childId, childDepth);

    const pointer = asRecord(block.format?.transclusion_reference_pointer);
    const sourceId = typeof pointer?.id === "string" ? pointer.id : undefined;
    if (sourceId) visit(sourceId, depth);
  };

  visit(rootId, -1);
  return [...depths.keys()];
}

type MissingContent = "limit" | "unavailable" | undefined;

async function fetchMissingBlocks(
  rootId: string,
  blocks: Map<string, NotionBlock>,
  signal?: AbortSignal,
): Promise<MissingContent> {
  const requested = new Set<string>();
  let requestCount = 0;

  while (requestCount < MAX_MISSING_BLOCK_REQUESTS) {
    const batch = referencedBlockIds(rootId, blocks)
      .filter((id) => !blocks.has(id) && !requested.has(id))
      .slice(0, SYNC_BLOCK_BATCH_SIZE);
    if (!batch.length) break;

    for (const id of batch) requested.add(id);
    const response = await notionRead<NotionResponse>(
      "syncRecordValues",
      {
        requests: batch.map((id) => ({
          pointer: { table: "block", id },
          version: -1,
        })),
      },
      signal,
    );
    mergeBlocks(blocks, response.recordMap?.block);
    requestCount++;
  }

  const unresolved = referencedBlockIds(rootId, blocks).filter((id) => !blocks.has(id));
  if (!unresolved.length) return undefined;
  return unresolved.some((id) => !requested.has(id)) ? "limit" : "unavailable";
}

async function fetchBlockTree(
  id: string,
  root: NotionBlock,
  signal?: AbortSignal,
): Promise<{ blocks: Map<string, NotionBlock>; missingContent: MissingContent }> {
  const blocks = new Map<string, NotionBlock>([[id, root]]);
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
    mergeBlocks(blocks, response.recordMap?.block);

    if (!response.cursor?.stack?.length) break;
    cursor = { stack: response.cursor.stack };
  }

  const missingContent = await fetchMissingBlocks(id, blocks, signal);
  return { blocks, missingContent };
}

async function readDatabase(
  pageId: string,
  block: NotionBlock,
  spaceId: string,
  signal?: AbortSignal,
): Promise<ReadResult> {
  const collectionId = block.collection_id;
  const viewId = stringArray(block.view_ids)[0];
  if (!collectionId || !viewId) {
    throw new Error("Could not find this database's collection or view.");
  }

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

export async function readNotion(input: string, signal?: AbortSignal): Promise<ReadResult> {
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

  const { blocks, missingContent } = await fetchBlockTree(id, block, signal);
  const page = blocks.get(id) ?? block;
  const title = richTextToPlainText(blockProperty(page, "title")) || "(untitled)";
  const body = renderBlocks(stringArray(page.content), blocks).trimEnd();
  const warning =
    missingContent === "limit"
      ? "*(Some nested content was omitted after reaching the Notion read limit.)*"
      : missingContent === "unavailable"
        ? "*(Some nested content was unavailable.)*"
        : "";
  const content = [body, warning].filter(Boolean).join("\n\n");
  return {
    title,
    type: "page",
    url: notionUrl(id),
    markdown: `# ${title}${content ? `\n\n${content}` : ""}`,
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

  // An empty list is more likely a transient response than a fact worth caching.
  if (!ids.size) return [];

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

export async function searchNotion(
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
