import { execFileSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

let cachedToken: string | undefined;

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

export function extractToken(): string {
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

  const rawToken = Array.from(decoded.slice(tokenStart))
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
