import type { OpenClawConfig } from "../../config/config.js";
import type { GatewayRequestHandlers } from "./types.js";
import fs from "node:fs";
import path from "node:path";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { installSkill } from "../../agents/skills-install.js";
import { buildWorkspaceSkillStatus } from "../../agents/skills-status.js";
import { loadWorkspaceSkillEntries, type SkillEntry } from "../../agents/skills.js";
import { resolveSkillKey } from "../../agents/skills/frontmatter.js";
import { resolveSkillConfig } from "../../agents/skills/config.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { CONFIG_DIR } from "../../utils.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSkillsBinsParams,
  validateSkillsInstallParams,
  validateSkillsListParams,
  validateSkillsStatusParams,
  validateSkillsUninstallParams,
  validateSkillsUpdateParams,
} from "../protocol/index.js";

function listWorkspaceDirs(cfg: OpenClawConfig): string[] {
  const dirs = new Set<string>();
  const list = cfg.agents?.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && typeof entry === "object" && typeof entry.id === "string") {
        dirs.add(resolveAgentWorkspaceDir(cfg, entry.id));
      }
    }
  }
  dirs.add(resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)));
  return [...dirs];
}

function collectSkillBins(entries: SkillEntry[]): string[] {
  const bins = new Set<string>();
  for (const entry of entries) {
    const required = entry.metadata?.requires?.bins ?? [];
    const anyBins = entry.metadata?.requires?.anyBins ?? [];
    const install = entry.metadata?.install ?? [];
    for (const bin of required) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const bin of anyBins) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const spec of install) {
      const specBins = spec?.bins ?? [];
      for (const bin of specBins) {
        const trimmed = String(bin).trim();
        if (trimmed) {
          bins.add(trimmed);
        }
      }
    }
  }
  return [...bins].toSorted();
}

function buildSkillList(entries: SkillEntry[], cfg: OpenClawConfig) {
  return entries
    .map((entry) => {
      const skillKey = resolveSkillKey(entry.skill, entry);
      const skillConfig = resolveSkillConfig(cfg, skillKey);
      const enabled = skillConfig?.enabled !== false;
      const versionRaw =
        typeof (entry.frontmatter as Record<string, unknown>)?.version === "string"
          ? String((entry.frontmatter as Record<string, unknown>).version)
          : undefined;
      return {
        id: skillKey,
        name: entry.skill.name,
        description: entry.skill.description || entry.frontmatter.description,
        version: versionRaw,
        icon: entry.metadata?.emoji,
        enabled,
        source: entry.skill.source,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const skillsHandlers: GatewayRequestHandlers = {
  "skills.list": ({ params, respond }) => {
    if (!validateSkillsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.list params: ${formatValidationErrors(validateSkillsListParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const agentIdRaw = typeof params?.agentId === "string" ? params.agentId.trim() : "";
    const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : resolveDefaultAgentId(cfg);
    if (agentIdRaw) {
      const knownAgents = listAgentIds(cfg);
      if (!knownAgents.includes(agentId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${agentIdRaw}"`),
        );
        return;
      }
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const entries = loadWorkspaceSkillEntries(workspaceDir, { config: cfg });
    respond(true, { skills: buildSkillList(entries, cfg) }, undefined);
  },
  "skills.status": ({ params, respond }) => {
    if (!validateSkillsStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.status params: ${formatValidationErrors(validateSkillsStatusParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const agentIdRaw = typeof params?.agentId === "string" ? params.agentId.trim() : "";
    const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : resolveDefaultAgentId(cfg);
    if (agentIdRaw) {
      const knownAgents = listAgentIds(cfg);
      if (!knownAgents.includes(agentId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${agentIdRaw}"`),
        );
        return;
      }
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      config: cfg,
      eligibility: { remote: getRemoteSkillEligibility() },
    });
    respond(true, report, undefined);
  },
  "skills.bins": ({ params, respond }) => {
    if (!validateSkillsBinsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.bins params: ${formatValidationErrors(validateSkillsBinsParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const workspaceDirs = listWorkspaceDirs(cfg);
    const bins = new Set<string>();
    for (const workspaceDir of workspaceDirs) {
      const entries = loadWorkspaceSkillEntries(workspaceDir, { config: cfg });
      for (const bin of collectSkillBins(entries)) {
        bins.add(bin);
      }
    }
    respond(true, { bins: [...bins].toSorted() }, undefined);
  },
  "skills.install": async ({ params, respond }) => {
    if (!validateSkillsInstallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.install params: ${formatValidationErrors(validateSkillsInstallParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      name: string;
      installId: string;
      timeoutMs?: number;
    };
    const cfg = loadConfig();
    const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const result = await installSkill({
      workspaceDir: workspaceDirRaw,
      skillName: p.name,
      installId: p.installId,
      timeoutMs: p.timeoutMs,
      config: cfg,
    });
    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.message),
    );
  },
  "skills.update": async ({ params, respond }) => {
    if (!validateSkillsUpdateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.update params: ${formatValidationErrors(validateSkillsUpdateParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      skillKey: string;
      enabled?: boolean;
      apiKey?: string;
      env?: Record<string, string>;
    };
    const cfg = loadConfig();
    const skills = cfg.skills ? { ...cfg.skills } : {};
    const entries = skills.entries ? { ...skills.entries } : {};
    const current = entries[p.skillKey] ? { ...entries[p.skillKey] } : {};
    if (typeof p.enabled === "boolean") {
      current.enabled = p.enabled;
    }
    if (typeof p.apiKey === "string") {
      const trimmed = p.apiKey.trim();
      if (trimmed) {
        current.apiKey = trimmed;
      } else {
        delete current.apiKey;
      }
    }
    if (p.env && typeof p.env === "object") {
      const nextEnv = current.env ? { ...current.env } : {};
      for (const [key, value] of Object.entries(p.env)) {
        const trimmedKey = key.trim();
        if (!trimmedKey) {
          continue;
        }
        const trimmedVal = value.trim();
        if (!trimmedVal) {
          delete nextEnv[trimmedKey];
        } else {
          nextEnv[trimmedKey] = trimmedVal;
        }
      }
      current.env = nextEnv;
    }
    entries[p.skillKey] = current;
    skills.entries = entries;
    const nextConfig: OpenClawConfig = {
      ...cfg,
      skills,
    };
    await writeConfigFile(nextConfig);
    respond(true, { ok: true, skillKey: p.skillKey, config: current }, undefined);
  },
  "skills.uninstall": async ({ params, respond }) => {
    if (!validateSkillsUninstallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.uninstall params: ${formatValidationErrors(validateSkillsUninstallParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { id: string };
    const cfg = loadConfig();
    const managedDir = path.resolve(CONFIG_DIR, "skills");
    const entries = loadWorkspaceSkillEntries(resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)), {
      config: cfg,
    });
    const target = entries.find((entry) => resolveSkillKey(entry.skill, entry) === p.id);
    if (!target) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown skill id"));
      return;
    }
    if (target.skill.source !== "openclaw-managed") {
      respond(
        false,
        { id: p.id, source: target.skill.source },
        errorShape(ErrorCodes.INVALID_REQUEST, "skill cannot be uninstalled"),
      );
      return;
    }
    const skillPath = path.resolve(target.skill.baseDir);
    const managedPrefix = managedDir.endsWith(path.sep) ? managedDir : `${managedDir}${path.sep}`;
    if (!(skillPath === managedDir || skillPath.startsWith(managedPrefix))) {
      respond(
        false,
        { id: p.id, path: skillPath },
        errorShape(ErrorCodes.INVALID_REQUEST, "skill is not in managed directory"),
      );
      return;
    }
    await fs.promises.rm(skillPath, { recursive: true, force: true });
    respond(true, { ok: true, id: p.id, path: skillPath }, undefined);
  },
};
