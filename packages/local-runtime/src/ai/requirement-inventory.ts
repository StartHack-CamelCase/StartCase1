import { createHash } from "node:crypto";
import type { InstructionVariables } from "../../../contracts/src/index.js";

export const REQUIREMENT_INVENTORY_VERSION = "requirement-inventory-v1";
export type RequirementInventoryItem = {
  id: string;
  source_excerpt: string;
  status: "mapped" | "unmapped" | "uncertain" | "uncovered";
  mappings: string[];
  questions: string[];
};
export type RequirementInventory = { version: string; requirements: RequirementInventoryItem[] };

/** Builds a stable inventory from the instruction and extraction evidence only. */
export function buildRequirementInventory(instruction: string, decoded: InstructionVariables): RequirementInventory {
  const clauses = [...new Set([
    ...instruction.split(/(?<=[.!?;])\s+|\n+/).map((s) => s.trim()).filter(Boolean),
    ...(instruction.match(/(?:size|taille|colour|color|couleur|familiar|habitu|merchant|vendeur|retour|return|delivery|livraison|extra|suppl|session|uncertain|incertain|doubt|doute|shoe|chauss|specialist|spécialiste|maximum|max(?:imum)?|plafond)[^.!?;\n]*/gi) ?? []).map((s) => s.trim()),
  ])];
  const evidence = [...decoded.variables.filter((v) => v.status !== "absent" && v.source_excerpt).map((v) => ({ excerpt: v.source_excerpt!, status: v.status === "ambiguous" ? "uncertain" as const : "mapped" as const, mapping: v.field })), ...decoded.unmapped_requirements.map((r) => ({ excerpt: r.source_excerpt, status: r.reason === "ambiguous" ? "uncertain" as const : "unmapped" as const, mapping: "" }))];
  const items = clauses.map((excerpt) => {
    const matches = evidence.filter((entry) => excerpt.includes(entry.excerpt) || entry.excerpt.includes(excerpt));
    const semantic = /size|taille|colour|color|couleur|familiar|habitu|retour|return|delivery|livraison|extra|suppl|session|uncertain|incertain|doubt|doute/i.test(excerpt);
    const status: RequirementInventoryItem["status"] = semantic && matches.every((m) => m.mapping.includes("item_name")) ? "uncovered" : matches.length ? (matches.some((m) => m.status === "uncertain") ? "uncertain" : matches[0]!.status) : "uncovered";
    const id = createHash("sha256").update(`${REQUIREMENT_INVENTORY_VERSION}\0${excerpt}`).digest("hex").slice(0, 16);
    return { id, source_excerpt: excerpt, status, mappings: [...new Set(matches.map((m) => m.mapping).filter(Boolean))], questions: status === "uncovered" || status === "uncertain" ? ["Cette exigence doit-elle être précisée ou confirmée ?"] : [] };
  });
  return { version: REQUIREMENT_INVENTORY_VERSION, requirements: items };
}
