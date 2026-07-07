/**
 * Tests for cli/lib/config.mjs — run as part of the vitest suite (the repo's
 * other CLI tests use the vitest API too). Also runnable standalone if desired.
 */
import { test, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configPath,
  loadConfig,
  saveConfig,
  resolveHubUrl,
  resolveDevRole,
  authHeaders,
} from "./config.mjs";

// Isolate every test from the real ~/.config and from ambient env.
function withEnv(overrides, fn) {
  const keys = ["DESK_CONFIG", "HUB_URL", "HUB_DEV_ROLE", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "XDG_CONFIG_HOME"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function tmpConfigFile() {
  const dir = mkdtempSync(join(tmpdir(), "desk-cfg-"));
  return { file: join(dir, "config.json"), dir };
}

test("configPath honors DESK_CONFIG override", () => {
  withEnv({ DESK_CONFIG: "/tmp/x/desk.json" }, () => {
    expect(configPath()).toBe("/tmp/x/desk.json");
  });
});

test("loadConfig returns {} when the file is missing", () => {
  const { file, dir } = tmpConfigFile();
  try {
    withEnv({ DESK_CONFIG: file }, () => expect(loadConfig()).toEqual({}));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveConfig writes chmod-600 JSON that loadConfig round-trips", () => {
  const { file, dir } = tmpConfigFile();
  try {
    withEnv({ DESK_CONFIG: file }, () => {
      const p = saveConfig({ hubUrl: "https://desk.example.com", devRole: "member" });
      expect(p).toBe(file);
      expect(existsSync(file)).toBe(true);
      // 0o600 = owner read/write only.
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(loadConfig()).toEqual({ hubUrl: "https://desk.example.com", devRole: "member" });
      expect(readFileSync(file, "utf8")).toMatch(/\n$/); // trailing newline
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig tolerates a corrupt file (→ {})", () => {
  const { file, dir } = tmpConfigFile();
  try {
    withEnv({ DESK_CONFIG: file }, () => {
      saveConfig({ hubUrl: "https://x" });
      writeFileSync(file, "{ not json"); // corrupt it
      expect(loadConfig()).toEqual({});
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveHubUrl precedence: ENV > config > default", () => {
  const { file, dir } = tmpConfigFile();
  try {
    // default
    withEnv({ DESK_CONFIG: file }, () => expect(resolveHubUrl()).toBe("http://localhost:3000"));
    // config
    withEnv({ DESK_CONFIG: file }, () => {
      saveConfig({ hubUrl: "https://from-config" });
      expect(resolveHubUrl()).toBe("https://from-config");
    });
    // env wins
    withEnv({ DESK_CONFIG: file, HUB_URL: "https://from-env" }, () => {
      saveConfig({ hubUrl: "https://from-config" });
      expect(resolveHubUrl()).toBe("https://from-env");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authHeaders: CF service token when both id+secret present, else dev-role", () => {
  const { file, dir } = tmpConfigFile();
  try {
    // config-based CF token
    withEnv({ DESK_CONFIG: file }, () => {
      saveConfig({ cfAccessClientId: "id-1", cfAccessClientSecret: "sec-1" });
      expect(authHeaders()).toEqual({ "CF-Access-Client-Id": "id-1", "CF-Access-Client-Secret": "sec-1" });
    });
    // ENV CF token overrides config
    withEnv({ DESK_CONFIG: file, CF_ACCESS_CLIENT_ID: "env-id", CF_ACCESS_CLIENT_SECRET: "env-sec" }, () => {
      saveConfig({ cfAccessClientId: "id-1", cfAccessClientSecret: "sec-1" });
      expect(authHeaders()).toEqual({ "CF-Access-Client-Id": "env-id", "CF-Access-Client-Secret": "env-sec" });
    });
    // no token → dev role (config, then env override)
    withEnv({ DESK_CONFIG: file }, () => {
      saveConfig({ devRole: "member" });
      expect(authHeaders()).toEqual({ "x-dev-role": "member" });
      expect(resolveDevRole()).toBe("member");
    });
    withEnv({ DESK_CONFIG: file, HUB_DEV_ROLE: "admin" }, () => {
      saveConfig({ devRole: "member" });
      expect(authHeaders()).toEqual({ "x-dev-role": "admin" });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
