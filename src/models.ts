import * as vscode from "vscode";

/**
 * Model families considered "free" tier, in descending preference order.
 * Any model family NOT listed here is treated as premium.
 */
export const FREE_MODEL_FAMILIES: readonly string[] = ["gpt-4o", "gpt-4o-mini", "gpt-4.1"];

export type ModelTier = "free" | "premium";

export interface ModelSelection {
    model: vscode.LanguageModelChat;
    tier: ModelTier;
    family: string;
}

function isFreeFamily(family: string): boolean {
    return FREE_MODEL_FAMILIES.some(
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

    if (tier === "free") {
        // Try each preferred free family in order
        for (const family of FREE_MODEL_FAMILIES) {
            const match = allModels.find(
                (m) => m.family.toLowerCase() === family.toLowerCase()
            );
            if (match) {
                return { model: match, tier: "free", family: match.family };
            }
        }

        // Fallback: any free model if available, else any model
        const anyFree = allModels.find((m) => isFreeFamily(m.family));
        if (anyFree) {
            return { model: anyFree, tier: "free", family: anyFree.family };
        }

        // Last resort — use whatever is available
        const fallback = allModels[0];
        return { model: fallback, tier: "free", family: fallback.family };
    }

    // Premium: pick any model that is NOT in the free list
    const premiumModel = allModels.find((m) => !isFreeFamily(m.family));
    if (premiumModel) {
        return { model: premiumModel, tier: "premium", family: premiumModel.family };
    }

    // Fallback: if all available models are free-tier (user has no premium),
    // use the best free model and still mark as "premium intent"
    const bestFree = allModels[0];
    return { model: bestFree, tier: "free", family: bestFree.family };
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

    const tier: ModelTier = isFreeFamily(match.family) ? "free" : "premium";
    return { model: match, tier, family: match.family };
}
