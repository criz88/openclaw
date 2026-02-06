import { DisconnectReason } from "@whiskeysockets/baileys";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/config.js";
import { danger, info, success } from "../globals.js";
import { logInfo } from "../logger.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { resolveWhatsAppAccount } from "./accounts.js";
import { renderQrPngBase64 } from "./qr-image.js";
import {
  createWaSocket,
  formatError,
  getStatusCode,
  logoutWeb,
  readWebSelfId,
  waitForWaConnection,
  webAuthExists,
} from "./session.js";

type WaSocket = Awaited<ReturnType<typeof createWaSocket>>;

type ActiveLogin = {
  accountId: string;
  authDir: string;
  isLegacyAuthDir: boolean;
  id: string;
  sock: WaSocket;
  startedAt: number;
  qr?: string;
  qrDataUrl?: string;
  restartAttempts: number;
  verbose: boolean;
  waiter?: Promise<{ ok: boolean; err?: unknown }>;
};

const ACTIVE_LOGIN_TTL_MS = 3 * 60_000;
const MAX_RESTART_ATTEMPTS = 1;
const activeLogins = new Map<string, ActiveLogin>();

function closeSocket(sock: WaSocket) {
  try {
    sock.ws?.close();
  } catch {
    // ignore
  }
}

async function resetActiveLogin(accountId: string, reason?: string) {
  const login = activeLogins.get(accountId);
  if (login) {
    closeSocket(login.sock);
    activeLogins.delete(accountId);
  }
  if (reason) {
    logInfo(reason);
  }
}

function isLoginFresh(login: ActiveLogin) {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

async function setLoginQrData(login: ActiveLogin, qr: string) {
  login.qr = qr;
  try {
    const base64 = await renderQrPngBase64(qr);
    login.qrDataUrl = `data:image/png;base64,${base64}`;
  } catch {
    // keep raw qr only
  }
}

function waitWithTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T | "timeout"> {
  const normalized =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? timeoutMs > 0
        ? Math.max(timeoutMs, 1000)
        : null
      : 120_000;
  if (normalized === null) {
    return promise;
  }
  return Promise.race([promise, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), normalized))]);
}

function getOrCreateWaiter(login: ActiveLogin): Promise<{ ok: boolean; err?: unknown }> {
  if (login.waiter) {
    return login.waiter;
  }
  login.waiter = waitForWaConnection(login.sock)
    .then(() => ({ ok: true as const }))
    .catch((err) => ({ ok: false as const, err }))
    .finally(() => {
      const current = activeLogins.get(login.accountId);
      if (current?.id === login.id) {
        current.waiter = undefined;
      }
    });
  return login.waiter;
}

async function restartSocketOnce(login: ActiveLogin, runtime: RuntimeEnv): Promise<boolean> {
  if (login.restartAttempts >= MAX_RESTART_ATTEMPTS) {
    return false;
  }
  login.restartAttempts += 1;
  runtime.log(info("WhatsApp asked for a restart after pairing (code 515); restarting connection once..."));
  closeSocket(login.sock);
  try {
    const sock = await createWaSocket(false, login.verbose, {
      authDir: login.authDir,
      onQr: (qr: string) => {
        const current = activeLogins.get(login.accountId);
        if (current?.id !== login.id) {
          return;
        }
        void setLoginQrData(current, qr);
      },
    });
    login.sock = sock;
    login.waiter = undefined;
    return true;
  } catch {
    return false;
  }
}

export async function startWebLoginWithQr(
  opts: {
    verbose?: boolean;
    timeoutMs?: number;
    force?: boolean;
    accountId?: string;
    runtime?: RuntimeEnv;
  } = {},
): Promise<{ qrDataUrl?: string; message: string }> {
  const runtime = opts.runtime ?? defaultRuntime;
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId: opts.accountId });
  const hasWeb = await webAuthExists(account.authDir);
  const selfId = readWebSelfId(account.authDir);
  if (hasWeb && !opts.force) {
    const who = selfId.e164 ?? selfId.jid ?? "unknown";
    return {
      message: `WhatsApp is already linked (${who}). Say “relink” if you want a fresh QR.`,
    };
  }

  const existing = activeLogins.get(account.accountId);
  if (existing && isLoginFresh(existing) && existing.qrDataUrl && !opts.force) {
    return {
      qrDataUrl: existing.qrDataUrl,
      message: "QR already active. Scan it in WhatsApp → Linked Devices.",
    };
  }

  await resetActiveLogin(account.accountId);

  let resolveQr: ((qr: string) => void) | null = null;
  let rejectQr: ((err: Error) => void) | null = null;
  const qrPromise = new Promise<string>((resolve, reject) => {
    resolveQr = resolve;
    rejectQr = reject;
  });

  const qrTimer = setTimeout(
    () => {
      rejectQr?.(new Error("Timed out waiting for WhatsApp QR"));
    },
    Math.max(opts.timeoutMs ?? 30_000, 5000),
  );

  let sock: WaSocket;
  try {
    sock = await createWaSocket(false, Boolean(opts.verbose), {
      authDir: account.authDir,
      onQr: (qr: string) => {
        const current = activeLogins.get(account.accountId);
        if (current) {
          void setLoginQrData(current, qr);
        }
        clearTimeout(qrTimer);
        runtime.log(info("WhatsApp QR received."));
        resolveQr?.(qr);
      },
    });
  } catch (err) {
    clearTimeout(qrTimer);
    await resetActiveLogin(account.accountId);
    return {
      message: `Failed to start WhatsApp login: ${String(err)}`,
    };
  }

  const login: ActiveLogin = {
    accountId: account.accountId,
    authDir: account.authDir,
    isLegacyAuthDir: account.isLegacyAuthDir,
    id: randomUUID(),
    sock,
    startedAt: Date.now(),
    restartAttempts: 0,
    verbose: Boolean(opts.verbose),
  };
  activeLogins.set(account.accountId, login);

  let qr: string;
  try {
    qr = await qrPromise;
  } catch (err) {
    clearTimeout(qrTimer);
    await resetActiveLogin(account.accountId);
    return {
      message: `Failed to get QR: ${String(err)}`,
    };
  }

  const base64 = await renderQrPngBase64(qr);
  login.qrDataUrl = `data:image/png;base64,${base64}`;
  return {
    qrDataUrl: login.qrDataUrl,
    message: "Scan this QR in WhatsApp → Linked Devices.",
  };
}

export async function waitForWebLogin(
  opts: { timeoutMs?: number; runtime?: RuntimeEnv; accountId?: string } = {},
): Promise<{ connected: boolean; message: string; qrDataUrl?: string }> {
  const runtime = opts.runtime ?? defaultRuntime;
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId: opts.accountId });
  const login = activeLogins.get(account.accountId);
  if (!login) {
    return {
      connected: false,
      message: "No active WhatsApp login in progress.",
    };
  }

  if (!isLoginFresh(login)) {
    await resetActiveLogin(account.accountId);
    return {
      connected: false,
      message: "The login QR expired. Ask me to generate a new one.",
    };
  }

  const first = await waitWithTimeout(getOrCreateWaiter(login), opts.timeoutMs);
  if (first === "timeout") {
    return {
      connected: false,
      message: "Still waiting for the QR scan. Let me know when you’ve scanned it.",
      ...(login.qrDataUrl ? { qrDataUrl: login.qrDataUrl } : {}),
    };
  }

  if (first.ok) {
    const message = "✅ Linked! WhatsApp is ready.";
    runtime.log(success(message));
    await resetActiveLogin(account.accountId);
    return { connected: true, message };
  }

  const firstCode = getStatusCode(first.err);
  if (firstCode === 515) {
    const restarted = await restartSocketOnce(login, runtime);
    if (restarted) {
      const second = await waitWithTimeout(getOrCreateWaiter(login), opts.timeoutMs);
      if (second === "timeout") {
        return {
          connected: false,
          message: "Still waiting for the QR scan. Let me know when you’ve scanned it.",
          ...(login.qrDataUrl ? { qrDataUrl: login.qrDataUrl } : {}),
        };
      }
      if (second.ok) {
        const message = "✅ Linked after restart; web session ready.";
        runtime.log(success(message));
        await resetActiveLogin(account.accountId);
        return { connected: true, message };
      }
      const secondCode = getStatusCode(second.err);
      if (secondCode === DisconnectReason.loggedOut) {
        await logoutWeb({
          authDir: login.authDir,
          isLegacyAuthDir: login.isLegacyAuthDir,
          runtime,
        });
        const message =
          "WhatsApp reported the session is logged out. Cleared cached web session; please scan a new QR.";
        await resetActiveLogin(account.accountId, message);
        runtime.log(danger(message));
        return { connected: false, message };
      }
      const formatted = formatError(second.err);
      const message = `WhatsApp login failed: ${formatted}`;
      await resetActiveLogin(account.accountId, message);
      runtime.log(danger(message));
      return { connected: false, message, ...(login.qrDataUrl ? { qrDataUrl: login.qrDataUrl } : {}) };
    }
  }

  if (firstCode === DisconnectReason.loggedOut) {
    await logoutWeb({
      authDir: login.authDir,
      isLegacyAuthDir: login.isLegacyAuthDir,
      runtime,
    });
    const message =
      "WhatsApp reported the session is logged out. Cleared cached web session; please scan a new QR.";
    await resetActiveLogin(account.accountId, message);
    runtime.log(danger(message));
    return { connected: false, message };
  }

  const formatted = formatError(first.err);
  const message = `WhatsApp login failed: ${formatted}`;
  await resetActiveLogin(account.accountId, message);
  runtime.log(danger(message));
  return { connected: false, message, ...(login.qrDataUrl ? { qrDataUrl: login.qrDataUrl } : {}) };
}
