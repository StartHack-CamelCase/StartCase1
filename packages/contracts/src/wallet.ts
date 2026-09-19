import type { InstructionDecoding } from './instruction-decoding.js';
import type { Assessment, SafetyConfig, SafetyParameters, AuditEntry } from './simulation.js';
import type { AuthorizationEvent } from './event.js';
export type WalletMode = 'local'|'live';
export type MonetaryMeaning = 'maximum'|'minimum'|'exact'|'approximate'|'range'|'description';
/** Range endpoints come only from the customer; the original clarification retains the target and quote. */
export type MonetaryRangeInterpretation = {meaning:'approximate'|'range';min_order_chf:string;max_order_chf:string};
export type MonetaryInterpretation = MonetaryMeaning|MonetaryRangeInterpretation;
export type MonetaryInterpretations = Record<string,MonetaryInterpretation>;
export type MonetaryReviewRequirement = {source_excerpt:string;description:string};
export type WalletClarification = {key:string;label:string;type:'text'|'number'|'select'|'items';options?:Array<{value:string;label:string}>;required:boolean;value:unknown;resolution?:'purchase_review';diagnostic?:{field:string|null;decoded_value:unknown;source_excerpt:string|null;reason:string}};
export type WalletPreparation = {preparation_id:string;status:'processing'|'ready'|'failed';scenario_id:string;instruction:string;mode:WalletMode;live_environment?:'mock'|'remote';model:string;error:string|null;config:SafetyConfig|null;permissions:Array<{key:string;label:string;value:string;description:string}>;clarifications:WalletClarification[];warnings:string[];decoding:InstructionDecoding|null;created_at:string;compiler_version?:string;amount_review_requirement?:MonetaryReviewRequirement|null;confirmation?:{fingerprint:string;parameters:SafetyParameters;actor_id:string;amount_interpretations?:MonetaryInterpretations;draft_id?:string;mandate_id?:string;config_id?:string;run_id?:string}};
export type WalletRunView={run_id:string;server_time:string;has_more_proposals:boolean;platform_run_id?:string;mode:WalletMode;status:string;mandate_status?:'active'|'revocation_pending'|'revocation_unknown'|'revoked';mandate_id:string;scenario_id:string;approved_chf:string;reservations:number;purchases:Array<{authorization_id:string;merchant_id:string;merchant_name:string;amount_chf:string;currency:string;description:string;items:AuthorizationEvent['authorization']['items'];assessment:Assessment|null;platform_status?:string}>;audit:AuditEntry[];config:SafetyConfig;transport:{last_status:204|200|null;note:string;environment?:'mock'|'remote'|'disabled';last_error?:string|null}};
