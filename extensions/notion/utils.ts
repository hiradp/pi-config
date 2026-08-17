import type { NotionBlock, StoredRecord } from "./types.ts";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function unwrap<T>(record: StoredRecord<T> | undefined): T | undefined {
  const value = record?.value;
  const wrapper = asRecord(value);
  return (wrapper && "value" in wrapper ? wrapper.value : value) as T | undefined;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function stringValue(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

export function parseNotionId(input: string): string {
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

export function notionUrl(id: string): string {
  return `https://www.notion.so/${id.replaceAll("-", "")}`;
}

export function blockProperty(block: NotionBlock | undefined, name: string): unknown {
  return block?.properties?.[name];
}
