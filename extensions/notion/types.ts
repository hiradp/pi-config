export type ReadEndpoint =
  | "getSpaces"
  | "loadPageChunk"
  | "queryCollection"
  | "search"
  | "syncRecordValues";

export interface StoredRecord<T> {
  value?: T | { value?: T };
  spaceId?: string;
}

export interface NotionBlock {
  type?: string;
  properties?: Record<string, unknown>;
  content?: unknown;
  format?: Record<string, unknown>;
  collection_id?: string;
  view_ids?: unknown;
  space_id?: string;
}

export interface NotionCollection {
  name?: unknown;
  schema?: Record<string, { name?: string }>;
}

export interface NotionSpace {
  name?: string;
}

export interface RecordMap {
  block?: Record<string, StoredRecord<NotionBlock>>;
  collection?: Record<string, StoredRecord<NotionCollection>>;
  space?: Record<string, StoredRecord<NotionSpace>>;
}

export interface NotionResponse {
  recordMap?: RecordMap;
}

export interface PageChunkResponse extends NotionResponse {
  cursor?: { stack?: unknown[] };
}

export interface SearchResponse extends NotionResponse {
  results?: Array<{ id?: unknown }>;
}

export interface QueryCollectionResponse extends NotionResponse {
  result?: {
    reducerResults?: {
      collection_group_results?: { blockIds?: unknown };
    };
  };
}

export interface SpaceInfo {
  id: string;
  name: string;
}

export interface SearchResult {
  id: string;
  title: string;
  type: string;
  url: string;
  space: string;
}

export interface ReadResult {
  title: string;
  type: "database" | "page";
  url: string;
  markdown: string;
}
