import { Type, type Static } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { readNotion, SEARCH_RESULTS_PER_SPACE, searchNotion } from "./client.ts";

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
