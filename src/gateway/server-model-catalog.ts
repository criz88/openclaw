import {
  loadModelCatalog,
  type ModelCatalogEntry,
  resetModelCatalogCacheForTest,
} from "../agents/model-catalog.js";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import fs from "node:fs/promises";
import path from "node:path";

export type GatewayModelChoice = ModelCatalogEntry;
type GatewayModelCatalogCache = {
  version: 1;
  updatedAtMs: number;
  models: GatewayModelChoice[];
};
const MODEL_CATALOG_CACHE_VERSION = 1;
const MODEL_CATALOG_CACHE_FILE = "model-catalog.json";

// Test-only escape hatch: model catalog is cached at module scope for the
// process lifetime, which is fine for the real gateway daemon, but makes
// isolated unit tests harder. Keep this intentionally obscure.
export function __resetModelCatalogCacheForTest() {
  resetModelCatalogCacheForTest();
}

function resolveGatewayModelCatalogCachePath() {
  return path.join(resolveStateDir(), "cache", MODEL_CATALOG_CACHE_FILE);
}

function normalizeGatewayModelChoice(entry: unknown): GatewayModelChoice | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const raw = entry as Partial<GatewayModelChoice>;
  const provider = String(raw.provider || "").trim();
  const id = String(raw.id || "").trim();
  if (!provider || !id) {
    return null;
  }
  const name = String(raw.name || id).trim() || id;
  const contextWindow =
    typeof raw.contextWindow === "number" && Number.isFinite(raw.contextWindow) && raw.contextWindow > 0
      ? Math.trunc(raw.contextWindow)
      : undefined;
  const reasoning = typeof raw.reasoning === "boolean" ? raw.reasoning : undefined;
  const input = Array.isArray(raw.input)
    ? raw.input.filter((value): value is "text" | "image" => value === "text" || value === "image")
    : undefined;
  return {
    id,
    name,
    provider,
    ...(contextWindow ? { contextWindow } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(input && input.length > 0 ? { input } : {}),
  };
}

function normalizeGatewayModelChoices(models: unknown): GatewayModelChoice[] {
  if (!Array.isArray(models)) {
    return [];
  }
  const out: GatewayModelChoice[] = [];
  for (const raw of models) {
    const normalized = normalizeGatewayModelChoice(raw);
    if (normalized) {
      out.push(normalized);
    }
  }
  return out;
}

async function readGatewayModelCatalogCache(): Promise<GatewayModelChoice[] | null> {
  const cachePath = resolveGatewayModelCatalogCachePath();
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<GatewayModelCatalogCache>;
    if (parsed.version !== MODEL_CATALOG_CACHE_VERSION) {
      return null;
    }
    const models = normalizeGatewayModelChoices(parsed.models);
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

async function writeGatewayModelCatalogCache(models: GatewayModelChoice[]) {
  if (models.length === 0) {
    return;
  }
  const cachePath = resolveGatewayModelCatalogCachePath();
  const payload: GatewayModelCatalogCache = {
    version: MODEL_CATALOG_CACHE_VERSION,
    updatedAtMs: Date.now(),
    models,
  };
  await fs.mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(cachePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Force-refresh catalog from live sources and persist it for startup/offline fallbacks.
 */
export async function refreshGatewayModelCatalogCache(): Promise<GatewayModelChoice[]> {
  try {
    const models = await loadModelCatalog({ config: loadConfig(), useCache: false });
    const normalized = normalizeGatewayModelChoices(models);
    if (normalized.length > 0) {
      await writeGatewayModelCatalogCache(normalized);
      return normalized;
    }
  } catch {
    // fallback below
  }
  return (await readGatewayModelCatalogCache()) ?? [];
}

export async function loadGatewayModelCatalog(): Promise<GatewayModelChoice[]> {
  try {
    const models = await loadModelCatalog({ config: loadConfig() });
    const normalized = normalizeGatewayModelChoices(models);
    if (normalized.length > 0) {
      void writeGatewayModelCatalogCache(normalized);
      return normalized;
    }
  } catch {
    // fallback below
  }
  return (await readGatewayModelCatalogCache()) ?? [];
}
