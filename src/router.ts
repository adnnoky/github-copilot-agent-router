import { ModelTier } from "./models";

export interface RouterInput {
  score: number;
  freeThreshold: number;
}

export interface RoutingDecision {
  tier: ModelTier;
  score: number;
  threshold: number;
}

function normalizeThreshold(value: number): number {
  if (!Number.isFinite(value)) {
    return 70;
  }
  return Math.round(Math.max(0, Math.min(100, value)));
}

/**
 * Determines whether the prompt should be routed to a free or premium model.
 * Score <= threshold → free; score > threshold → premium.
 */
export function getRoutingDecision(input: RouterInput): RoutingDecision {
  const threshold = normalizeThreshold(input.freeThreshold);
  const tier: ModelTier = input.score <= threshold ? "free" : "premium";

  return {
    tier,
    score: input.score,
    threshold
  };
}
