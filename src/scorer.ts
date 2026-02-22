export interface ComplexityResult {
  score: number;
  reasons: string[];
}

const COMPLEXITY_TERMS: ReadonlyArray<{ pattern: RegExp; weight: number; reason: string }> = [
  { pattern: /\b(architecture|system design|distributed|scalable|microservices)\b/i, weight: 20, reason: "system-level request" },
  { pattern: /\b(optimi[sz]e|performance|big\s*o|benchmark|latency|throughput)\b/i, weight: 15, reason: "performance focus" },
  { pattern: /\b(security|auth|encryption|compliance|vulnerability)\b/i, weight: 20, reason: "security/compliance" },
  { pattern: /\b(refactor|migration|backward compatibility|legacy)\b/i, weight: 12, reason: "codebase evolution" },
  { pattern: /\b(machine learning|ml|neural|model training|inference)\b/i, weight: 18, reason: "advanced domain" },
  { pattern: /\b(debug|trace|root cause|intermittent)\b/i, weight: 10, reason: "deep troubleshooting" }
];

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function scorePromptComplexity(prompt: string): ComplexityResult {
  const normalized = prompt.trim();

  if (!normalized) {
    return { score: 0, reasons: ["empty prompt"] };
  }

  let score = 10;
  const reasons: string[] = [];

  const lengthBonus = Math.min(25, Math.floor(normalized.length / 50));
  score += lengthBonus;
  if (lengthBonus > 0) {
    reasons.push("longer prompt");
  }

  const lineCount = normalized.split(/\r?\n/).length;
  if (lineCount >= 4) {
    score += 8;
    reasons.push("multi-step structure");
  }

  const punctuationComplexity = (normalized.match(/[;:{}()[\]]/g) ?? []).length;
  if (punctuationComplexity >= 8) {
    score += 7;
    reasons.push("dense technical syntax");
  }

  for (const term of COMPLEXITY_TERMS) {
    if (term.pattern.test(normalized)) {
      score += term.weight;
      reasons.push(term.reason);
    }
  }

  const finalScore = clampScore(score);
  return {
    score: finalScore,
    reasons: reasons.length ? reasons : ["general request"]
  };
}
