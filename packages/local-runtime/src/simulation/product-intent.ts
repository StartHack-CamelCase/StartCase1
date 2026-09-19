export type ComputerProductType = 'computer' | 'laptop' | 'desktop_computer';
export type SupportedProductIntent = { productType: ComputerProductType; itemCategory: 'electronics'; sourceExcerpt: string };

const computer = String.raw`(?:desktop(?:[ -](?:computer|PC))?|(?:ordinateur|PC) de bureau|(?:laptop|notebook)(?:[ -]computer)?|(?:ordinateur|PC) portable|portable (?:computer|PC)|computers?|ordinateurs?|PC)`;
const condition = String.raw`(?:refurbished|used|new|reconditionn[eé]|neuf|d'occasion)`;
const accessory = String.raw`(?:accessor(?:y|ies)|accessoires?|monitors?|screens?|moniteurs?|[eé]crans?|keyboard|clavier|mouse|souris|charger|chargeur|cables?|adapt(?:e|o)r|stand|support|cases?|sleeves?|bags?|sacs?|batter(?:y|ies)|batterie|desk|cover|housse|games?|software|licenses?|logiciels?|jeux|docks?|docking(?: station)?|repair(?: service)?|r[eé]paration|services?|parts?|components?|composants?|memory modules?|modules? de m[eé]moire|processors?|motherboards?|fans?|coolers?|replacement\s+(?:displays?|panels?|parts?)|pi[eè]ces|jouets?|toys?)`;
const normalize = (text: string): string => text.normalize('NFKC').replaceAll('’', "'");

/** An explicit denial is contradictory evidence, not an absent product name. */
export function hasNegatedComputerIdentity(value: string): boolean {
 const text = normalize(value).trim();
 return new RegExp(String.raw`^(?:(?:this|it)\s+is\s+)?(?:not|no)\s+(?:(?:a|an|the)\s+)?${computer}\b|^(?:(?:this|it)\s+)?isn't\s+(?:(?:a|an|the)\s+)?${computer}\b|^(?:(?:ce|ceci)\s+)?n'est\s+pas\s+(?:(?:un|une|le)\s+)?${computer}\b|^(?:pas|aucun)\s+(?:un\s+)?${computer}\b`, 'i').test(text);
}

/** Only an affirmative, single-product request can narrow the whole basket.
 * Mentions of an existing computer, accessories, alternatives and negated
 * requests stay available to the normal requirement review. */
export function parseSupportedProductIntent(instruction: string): SupportedProductIntent | null {
 // Keep offsets aligned with the literal instruction used as rule evidence.
 const text = instruction.replaceAll('’', "'");
 const request = new RegExp(String.raw`\b(?:buy|purchase|order|get|find|need|want|would like|(?:i|we)'d like|acheter|ach[eè]te(?:z)?|commander|commande(?:z)?|veux|voudrais|aimerais|souhaite(?:z)?|cherche(?:z)?|besoin de)(?:-(?:moi|nous))?\s+(?:only\s+)?(?:(?:me|us|moi)\s+)?(?:(?:a|an|the|one|my|un|une|le|mon|un nouvel)\s+)?(?:(?:new|used|refurbished|gaming|cheap|nouveau|nouvel|reconditionn[eé])\s+)*(${computer})\b((?:\s+${condition}(?=\s|[.,!?;]|$))*)`, 'gi');
 const matches = [...text.matchAll(request)];
 if (matches.length !== 1) return null;
 const match = matches[0]!;
 const start = match.index!;
 const before = text.slice(0, start).split(/[.!?;]/).at(-1)!;
 if (/(?<!\p{L})(?:not|never|no|don't|do not|cannot|can't|won't|avoid|refuse|forbid|without|pas|jamais|sans|[eé]vite(?:r|z)?|if|unless|si)(?!\p{L})/iu.test(before)||/\bne\b[^.!?;]*\bplus\b/i.test(before)) return null;
 const after = text.slice(start + match[0].length);
 const otherRequest = /\b(?:buy|purchase|order|get|find|acheter|ach[eè]te(?:z)?|commander|commande(?:z)?)\s+(?:(?:a|an|the|one|some|my|un|une|des|le|la|les)\s+)?[a-zà-ÿ]+/i;
 if (otherRequest.test(text.slice(0, start)) || otherRequest.test(after)) return null;
 if (new RegExp(String.raw`^\s*[- ]\s*(?:${accessory})\b`, 'i').test(after)) return null;
 // A second requested physical item cannot share a computer-only line rule.
 // Specifications such as "with 16GB RAM" are not accessory noun heads.
 if (new RegExp(String.raw`^\s*(?:(?:with|avec|including)\s+|,\s*)(?:(?:a|an|one|the|un|une|des)\s+)?(?:${accessory})\b`, 'i').test(after)) return null;
 // An unknown noun immediately after "computer" may be the real product
 // (for example, "computer gizmo"). Only a complete noun or a requirement
 // clause establishes a device request; do not guess the trailing noun away.
 if (after.trim() && !/^(?:[.,!?;]|\b(?:from|for|with|without|under|below|over|above|between|at|in|that|which|costing|costs|priced|and|or|pour|avec|sans|chez|de|qui|dont|[aà]|moins|plus|entre|et|ou)\b)/i.test(after.trimStart())) return null;
 // One type applies to every basket line. Do not turn "computer and groceries"
 // or "computer or monitor" into an electronics-only mandate.
 const mentions = text.match(new RegExp(String.raw`\b(?:${computer}|monitor|moniteur)\b`, 'gi')) ?? [];
 if (mentions.length !== 1) return null;
 // A later prohibition such as "No accessories or subscriptions" is not an
 // alternative to the requested computer. Decimal points do not end a clause.
 const productSentenceTail = after.split(/[!?;]|\.(?=\s|$)/)[0]!;
 const conjunctions = [...productSentenceTail.matchAll(/\b(?:and|or|et|ou|plus)\s+([^.!?;]+)/gi)];
 if (conjunctions.some(m => {
  const continuation=m[1]!;
  const monetaryContinuation=/^(?:CHF\s*\d|\d+(?:[.,]\d+)?\s*(?:CHF|francs?|frs?\.?|Swiss francs?))\b/i.test(continuation)
   ||/\b(?:between|entre|from|de)\s+CHF\s*\d+(?:[.,]\d+)?\s*$/i.test(productSentenceTail.slice(0,m.index))&&/^\d+(?:[.,]\d+)?(?:\s|[,.!?;]|$)/.test(continuation);
  return !monetaryContinuation&&!/^(?:that|which|it|must|should|has|costs?|price|(?:the )?(?:minimum|maximum|total|price|budget|delivery)|(?:at|no) (?:least|most|more)|under|below|over|above|less|more|from|with|without|including|for|in|qui|dont|doit|co[uû]t|(?:le )?(?:prix|minimum|maximum)|livr)/i.test(continuation);
 })) return null;
 const productType = classifyProductKind(match[1]!) as ComputerProductType;
 // Condition words identify the noun phrase but remain separate requirements.
 return { productType, itemCategory: 'electronics', sourceExcerpt: instruction.slice(start, start + match[0].length - (match[2]?.length ?? 0)) };
}

/** A small catalogue vocabulary: unknown names remain unresolved. Accessories
 * take precedence so a "laptop charger" cannot become a compatible laptop. */
export function classifyProductKind(value: string): string | null {
 if (hasNegatedComputerIdentity(value)) return null;
 const text = normalize(value).replaceAll('_', ' ').split(/\b(?:with|without|avec|sans|for|pour|including)\b/i)[0]!
  .replace(new RegExp(String.raw`(?:\s+${condition})+\s*[.!]?\s*$`, 'i'), '');
 if (/\btrail\b/i.test(text)) return 'trail';
 if (/road[- ]running|course sur route/i.test(text)) return 'road';
 if (/\b(?:monitor|moniteur|screen|[eé]cran)\b/i.test(text)) return 'monitor';
 if (/\b(?:helmet|casque)\b/i.test(text)) return 'helmet';
 if (new RegExp(String.raw`\b${accessory}\b`, 'i').test(text)) return 'computer_accessory';
 // A bare device noun or a title ending with that noun establishes its kind.
 // Unknown trailing nouns/model descriptions remain unresolved. Explicit
 // "with ..." specifications were removed above, so RAM in a laptop's spec
 // does not turn the complete device into a memory component.
 if (/\b(?:laptop|notebook)(?:[ -]computer)?\s*[.!]?\s*$|\b(?:ordinateur|PC) portable\s*[.!]?\s*$|\bportable (?:computer|PC)\s*[.!]?\s*$/i.test(text)) return 'laptop';
 if (/\bdesktop(?:[ -](?:computer|PC))?\s*[.!]?\s*$|\b(?:ordinateur|PC) de bureau\s*[.!]?\s*$/i.test(text)) return 'desktop_computer';
 if (/\b(?:computers?|ordinateurs?|PC)\s*[.!]?\s*$/i.test(text)) return 'computer';
 if (/\b(?:tablet|tablette|phone|smartphone|printer|imprimante|router|speaker|television|TV)\b/i.test(text)) return 'other_electronics';
 return null;
}

export function productKindsMatch(expected: string, observed: string): boolean {
 return expected === observed || expected === 'computer' && (observed === 'laptop' || observed === 'desktop_computer');
}
