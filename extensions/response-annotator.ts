import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

interface ExternalEditorResult {
  status: "complete" | "failed";
  content?: string;
  error?: string;
}

export interface EditorInvocation {
  command: string;
  args: string[];
  label: string;
}

export function findLastAssistantText(entries: readonly SessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant") continue;

    const text = entry.message.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("\n\n");
    if (text.trim()) return text;
  }

  return undefined;
}

function configuredEditorCommand(ctx: ExtensionContext): string {
  try {
    return SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    }).getExternalEditorCommand();
  } catch {
    return (
      process.env.VISUAL ||
      process.env.EDITOR ||
      (process.platform === "win32" ? "notepad" : "nano")
    );
  }
}

function unquote(value: string): string {
  const quote = value[0];
  return value.length >= 2 && (quote === '"' || quote === "'") && value.at(-1) === quote
    ? value.slice(1, -1)
    : value;
}

export function resolveEditorInvocation(
  requestedEditor: string,
  configuredCommand: string,
  platform: NodeJS.Platform = process.platform,
): EditorInvocation {
  const requested = unquote(requestedEditor.trim());
  if (!requested) {
    const [command, ...args] = configuredCommand.split(" ").filter(Boolean);
    return { command: command ?? "", args, label: configuredCommand };
  }

  switch (requested.toLowerCase()) {
    case "zed":
      return { command: "zed", args: ["--wait"], label: "zed --wait" };
    case "markedit":
      return platform === "darwin"
        ? { command: "open", args: ["-W", "-a", "MarkEdit"], label: "MarkEdit" }
        : { command: "markedit", args: [], label: "markedit" };
    default:
      return platform === "darwin"
        ? { command: "open", args: ["-W", "-a", requested], label: requested }
        : { command: requested, args: [], label: requested };
  }
}

async function editInExternalEditor(
  editor: EditorInvocation,
  content: string,
): Promise<ExternalEditorResult> {
  let directory: string | undefined;

  try {
    directory = await mkdtemp(join(tmpdir(), "pi-response-annotator-"));
    const filePath = join(directory, "response.md");
    await writeFile(filePath, content, "utf8");
    if (!editor.command) return { status: "failed", error: "No external editor is configured" };

    process.stdout.write(
      `Launching external editor: ${editor.label}\nPi will resume when the editor exits.\n`,
    );

    const outcome = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
      const child = spawn(editor.command, [...editor.args, filePath], {
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      child.once("error", (error) => resolve({ code: null, error }));
      child.once("close", (code) => resolve({ code }));
    });

    if (outcome.error) return { status: "failed", error: outcome.error.message };
    if (outcome.code !== 0) {
      return {
        status: "failed",
        error: `External editor exited with code ${outcome.code ?? "unknown"}`,
      };
    }

    const edited = await readFile(filePath, "utf8");
    return { status: "complete", content: edited.replace(/\r?\n$/, "") };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function openEditor(
  ctx: ExtensionContext,
  content: string,
  requestedEditor: string,
): Promise<ExternalEditorResult> {
  const editor = resolveEditorInvocation(requestedEditor, configuredEditorCommand(ctx));

  return ctx.ui.custom<ExternalEditorResult>((tui, _theme, _keybindings, done) => {
    tui.stop();

    void editInExternalEditor(editor, content)
      .catch((error: unknown) => ({
        status: "failed" as const,
        error: error instanceof Error ? error.message : String(error),
      }))
      .then((result) => {
        tui.start();
        tui.requestRender(true);
        done(result);
      });

    return {
      render: () => [],
      invalidate() {},
    };
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("annotate-response", {
    description: "Annotate the last assistant response externally (optionally: zed or markedit)",
    getArgumentCompletions: (prefix) => {
      const editors = ["zed", "markedit"];
      const matches = editors.filter((editor) => editor.startsWith(prefix.toLowerCase()));
      return matches.length > 0
        ? matches.map((editor) => ({ value: editor, label: editor }))
        : null;
    },
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("annotate-response requires interactive mode", "error");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the agent to finish before editing its response", "warning");
        return;
      }

      const response = findLastAssistantText(ctx.sessionManager.getBranch());
      if (!response) {
        ctx.ui.notify("No assistant response found", "warning");
        return;
      }

      const draft = ctx.ui.getEditorText();
      if (draft.trim()) {
        const replace = await ctx.ui.confirm(
          "Replace current draft?",
          "The annotated assistant response will replace the text currently in the chat editor.",
        );
        if (!replace) return;
      }

      const result = await openEditor(ctx, response, args);
      if (result.status === "failed") {
        ctx.ui.notify(result.error ?? "External editor failed", "error");
        return;
      }

      ctx.ui.setEditorText(result.content ?? "");
      ctx.ui.notify("Annotated response loaded into the chat editor", "info");
    },
  });
}
