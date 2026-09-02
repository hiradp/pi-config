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

  // Notion appends the id after the slug, so the last match wins over a hex-looking slug.
  const match = candidate
    .match(/[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi)
    ?.at(-1);
  if (match) {
    const compact = match.replaceAll("-", "");
    return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
  }
  throw new Error(`Could not extract a Notion page or database ID from: ${input}`);
}

export function notionUrl(id: string): string {
  return `https://www.notion.so/${id.replaceAll("-", "")}`;
}

export function blockProperty(block: NotionBlock | undefined, name: string): unknown {
  return block?.properties?.[name];
}

// Mirrors session-review's sanitizeDisplayText, except tabs and line breaks survive because
// the output is Markdown rather than a single display line.
export function sanitizeDisplayText(value: string): string {
  let result = "";
  let index = 0;
  const consumeControlString = (start: number): number => {
    let cursor = start;
    while (cursor < value.length) {
      const code = value.charCodeAt(cursor);
      if (code === 0x07 || code === 0x9c) return cursor + 1;
      if (code === 0x1b && value.charCodeAt(cursor + 1) === 0x5c) return cursor + 2;
      cursor++;
    }
    return cursor;
  };
  const consumeCsi = (start: number): number => {
    let cursor = start;
    while (cursor < value.length) {
      const code = value.charCodeAt(cursor++);
      if (code >= 0x40 && code <= 0x7e) break;
    }
    return cursor;
  };

  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const next = value.charCodeAt(index + 1);
      if (next === 0x5b) index = consumeCsi(index + 2);
      else if (next === 0x5d || next === 0x50 || next === 0x5f || next === 0x5e) {
        index = consumeControlString(index + 2);
      } else index += 2;
      continue;
    }
    if (code === 0x9b) {
      index = consumeCsi(index + 1);
      continue;
    }
    if (code === 0x90 || code === 0x9d || code === 0x9e || code === 0x9f) {
      index = consumeControlString(index + 1);
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      if (code === 0x09 || code === 0x0a) result += value[index];
      else if (code === 0x0d && value.charCodeAt(index + 1) !== 0x0a) result += "\n";
      index++;
      continue;
    }
    result += value[index];
    index++;
  }
  return result;
}
