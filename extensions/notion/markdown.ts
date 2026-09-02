import type { NotionBlock } from "./types.ts";
import {
  asRecord,
  blockProperty,
  notionUrl,
  sanitizeDisplayText,
  stringArray,
  stringValue,
} from "./utils.ts";

const MAX_BLOCK_DEPTH = 5;

function annotationValue(annotation: unknown[]): unknown {
  return annotation.length > 1 ? annotation[1] : undefined;
}

export function richTextToMarkdown(value: unknown): string {
  if (!Array.isArray(value)) return "";

  const markdown = value
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
  return sanitizeDisplayText(markdown);
}

export function richTextToPlainText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const text = value
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (!Array.isArray(chunk) || chunk[0] === undefined || chunk[0] === null) return "";
      return String(chunk[0]);
    })
    .join("");
  return sanitizeDisplayText(text);
}

export function tableCell(value: unknown): string {
  return richTextToMarkdown(value).replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

function codeFence(code: string): string {
  const longestRun = Math.max(2, ...[...code.matchAll(/`+/g)].map((run) => run[0].length));
  return "`".repeat(longestRun + 1);
}

export function renderBlocks(
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
      if (children.length) lines.push(renderBlocks(children, blocks, depth + 1, `${indent}  `));
    } else if (type === "header" || type === "sub_header" || type === "sub_sub_header") {
      const level = type === "header" ? "#" : type === "sub_header" ? "##" : "###";
      lines.push(`${indent}${level} ${text}`, "");
      if (children.length) lines.push(renderBlocks(children, blocks, depth + 1, indent));
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
      const code = richTextToPlainText(blockProperty(block, "title"));
      const fence = codeFence(code);
      lines.push(
        `${indent}${fence}${language}`,
        ...code.split("\n").map((line) => `${indent}${line}`),
        `${indent}${fence}`,
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
    } else if (type === "transclusion_reference") {
      // A synced block's children live on the original container it points at.
      const pointer = asRecord(format?.transclusion_reference_pointer);
      const source = blocks.get(stringValue(pointer, "id"));
      if (source) lines.push(renderBlocks(stringArray(source.content), blocks, depth + 1, indent));
      else lines.push(`${indent}*(synced block content unavailable)*`, "");
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
