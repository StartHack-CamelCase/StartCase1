import type { DataPack } from '../../../contracts/src/data.js';
import type { InstructionDecoding } from '../../../contracts/src/instruction-decoding.js';
import type { HardRule, MandateRecord } from '../../../contracts/src/policy.js';
import type { SafetyConfig, SafetyParameters } from '../../../contracts/src/simulation.js';
import type { WalletPreparation, WalletClarification } from '../../../contracts/src/wallet.js';
import { suggestConfig, validateParameters, assertNoWeakening, applyOrderAmountRule, parseOrderAmountBounds } from '../simulation/config.js';
import { AppError } from '../../../contracts/src/errors.js';
import { Decimal } from 'decimal.js';
import { parseAttributes } from '../simulation/parsers.js';

// Older decoding prompts sometimes put a history predicate in a merchant text
// field. Cover only that literal predicate when its executable history rule is
// already present, without changing the archived decoding or its provenance.
function merchantHistoryCovered(variable:InstructionDecoding['variables'][number],instruction:string,parameters:SafetyParameters):boolean {
 if(!['authorization.merchant.merchant_category','authorization.merchant.merchant_name'].includes(variable.field)||(variable.operator!==null&&variable.operator!=='=')||typeof variable.value!=='string'||!variable.source_excerpt||!instruction.includes(variable.source_excerpt))return false;
 const normalize=(value:string)=>value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g,' ').replace(/[.]$/,'');
 const value=normalize(variable.value);
 if(!normalize(variable.source_excerpt).includes(value))return false;
 const regular=/^(?:(?:a|the|my) )?(?:(?:regular|usual) (?:shops?|merchants?|stores?|retailers?)|(?:shops?|merchants?|stores?|retailers?) (?:that )?(?:i|we) (?:use|visit|shop at|buy from) regularly)$/.test(value);
 const familiar=/^(?:(?:a|the|my) )?(?:(?:familiar|known|previously used) (?:shops?|merchants?|stores?|retailers?)|(?:shops?|merchants?|stores?|retailers?) (?:that )?(?:i|we) (?:have )?(?:used|bought from|shopped at|visited) before)$/.test(value);
 return regular&&parameters.regularity!==null||familiar&&parameters.familiar_merchant;
}

/** For a plain history requirement, the cardholder's source determines whether
 * one prior purchase or regular purchases are required, not a model paraphrase. */
function merchantHistoryRequirementCovered(requirement:InstructionDecoding['unmapped_requirements'][number],instruction:string,parameters:SafetyParameters):boolean {
 const start=instruction.indexOf(requirement.source_excerpt);if(start<0)return false;
 const normalize=(value:string)=>value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g,' ').replace(/[.]$/,'');
 const description=normalize(requirement.description)
  .replace(/; (?:this is a habitual-merchant constraint and no dedicated field exists|seller familiarity is required but no canonical field exists|this is vague and cannot be mapped to a specific merchant field)$/,'')
  .replace(/, based on habitual prior purchases$/,'');
 const noun='(?:shop|merchant|store|seller|retailer)s?';
 const person='(?:i|we|(?:the )?(?:user|cardholder))';
 const regular=`(?:(?:a|the|my) )?(?:(?:regular|usual) ${noun}|${noun} (?:that )?${person} (?:use|uses|visit|visits|shop at|shops at|buy from|buys from) regularly)`;
 const familiar=`(?:(?:a|the|my) )?(?:(?:familiar|known|previously used) ${noun}|${noun} (?:that )?${person} (?:(?:have|has) )?(?:used|bought from|shopped at|visited) before)`;
 const plain=new RegExp(`^(?:(?:the )?${noun} (?:must|should) be |(?:use|buy from|purchase from|order from) )?(?:${regular}(?: / (?:has|have) (?:used|bought from|shopped at|visited) before)?|${familiar}|familiar from previous purchases)$`);
 if(!plain.test(description))return false;
 // Include the beginning of a partial source clause so "do not buy from ..."
 // cannot be turned into a positive history permission by quoting only "from".
 const prefix=instruction.slice(0,start).split(/[.!?;]/).at(-1)??'';
 let regularSource=false,familiarSource=false;
 for(const clause of normalize(prefix+requirement.source_excerpt).split(/[.!?;]/)){
  const matches=[{match:new RegExp(`\\b${regular}\\b`).exec(clause),kind:'regular'},{match:new RegExp(`\\b${familiar}\\b`).exec(clause),kind:'familiar'}] as const;
  for(const {match,kind} of matches){if(!match)continue;if(/\b(?:not|never|avoid|exclude|except)\b/.test(clause.slice(0,match.index)))return false;if(kind==='regular')regularSource=true;else familiarSource=true;}
 }
 return (regularSource||familiarSource)&&(!regularSource||parameters.regularity!==null)&&(!familiarSource||parameters.familiar_merchant);
}

const categoryGroups:Array<{phrases:string[];categories:string[]}>= [
 {phrases:['household groceries','household grocery items','groceries and household items'],categories:['groceries','household']},
 {phrases:['groceries','grocery items'],categories:['groceries']},
 {phrases:['household items','household goods','household supplies'],categories:['household']},
 {phrases:['clothing','clothes','clothing items'],categories:['clothing']},
];
/** Recognize a complete category-only requirement, never a keyword inside a
 * compound restriction. The literal source and executable whitelist must agree. */
function categoryRequirementCovered(requirement:InstructionDecoding['unmapped_requirements'][number],instruction:string,parameters:SafetyParameters):boolean {
 if(!instruction.includes(requirement.source_excerpt)||!parameters.allowed_item_categories?.length)return false;
 const description=requirement.description.normalize('NFKC').trim().toLowerCase().replace(/[.]$/,'').replace(/\s+/g,' ');
 const source=requirement.source_excerpt.normalize('NFKC').trim().toLowerCase();
 for(const {phrases,categories} of categoryGroups){
  const category=`(?:${phrases.join('|')})`;
  const request=new RegExp(`^(?:(?:only )?${category}|(?:buy|purchase|order|request|allow|permit) (?:only )?${category}|(?:the )?(?:purchase|order) (?:must|should) (?:be for|contain(?: only)?) ${category}|(?:the )?(?:items|products) (?:must|should) be (?:only )?${category}|${category} (?:are|is) (?:requested|required|allowed|permitted))$`);
  if(!request.test(description)||parameters.allowed_item_categories.some(value=>!categories.includes(value)))continue;
  // A positive purchase verb must introduce the category directly. This excludes
  // a negated request or an unsupported adjective such as "organic" in its place.
  const literal=new RegExp(`(?:^|[.!?;]\\s*)(?:please\\s+)?(?:buy|purchase|order|get)\\s+(?:(?:our|my|the|some|only)\\s+)?${category}\\b`);
  if(literal.test(source))return true;
 }
 return false;
}

export function preparePermissions(pack:DataPack, instruction:string, decoding:InstructionDecoding|null, now:string):Pick<WalletPreparation,'config'|'permissions'|'clarifications'|'warnings'> {
 const proposed=suggestConfig({instruction,mandate_id:'PREPARATION',version:1,hard_rules:[],interpretation:decoding?{instruction_decoding:decoding}:{}} as unknown as MandateRecord,now);
 const p=proposed.parameters;
 // Interpret only locally validated fields. Technical IDs never come from the model.
 for(const v of decoding?.variables??[]){if(v.status!=='present')continue;
  if(v.field==='authorization.billing_amount_chf')applyOrderAmountRule(p,v as HardRule);
  if(v.field==='context.approved_spend_in_period_chf'&&v.operator==='<='&&typeof v.value==='number'&&v.period_days)p.rolling_budget={days:v.period_days,limit_chf:String(v.value)};
  if(v.field==='authorization.currency'&&(v.operator==='='||v.operator==='in'))p.allowed_currencies=Array.isArray(v.value)?v.value:typeof v.value==='string'?[v.value]:null;
  const listField=({'authorization.merchant.merchant_id':'allowed_merchant_ids','authorization.merchant.merchant_country':'allowed_merchant_countries','authorization.items[].item_category':'allowed_item_categories'} as const)[v.field as 'authorization.merchant.merchant_id'];
  if(listField&&(v.operator==='='||v.operator==='in')&&(typeof v.value==='string'||Array.isArray(v.value)))p[listField]=Array.isArray(v.value)?v.value:[v.value];
  if(v.field==='authorization.order_cancellable'&&v.value==='true')p.require_cancellation=true;
  if(v.field==='authorization.items[].quantity'&&v.operator==='<='&&typeof v.value==='number'&&Number.isSafeInteger(v.value)&&v.value>0)p.max_quantity_per_order=v.value;
  if(v.field==='authorization.fulfillment_method'&&v.operator==='='&&typeof v.value==='string')p.fulfillment_method=v.value;
  if(v.field==='authorization.merchant.merchant_country'&&(v.operator==='='||v.operator==='in'))p.allowed_merchant_countries=Array.isArray(v.value)?v.value:typeof v.value==='string'?[v.value]:null;
 }
 if(/someone (?:else|other than me)|session|driving the session/i.test(instruction)){p.watch_devices=true;p.burst_threshold=3;p.historical_time_review=true;p.unusual_country=true;}
 const color=instruction.match(/\b(black|white|blue|red|green|grey|gray|pink|yellow)\b/i);if(color&&/shoe|shirt|clothing|jacket|trouser/i.test(instruction)&&!p.attributes.some(a=>a.name==='color'))p.attributes.push({name:'color',values:[color[1]!.toLowerCase()],unit:null});
 // This convention is visible in the permission review and accepted with the policy.
 p.domestic_country='CH';
 p.duplicate_hours=24;
 const clarifications:WalletClarification[]=[];
 // Propose numeric comparison without inventing an EU/UK/US conversion.
 if(p.attributes.some(a=>a.name==='size'&&a.unit===null))p.numeric_size_convention='shared_numeric';
 // Resolve a catalogue ID only when the instruction's product attributes identify one entry.
 if(p.product_type==='monitor'&&p.attributes.some(a=>a.name==='inches')){
  const candidates=pack.items.filter(item=>/monitor/i.test(item.item_name)&&p.attributes.filter(a=>a.name==='inches').every(req=>parseAttributes(item.item_name).some(a=>a.attribute==='inches'&&!a.negated&&req.values.includes(a.value))));
  if(candidates.length===1)p.allowed_item_ids=[candidates[0]!.item_id];
 }
 const warnings:string[]=[];
 for(const v of decoding?.variables??[]){if(v.status!=='present')continue;
  const mapped=merchantHistoryCovered(v,instruction,p)||v.field==='authorization.billing_amount_chf'&&applyOrderAmountRule(structuredClone(p),v as HardRule)||v.field==='context.approved_spend_in_period_chf'&&v.operator==='<='&&Boolean(v.period_days)||v.field==='authorization.currency'&&Boolean(p.allowed_currencies)||v.field==='authorization.merchant.merchant_country'&&Boolean(p.allowed_merchant_countries)||v.field==='authorization.merchant.merchant_id'&&Boolean(p.allowed_merchant_ids)||v.field==='authorization.items[].item_category'&&Boolean(p.allowed_item_categories)||v.field==='authorization.items[].quantity'&&p.max_quantity_per_order!==null||v.field==='authorization.fulfillment_method'&&Boolean(p.fulfillment_method)||v.field==='authorization.order_returnable'&&v.value==='true'&&/return|retour/i.test(instruction)||v.field==='authorization.order_cancellable'&&v.value==='true'&&p.require_cancellation||v.field==='mandate.uncertainty_policy'&&v.value==='ask'||v.field==='authorization.merchant.merchant_category'&&Boolean(p.allowed_merchant_categories)||v.field==='authorization.items[].item_name'&&(Boolean(p.product_type)||Boolean(p.allowed_item_categories)&&/^(?:(?:ordinary|household|weekly) )?(?:groceries|grocery (?:item|items)|clothing)$/i.test(String(v.value)))||v.field==='authorization.purchase_description'&&p.watch_devices&&/session|someone/i.test(String(v.value));
  if(!mapped)clarifications.push({key:`unresolved:${v.field}`,label:`Unsupported decoded constraint: ${v.field} = ${JSON.stringify(v.value)}.`,type:'text',required:true,value:'',diagnostic:{field:v.field,decoded_value:v.value,source_excerpt:v.source_excerpt,reason:'This decoded field and value have no executable permission mapping.'}});
 }

 if(!decoding)warnings.push('Prepared with the local rules parser. No AI service was used. Please review the permissions carefully.');
 for(const v of decoding?.variables??[])if(v.note?.includes('Review:'))warnings.push(v.note);
 for(const r of decoding?.unmapped_requirements??[])if(r.description.startsWith('Review:'))warnings.push(r.description);
 for(const [i,r] of (decoding?.unmapped_requirements??[]).entries()){
  if(r.description.startsWith('Review:'))continue;
  const text=r.description.toLowerCase();
  const groceryQuantityCovered=/^(?:(?:purchase|order) must be for |(?:buy|purchase|order) )?(?:one|a single|a) (?:ordinary |household |weekly )?grocery item[.]?$/.test(text.trim())&&p.allowed_item_categories?.length===1&&p.allowed_item_categories[0]==='groceries'&&p.max_quantity_per_order===1;
  const bounds=parseOrderAmountBounds(r.source_excerpt);
  const describedBounds=parseOrderAmountBounds(r.description);
  const monetaryText=p.allowed_item_categories?.length===1&&p.allowed_item_categories[0]==='groceries'&&p.max_quantity_per_order===1?r.description.replace(/\b(?:one|a single|1) (?:ordinary )?grocery item\b/ig,''):r.description;
  const monetaryOnly=/CHF|amount|price|cost|minimum|maximum|bound/i.test(monetaryText)&&monetaryText.toLowerCase().replace(/\b(?:the|purchase|buy|pay|order|per|amount|price|cost|minimum|maximum|lower|upper|bound|boundary|must|be|is|at|least|most|of|between|and|no|more|less|than|exactly|equal|to|chf|a|an|francs|swiss|total|for)\b/g,'').replace(/[\d\s.,;:()<>=!\-]/g,'')==='';
  const amountCovered=monetaryOnly&&(describedBounds.min_order_chf!==null||describedBounds.max_order_chf!==null)&&(describedBounds.min_order_chf===null||(bounds.min_order_chf!==null&&new Decimal(bounds.min_order_chf).gte(describedBounds.min_order_chf)&&p.min_order_chf!==null&&new Decimal(p.min_order_chf).gte(describedBounds.min_order_chf)))&&(describedBounds.max_order_chf===null||(bounds.max_order_chf!==null&&new Decimal(bounds.max_order_chf).lte(describedBounds.max_order_chf)&&p.max_order_chf!==null&&new Decimal(p.max_order_chf).lte(describedBounds.max_order_chf)));
  const covered=merchantHistoryRequirementCovered(r,instruction,p)||categoryRequirementCovered(r,instruction,p)||amountCovered||groceryQuantityCovered||(/size/.test(text)&&p.attributes.some(a=>a.name==='size'))||(/inch|screen|dimension/.test(text)&&p.attributes.some(a=>a.name==='inches'))||(/return/.test(text)&&(/return/i.test(instruction)))||(/session|someone|device|suspici/.test(text)&&p.watch_devices)||(/extra|add.on|unrequested/.test(text)&&p.no_extras)||(/chosen|chose|selected/.test(text)&&p.product_type==='monitor')||(/delivery|shipping/.test(text)&&p.fulfillment_method==='delivery'&&!/before|deadline|date/.test(text))||(/colou?r/.test(text)&&p.attributes.some(a=>a.name==='color'));
  if(!covered)clarifications.push({key:`unresolved:requirement:${i}`,label:`Unsupported decoded requirement: ${r.description}`,type:'text',required:true,value:'',diagnostic:{field:null,decoded_value:r.description,source_excerpt:r.source_excerpt,reason:'No executable rule covers this decoded requirement.'}});
 }
 const ambiguous=(decoding?.variables??[]).filter(v=>v.status==='ambiguous'&&!(v.field==='authorization.items[].item_name'&&p.product_type===null&&p.allowed_item_categories!==null&&/grocery item|groceries|clothing/i.test(v.source_excerpt??'')&&/(?:does not|doesn't|not) specify|not specified|unspecified|no specific|no particular/i.test(v.note??'')&&/item name|specific (?:item|product)|particular (?:item|product)/i.test(v.note??'')));
 // Unresolved model ambiguity must not silently become executable permission.
 for(const v of ambiguous)clarifications.push({key:`unresolved:${v.field}`,label:`Unresolved decoded field: ${v.field}.`,type:'text',required:true,value:'',diagnostic:{field:v.field,decoded_value:v.value,source_excerpt:v.source_excerpt,reason:v.note??'The decoder marked this field ambiguous; no executable mapping was established.'}});
 proposed.parameters=validateParameters(p);
 return {config:proposed,permissions:permissionSummary(p),clarifications,warnings:[...new Set(warnings)]};
}
export function applyParameters(prep:WalletPreparation, value:unknown,pack:DataPack):SafetyParameters {
 if(!prep.config)throw new AppError(409,'permission_review_not_ready','Wait until the permissions are ready.');
 const unresolved=prep.clarifications.filter(c=>c.key.startsWith('unresolved:'));
 if(unresolved.length){const first=unresolved[0]!;throw new AppError(422,'instruction_needs_clarification',`Cannot start: ${first.label}`,{unresolved:unresolved.map(c=>c.diagnostic??{field:null,decoded_value:c.value,source_excerpt:null,reason:c.label})});}
 const p=validateParameters(value);
 if(p.allowed_item_ids?.some(id=>!pack.itemsById.has(id as never)))throw new AppError(422,'product_reference_invalid','Permission JSON contains a product ID outside the supplied catalogue.');
 if(p.numeric_size_convention!==null&&!['shared_numeric','EU','UK','US'].includes(p.numeric_size_convention))throw new AppError(422,'size_convention_invalid','Use shared_numeric, EU, UK, US, or null for the size convention.');
 assertNoWeakening(prep.config.parameters,p);
 return p;
}
export function permissionSummary(p:SafetyParameters):WalletPreparation['permissions'] {
 const rows:WalletPreparation['permissions']=[];const add=(key:string,label:string,value:string,description='')=>rows.push({key,label,value,description});
 if(p.min_order_chf!=null)add('min_order_chf','Minimum per purchase',`CHF ${new Decimal(p.min_order_chf).toFixed(2)}`,'Includes delivery.');
 add('max_order_chf','Per purchase',p.max_order_chf===null?'No extra policy limit':`Up to CHF ${new Decimal(p.max_order_chf).toFixed(2)}`,'Includes delivery. Card limits still apply.');
 if(p.rolling_budget)add('rolling_budget','Spending budget',`CHF ${p.rolling_budget.limit_chf} over any ${p.rolling_budget.days} days`,'Only approved purchases count as spending. Pending requests reserve capacity.');
 add('allowed_currencies','Payment currency',p.allowed_currencies?.join(', ')??'Any supported currency','Foreign prices are converted to CHF before checking your limit.');
 if(p.allowed_item_categories)add('allowed_item_categories','What the agent can buy',p.allowed_item_categories.map(s=>s.replaceAll('_',' ')).join(', '));
 if(p.product_type)add('product_type','Requested product',p.product_type.replaceAll('_',' '));
 for(const a of p.attributes)add('attribute_'+a.name,a.name==='inches'?'Screen size':a.name==='size'?'Requested size':'Requested colour',a.values.join(' or ')+(a.unit?' '+a.unit:''));
 if(p.allowed_merchant_categories)add('merchant_type','Shop type',p.allowed_merchant_categories.join(', ').replaceAll('_',' '));
 if(p.familiar_merchant)add('familiar_merchant','Familiar shops','Previously approved purchase on any of your cards','Missing history asks for review; it is not an automatic rejection.');
 if(p.regularity)add('regularity','Regular shop',`At least ${p.regularity.distinct_dates} purchase dates in ${p.regularity.days} days`,'Proposed definition for your confirmation. Incomplete history asks for review.');
 if(p.allowed_merchant_ids)add('merchant_ids','Allowed shops',p.allowed_merchant_ids.join(', '));
 if(p.allowed_merchant_countries)add('merchant_countries','Merchant countries',p.allowed_merchant_countries.join(', '));
 if(p.require_cancellation)add('cancellation','Cancellation','The order must be cancellable');
 if(p.min_return_days!==null)add('min_return_days','Returns',`At least ${p.min_return_days} days`);
 if(p.fulfillment_method)add('fulfillment_method','Delivery',p.fulfillment_method.replaceAll('_',' '));
 if(p.no_extras)add('no_extras','Extras','Only your selected product — no added items');
 if(p.duplicate_hours!==null)add('duplicates','Repeated purchases',`Ask about similar purchases within ${p.duplicate_hours} hours`,'A different request ID does not make a repeated purchase intentional.');
 if(p.max_quantity_per_order!==null)add('quantity','Quantity',`Up to ${p.max_quantity_per_order} per purchase`);
 if(p.mission_quantity!==null)add('mission_quantity','Total quantity',`Up to ${p.mission_quantity} across this shopping mission`);
 if(p.watch_devices)add('session','Session protection','Ask about an unfamiliar device, country, time or burst of purchases',`Burst review: ${p.burst_threshold??3} attempts within 10 minutes. Behaviour is a review signal, never a spending permission.`);
 add('learning','Learn confirmed habits',p.learn_confirmed_habits?'Enabled':'Disabled','Only your explicit confirmations teach device, time and country habits. Spending limits and mandatory confirmations remain unchanged.');
 add('uncertainty','When something is unclear','Ask me before proceeding','Certain violations are declined. Clear, compliant purchases are approved automatically.');
 add('home_country','Card convention','Switzerland (CH) · Europe/Zurich','Used for domestic-card checks and calendar budgets.');
 add('consent','Confirmation window',`${p.consent_ttl_seconds} seconds`,'Your response applies once to this exact purchase and policy.');return rows;
}
export function hardRulesFromParameters(p:SafetyParameters):HardRule[]{
 const out:HardRule[]=[];
 if(p.min_order_chf!=null&&p.max_order_chf!==null&&new Decimal(p.min_order_chf).eq(p.max_order_chf))out.push({field:'authorization.billing_amount_chf',operator:'=',value:Number(p.min_order_chf),currency:'CHF',scope:'purchase'});
 else {
  if(p.min_order_chf!=null)out.push({field:'authorization.billing_amount_chf',operator:'>=',value:Number(p.min_order_chf),currency:'CHF',scope:'purchase'});
  if(p.max_order_chf!==null)out.push({field:'authorization.billing_amount_chf',operator:'<=',value:Number(p.max_order_chf),currency:'CHF',scope:'purchase'});
 }
 if(p.rolling_budget)out.push({field:'authorization.billing_amount_chf',operator:'<=',value:Number(p.rolling_budget.limit_chf),currency:'CHF',scope:'period',period_days:p.rolling_budget.days});
 if(p.allowed_currencies!==null)out.push({field:'authorization.currency',operator:'in',value:p.allowed_currencies});
 return out;
}
