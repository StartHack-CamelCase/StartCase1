import type {
  AccountId,
  AuthorityId,
  CardId,
  CustomerId,
  HistoricalAuthorizationId,
  ItemId,
  MerchantId,
  ScenarioId,
  SourceAuthorizationId,
} from "./ids.js";

export const CURRENCIES = ["CHF", "EUR", "GBP", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];
export type DecimalString = string;
export type ISODate = string;
export type ISODateTime = string;
export type BooleanString = "true" | "false";
export type PurchaseTerm = BooleanString | "unknown" | "not_applicable";

export type SourceLocation = {
  file: string;
  row: number;
};

export type Customer = {
  customer_id: CustomerId;
  persona_name: string;
  home_region: string;
  background: string;
  shopping_preferences: string;
  typical_spending: string;
  budget_style: string;
  travel_pattern: string;
  source: SourceLocation;
};

export type Account = {
  account_id: AccountId;
  customer_id: CustomerId;
  account_type: "credit" | "debit" | "prepaid";
  account_purpose: string;
  base_currency: Currency;
  status: string;
  opened_on: ISODate;
  per_transaction_limit_chf: DecimalString;
  monthly_limit_chf: DecimalString;
  source: SourceLocation;
};

export type Card = {
  card_id: CardId;
  account_id: AccountId;
  card_type: string;
  card_purpose: string;
  status: "active" | "blocked" | "expired";
  first_used_on: ISODate;
  expires_on: ISODate;
  online_enabled: boolean;
  international_enabled: boolean;
  virtual_card: boolean;
  source: SourceLocation;
};

export type Merchant = {
  merchant_id: MerchantId;
  merchant_name: string;
  merchant_category: string;
  merchant_mcc: string;
  merchant_country: string;
  merchant_city: string;
  availability: "online" | "store" | "store_and_online" | "atm";
  recurring_capable: BooleanString;
  source: SourceLocation;
};

export type CatalogueItem = {
  item_id: ItemId;
  item_name: string;
  item_category: string;
  item_description: string;
  unit_price_min_chf: DecimalString;
  unit_price_typical_chf: DecimalString;
  unit_price_max_chf: DecimalString;
  source: SourceLocation;
};

export type FxRate = {
  from_currency: Currency;
  to_currency: "CHF";
  rate: DecimalString;
  rate_date: ISODate;
  source_name: string;
  source: SourceLocation;
};

export type Scenario = {
  scenario_id: ScenarioId;
  scenario_name: string;
  cardholder_instruction: string;
  control_question: string;
  control_theme: string;
  event_count: number;
  short_rationale: string;
  source: SourceLocation;
};

export type FixtureAuthority = {
  authority_id: AuthorityId;
  customer_id: CustomerId;
  card_id: CardId;
  valid_from: ISODateTime;
  valid_until: ISODateTime;
  initial_status: "active" | "revoked" | "expired";
  source: SourceLocation;
};

export type SourceAttempt = {
  authorization_id: SourceAuthorizationId;
  scenario_id: ScenarioId;
  replay_order: number;
  authority_id: AuthorityId;
  card_id: CardId;
  merchant_id: MerchantId;
  timestamp: ISODateTime;
  amount: DecimalString;
  currency: Currency;
  billing_amount_chf: DecimalString;
  items_subtotal: DecimalString;
  delivery_fee: DecimalString;
  channel: "ecommerce" | "in_store" | "mobile_wallet" | "recurring" | "atm";
  customer_device_id: string | null;
  authority_status: "active" | "revoked" | "expired";
  card_status_at_attempt: "active" | "blocked";
  spend_in_period_before_chf: DecimalString | null;
  recent_attempt_count_10m: number;
  fulfillment_method: string;
  delivery_by: ISODate | null;
  order_returnable: PurchaseTerm;
  order_cancellable: PurchaseTerm;
  related_authorization_id: SourceAuthorizationId | null;
  related_authorization_status: "pending" | "approved" | "declined" | "cancelled" | null;
  purchase_description: string;
  source: SourceLocation;
};

export type SourceAttemptItem = {
  authorization_id: SourceAuthorizationId;
  line_no: number;
  item_id: ItemId;
  item_name: string;
  item_category: string;
  quantity: number;
  unit_price: DecimalString;
  currency: Currency;
  item_details: string;
  source: SourceLocation;
};

export type HistoricalAuthorization = {
  authorization_id: HistoricalAuthorizationId;
  customer_id: CustomerId;
  account_id: AccountId;
  card_id: CardId;
  initiator_type: "human" | "agent" | "merchant";
  timestamp: ISODateTime;
  transaction_type: "purchase" | "refund" | "cash_withdrawal";
  status: "approved" | "declined";
  amount: DecimalString;
  currency: Currency;
  billing_amount_chf: DecimalString;
  merchant_id: MerchantId;
  merchant_name: string;
  merchant_category: string;
  merchant_mcc: string;
  merchant_country: string;
  merchant_city: string;
  channel: "ecommerce" | "in_store" | "mobile_wallet" | "recurring" | "atm";
  card_present: boolean;
  recurring: boolean;
  customer_device_id: string | null;
  description: string;
  related_transaction_id: HistoricalAuthorizationId | null;
  account_type: "credit" | "debit" | "prepaid";
  account_purpose: string;
  base_currency: Currency;
  per_transaction_limit_chf: DecimalString;
  monthly_limit_chf: DecimalString;
  card_purpose: string;
  card_status: "active" | "blocked" | "expired";
  online_enabled: boolean;
  international_enabled: boolean;
  virtual_card: boolean;
  customer_home_region: string;
  customer_budget_style: string;
  customer_persona_name: string;
  approved_spend_before_chf: DecimalString;
  approved_merchant_transaction_count_before: number;
  approved_device_transaction_count_before: number;
  last_approved_at: ISODateTime | null;
  source: SourceLocation;
};

export type DataPack = {
  pack_version: string;
  manifest_file_count: number;
  manifest_hashes_verified: number;
  customers: Customer[];
  accounts: Account[];
  cards: Card[];
  merchants: Merchant[];
  items: CatalogueItem[];
  fxRates: FxRate[];
  scenarios: Scenario[];
  authorities: FixtureAuthority[];
  attempts: SourceAttempt[];
  attemptItems: SourceAttemptItem[];
  history: HistoricalAuthorization[];
  customersById: ReadonlyMap<CustomerId, Customer>;
  accountsById: ReadonlyMap<AccountId, Account>;
  cardsById: ReadonlyMap<CardId, Card>;
  merchantsById: ReadonlyMap<MerchantId, Merchant>;
  itemsById: ReadonlyMap<ItemId, CatalogueItem>;
  scenariosById: ReadonlyMap<ScenarioId, Scenario>;
  authoritiesById: ReadonlyMap<AuthorityId, FixtureAuthority>;
  fxByCurrency: ReadonlyMap<Currency, FxRate>;
  attemptsByScenario: ReadonlyMap<ScenarioId, SourceAttempt[]>;
  itemsByAttempt: ReadonlyMap<SourceAuthorizationId, SourceAttemptItem[]>;
  historyByCard: ReadonlyMap<CardId, HistoricalAuthorization[]>;
};
