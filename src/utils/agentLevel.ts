import { AgentLevel } from "@prisma/client";

// Tier thresholds as decided: Bronze 5–20 schools, Silver 21–50, Gold 50+.
// An agent with fewer than 5 schools still sits at BRONZE (the enum has no
// "below bronze" tier) — they just haven't unlocked the 5% rate's stated
// range yet, but BRONZE is the correct default/starting level either way.
export function levelForSchoolCount(schoolCount: number): AgentLevel {
  if (schoolCount >= 50) return "GOLD";
  if (schoolCount >= 21) return "SILVER";
  return "BRONZE";
}

// Single source of truth for commission % per level — change here only.
export function commissionPercentForLevel(level: AgentLevel): number {
  switch (level) {
    case "GOLD":
      return 10;
    case "SILVER":
      return 8;
    case "BRONZE":
    default:
      return 5;
  }
}

export function generateReferralCode(name: string): string {
  const prefix = name
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase()
    .slice(0, 4)
    .padEnd(4, "X");
  const random = Math.floor(1000 + Math.random() * 9000); // 4-digit
  return `${prefix}${random}`;
}
