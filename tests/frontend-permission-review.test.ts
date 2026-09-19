import {expect,it} from 'vitest';
import {renderPermissionHighlights} from '../apps/local-web/web/permission-review-view.js';
import {preparePermissions} from '../packages/local-runtime/src/services/wallet-preparation.js';
import {fixture} from './simulation-fixture.js';

const draft={max_order_chf:'200',rolling_budget:{limit_chf:'400',days:7},daily_budget_chf:'250',monthly_budget_chf:'1000',timezone:'Europe/Zurich',always_ask:false,autonomous_limit_chf:'100',allowed_currencies:['CHF']};
it('shows spending periods and confirmation thresholds from the exact current JSON without approval guarantees',()=>{
 const html=renderPermissionHighlights(JSON.stringify(draft));
 expect(html).toContain('CHF 200, including delivery');
 expect(html).toContain('CHF 400 over any 7 days');
 expect(html).toContain('Calendar day budget');expect(html).toContain('Calendar month budget');expect(html).toContain('Europe/Zurich');
 expect(html).toContain('Required above CHF 100');
 expect(html).toContain('<h3>Points retained</h3>');
 expect(html).toContain('<ul class="retained-points">');
 expect(html).toContain('<li>');expect(html).not.toContain('<dl');
});
it('keeps mandatory confirmation ahead of autonomy and omits absent or inactive settings',()=>{
 const html=renderPermissionHighlights(JSON.stringify({...draft,always_ask:true}));
 expect(html).toContain('Required for every purchase that can proceed');expect(html).not.toContain('Required above');
 const noExtra=renderPermissionHighlights(JSON.stringify({max_order_chf:null,autonomous_limit_chf:null,always_ask:false,allowed_currencies:null,attributes:[],blocked_merchant_ids:[],no_extras:false,domestic_country:'CH',duplicate_hours:24,consent_ttl_seconds:120,timezone:'Europe/Zurich'}));
 expect(noExtra).not.toContain('<li>');
 expect(noExtra).not.toContain('No extra policy limit');expect(noExtra).not.toContain('Not specified');
 expect(noExtra).not.toContain('Europe/Zurich');expect(noExtra).not.toContain('24');expect(noExtra).not.toContain('120');
 expect(renderPermissionHighlights('{}')).not.toContain('Not specified');
});
it('escapes custom human-review requirements and preserves their exact content',()=>{
 const html=renderPermissionHighlights(JSON.stringify({...draft,manual_review_requirements:[{description:'Compostable packaging <img src=x onerror=alert(1)>'}]}));
 expect(html).toContain('Confirm for each purchase:');expect(html).toContain('Compostable packaging &lt;img');expect(html).not.toContain('<img');
});
it('distinguishes an empty allowed list from an absent restriction',()=>{
 const html=renderPermissionHighlights(JSON.stringify({allowed_currencies:[],allowed_merchant_ids:[],allowed_item_categories:[]}));
 expect((html.match(/<li>/g)??[])).toHaveLength(3);
 expect(html).toMatch(/no .*currenc/i);expect(html).toMatch(/no .*shop|no .*merchant/i);expect(html).toMatch(/no .*categor/i);
 expect(renderPermissionHighlights(JSON.stringify({allowed_currencies:null,allowed_merchant_ids:null,allowed_item_categories:null}))).not.toContain('<li>');
});
it.each([
 ['SCEN0000',[/CHF 20/,/grocer/i,/regular/i,/180/,/quantity.*1|1.*quantity/i]],
 ['SCEN0001',[/CHF 120/,/CHF 300 over any 7 days/,/household/i,/delivery/i]],
 ['SCEN0002',[/CHF 200/,/road.running shoes/i,/43/,/sporting goods/i,/14 days/]],
 ['SCEN0003',[/CHF 250/,/clothing/i,/familiar|previously|used before/i,/device|session/i]],
 ['SCEN0004',[/CHF 400/,/monitor/i,/27/,/IT0017/,/familiar|previously|used before/i,/extra|unrequested items/i]],
] as const)('keeps the retained product, merchant and spending constraints for %s', (scenarioId,expected)=>{
 const ctx=fixture(),scenario=ctx.pack.scenariosById.get(scenarioId as never)!;
 const prepared=preparePermissions(ctx.pack,scenario.cardholder_instruction,null,ctx.now);
 const html=renderPermissionHighlights(JSON.stringify(prepared.config!.parameters),scenario.cardholder_instruction);
 for(const text of expected)expect(html).toMatch(text);
 expect(html).toMatch(/uncertain|unclear|doubt/i);
 expect(html).not.toContain('Not specified');expect(html).not.toContain('No extra policy limit');
});
it.each(['{broken','null','[]',JSON.stringify({...draft,max_order_chf:'unlimited'}),JSON.stringify({...draft,rolling_budget:{limit_chf:'40',days:0}}),JSON.stringify({...draft,always_ask:'false'})])('withholds misleading preview for malformed selected settings: %s',source=>{
 const html=renderPermissionHighlights(source);expect(html).toContain('Preview unavailable');expect(html).not.toContain('<li>');
});
