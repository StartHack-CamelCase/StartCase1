import type { SimplePreferencesDashboard } from './simple-preferences.js';
import type { BehaviorMLDashboard } from './behavior-ml.js';
import type { BehaviorControlEvent, BehaviorObservation, BehaviorProfile, BehaviorScope, HabitFilterId } from './behavior.js';

/** Durable projection of accepted feedback; the original decision journals remain intact. */
export type BehaviorJournal = {
  schema_version: 1;
  sequence: number;
  observations: BehaviorObservation[];
  controls: BehaviorControlEvent[];
  reviews?:BehaviorReviewEvent[];
  invalid_profiles?:Array<{customer_id:string;scope:BehaviorScope;reason:string}>;
};
export type BehaviorReviewEvent={sequence:number;customer_id:string;scope:BehaviorScope;source_id:string;authorization_id:string;filter_id:HabitFilterId;context_key:string;verdict:'confirmed'|'rejected';at:string;actor_id:string};
export type BehaviorProfileOption = {customer_id:string;scenario_id:string;scenario_name:string};
export type BehaviorProfileDashboard = {
  customer_id:string;
  scenario_id:string;
  scope:BehaviorScope;
  revision:number;
  profile:BehaviorProfile;
  permissions:Array<{run_id:string;mandate_id:string;status?:string;learning_enabled:boolean;items:Array<{key:string;label:string;value:string;description:string}>}>;
  controls:BehaviorControlEvent[];
  reviews?:Array<{authorization_id:string;source_id:string;filter_id:HabitFilterId;context_key:string;occurred_at:string;was_suppressed?:boolean;verdict:'confirmed'|'rejected'|null}>;
  metrics:{evaluations:number;alerts_avoided:number;interruptions_avoided:number;verified_suppressions:number;contradicted_suppressions:number;unknown_suppressions:number;by_filter:Array<{filter_id:HabitFilterId;evaluations:number;alerts_avoided:number;verified:number;contradicted:number;unknown:number}>};
  machine_learning?:BehaviorMLDashboard;
  simple_preferences?:SimplePreferencesDashboard;
  notice:string;
};
export type BehaviorControlRequest = {scenario_id:string;scope:BehaviorScope;filter_id:HabitFilterId;context_key:string;action:'forget'|'suspend'|'resume';expected_revision:number};
export type BehaviorFeedbackRequest={scenario_id:string;scope:BehaviorScope;authorization_id:string;filter_id:HabitFilterId;verdict:'confirmed'|'rejected';expected_revision:number};
