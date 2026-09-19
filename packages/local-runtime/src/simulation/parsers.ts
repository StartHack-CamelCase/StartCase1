export type AttributeCandidate={attribute:'size'|'color'|'inches';value:string;unit?:string;negated:boolean;source:string;ambiguous?:boolean;selected?:boolean};
const clean=(s:string)=>s.normalize('NFKC');
export function detectInjection(text:string){const normalized=clean(text);const patterns=[/(?:spending|per[- ]order)\s+limits?.{0,30}(?:do not|don't)\s+apply|(?:approved|authori[sz]ed)\s+without\s+(?:further\s+)?checks/iu,/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u,/ignore\b.{0,65}(?:instruct|limit|budget|size|rule|previous)|ignor(?:e|ez).{0,50}(?:instruction|règle|plafond|taille)/iu,/(?:system|developer)\s*(?:message|instruction|:)|<\/?(?:system|assistant)>/iu,/(?:approve|authori[sz]e)\s+(?:immediately|this|the|now)|(?:raise|increase|override|change).{0,25}(?:limit|budget)|respond\s+\d|call\s+(?:a|the)\s+tool/iu,/(?:new|updated|approved)\s+(?:limit|ceiling)|(?:treat|consider).{0,25}(?:limit|budget).{0,15}(?:approved|unlimited)/iu];return {detected:patterns.some(p=>p.test(normalized)),matches:patterns.filter(p=>p.test(normalized)).map(String),normalized};}
export function parseAttributes(text:string):AttributeCandidate[]{
 const s=clean(text),out:AttributeCandidate[]=[];
 // A decimal point belongs to its dimension, not to a new sentence.
 for(const clause of s.split(/(?<!\d)\.|\.(?!\d)|[;\n]/u)){
  if(/(?:ignore|respond|answer|pretend|treat|assume|ignorez|répond).{0,35}(?:size|taille|colour|color|couleur|\d)/iu.test(clause))continue;
  const neg=(index:number)=>/\b(?:not|pas|no|sans)\s*$/iu.test(clause.slice(Math.max(0,index-16),index));
  for(const m of clause.matchAll(/(?:size|taille)\s*[:=]?\s*(?:(EU|UK|US)\s*)?(\d+(?:[.,]\d+)?)(?:\s*(EU|UK|US))?(?:\s*(?:or|ou|\/|and)\s*(\d+(?:[.,]\d+)?))?/giu)){
   const selected=/selected|chosen|sélectionnée?|choisie?/iu.test(clause.slice(0,m.index));
   for(const value of [m[2],m[4]].filter((v):v is string=>v!==undefined))out.push({attribute:'size',value:value.replace(',','.'),...(m[1]||m[3]?{unit:(m[1]??m[3])!.toUpperCase()}:{}),negated:neg(m.index),source:m[0],ambiguous:m[4]!==undefined,selected});
  }
  for(const m of clause.matchAll(/(?:colou?r|couleur)\s*[:=]?\s*([\p{L}-]+)(?:\s*(?:or|ou|\/)\s*([\p{L}-]+))?/giu))for(const value of [m[1],m[2]].filter((v):v is string=>v!==undefined))out.push({attribute:'color',value:value.toLowerCase(),negated:neg(m.index),source:m[0],ambiguous:m[2]!==undefined});
  for(const m of clause.matchAll(/(?<![\p{L}\p{N}_.-])(\d+(?:[.,]\d+)?)\s*[- ]?\s*(?:inch(?:es)?|pouces?|in(?!-))(?![\p{L}\p{N}_])/giu))out.push({attribute:'inches',value:m[1]!.replace(',','.'),unit:'inch',negated:neg(m.index),source:m[0]});
 }
 return out;
}

export type RecurringTerms = { recurring: boolean; conflict: boolean; positive: string[]; negated: string[] };
/** Interpret each offer separately. A denial has only local grammatical scope. */
export function parseRecurringTerms(text: string): RecurringTerms {
 const positive: string[] = [], negated: string[] = [];
 const positiveKinds = new Set<string>(), negatedKinds = new Set<string>();
 const clauses = clean(text).split(/[.;,!?\n]+|\b(?:but|however|mais|pourtant)\b/iu);
 for (const source of clauses) {
  const clause = source.trim();
  for (const match of clause.matchAll(/(?<![\p{L}\p{N}_])(?:monthly|annual(?:ly)?|subscriptions?|renew(?:al|s|ing)?|every\s+(?:month|year)|factur(?:ation|ing)\s+mensuelle)(?![\p{L}\p{N}_])/giu)) {
   const before = clause.slice(0, match.index), after = clause.slice(match.index + match[0].length);
   // Only recognized modifiers can connect a negation to this term. For
   // example, "no delivery fee, billed monthly" still states a monthly charge.
   const deniedBefore = /\b(?:no|without|sans|not|never|pas(?:\s+de)?|aucune?)\s+(?:(?:a|an|any|automatic(?:ally)?|monthly|annual|recurring|auto|renew(?:s|ing)?|bill(?:ed|ing)?|charg(?:ed|ing)?)\s+)*$/iu.test(before);
   const deniedAfter = /^\s+(?:(?:is|are|will|does|do|est|sont)\s+)?(?:not|never|pas|disabled|excluded)\b/iu.test(after);
   const coordinatedDenial = /\b(?:no|without|sans)\s+(?:(?:monthly|annual)\s+)?(?:subscriptions?|renewals?)(?:\s+(?:or|and|ou|ni|et)\s+(?:(?:monthly|annual)\s+)?(?:subscriptions?|renewals?))*\s+(?:or|and|ou|ni|et)\s*$/iu.test(before);
   const denied = deniedBefore || deniedAfter || coordinatedDenial;
   (denied ? negated : positive).push(clause);
   // Subscription, renewal and billing may describe separate commitments.
   // A denial of a device renewal cannot negate a different subscription.
   const term = match[0].toLowerCase();
   const kind = /subscription/.test(term) ? 'subscription' : /renew/.test(term) ? 'renewal' : /^\s+subscriptions?\b/i.test(after) ? 'subscription' : 'billing';
   (denied ? negatedKinds : positiveKinds).add(kind);
  }
 }
 return { recurring: positive.length > 0, conflict: [...positiveKinds].some(kind => negatedKinds.has(kind)), positive: [...new Set(positive)], negated: [...new Set(negated)] };
}
export function parseReturnTerms(text:string):{days?:number;returnable?:boolean;conflict:boolean;source:string}{
 const clauses=clean(text).split(/[.;\n]/u).filter(s=>!/ignore|respond|pretend|override|ignorez|répond/iu.test(s));const s=clauses.join(';');
 const values=[...s.matchAll(/(?:returns?|retours?)\s*(?:(?:are\s+)?(?:accepted|allowed|possible|acceptés?)\s*)?(?:within|for|under|sous|pendant|de)?\s*(\d+)\s*[- ]?(?:days?|jours?)/giu),...s.matchAll(/(\d+)\s*[- ]?(?:days?|jours?)\s*(?:return(?:\s+window)?|retour)/giu)].map(m=>Number(m[1]));
 const no=/\b(?:no|non|not|aucun)\s+returns?\b|returns?\s+(?:are\s+)?not\s+accepted|final\s+sale|sans\s+retour/iu.test(s);
 return {...(values.length?{days:Math.min(...values)}:{}),...(no?{returnable:false}:values.length?{returnable:true}:{}),conflict:(no&&values.length>0)||new Set(values).size>1,source:/warranty/i.test(s)&&!values.length?'':s};
}
export function levenshtein(a:string,b:string):number{const x=[...a],y=[...b];let prev=Array.from({length:y.length+1},(_,i)=>i);for(let i=1;i<=x.length;i++){const row=[i];for(let j=1;j<=y.length;j++)row[j]=Math.min(row[j-1]!+1,prev[j]!+1,prev[j-1]!+(x[i-1]===y[j-1]?0:1));prev=row;}return prev[y.length]!;}
