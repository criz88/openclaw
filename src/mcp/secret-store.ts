import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../config/paths.js";

const KEYCHAIN_SERVICE = "openclaw.mcp";
const FALLBACK_SECRETS_PATH = path.join(STATE_DIR, "credentials", "mcp-secrets.json");

export type SecretStoreWriteResult = {
  ok: boolean;
  error?: string;
};

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

function runPowerShell(script: string, env: Record<string, string>): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function runMacSecurity(args: string[]): string {
  return execFileSync("security", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function readFallbackStore(): Record<string, string> {
  try {
    const raw = fs.readFileSync(FALLBACK_SECRETS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const id = String(key || "").trim();
      const secret = typeof value === "string" ? value : "";
      if (id && secret) {
        next[id] = secret;
      }
    }
    return next;
  } catch {
    return {};
  }
}

function writeFallbackStore(store: Record<string, string>) {
  fs.mkdirSync(path.dirname(FALLBACK_SECRETS_PATH), { recursive: true });
  fs.writeFileSync(FALLBACK_SECRETS_PATH, JSON.stringify(store, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function setSecret(secretRef: string, secret: string): SecretStoreWriteResult {
  const ref = String(secretRef || "").trim();
  const value = String(secret || "");
  if (!ref) return { ok: false, error: "secret ref is required" };
  if (!value.trim()) return { ok: false, error: "secret value is required" };

  try {
    if (isMac) {
      runMacSecurity(["add-generic-password", "-a", ref, "-s", KEYCHAIN_SERVICE, "-w", value, "-U"]);
      return { ok: true };
    }

    if (isWin) {
      runPowerShell(
        [
          "$ErrorActionPreference='Stop'",
          "[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]",
          "$vault=New-Object Windows.Security.Credentials.PasswordVault",
          "$resource=$env:OPENCLAW_MCP_RESOURCE",
          "$account=$env:OPENCLAW_MCP_ACCOUNT",
          "$secret=$env:OPENCLAW_MCP_SECRET",
          "try { $existing=$vault.Retrieve($resource,$account); if($existing){$vault.Remove($existing)} } catch {}",
          "$cred=New-Object Windows.Security.Credentials.PasswordCredential($resource,$account,$secret)",
          "$vault.Add($cred)",
          "Write-Output 'ok'",
        ].join(";"),
        {
          OPENCLAW_MCP_RESOURCE: KEYCHAIN_SERVICE,
          OPENCLAW_MCP_ACCOUNT: ref,
          OPENCLAW_MCP_SECRET: value,
        },
      );
      return { ok: true };
    }

    const store = readFallbackStore();
    store[ref] = value;
    writeFallbackStore(store);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message || error || "set secret failed") };
  }
}

export function getSecret(secretRef: string): string | null {
  const ref = String(secretRef || "").trim();
  if (!ref) return null;
  try {
    if (isMac) {
      return runMacSecurity(["find-generic-password", "-a", ref, "-s", KEYCHAIN_SERVICE, "-w"]);
    }
    if (isWin) {
      const output = runPowerShell(
        [
          "$ErrorActionPreference='Stop'",
          "[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]",
          "$vault=New-Object Windows.Security.Credentials.PasswordVault",
          "$resource=$env:OPENCLAW_MCP_RESOURCE",
          "$account=$env:OPENCLAW_MCP_ACCOUNT",
          "$cred=$vault.Retrieve($resource,$account)",
          "$cred.RetrievePassword()",
          "Write-Output $cred.Password",
        ].join(";"),
        {
          OPENCLAW_MCP_RESOURCE: KEYCHAIN_SERVICE,
          OPENCLAW_MCP_ACCOUNT: ref,
        },
      );
      return output || null;
    }
    const store = readFallbackStore();
    return store[ref] || null;
  } catch {
    return null;
  }
}

export function deleteSecret(secretRef: string): SecretStoreWriteResult {
  const ref = String(secretRef || "").trim();
  if (!ref) return { ok: true };

  try {
    if (isMac) {
      try {
        runMacSecurity(["delete-generic-password", "-a", ref, "-s", KEYCHAIN_SERVICE]);
      } catch {
        // ignore when already absent
      }
      return { ok: true };
    }
    if (isWin) {
      runPowerShell(
        [
          "$ErrorActionPreference='Stop'",
          "[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]",
          "$vault=New-Object Windows.Security.Credentials.PasswordVault",
          "$resource=$env:OPENCLAW_MCP_RESOURCE",
          "$account=$env:OPENCLAW_MCP_ACCOUNT",
          "try { $cred=$vault.Retrieve($resource,$account); if($cred){$vault.Remove($cred)} } catch {}",
          "Write-Output 'ok'",
        ].join(";"),
        {
          OPENCLAW_MCP_RESOURCE: KEYCHAIN_SERVICE,
          OPENCLAW_MCP_ACCOUNT: ref,
        },
      );
      return { ok: true };
    }

    const store = readFallbackStore();
    if (Object.prototype.hasOwnProperty.call(store, ref)) {
      delete store[ref];
      writeFallbackStore(store);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message || error || "delete secret failed") };
  }
}

export function hasSecret(secretRef: string): boolean {
  return Boolean(getSecret(secretRef));
}
