import type { BooleanString, Currency, ISODate, ISODateTime, PurchaseTerm } from "./data.js";
import type {
  CardId,
  CustomerId,
  MandateId,
  MerchantId,
  ProfileId,
  RequestId,
  RuntimeAuthorizationId,
  ScenarioId,
  SourceAuthorizationId,
} from "./ids.js";
import type { HardRule, UncertaintyPolicy } from "./policy.js";

export type AuthorizationEventItem = {
  line_no: number;
  item_id: string;
  item_name: string;
  item_category: string;
  quantity: number;
  unit_price: number;
  currency: Currency;
  item_details: string;
};

export type AuthorizationEventMerchant = {
  merchant_id: MerchantId;
  merchant_name: string;
  merchant_category: string;
  merchant_mcc: string;
  merchant_country: string;
  merchant_city: string;
  availability: "online" | "store" | "store_and_online" | "atm";
  recurring_capable: BooleanString;
};

export type MandateSnapshot = {
  mandate_id: MandateId;
  status: "active" | "superseded" | "revoked" | "expired";
  customer_id: CustomerId;
  card_id: CardId;
  instruction: string;
  hard_rules: HardRule[];
  uncertainty_policy: UncertaintyPolicy;
  profile_id: ProfileId;
};

export type RecentAuthorization = {
  authorization_id: RuntimeAuthorizationId;
  timestamp: ISODateTime;
  merchant_id: MerchantId;
  billing_amount_chf: number;
  status: "pending" | "approved" | "declined" | "cancelled";
};

export type AuthorizationEvent = {
  type: "authorization.request";
  request_id: RequestId;
  deadline_at: ISODateTime;
  authorization: {
    authorization_id: RuntimeAuthorizationId;
    source_authorization_id: SourceAuthorizationId;
    scenario_id: ScenarioId;
    replay_order: number;
    mandate_id: MandateId;
    profile_id: ProfileId;
    card_id: CardId;
    initiator_type: "agent";
    merchant: AuthorizationEventMerchant;
    timestamp: ISODateTime;
    amount: number;
    currency: Currency;
    billing_amount_chf: number;
    items_subtotal: number;
    delivery_fee: number;
    channel: "ecommerce" | "in_store" | "mobile_wallet" | "recurring" | "atm";
    customer_device_id: string;
    authority_status: "active" | "revoked" | "expired";
    card_status_at_attempt: "active" | "blocked";
    spend_in_period_before_chf: number | null;
    recent_attempt_count_10m: number;
    fulfillment_method: string;
    delivery_by: ISODate | null;
    order_returnable: PurchaseTerm;
    order_cancellable: PurchaseTerm;
    related_authorization_id: RuntimeAuthorizationId | null;
    related_authorization_status: "pending" | "approved" | "declined" | "cancelled" | null;
    purchase_description: string;
    items: AuthorizationEventItem[];
  };
  mandate: MandateSnapshot;
  context: {
    approved_spend_in_period_chf: number | null;
    recent_authorizations: RecentAuthorization[];
  };
  runtime: {
    received_at: ISODateTime;
    history_window_minutes: number;
    context_basis: "run_decisions_and_scenario_timestamps";
  };
};
