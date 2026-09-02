import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const COMMAND_TIMEOUT_MS = 60_000;
const COOKIE_DATABASE = join(
  homedir(),
  "Library",
  "Application Support",
  "Notion",
  "Partitions",
  "notion",
  "Cookies",
);
const TOKEN_QUERY =
  "SELECT hex(encrypted_value) FROM cookies WHERE name='token_v2' AND host_key LIKE '%notion%' ORDER BY length(host_key) LIMIT 1;";
const DECRYPT_FAILURE = "Could not decrypt Notion's token_v2 cookie. Set NOTION_TOKEN instead.";

export type CommandRunner = (
  command: string,
  args: string[],
  signal?: AbortSignal,
) => Promise<string>;

export interface TokenOptions {
  signal?: AbortSignal;
  runCommand?: CommandRunner;
  cookieDatabase?: string;
}

const execFileAsync = promisify(execFile);

// Async so a Keychain prompt neither freezes the TUI nor blocks Ctrl-C.
const runCommand: CommandRunner = async (command, args, signal) => {
  const { stdout } = await execFileAsync(command, args, {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    signal,
  });
  return stdout;
};

let cachedToken: string | undefined;

export function invalidateToken(): void {
  cachedToken = undefined;
}

function describeFailure(command: string, error: unknown): string {
  const details = error as { code?: unknown; killed?: boolean; stderr?: unknown };
  if (details.code === "ENOENT") return `${command} is not installed`;
  if (details.killed) return `${command} timed out after ${COMMAND_TIMEOUT_MS / 1000}s`;
  const stderr = typeof details.stderr === "string" ? details.stderr.trim().split("\n")[0] : "";
  return stderr ? `${command} failed: ${stderr}` : `${command} failed`;
}

async function commandOutput(
  run: CommandRunner,
  command: string,
  args: string[],
  signal: AbortSignal | undefined,
  failure: string,
  advice: string,
): Promise<string> {
  try {
    return (await run(command, args, signal)).trim();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`${failure} (${describeFailure(command, error)}). ${advice}`);
  }
}

// Browsers show the cookie percent-encoded (v02%3A...), so accept that form as well.
function decodeToken(raw: string, failure: string): string {
  if (!/%[0-9a-f]{2}/i.test(raw)) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new Error(failure);
  }
}

async function copyCookieDatabase(source: string, target: string): Promise<void> {
  try {
    await copyFile(source, target);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new Error(
      code === "ENOENT"
        ? `Notion.app's cookie database was not found at ${source}. Make sure Notion.app is installed and logged in, or set NOTION_TOKEN.`
        : `Could not copy Notion.app's cookie database (${(error as Error).message}). Set NOTION_TOKEN instead.`,
    );
  }
  // A journal or WAL file can hold writes that are not in the main file yet.
  for (const suffix of ["-journal", "-wal"]) {
    await copyFile(`${source}${suffix}`, `${target}${suffix}`).catch(() => undefined);
  }
}

// Notion.app keeps an exclusive lock on the live database, so query a private copy.
async function readEncryptedCookie(
  run: CommandRunner,
  cookieDatabase: string,
  signal?: AbortSignal,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "notion-cookies-"));
  try {
    const copy = join(directory, "Cookies");
    await copyCookieDatabase(cookieDatabase, copy);
    return await commandOutput(
      run,
      "sqlite3",
      [copy, TOKEN_QUERY],
      signal,
      "Could not read Notion.app's cookie database",
      "Set NOTION_TOKEN instead.",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function decryptToken(encrypted: Buffer, safeStoragePassword: string): string {
  const version = encrypted.subarray(0, 3).toString("ascii");
  if (version !== "v10" && version !== "v11") {
    throw new Error(
      "Notion's cookie encryption format is not supported. Set NOTION_TOKEN instead.",
    );
  }

  const key = pbkdf2Sync(safeStoragePassword, "saltysalt", 1003, 16, "sha1");
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  decipher.setAutoPadding(false);
  let decrypted: Buffer;
  try {
    decrypted = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  } catch {
    throw new Error(DECRYPT_FAILURE);
  }
  const decoded = decrypted.toString("utf8");
  const tokenStart = decoded.indexOf("v0");
  if (tokenStart < 0) throw new Error(DECRYPT_FAILURE);

  const rawToken = Array.from(decoded.slice(tokenStart))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code <= 0x7e;
    })
    .join("");
  return decodeToken(
    rawToken,
    "Notion's token_v2 cookie had an unexpected encoding. Set NOTION_TOKEN instead.",
  );
}

export async function extractToken(options: TokenOptions = {}): Promise<string> {
  if (cachedToken) return cachedToken;

  const environmentToken = process.env.NOTION_TOKEN?.trim();
  if (environmentToken) {
    if (/[\r\n]/.test(environmentToken)) throw new Error("NOTION_TOKEN contains a newline.");
    cachedToken = decodeToken(environmentToken, "NOTION_TOKEN is not valid percent-encoding.");
    return cachedToken;
  }

  // An injected runner does not need the macOS tools.
  if (process.platform !== "darwin" && !options.runCommand) {
    throw new Error("Automatic Notion authentication requires macOS. Set NOTION_TOKEN instead.");
  }

  const run = options.runCommand ?? runCommand;
  const safeStoragePassword = await commandOutput(
    run,
    "security",
    ["find-generic-password", "-s", "Notion Safe Storage", "-w"],
    options.signal,
    "Could not read Notion Safe Storage from the macOS Keychain",
    "Make sure Notion.app is installed and logged in, or set NOTION_TOKEN.",
  );
  const encryptedHex = await readEncryptedCookie(
    run,
    options.cookieDatabase ?? COOKIE_DATABASE,
    options.signal,
  );
  if (!encryptedHex) {
    throw new Error("Notion's token_v2 cookie was not found. Make sure Notion.app is logged in.");
  }

  cachedToken = decryptToken(Buffer.from(encryptedHex, "hex"), safeStoragePassword);
  return cachedToken;
}
