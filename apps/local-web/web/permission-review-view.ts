import {parsePermissionJson} from './wallet-ui.js';

const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const amount=(value:unknown):string=>{
 if(typeof value!=='string'||!/^\d+(?:\.\d+)?$/.test(value))throw Error('Invalid amount');
 return `CHF ${value}`;
};
const text=(value:unknown):string=>{
 if(typeof value!=='string'||!value.trim())throw Error('Invalid text');
 return value.replaceAll('_',' ');
};
const positive=(value:unknown):number=>{
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<=0)throw Error('Invalid quantity');
 return value;
};
const strings=(value:unknown):string[]=>{
 if(!Array.isArray(value)||!value.every(v=>typeof v==='string'&&v.trim()))throw Error('Invalid list');
 return value.map(text);
};

/** Render retained settings, never absent fields or implicit runtime conventions.
 * The current JSON stays authoritative when the user edits permissions. */
export function renderPermissionHighlights(source:string,instruction=''):string {
 try{
  const p=parsePermissionJson(source),points:string[]=[];
  const present=(key:string)=>p[key]!==null&&p[key]!==undefined;
  const addText=(key:string,label:string)=>{if(present(key))points.push(`${label}: ${text(p[key])}.`);};
  const flag=(key:string,label:string)=>{if(p[key]===undefined)return;if(typeof p[key]!=='boolean')throw Error('Invalid flag');if(p[key])points.push(label);};
  const allow=(key:string,label:string,empty:string)=>{if(present(key)){const values=strings(p[key]);points.push(values.length?`${label}: ${values.join(', ')}.`:empty);}};
  const optionalList=(key:string,label:string)=>{if(present(key)){const values=strings(p[key]);if(values.length)points.push(`${label}: ${values.join(', ')}.`);}};

  addText('product_type','Requested product');
  allow('allowed_item_categories','Allowed products','No product categories are permitted.');
  allow('allowed_item_ids','Selected products','No products are permitted.');
  if(p['attributes']!==undefined){
   if(!Array.isArray(p['attributes']))throw Error('Invalid attributes');
   for(const attribute of p['attributes']){
    if(!attribute||typeof attribute!=='object')throw Error('Invalid attribute');
    const label=({size:'Requested size',color:'Requested colour',inches:'Screen size'} as Record<string,string>)[attribute.name];
    if(!label)throw Error('Invalid attribute');
    const values=strings(attribute.values);if(!values.length)throw Error('Missing attribute value');
    points.push(`${label}: ${values.join(' or ')}${attribute.unit?` ${text(attribute.unit)}`:''}.`);
   }
  }
  for(const [key,label] of [['min_order_chf','Minimum per purchase'],['max_order_chf','Maximum per purchase']] as const){
   if(present(key))points.push(`${label}: ${amount(p[key])}, including delivery.`);
  }
  if(present('rolling_budget')){
   const rolling=p['rolling_budget'];if(typeof rolling!=='object'||Array.isArray(rolling))throw Error('Invalid budget');
   const budget=rolling as Record<string,unknown>;
   points.push(`Rolling budget: ${amount(budget['limit_chf'])} over any ${positive(budget['days'])} days.`);
  }
  for(const [key,label] of [['daily_budget_chf','Calendar day budget'],['monthly_budget_chf','Calendar month budget']] as const){
   if(present(key))points.push(`${label}: ${amount(p[key])}${typeof p['timezone']==='string'?` (${p['timezone']})`:''}.`);
  }
  allow('allowed_currencies','Payment currencies','No payment currencies are permitted.');
  allow('allowed_merchant_ids','Allowed shops','No shops are permitted.');
  optionalList('blocked_merchant_ids','Excluded shops');
  allow('allowed_merchant_categories','Shop types','No shop types are permitted.');
  allow('allowed_merchant_countries','Merchant countries','No merchant countries are permitted.');
  flag('familiar_merchant','Buy from shops you have used before.');
  if(present('regularity')){
   const regularity=p['regularity'];if(typeof regularity!=='object'||Array.isArray(regularity))throw Error('Invalid regularity');
   const rule=regularity as Record<string,unknown>;
   points.push(`Buy from regular shops: at least ${positive(rule['distinct_dates'])} purchase dates within ${positive(rule['days'])} days (proposed definition).`);
  }
  flag('bounded_history_required','Use a verified, bounded purchase history.');
  for(const [key,label] of [['max_quantity_per_order','Maximum quantity per purchase'],['mission_quantity','Maximum quantity across this shopping mission']] as const){
   if(present(key))points.push(`${label}: ${positive(p[key])}.`);
  }
  flag('no_extras','Do not add unrequested items.');
  if(present('min_return_days'))points.push(`Returns: at least ${positive(p['min_return_days'])} days.`);
  flag('require_cancellation','The order must be cancellable.');
  addText('fulfillment_method','Fulfilment');
  addText('delivery_deadline','Delivery deadline');
  flag('forbid_recurring','No subscriptions or recurring commitments.');
  addText('account_purpose','Account purpose');
  flag('watch_devices','Ask me about an unfamiliar device.');
  if(present('burst_threshold'))points.push(`Review a burst of ${positive(p['burst_threshold'])} purchases within 10 minutes.`);
  flag('historical_time_review','Ask me about an unusual purchase time.');
  flag('unusual_country','Ask me about an unfamiliar merchant country.');
  flag('unusual_amount','Ask me about an unusual purchase amount.');
  if(present('time_review')){
   const period=p['time_review'];if(typeof period!=='object'||Array.isArray(period))throw Error('Invalid period');
   const times=period as Record<string,unknown>;
   const hour=(value:unknown)=>{if(typeof value!=='number'||!Number.isInteger(value)||value<0||value>23)throw Error('Invalid hour');return String(value).padStart(2,'0')+':00';};
   points.push(`Review purchases from ${hour(times['from_hour'])} to ${hour(times['to_hour'])}${typeof p['timezone']==='string'?` (${p['timezone']})`:''}.`);
  }
  optionalList('preference_categories','Preferred products');
  flag('always_ask','Required for every purchase that can proceed: your confirmation.');
  if(p['always_ask']!==true&&present('autonomous_limit_chf'))points.push(`Required above ${amount(p['autonomous_limit_chf'])}: your confirmation.`);
  if(p['always_ask']!==true&&/\bask me when (?:uncertain|unsure|in doubt)\b|demande(?:z)?[- ]moi en cas de doute/i.test(instruction))points.push('Ask me when uncertain.');
  if(p['manual_review_requirements']!==undefined){
   if(!Array.isArray(p['manual_review_requirements']))throw Error('Invalid requirements');
   for(const requirement of p['manual_review_requirements']){
    if(!requirement||typeof requirement!=='object'||typeof requirement.description!=='string'||!requirement.description.trim())throw Error('Invalid requirement');
    points.push(`Confirm for each purchase: ${requirement.description}`);
   }
  }
  return `<h3>Points retained</h3>${points.length?`<ul class="retained-points">${[...new Set(points)].map(point=>`<li>${esc(point)}</li>`).join('')}</ul>`:'<p class="help-text">No instruction points to display yet.</p>'}`;
 }catch{
  return '<h3>Points retained</h3><p class="help-text" role="status">Preview unavailable. Open JSON to correct the settings.</p>';
 }
}
