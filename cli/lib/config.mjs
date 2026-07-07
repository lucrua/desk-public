/**
 * config.mjs — CLI configuration (Desk URL + auth) for desk.mjs.
 *
 * Config file: ~/.config/desk/config.json (override with DESK_CONFIG), written
 * chmod 600 because it can hold a service-token secret. Shape:
 *   { hubUrl, cfAccessClientId, cfAccessClientSecret, devRole }
 *
 * Precedence is always ENV > config file > default, so a shell that exports
 * HUB_URL / CF_ACCESS_* / HUB_DEV_ROLE overrides the saved config, and CI can
 * stay env-only. `desk config` writes the file; nothing else does.
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const DEFAULT_URL = "http://localhost:3000";

export function configPath() {
  if (process.env.DESK_CONFIG) return process.env.DESK_CONFIG;
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "desk", "config.json");
}

export function loadConfig() {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) ?? {};
  } catch {
    return {}; // corrupt config → behave as if unset (env/defaults still work)
  }
}

export function saveConfig(cfg) {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(p, 0o600); // tighten even if the file already existed
  } catch {
    /* best effort */
  }
  return p;
}

/** Effective hub base URL: ENV HUB_URL > config.hubUrl > default. */
export function resolveHubUrl(cfg = loadConfig()) {
  return process.env.HUB_URL ?? cfg.hubUrl ?? DEFAULT_URL;
}

/** Dev-mode role header value: ENV HUB_DEV_ROLE > config.devRole > 'admin'. */
export function resolveDevRole(cfg = loadConfig()) {
  return process.env.HUB_DEV_ROLE ?? cfg.devRole ?? "admin";
}

/**
 * Auth headers. A Cloudflare Access service token (ENV wins over config) is used
 * when both id + secret are present; otherwise the dev role header.
 */
export function authHeaders(cfg = loadConfig()) {
  const id = process.env.CF_ACCESS_CLIENT_ID ?? cfg.cfAccessClientId;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET ?? cfg.cfAccessClientSecret;
  if (id && secret) {
    return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
  }
  return { "x-dev-role": resolveDevRole(cfg) };
}
