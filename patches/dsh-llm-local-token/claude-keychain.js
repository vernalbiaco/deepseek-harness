import { execFile } from "node:child_process";
import { chown, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
/** The Keychain path exists on macOS only; other platforms use the file store. */
const HAS_KEYCHAIN = process.platform === "darwin";
const SERVICE = "Claude Code-credentials";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = Buffer.from("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl", "base64").toString("utf8");
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export const defaultClaudeAuthPath = () => join(homedir(), ".claude", ".credentials.json");

function parseSecurityPassword(stdout, stderr) {
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  const line = combined.split("\n").find((entry) => entry.startsWith("password: "));
  if (!line) throw new Error("security output did not contain a password line");
  let raw = line.slice("password: ".length);
  if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
  return raw;
}

async function readKeychainJson(service = SERVICE) {
  const { stdout, stderr } = await execFileAsync("security", ["find-generic-password", "-s", service, "-g"], { maxBuffer: 1024 * 1024 });
  return JSON.parse(parseSecurityPassword(stdout, stderr));
}

async function writeKeychainJson(data, service = SERVICE, account = userInfo().username) {
  await execFileAsync("security", ["add-generic-password", "-U", "-a", account, "-s", service, "-w", JSON.stringify(data)], { maxBuffer: 1024 * 1024 });
}

async function refreshClaudeKeychainToken(data, options = {}) {
  const current = data?.claudeAiOauth;
  const refreshToken = current?.refreshToken;
  if (!refreshToken) throw new Error("Claude Keychain entry has no claudeAiOauth.refreshToken");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Claude token refresh failed (${response.status}): ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const next = {
    ...data,
    claudeAiOauth: {
      ...current,
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? current.refreshToken,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 - REFRESH_SKEW_MS,
    },
  };
  await writeKeychainJson(next, options.service, options.account);
  return next.claudeAiOauth.accessToken;
}

async function readLegacyClaudeCredentialsFile(path) {
  const raw = await readFile(path, "utf8");
  const creds = JSON.parse(raw);
  const first = creds?.tokens?.[0];
  const token = first?.accessToken ?? first?.authToken ?? creds?.accessToken;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

// LOCAL PATCH (not upstream 1.3.2): current Claude Code builds write the
// `claudeAiOauth` payload to ~/.claude/.credentials.json on every platform, not
// only to the macOS Keychain. Upstream reads that shape from the Keychain alone,
// so on Linux the file is parsed, yields no legacy token, and the resolver dies
// on the darwin-only branch. These helpers give the file store the same
// read/refresh/write-back the Keychain store already has.

/** Read the whole credential document, or undefined when the file is absent. */
async function readClaudeCredentialsJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Replace the credential document atomically, preserving the file's mode and
 * owner: the host CLI runs as the owning user and a root-written 0600 file
 * would lock it out of its own login.
 */
async function writeClaudeCredentialsJson(path, data) {
  const previous = await stat(path);
  const temporary = `${path}.llm-local-token.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(data, undefined, 2) + "\n", { mode: 0o600 });
  await chown(temporary, previous.uid, previous.gid);
  await rename(temporary, path);
}

/** One in-flight refresh per credential path; concurrent callers share it. */
const fileRefreshes = new Map();

async function refreshClaudeFileToken(data, filePath) {
  const current = data?.claudeAiOauth;
  const refreshToken = current?.refreshToken;
  if (!refreshToken) throw new Error(`Claude credentials at ${filePath} have no claudeAiOauth.refreshToken`);
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Claude token refresh failed (${response.status}): ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const next = {
    ...data,
    claudeAiOauth: {
      ...current,
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? current.refreshToken,
      // True expiry, not expiry-minus-skew: the official CLI reads this same
      // field, and the skew belongs to the comparison below, not to storage.
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    },
  };
  await writeClaudeCredentialsJson(filePath, next);
  return next.claudeAiOauth.accessToken;
}

/** Resolve `claudeAiOauth` from the file store, refreshing in place near expiry. */
async function resolveClaudeFileOauth(filePath) {
  const data = await readClaudeCredentialsJson(filePath);
  const oauth = data?.claudeAiOauth;
  const token = oauth?.accessToken;
  if (typeof token !== "string" || token.length === 0) return undefined;
  if (typeof oauth.expiresAt !== "number" || oauth.expiresAt - Date.now() > REFRESH_SKEW_MS) return token;
  const pending = fileRefreshes.get(filePath)
    ?? refreshClaudeFileToken(data, filePath).finally(() => fileRefreshes.delete(filePath));
  fileRefreshes.set(filePath, pending);
  return pending;
}

export async function resolveClaudeAccessToken(options = {}) {
  // Old Claude Code builds wrote ~/.claude/.credentials.json. Prefer it when present.
  const filePath = options.filePath ?? defaultClaudeAuthPath();
  try {
    const token = await readLegacyClaudeCredentialsFile(filePath);
    if (token) return token;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  // LOCAL PATCH: current-shape payload in the same file, on every platform.
  const fileToken = await resolveClaudeFileOauth(filePath);
  if (fileToken) return fileToken;

  // New Claude Code builds store the account OAuth payload in macOS Keychain.
  // Elsewhere the file above is the only store, so say so plainly rather than
  // shelling out to a tool that does not exist.
  if (!HAS_KEYCHAIN) {
    throw new Error(`llm-local-token: no Claude credentials at ${filePath} (Keychain lookup is macOS-only on ${process.platform})`);
  }
  const service = options.service ?? SERVICE;
  const data = await readKeychainJson(service);
  const oauth = data?.claudeAiOauth;
  const token = oauth?.accessToken;
  if (typeof token !== "string" || token.length === 0) throw new Error(`Claude Keychain service "${service}" has no claudeAiOauth.accessToken`);
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt - Date.now() <= REFRESH_SKEW_MS) {
    return refreshClaudeKeychainToken(data, { service, account: options.account });
  }
  return token;
}
