import * as vscode from "vscode";

/**
 * Model cost multipliers — determines how many premium requests each model consumes.
 * Lower multiplier = cheaper. Models not listed default to 1x.
 *
 * Standard (1x): gpt-5-mini, gpt-5.6-luna, mai-code-1.1-flash
 * Advanced (2x+): claude-sonnet-5.0, claude-opus-5.0, gpt-5.3-codex, gpt-5.6-terra
 *
 * Updated for model refresh effective 2026-09-01 (WK2636.2)
 */
export const MODEL_COSTS: Readonly<Record<string, number>> = {
    "gpt-5-mini": 1,
    "gpt-5.6-luna": 1,
    "mai-code-1.1-flash": 1,
    "claude-sonnet-5.0": 2,
    "gpt-5.6-terra": 2,
    "gpt-5.3-codex": 3,
    "claude-opus-5.0": 3,
};

/** @deprecated Kept for backward compatibility in UI strings */
export const FREE_MODEL_FAMILIES: readonly string[] = ["gpt-5-mini", "gpt-5.6-luna", "mai-code-1.1-flash"];

export const STANDARD_MODEL_FAMILIES: readonly string[] = ["gpt-5-mini", "gpt-5.6-luna", "mai-code-1.1-flash"];
export const ADVANCED_MODEL_FAMILIES: readonly string[] = ["claude-sonnet-5.0", "claude-opus-5.0", "gpt-5.3-codex", "gpt-5.6-terra"];

export type ModelTier = "standard" | "advanced";

export interface ModelSelection {
    model: vscode.LanguageModelChat;
    tier: ModelTier;
    family: string;
    multiplier: number;
}

function getMultiplier(family: string): number {
    const key = family.toLowerCase().trim();
    // Exact match first
    for (const [k, v] of Object.entries(MODEL_COSTS)) {
        if (k.toLowerCase() === key) { return v; }
    }
    // Partial match: strip version numbers and match base name (e.g. "claude-opus-4.6" matches "claude-opus-5.0")
    const baseKey = key.replace(/[-.]?\d+(\.\d+)?$/, "");
    for (const [k, v] of Object.entries(MODEL_COSTS)) {
        const baseK = k.toLowerCase().replace(/[-.]?\d+(\.\d+)?$/, "");
        if (baseK === baseKey) { return v; }
    }
    // Unknown models: if they're in the standard list, 1x; otherwise assume 2x (advanced)
    return isStandardFamily(family) ? 1 : 2;
}

function isStandardFamily(family: string): boolean {
    return STANDARD_MODEL_FAMILIES.some(
        (f) => family.toLowerCase().trim() === f.toLowerCase()
    );
}

/**
 * Returns all currently available Copilot language models.
 */
async function getAllModels(): Promise<vscode.LanguageModelChat[]> {
    return vscode.lm.selectChatModels({ vendor: "copilot" });
}

/**
 * Selects the best available model for the requested tier.
 *
 * Free tier: tries each FREE_MODEL_FAMILIES entry in order.
 * Premium tier: tries any model whose family is NOT in FREE_MODEL_FAMILIES.
 *
 * Falls back to any available model if no ideal match is found.
 */
export async function selectModel(tier: ModelTier): Promise<ModelSelection | undefined> {
    const allModels = await getAllModels();

    if (allModels.length === 0) {
        return undefined;
    }

    if (tier === "standard") {
        // Try each preferred standard (1x) family in order
        for (const family of STANDARD_MODEL_FAMILIES) {
            const match = allModels.find(
                (m) => m.family.toLowerCase() === family.toLowerCase()
            );
            if (match) {
                return { model: match, tier: "standard", family: match.family, multiplier: getMultiplier(match.family) };
            }
        }

        // Fallback: any standard model if available, else any model
        const anyStandard = allModels.find((m) => isStandardFamily(m.family));
        if (anyStandard) {
            return { model: anyStandard, tier: "standard", family: anyStandard.family, multiplier: getMultiplier(anyStandard.family) };
        }

        // Last resort — use whatever is available
        const fallback = allModels[0];
        return { model: fallback, tier: "standard", family: fallback.family, multiplier: getMultiplier(fallback.family) };
    }

    // Advanced: prioritize claude-sonnet-5.0
    const preferredAdvanced = allModels.find(
        (m) => m.family.toLowerCase() === "claude-sonnet-5.0"
    );
    if (preferredAdvanced) {
        return { model: preferredAdvanced, tier: "advanced", family: preferredAdvanced.family, multiplier: getMultiplier(preferredAdvanced.family) };
    }

    // Fallback advanced: pick any model that is NOT in the standard list
    const advancedModel = allModels.find((m) => !isStandardFamily(m.family));
    if (advancedModel) {
        return { model: advancedModel, tier: "advanced", family: advancedModel.family, multiplier: getMultiplier(advancedModel.family) };
    }

    // Fallback: if all available models are standard-tier,
    // use the best standard model
    const bestStandard = allModels[0];
    return { model: bestStandard, tier: "standard", family: bestStandard.family, multiplier: getMultiplier(bestStandard.family) };
}

/**
 * Lists all available model families for diagnostic purposes.
 */
export async function listAvailableModels(): Promise<string[]> {
    const models = await getAllModels();
    return models.map((m) => `${m.family} (${m.id})`);
}

/**
 * Selects a model by a user-specified name string.
 * Matches against model id, family, and name (case-insensitive substring).
 * Returns the match and its tier, or undefined if no model is found.
 */
export async function selectModelByName(name: string): Promise<ModelSelection | undefined> {
    const allModels = await getAllModels();
    if (allModels.length === 0) { return undefined; }

    const q = name.toLowerCase().trim();

    // Priority: exact id match > exact family match > substring match
    const match =
        allModels.find(m => m.id.toLowerCase() === q) ??
        allModels.find(m => m.family.toLowerCase() === q) ??
        allModels.find(m => m.id.toLowerCase().includes(q) || m.family.toLowerCase().includes(q));

    if (!match) { return undefined; }

    const tier: ModelTier = isStandardFamily(match.family) ? "standard" : "advanced";
    return { model: match, tier, family: match.family, multiplier: getMultiplier(match.family) };
}
