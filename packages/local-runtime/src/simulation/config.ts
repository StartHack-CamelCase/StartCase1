import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { AppError } from '../../../contracts/src/errors.js';
import type { HardRule, MandateRecord } from '../../../contracts/src/policy.js';
import type { FilterId, Requirement, SafetyConfig, SafetyParameters } from '../../../contracts/src/simulation.js';
import { hash } from './common.js';
export function defaultParameters():SafetyParameters{return {learn_confirmed_habits:false,min_order_chf:null,max_order_chf:null,rolling_budget:null,daily_budget_chf:null,monthly_budget_chf:null,allowed_currencies:null,allowed_merchant_ids:null,blocked_merchant_ids:[],allowed_merchant_categories:null,allowed_merchant_countries:null,familiar_merchant:false,bounded_history_required:false,regularity:null,allowed_item_categories:null,allowed_item_ids:null,product_type:null,attributes:[],numeric_size_convention:null,no_extras:false,max_quantity_per_order:null,mission_quantity:null,min_return_days:null,require_cancellation:false,fulfillment_method:null,delivery_deadline:null,forbid_recurring:false,domestic_country:null,account_purpose:null,watch_devices:false,burst_threshold:null,duplicate_hours:null,time_review:null,historical_time_review:false,unusual_country:false,unusual_amount:false,preference_categories:[],always_ask:false,autonomous_limit_chf:null,consent_ttl_seconds:120,timezone:'Europe/Zurich'};}

type AmountBounds=Pick<SafetyParameters,'min_order_chf'|'max_order_chf'|'rolling_budget'>;
type AmountOperator='<'|'<='|'='|'>'|'>=';
/** Convert an amount comparison to inclusive, exact CHF-cent bounds. */
function constrainAmount(bounds:AmountBounds,operator:AmountOperator,value:string):void {
 const amount=new Decimal(value),cents=amount.mul(100);
 const lower=operator==='>'?cents.floor().plus(1).div(100):operator==='>='?cents.ceil().div(100):operator==='='?amount:null;
 const upper=operator==='<'?cents.ceil().minus(1).div(100):operator==='<='?cents.floor().div(100):operator==='='?amount:null;
 if(operator==='='&&!cents.isInteger())throw new AppError(400,'CONFIG_INVALID','An exact CHF amount must be representable in cents.');
 if(upper?.lt(0))throw new AppError(400,'CONFIG_INVALID','The amount constraint allows no nonnegative CHF payment.');
 if(lower!==null)bounds.min_order_chf=Decimal.max(lower,bounds.min_order_chf??lower).toString();
 if(upper!==null)bounds.max_order_chf=Decimal.min(upper,bounds.max_order_chf??upper).toString();
}
export function normalizeOrderAmountBound(value:string,operator:string):Pick<AmountBounds,'min_order_chf'|'max_order_chf'>|null {
 if(!['<','<=','=','>','>='].includes(operator)||!/^\d+(?:\.\d+)?$/.test(value))return null;
 const bounds:AmountBounds={min_order_chf:null,max_order_chf:null,rolling_budget:null};
 constrainAmount(bounds,operator as AmountOperator,value);return {min_order_chf:bounds.min_order_chf,max_order_chf:bounds.max_order_chf};
}

/** Monetary source constraints only; absent bounds stay null, with no invented minimum. */
export function parseOrderAmountBounds(instruction:string):AmountBounds {
 const bounds:AmountBounds={min_order_chf:null,max_order_chf:null,rolling_budget:null};
 const text=instruction.normalize('NFKC').replaceAll('’',"'").replace(/CHF\s*(<=|>=|<|>|=)\s*(\d)/gi,'$1 CHF $2');
 // Keep range conjunctions together, but isolate order and period clauses.
 const clauses=text.split(/(?<=[.!?;])\s+|,\s+(?!\d)|\s+(?:and|et)\s+(?!(?:CHF\s*)?\d)/iu);
 const number='(\\d+(?:[.,]\\d+)?)';
 for(const clause of clauses){
  const days=clause.match(/\b(\d+|seven|sept)\s*(?:days?|jours?)\b/i);
  const period=days&&(/\b(?:across|rolling|total|budget|glissant|cumul)\b/i.test(clause)||/\b(?:over|during|pendant|sur)\s+(?:any\s+)?(?:\d+|seven|sept)\s*(?:days?|jours?)\b/i.test(clause)||(/\b(?:spend|spending|d[eé]penser|d[eé]penses)\b/i.test(clause)&&/\bwithin\b/i.test(clause)));
  const apply=(operator:AmountOperator,value:string)=>{
   if(period){
    if(operator!=='<'&&operator!=='<=')return;
    const limited:AmountBounds={min_order_chf:null,max_order_chf:null,rolling_budget:null};constrainAmount(limited,operator,value);
    const duration=/seven|sept/i.test(days[1]!)?7:Number(days[1]);
    if(duration>0&&(!bounds.rolling_budget||bounds.rolling_budget.days===duration))bounds.rolling_budget={days:duration,limit_chf:Decimal.min(limited.max_order_chf!,bounds.rolling_budget?.limit_chf??limited.max_order_chf!).toString()};
   }else constrainAmount(bounds,operator,value);
  };
  const ranged=new RegExp(`(?:between|entre|from|de)\\s+(?:CHF\\s*)?${number}\\s*(?:CHF\\s*)?(?:and|et|to|[àa])\\s*(?:CHF\\s*)?${number}\\s*(?:CHF)?|(?:CHF\\s*)?${number}\\s*[-–]\\s*(?:CHF\\s*)?${number}\\s*(?:CHF)?`,'gi');
  const spans:Array<{from:number;to:number}>=[];
  for(const match of clause.matchAll(ranged)){
   if(!/CHF/i.test(match[0]))continue;
   const low=(match[1]??match[3])!.replace(',','.'),high=(match[2]??match[4])!.replace(',','.');
   apply('>=',low);apply('<=',high);spans.push({from:match.index,to:match.index+match[0].length});
  }
  for(const match of clause.matchAll(/CHF\s*(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*CHF\b/gi)){
   if(spans.some(span=>match.index>=span.from&&match.index<span.to))continue;
   const before=clause.slice(0,match.index).trimEnd().toLowerCase(),after=clause.slice(match.index+match[0].length).trimStart().toLowerCase();
   let operator:AmountOperator|null=null;
   if(/(?:>=|≥|at least|no less than|not less than|au moins|minimum(?: de)?|sup[eé]rieur(?:e)? ou [eé]gal(?:e)? [aà])\s*$/.test(before)||/^(?:or more|or above|et plus|ou plus|minimum)\b/.test(after))operator='>=';
   else if(/(?:<=|≤|at or below|at most|up to|no more than|not more than|maximum(?: de)?|au plus|jusqu'[aà]|inf[eé]rieur(?:e)? ou [eé]gal(?:e)? [aà])\s*$/.test(before)||/^(?:or less|or below|ou moins|maximum)\b/.test(after))operator='<=';
   else if(/(?:>|more than|greater than|above|over|plus de|sup[eé]rieur(?:e)? [aà])\s*$/.test(before))operator='>';
   else if(/(?:<|less than|lower than|below|under|moins de|inf[eé]rieur(?:e)? [aà])\s*$/.test(before))operator='<';
   else if(/(?:=|exactly|equal to|equals|exactement|[eé]gal(?:e)? [aà])\s*$/.test(before)||/^exactly\b/.test(after))operator='=';
   else if(/\b(?:limit|maximum|cap|plafond|budget)\b/.test(before))operator='<=';
   if(operator)apply(operator,(match[1]??match[2])!.replace(',','.'));
  }
 }
 return bounds;
}

/** Compile a native amount rule, returning false when its meaning is unsupported. */
export function applyOrderAmountRule(parameters:AmountBounds,rule:HardRule):boolean {
 if(rule.field!=='authorization.billing_amount_chf'||(rule.currency&&rule.currency!=='CHF')||!['<','<=','=','>','>='].includes(rule.operator))return false;
 if((typeof rule.value!=='number'&&typeof rule.value!=='string')||!/^\d+(?:\.\d+)?$/.test(String(rule.value)))return false;
 const value=String(rule.value),operator=rule.operator as AmountOperator;
 if(rule.scope==='period'){
  if((operator!=='<'&&operator!=='<=')||!Number.isInteger(rule.period_days)||rule.period_days!<=0||(parameters.rolling_budget&&parameters.rolling_budget.days!==rule.period_days))return false;
  const cap:AmountBounds={min_order_chf:null,max_order_chf:null,rolling_budget:null};constrainAmount(cap,operator,value);
  parameters.rolling_budget={days:rule.period_days!,limit_chf:Decimal.min(cap.max_order_chf!,parameters.rolling_budget?.limit_chf??cap.max_order_chf!).toString()};
 }else constrainAmount(parameters,operator,value);
 return true;
}
export function suggestConfig(mandate:MandateRecord,now:string):SafetyConfig {
 const text=mandate.instruction;const p=defaultParameters();const requirements:Requirement[]=[];
 const add=(description:string,ids:FilterId[],keys:(keyof SafetyParameters)[],excerpt=text)=>requirements.push({requirement_id:'REQ_'+hash([description,excerpt]).slice(0,16),source_excerpt:excerpt,description,filter_ids:ids,parameter_keys:keys,status:'pending',question:'Relisez la correspondance et confirmez les paramètres.',author:null,revision:1});
 Object.assign(p,parseOrderAmountBounds(text));
 if(p.min_order_chf!==null||p.max_order_chf!==null)add('Purchase amount bounds, including fees',['C09'],[...(p.min_order_chf===null?[]:['min_order_chf' as const]),...(p.max_order_chf===null?[]:['max_order_chf' as const])]);
 if(p.rolling_budget)add('Rolling spending budget',['C10'],['rolling_budget']);
 if(/grocer|courses|alimentaire/i.test(text)){p.allowed_item_categories=/household|ménage/i.test(text)?['groceries','household']:['groceries'];add('Catégorie des articles : courses du ménage',['M09'],['allowed_item_categories']);}
 if(/clothes|clothing|vêtements/i.test(text)){p.allowed_item_categories=['clothing'];add('Catégorie des articles : vêtements',['M09'],['allowed_item_categories']);}
 if(/road.running|course sur route/i.test(text)){p.product_type='road_running_shoes';p.allowed_item_categories=['sporting_goods'];add('Usage : chaussures de course sur route',['M09','M10'],['product_type','allowed_item_categories']);}
 if(/monitor|moniteur/i.test(text)){p.product_type='monitor';p.allowed_item_categories=['electronics'];add('Requested product type',['M10'],['product_type']);}
 const size=text.match(/(?:size|taille)\s*(\d+(?:[.,]\d+)?)/i);if(size){p.attributes.push({name:'size',values:[size[1]!.replace(',','.')],unit:null});add('Requested size',['M11'],['attributes'],size[0]);}
 const inches=text.match(/(\d+(?:[.,]\d+)?)\s*[- ]?(?:inch|pouces?)/i);if(inches){p.attributes.push({name:'inches',values:[inches[1]!.replace(',','.')],unit:'inch'});add('Dimensions du produit',['M11'],['attributes'],inches[0]);}
 if(/specialist|spécialiste/i.test(text)){p.allowed_merchant_categories=['sporting_goods'];add('Correspondance du spécialiste sportif',['M06'],['allowed_merchant_categories']);}
 const returns=text.match(/(?:at least|au moins|within)\s*(\d+)\s*(?:days?|jours?)/i);if(/return|retour/i.test(text)){p.min_return_days=returns?Number(returns[1]):null;add('Droit de retour et durée minimale',['M13'],['min_return_days']);}
 if(/regularly|régulièrement/i.test(text)){p.regularity={days:180,distinct_dates:3};add('Régulièrement : proposition de trois dates sur 180 jours à confirmer',['M04'],['regularity']);}
 if(/used before|bought from before|shopped|already|déjà|previously/i.test(text)){p.familiar_merchant=true;add('Marchand déjà utilisé, historique gelé et toutes les cartes',['M02','M03'],['familiar_merchant']);}
 if(/deliver|livraison/i.test(text)){p.fulfillment_method='delivery';add('Mode de livraison',['M15'],['fulfillment_method']);}
 if(/do not add|don.t add|nothing|n’ajoute|n'ajoute|anything I did not|didn.t ask/i.test(text)){p.no_extras=true;add('No unrequested extras',['M12'],['no_extras']);}
 if(/\bone\b|\breplace\b|\bremplace\b|le moniteur|\b(?:the|a)\s+(?:\d+[- ]inch\s+)?(?:computer\s+)?monitor\b/i.test(text)){p.max_quantity_per_order=1;p.mission_quantity=/replace|remplace|monitor|moniteur/i.test(text)?1:null;add('Quantité demandée ; quantité de mission proposée à confirmer',['M12','C14'],['max_quantity_per_order',...(p.mission_quantity===null?[]:['mission_quantity' as const])]);}
 if(/someone else|quelqu.un d.autre|session/i.test(text)){p.watch_devices=true;add('Vigilance de session',['C15'],['watch_devices']);}
 add('Demander en cas de doute ; aucune approbation par défaut',['C25'],[]);
 add('Convention domestique et délai de confirmation simulée',['C06','G04'],['domestic_country','consent_ttl_seconds','timezone']);
 // Every complete clause stays visible for human coverage review, independent of extractor output.
 for(const clause of text.split(/(?<=[.!?;])\s+/).filter(Boolean))add('Couverture complète de cette phrase (y compris exigences non structurées)',['C03'],[],clause);
 for(const requirement of mandate.interpretation.instruction_decoding?.unmapped_requirements??[])add(requirement.description,['C03'],[],requirement.source_excerpt);
 for(const rule of mandate.hard_rules){
  let handled=false;
  if(rule.field==='authorization.billing_amount_chf')handled=applyOrderAmountRule(p,rule);
  else if(!rule.currency&&rule.scope!=='period'){
   const field={ 'authorization.currency':'allowed_currencies','authorization.merchant.merchant_id':'allowed_merchant_ids','authorization.merchant.merchant_country':'allowed_merchant_countries','authorization.merchant.merchant_category':'allowed_merchant_categories','authorization.items.item_category':'allowed_item_categories' }[rule.field] as 'allowed_currencies'|'allowed_merchant_ids'|'allowed_merchant_countries'|'allowed_merchant_categories'|'allowed_item_categories'|undefined;
   if(field&&(rule.operator==='='||rule.operator==='in')&&(typeof rule.value==='string'||Array.isArray(rule.value))){const values=Array.isArray(rule.value)?rule.value:[rule.value];p[field]=p[field]===null?values:p[field]!.filter(v=>values.includes(v));handled=true;}
   if(field==='allowed_merchant_ids'&&(rule.operator==='!='||rule.operator==='not_in')&&(typeof rule.value==='string'||Array.isArray(rule.value))){p.blocked_merchant_ids.push(...(Array.isArray(rule.value)?rule.value:[rule.value]));handled=true;}
  }
  if(!handled)add(`Règle non reconnue : ${rule.field} ${rule.operator} ${String(rule.value)}`,['G06'],[]);
 }

 return {schema_version:1,config_id:'CFG_'+randomUUID(),mandate_id:mandate.mandate_id,mandate_version:mandate.version,revision:1,instruction:text,instruction_hash:hash(text),status:'draft',requirements,parameters:p,confirmed_by:null,confirmed_at:null,created_at:now};
}
/** A G06 requirement with no parameters is the persisted representation of a
 * rule the compiler could not safely understand. Such configurations must
 * never become executable, regardless of the description language. */
export function hasUnsupportedRule(config:Pick<SafetyConfig,'requirements'>):boolean {
 return config.requirements.some(r=>r.filter_ids.includes('G06')&&r.parameter_keys.length===0);
}
const nullable=(schema:object)=>({anyOf:[{type:'null'},schema]});
const closed=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const money={type:'string',pattern:'^\\d+(\\.\\d{1,2})?$'};
const list={type:'array',items:{type:'string',minLength:1},uniqueItems:true};
const positive={type:'integer',minimum:1};
const parameterProperties:Record<string,unknown>={};
for(const [key,value] of Object.entries(defaultParameters()))parameterProperties[key]=typeof value==='boolean'?{type:'boolean'}:nullable({type:'string',minLength:1});
for(const key of ['min_order_chf','max_order_chf','daily_budget_chf','monthly_budget_chf','autonomous_limit_chf'])parameterProperties[key]=nullable(money);
for(const key of ['allowed_currencies','allowed_merchant_ids','allowed_merchant_categories','allowed_merchant_countries','allowed_item_categories','allowed_item_ids'])parameterProperties[key]=nullable(list);
for(const key of ['blocked_merchant_ids','preference_categories'])parameterProperties[key]=list;
for(const key of ['mission_quantity','max_quantity_per_order','min_return_days','burst_threshold'])parameterProperties[key]=nullable(positive);
parameterProperties['consent_ttl_seconds']={type:'integer',minimum:1,maximum:86400};
parameterProperties['timezone']={type:'string',minLength:1};
parameterProperties['duplicate_hours']=nullable({type:'number',exclusiveMinimum:0});
parameterProperties['rolling_budget']=nullable(closed({limit_chf:money,days:positive}));
parameterProperties['regularity']=nullable(closed({days:positive,distinct_dates:positive}));
parameterProperties['time_review']=nullable(closed({from_hour:{type:'integer',minimum:0,maximum:23},to_hour:{type:'integer',minimum:0,maximum:23}}));
parameterProperties['attributes']={type:'array',items:closed({name:{enum:['size','color','inches']},values:{...list,minItems:1},unit:nullable({type:'string',minLength:1})})};
parameterProperties['delivery_deadline']=nullable({type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'});
const validate = new Ajv2020({allErrors:true,strict:false}).compile(closed(parameterProperties));
export function validateParameters(value:unknown):SafetyParameters {
 // Legacy signed/persisted documents predate the floor. Normalize only a clone.
 const normalized=value&&typeof value==='object'&&!Array.isArray(value)?{learn_confirmed_habits:false,min_order_chf:null,...value}:value;
 if(!validate(normalized))throw new AppError(400,'G06_RULE_INVALID','Invalid configuration: unrecognized fields, values, or types.',{errors:validate.errors});
 const p=normalized as SafetyParameters;
 if(p.min_order_chf!==null&&p.max_order_chf!==null&&new Decimal(p.min_order_chf).gt(p.max_order_chf))throw new AppError(400,'CONFIG_INVALID','min_order_chf must be less than or equal to max_order_chf.');
 if(p.allowed_merchant_ids?.some(id=>p.blocked_merchant_ids.includes(id)))throw new AppError(400,'M05_LIST_CONFIGURATION_CONFLICT','Merchant lists conflict.');
 if(new Set(p.attributes.map(a=>a.name)).size!==p.attributes.length)throw new AppError(400,'CONFIG_INVALID','One value group per attribute is required.');
 if(p.delivery_deadline){const date=new Date(p.delivery_deadline);if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==p.delivery_deadline)throw new AppError(400,'CONFIG_INVALID','Invalid delivery date.');}
 try{new Intl.DateTimeFormat('fr',{timeZone:p.timezone}).format();}catch{throw new AppError(400,'CONFIG_INVALID','Invalid timezone.');}
 return structuredClone(p);
}
/** Confirmation may clarify a proposal or tighten a permission, never silently widen native rules. */
export function assertNoWeakening(proposed:SafetyParameters,confirmed:SafetyParameters):void {
 const reject=(key:string)=>{throw new AppError(409,'C03_PERMISSION_AMENDMENT_REQUIRED',`Permission ${key} cannot be widened without a new mandate.`);};
 if(proposed.min_order_chf!=null&&(confirmed.min_order_chf==null||new Decimal(confirmed.min_order_chf).lt(proposed.min_order_chf)))reject('min_order_chf');
 for(const key of ['max_order_chf','daily_budget_chf','monthly_budget_chf','autonomous_limit_chf'] as const)if(proposed[key]!==null&&(confirmed[key]===null||new Decimal(confirmed[key]!).gt(proposed[key]!)))reject(key);
 for(const key of ['allowed_currencies','allowed_merchant_ids','allowed_merchant_categories','allowed_merchant_countries','allowed_item_categories','allowed_item_ids'] as const)if(proposed[key]!==null&&(confirmed[key]===null||confirmed[key]!.some(v=>!proposed[key]!.includes(v))))reject(key);
 if(proposed.blocked_merchant_ids.some(v=>!confirmed.blocked_merchant_ids.includes(v)))reject('blocked_merchant_ids');
 for(const key of ['familiar_merchant','bounded_history_required','no_extras','require_cancellation','forbid_recurring','watch_devices','historical_time_review','unusual_country','unusual_amount','always_ask'] as const)if(proposed[key]&&!confirmed[key])reject(key);
 for(const key of ['max_quantity_per_order','mission_quantity'] as const)if(proposed[key]!==null&&(confirmed[key]===null||confirmed[key]!>proposed[key]!))reject(key);
 if(proposed.min_return_days!==null&&(confirmed.min_return_days===null||confirmed.min_return_days<proposed.min_return_days))reject('min_return_days');
 if(proposed.regularity!=null&&(confirmed.regularity==null||confirmed.regularity.days>proposed.regularity.days||confirmed.regularity.distinct_dates<proposed.regularity.distinct_dates))reject('regularity');
 if(proposed.delivery_deadline!=null&&(confirmed.delivery_deadline==null||confirmed.delivery_deadline>proposed.delivery_deadline))reject('delivery_deadline');
 if(proposed.duplicate_hours!=null&&(confirmed.duplicate_hours==null||confirmed.duplicate_hours<proposed.duplicate_hours))reject('duplicate_hours');
 if(proposed.burst_threshold!=null&&(confirmed.burst_threshold==null||confirmed.burst_threshold>proposed.burst_threshold))reject('burst_threshold');
 if(proposed.time_review!=null){
  const covered=(window:NonNullable<SafetyParameters['time_review']>,hour:number)=>window.from_hour<=window.to_hour?hour>=window.from_hour&&hour<window.to_hour:hour>=window.from_hour||hour<window.to_hour;
  if(confirmed.time_review==null||confirmed.timezone!==proposed.timezone||Array.from({length:24},(_,hour)=>hour).some(hour=>covered(proposed.time_review!,hour)&&!covered(confirmed.time_review!,hour)))reject('time_review');
 }
 for(const key of ['product_type','fulfillment_method'] as const)if(proposed[key]!==null&&proposed[key]!==confirmed[key])reject(key);
 if(proposed.rolling_budget&&(!confirmed.rolling_budget||confirmed.rolling_budget.days!==proposed.rolling_budget.days||new Decimal(confirmed.rolling_budget.limit_chf).gt(proposed.rolling_budget.limit_chf)))reject('rolling_budget');
 for(const attr of proposed.attributes){const c=confirmed.attributes.find(a=>a.name===attr.name);if(!c||c.values.some(v=>!attr.values.includes(v))||(attr.unit!==null&&attr.unit!==c.unit))reject(`attributes.${attr.name}`);}
}
