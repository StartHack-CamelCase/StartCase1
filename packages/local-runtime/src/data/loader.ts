import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { Decimal } from "decimal.js";

import type {
  Account,
  AccountId,
  AuthorityId,
  Card,
  CardId,
  CatalogueItem,
  Currency,
  Customer,
  CustomerId,
  DataPack,
  FixtureAuthority,
  FxRate,
  HistoricalAuthorization,
  HistoricalAuthorizationId,
  ItemId,
  Merchant,
  MerchantId,
  Scenario,
  ScenarioId,
  SourceAttempt,
  SourceAttemptItem,
  SourceAuthorizationId,
} from "../../../contracts/src/index.js";
import { asId, CURRENCIES, DataValidationError } from "../../../contracts/src/index.js";

import {
  assertHeader,
  boolean,
  decimalString,
  identifier,
  integer,
  isoDate,
  isoDateTime,
  nullable,
  oneOf,
  parseCsv,
  required,
  type CsvRow,
  type ParsedCsv,
} from "./csv.js";

const CUSTOMER_ID = /^CU\d{4}$/;
const ACCOUNT_ID = /^AC\d{4}$/;
const CARD_ID = /^CA\d{4}$/;
const MERCHANT_ID = /^ME\d{4}$/;
const ITEM_ID = /^IT\d{4}$/;
const SCENARIO_ID = /^SCEN\d{4}$/;
const AUTHORITY_ID = /^AUTH\d{4}$/;
const SOURCE_AUTHORIZATION_ID = /^AU\d{4}$/;
const HISTORICAL_AUTHORIZATION_ID = /^TR\d{5}$/;

const ACCOUNT_TYPES = ["credit", "debit", "prepaid"] as const;
const CARD_STATUSES = ["active", "blocked", "expired"] as const;
const AUTHORITY_STATUSES = ["active", "revoked", "expired"] as const;
const ATTEMPT_CARD_STATUSES = ["active", "blocked"] as const;
const CHANNELS = ["ecommerce", "in_store", "mobile_wallet", "recurring", "atm"] as const;
const AVAILABILITIES = ["online", "store", "store_and_online", "atm"] as const;
const PURCHASE_TERMS = ["true", "false", "unknown", "not_applicable"] as const;
const RELATED_STATUSES = ["pending", "approved", "declined", "cancelled"] as const;
const INITIATOR_TYPES = ["human", "agent", "merchant"] as const;
const TRANSACTION_TYPES = ["purchase", "refund", "cash_withdrawal"] as const;
const HISTORY_STATUSES = ["approved", "declined"] as const;

const CSV_FILES = [
  "customers.csv",
  "accounts.csv",
  "cards.csv",
  "merchants.csv",
  "items.csv",
  "fx_rates.csv",
  "scenario_catalogue.csv",
  "scenario_authorities.csv",
  "purchase_attempts.csv",
  "purchase_attempt_items.csv",
  "authorization_history.csv",
] as const;

const MoneyDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => Ajv2020;

type ManifestFile = {
  path: string;
  format: string;
  rows?: number;
  sha256: string;
};

type Manifest = {
  pack_version: string;
  files: ManifestFile[];
  [key: string]: unknown;
};

export type LoadDataPackOptions = {
  dataDir?: string;
};

function fail(message: string, details?: Record<string, unknown>): never {
  throw new DataValidationError(message, details);
}

async function readJson(path: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    fail(`Unable to read ${path}`, { cause: error instanceof Error ? error.message : String(error) });
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    fail(`Invalid JSON in ${path}`, { cause: error instanceof Error ? error.message : String(error) });
  }
}

function object(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${description} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, description: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`${description} must be an array of strings`);
  }
  return value as string[];
}

function source(file: string, index: number): { file: string; row: number } {
  return { file, row: index + 2 };
}

function currency(value: string, file: string, row: number, field: string): Currency {
  return oneOf(value, CURRENCIES, file, row, field);
}

function nullableDate(
  row: CsvRow,
  field: string,
  file: string,
  rowNumber: number,
): string | null {
  const value = nullable(row, field, file, rowNumber);
  return value === null ? null : isoDate(value, file, rowNumber, field);
}

function nullableDateTime(
  row: CsvRow,
  field: string,
  file: string,
  rowNumber: number,
): string | null {
  const value = nullable(row, field, file, rowNumber);
  return value === null ? null : isoDateTime(value, file, rowNumber, field);
}

function nullableDecimal(
  row: CsvRow,
  field: string,
  file: string,
  rowNumber: number,
): string | null {
  const value = nullable(row, field, file, rowNumber);
  return value === null ? null : decimalString(value, file, rowNumber, field, { nonNegative: true });
}

function parseCustomers(table: ParsedCsv): Customer[] {
  const file = "customers.csv";
  return table.rows.map((row, index) => {
    const rowNumber = index + 2;
    return {
      customer_id: asId<CustomerId>(identifier(required(row, "customer_id", file, rowNumber), CUSTOMER_ID, file, rowNumber, "customer_id")),
      persona_name: required(row, "persona_name", file, rowNumber),
      home_region: required(row, "home_region", file, rowNumber),
      background: required(row, "background", file, rowNumber),
      shopping_preferences: required(row, "shopping_preferences", file, rowNumber),
      typical_spending: required(row, "typical_spending", file, rowNumber),
      budget_style: required(row, "budget_style", file, rowNumber),
      travel_pattern: required(row, "travel_pattern", file, rowNumber),
      source: source(file, index),
    };
  });
}

function parseAccounts(table: ParsedCsv): Account[] {
  const file = "accounts.csv";
  return table.rows.map((row, index) => {
    const rowNumber = index + 2;
    return {
      account_id: asId<AccountId>(identifier(required(row, "account_id", file, rowNumber), ACCOUNT_ID, file, rowNumber, "account_id")),
      customer_id: asId<CustomerId>(identifier(required(row, "customer_id", file, rowNumber), CUSTOMER_ID, file, rowNumber, "customer_id")),
      account_type: oneOf(required(row, "account_type", file, rowNumber), ACCOUNT_TYPES, file, rowNumber, "account_type"),
      account_purpose: required(row, "account_purpose", file, rowNumber),
      base_currency: currency(required(row, "base_currency", file, rowNumber), file, rowNumber, "base_currency"),
      status: required(row, "status", file, rowNumber),
      opened_on: isoDate(required(row, "opened_on", file, rowNumber), file, rowNumber, "opened_on"),
      per_transaction_limit_chf: decimalString(required(row, "per_transaction_limit_chf", file, rowNumber), file, rowNumber, "per_transaction_limit_chf", { positive: true }),
      monthly_limit_chf: decimalString(required(row, "monthly_limit_chf", file, rowNumber), file, rowNumber, "monthly_limit_chf", { positive: true }),
      source: source(file, index),
    };
  });
}

function parseCards(table: ParsedCsv): Card[] {
  const file = "cards.csv";
  return table.rows.map((row, index) => {
    const rowNumber = index + 2;
    return {
      card_id: asId<CardId>(identifier(required(row, "card_id", file, rowNumber), CARD_ID, file, rowNumber, "card_id")),
      account_id: asId<AccountId>(identifier(required(row, "account_id", file, rowNumber), ACCOUNT_ID, file, rowNumber, "account_id")),
      card_type: oneOf(required(row, "card_type", file, rowNumber), ACCOUNT_TYPES, file, rowNumber, "card_type"),
      card_purpose: required(row, "card_purpose", file, rowNumber),
      status: oneOf(required(row, "status", file, rowNumber), CARD_STATUSES, file, rowNumber, "status"),
      first_used_on: isoDate(required(row, "first_used_on", file, rowNumber), file, rowNumber, "first_used_on"),
      expires_on: isoDate(required(row, "expires_on", file, rowNumber), file, rowNumber, "expires_on"),
      online_enabled: boolean(required(row, "online_enabled", file, rowNumber), file, rowNumber, "online_enabled"),
      international_enabled: boolean(required(row, "international_enabled", file, rowNumber), file, rowNumber, "international_enabled"),
      virtual_card: boolean(required(row, "virtual_card", file, rowNumber), file, rowNumber, "virtual_card"),
      source: source(file, index),
    };
  });
}

function parseMerchants(table: ParsedCsv): Merchant[] {
  const file = "merchants.csv";
  return table.rows.map((row, index) => {
    const rowNumber = index + 2;
    const mcc = required(row, "merchant_mcc", file, rowNumber);
    const country = required(row, "merchant_country", file, rowNumber);
    if (!/^\d{4}$/.test(mcc)) fail(`${file}: invalid merchant_mcc`, { row: rowNumber, field: "merchant_mcc", value: mcc });
    if (!/^[A-Z]{2}$/.test(country)) fail(`${file}: invalid merchant_country`, { row: rowNumber, field: "merchant_country", value: country });
    return {
      merchant_id: asId<MerchantId>(identifier(required(row, "merchant_id", file, rowNumber), MERCHANT_ID, file, rowNumber, "merchant_id")),
      merchant_name: required(row, "merchant_name", file, rowNumber),
      merchant_category: required(row, "merchant_category", file, rowNumber),
      merchant_mcc: mcc,
      merchant_country: country,
      merchant_city: required(row, "merchant_city", file, rowNumber),
      availability: oneOf(required(row, "availability", file, rowNumber), AVAILABILITIES, file, rowNumber, "availability"),
      recurring_capable: oneOf(required(row, "recurring_capable", file, rowNumber), ["true", "false"] as const, file, rowNumber, "recurring_capable"),
      source: source(file, index),
    };
  });
}

function parseItems(table: ParsedCsv): CatalogueItem[] {
  const file = "items.csv";
  return table.rows.map((row, index) => {
    const rowNumber = index + 2;
    return {
      item_id: asId<ItemId>(identifier(required(row, "item_id", file, rowNumber), ITEM_ID, file, rowNumber, "item_id")),
      item_name: required(row, "item_name", file, rowNumber),
      item_category: required(row, "item_category", file, rowNumber),
      item_description: required(row, "item_description", file, rowNumber),
      unit_price_min_chf: decimalString(required(row, "unit_price_min_chf", file, rowNumber), file, rowNumber, "unit_price_min_chf", { scale: 2, positive: true }),
      unit_price_typical_chf: decimalString(required(row, "unit_price_typical_chf", file, rowNumber), file, rowNumber, "unit_price_typical_chf", { scale: 2, positive: true }),
      unit_price_max_chf: decimalString(required(row, "unit_price_max_chf", file, rowNumber), file, rowNumber, "unit_price_max_chf", { scale: 2, positive: true }),
      source: source(file, index),
    };
  });
}

function parseFxRates(table: ParsedCsv): FxRate[] {
  const file = "fx_rates.csv";
  return table.rows.map((row, index) => {
    const rowNumber = index + 2;
    return {
      from_currency: currency(required(row, "from_currency", file, rowNumber), file, rowNumber, "from_currency"),
      to_currency: oneOf(required(row, "to_currency", file, rowNumber), ["CHF"] as const, file, rowNumber, "to_currency"),
      rate: decimalString(required(row, "rate", file, rowNumber), file, rowNumber, "rate", { scale: 6, positive: true }),
      rate_date: isoDate(required(row, "rate_date", file, rowNumber), file, rowNumber, "rate_date"),
      source_name: required(row, "source", file, rowNumber),
      source: source(file, index),
    };
  });
}

function parseScenarios(table: ParsedCsv): Scenario[] {
  const file = "scenario_catalogue.csv";
  return table.rows.map((row, index) => {
    const rowNumber = index + 2;
    return {
      scenario_id: asId<ScenarioId>(identifier(required(row, "scenario_id", file, rowNumber), SCENARIO_ID, file, rowNumber, "scenario_id")),
      scenario_name: required(row, "scenario_name", file, rowNumber),
      cardholder_instruction: required(row, "cardholder_instruction", file, rowNumber),
      control_question: required(row, "control_question", file, rowNumber),
      control_theme: required(row, "control_theme", file, rowNumber),
      event_count: integer(required(row, "event_count", file, rowNumber), file, rowNumber, "event_count", 1),
      short_rationale: required(row, "short_rationale", file, rowNumber),
      source: source(file, index),
    };
  });
}

function parseAuthorities(table: ParsedCsv): FixtureAuthority[] {
  const file = "scenario_authorities.csv";
  return table.rows.map((row, index) => {
    const rowNumber = index + 2;
    return {
      authority_id: asId<AuthorityId>(identifier(required(row, "authority_id", file, rowNumber), AUTHORITY_ID, file, rowNumber, "authority_id")),
      customer_id: asId<CustomerId>(identifier(required(row, "customer_id", file, rowNumber), CUSTOMER_ID, file, rowNumber, "customer_id")),
      card_id: asId<CardId>(identifier(required(row, "card_id", file, rowNumber), CARD_ID, file, rowNumber, "card_id")),
      valid_from: isoDateTime(required(row, "valid_from", file, rowNumber), file, rowNumber, "valid_from"),
      valid_until: isoDateTime(required(row, "valid_until", file, rowNumber), file, rowNumber, "valid_until"),
      initial_status: oneOf(required(row, "initial_status", file, rowNumber), AUTHORITY_STATUSES, file, rowNumber, "initial_status"),
      source: source(file, index),
    };
  });
}

function parseAttempts(table: ParsedCsv): SourceAttempt[] {
  const file = "purchase_attempts.csv";
  return table.rows.map((row, index) => {
    const rowNumber = index + 2;
    const relatedId = nullable(row, "related_authorization_id", file, rowNumber);
    const relatedStatus = nullable(row, "related_authorization_status", file, rowNumber);
    return {
      authorization_id: asId<SourceAuthorizationId>(identifier(required(row, "authorization_id", file, rowNumber), SOURCE_AUTHORIZATION_ID, file, rowNumber, "authorization_id")),
      scenario_id: asId<ScenarioId>(identifier(required(row, "scenario_id", file, rowNumber), SCENARIO_ID, file, rowNumber, "scenario_id")),
      replay_order: integer(required(row, "replay_order", file, rowNumber), file, rowNumber, "replay_order", 1),
      authority_id: asId<AuthorityId>(identifier(required(row, "authority_id", file, rowNumber), AUTHORITY_ID, file, rowNumber, "authority_id")),
      card_id: asId<CardId>(identifier(required(row, "card_id", file, rowNumber), CARD_ID, file, rowNumber, "card_id")),
      merchant_id: asId<MerchantId>(identifier(required(row, "merchant_id", file, rowNumber), MERCHANT_ID, file, rowNumber, "merchant_id")),
      timestamp: isoDateTime(required(row, "timestamp", file, rowNumber), file, rowNumber, "timestamp"),
      amount: decimalString(required(row, "amount", file, rowNumber), file, rowNumber, "amount", { scale: 2, positive: true }),
      currency: currency(required(row, "currency", file, rowNumber), file, rowNumber, "currency"),
      billing_amount_chf: decimalString(required(row, "billing_amount_chf", file, rowNumber), file, rowNumber, "billing_amount_chf", { scale: 2, positive: true }),
      items_subtotal: decimalString(required(row, "items_subtotal", file, rowNumber), file, rowNumber, "items_subtotal", { scale: 2, positive: true }),
      delivery_fee: decimalString(required(row, "delivery_fee", file, rowNumber), file, rowNumber, "delivery_fee", { scale: 2, nonNegative: true }),
      channel: oneOf(required(row, "channel", file, rowNumber), CHANNELS, file, rowNumber, "channel"),
      customer_device_id: nullable(row, "customer_device_id", file, rowNumber),
      authority_status: oneOf(required(row, "authority_status", file, rowNumber), AUTHORITY_STATUSES, file, rowNumber, "authority_status"),
      card_status_at_attempt: oneOf(required(row, "card_status_at_attempt", file, rowNumber), ATTEMPT_CARD_STATUSES, file, rowNumber, "card_status_at_attempt"),
      spend_in_period_before_chf: nullableDecimal(row, "spend_in_period_before_chf", file, rowNumber),
      recent_attempt_count_10m: integer(required(row, "recent_attempt_count_10m", file, rowNumber), file, rowNumber, "recent_attempt_count_10m", 0),
      fulfillment_method: required(row, "fulfillment_method", file, rowNumber),
      delivery_by: nullableDate(row, "delivery_by", file, rowNumber),
      order_returnable: oneOf(required(row, "order_returnable", file, rowNumber), PURCHASE_TERMS, file, rowNumber, "order_returnable"),
      order_cancellable: oneOf(required(row, "order_cancellable", file, rowNumber), PURCHASE_TERMS, file, rowNumber, "order_cancellable"),
      related_authorization_id: relatedId === null ? null : asId<SourceAuthorizationId>(identifier(relatedId, SOURCE_AUTHORIZATION_ID, file, rowNumber, "related_authorization_id")),
      related_authorization_status: relatedStatus === null ? null : oneOf(relatedStatus, RELATED_STATUSES, file, rowNumber, "related_authorization_status"),
      purchase_description: required(row, "purchase_description", file, rowNumber),
      source: source(file, index),
    };
  });
}

function parseAttemptItems(table: ParsedCsv): SourceAttemptItem[] {
  const file = "purchase_attempt_items.csv";
  return table.rows.map((row, index) => {
    const rowNumber = index + 2;
    return {
      authorization_id: asId<SourceAuthorizationId>(identifier(required(row, "authorization_id", file, rowNumber), SOURCE_AUTHORIZATION_ID, file, rowNumber, "authorization_id")),
      line_no: integer(required(row, "line_no", file, rowNumber), file, rowNumber, "line_no", 1),
      item_id: asId<ItemId>(identifier(required(row, "item_id", file, rowNumber), ITEM_ID, file, rowNumber, "item_id")),
      item_name: required(row, "item_name", file, rowNumber),
      item_category: required(row, "item_category", file, rowNumber),
      quantity: integer(required(row, "quantity", file, rowNumber), file, rowNumber, "quantity", 1),
      unit_price: decimalString(required(row, "unit_price", file, rowNumber), file, rowNumber, "unit_price", { scale: 2, positive: true }),
      currency: currency(required(row, "currency", file, rowNumber), file, rowNumber, "currency"),
      item_details: required(row, "item_details", file, rowNumber),
      source: source(file, index),
    };
  });
}

function parseHistory(table: ParsedCsv): HistoricalAuthorization[] {
  const file = "authorization_history.csv";
  return table.rows.map((row, index) => {
    const rowNumber = index + 2;
    const relatedId = nullable(row, "related_transaction_id", file, rowNumber);
    return {
      authorization_id: asId<HistoricalAuthorizationId>(identifier(required(row, "authorization_id", file, rowNumber), HISTORICAL_AUTHORIZATION_ID, file, rowNumber, "authorization_id")),
      customer_id: asId<CustomerId>(identifier(required(row, "customer_id", file, rowNumber), CUSTOMER_ID, file, rowNumber, "customer_id")),
      account_id: asId<AccountId>(identifier(required(row, "account_id", file, rowNumber), ACCOUNT_ID, file, rowNumber, "account_id")),
      card_id: asId<CardId>(identifier(required(row, "card_id", file, rowNumber), CARD_ID, file, rowNumber, "card_id")),
      initiator_type: oneOf(required(row, "initiator_type", file, rowNumber), INITIATOR_TYPES, file, rowNumber, "initiator_type"),
      timestamp: isoDateTime(required(row, "timestamp", file, rowNumber), file, rowNumber, "timestamp"),
      transaction_type: oneOf(required(row, "transaction_type", file, rowNumber), TRANSACTION_TYPES, file, rowNumber, "transaction_type"),
      status: oneOf(required(row, "status", file, rowNumber), HISTORY_STATUSES, file, rowNumber, "status"),
      amount: decimalString(required(row, "amount", file, rowNumber), file, rowNumber, "amount", { scale: 2 }),
      currency: currency(required(row, "currency", file, rowNumber), file, rowNumber, "currency"),
      billing_amount_chf: decimalString(required(row, "billing_amount_chf", file, rowNumber), file, rowNumber, "billing_amount_chf", { scale: 2 }),
      merchant_id: asId<MerchantId>(identifier(required(row, "merchant_id", file, rowNumber), MERCHANT_ID, file, rowNumber, "merchant_id")),
      merchant_name: required(row, "merchant_name", file, rowNumber),
      merchant_category: required(row, "merchant_category", file, rowNumber),
      merchant_mcc: required(row, "merchant_mcc", file, rowNumber),
      merchant_country: required(row, "merchant_country", file, rowNumber),
      merchant_city: required(row, "merchant_city", file, rowNumber),
      channel: oneOf(required(row, "channel", file, rowNumber), CHANNELS, file, rowNumber, "channel"),
      card_present: boolean(required(row, "card_present", file, rowNumber), file, rowNumber, "card_present"),
      recurring: boolean(required(row, "recurring", file, rowNumber), file, rowNumber, "recurring"),
      customer_device_id: nullable(row, "customer_device_id", file, rowNumber),
      description: required(row, "description", file, rowNumber),
      related_transaction_id: relatedId === null ? null : asId<HistoricalAuthorizationId>(identifier(relatedId, HISTORICAL_AUTHORIZATION_ID, file, rowNumber, "related_transaction_id")),
      account_type: oneOf(required(row, "account_type", file, rowNumber), ACCOUNT_TYPES, file, rowNumber, "account_type"),
      account_purpose: required(row, "account_purpose", file, rowNumber),
      base_currency: currency(required(row, "base_currency", file, rowNumber), file, rowNumber, "base_currency"),
      per_transaction_limit_chf: decimalString(required(row, "per_transaction_limit_chf", file, rowNumber), file, rowNumber, "per_transaction_limit_chf", { scale: 2, positive: true }),
      monthly_limit_chf: decimalString(required(row, "monthly_limit_chf", file, rowNumber), file, rowNumber, "monthly_limit_chf", { scale: 2, positive: true }),
      card_purpose: required(row, "card_purpose", file, rowNumber),
      card_status: oneOf(required(row, "card_status", file, rowNumber), CARD_STATUSES, file, rowNumber, "card_status"),
      online_enabled: boolean(required(row, "online_enabled", file, rowNumber), file, rowNumber, "online_enabled"),
      international_enabled: boolean(required(row, "international_enabled", file, rowNumber), file, rowNumber, "international_enabled"),
      virtual_card: boolean(required(row, "virtual_card", file, rowNumber), file, rowNumber, "virtual_card"),
      customer_home_region: required(row, "customer_home_region", file, rowNumber),
      customer_budget_style: required(row, "customer_budget_style", file, rowNumber),
      customer_persona_name: required(row, "customer_persona_name", file, rowNumber),
      approved_spend_before_chf: decimalString(required(row, "approved_spend_before_chf", file, rowNumber), file, rowNumber, "approved_spend_before_chf", { scale: 2, nonNegative: true }),
      approved_merchant_transaction_count_before: integer(required(row, "approved_merchant_transaction_count_before", file, rowNumber), file, rowNumber, "approved_merchant_transaction_count_before", 0),
      approved_device_transaction_count_before: integer(required(row, "approved_device_transaction_count_before", file, rowNumber), file, rowNumber, "approved_device_transaction_count_before", 0),
      last_approved_at: nullableDateTime(row, "last_approved_at", file, rowNumber),
      source: source(file, index),
    };
  });
}

function indexUnique<T, K>(items: readonly T[], key: (item: T) => K, label: string): Map<K, T> {
  const result = new Map<K, T>();
  for (const item of items) {
    const value = key(item);
    if (result.has(value)) fail(`Duplicate ${label}`, { key: String(value) });
    result.set(value, item);
  }
  return result;
}

function requireReference<T>(value: T | undefined, message: string, details: Record<string, unknown>): T {
  if (value === undefined) fail(message, details);
  return value;
}

function equalDecimal(actual: string, expected: Decimal): boolean {
  return new MoneyDecimal(actual).equals(expected);
}

function validateRelations(input: {
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
}): Omit<DataPack, "pack_version" | "manifest_file_count" | "manifest_hashes_verified"> {
  const customersById = indexUnique(input.customers, (item) => item.customer_id, "customer_id");
  const accountsById = indexUnique(input.accounts, (item) => item.account_id, "account_id");
  const cardsById = indexUnique(input.cards, (item) => item.card_id, "card_id");
  const merchantsById = indexUnique(input.merchants, (item) => item.merchant_id, "merchant_id");
  const itemsById = indexUnique(input.items, (item) => item.item_id, "item_id");
  const scenariosById = indexUnique(input.scenarios, (item) => item.scenario_id, "scenario_id");
  const authoritiesById = indexUnique(input.authorities, (item) => item.authority_id, "authority_id");
  const fxByCurrency = indexUnique(input.fxRates, (item) => item.from_currency, "FX source currency");
  const attemptsById = indexUnique(input.attempts, (item) => item.authorization_id, "source authorization_id");
  const historyById = indexUnique(input.history, (item) => item.authorization_id, "historical authorization_id");

  for (const expectedCurrency of CURRENCIES) {
    requireReference(fxByCurrency.get(expectedCurrency), "Missing fixed FX rate", { currency: expectedCurrency });
  }

  for (const account of input.accounts) {
    requireReference(customersById.get(account.customer_id), "Account references an unknown customer", {
      ...account.source,
      customer_id: account.customer_id,
    });
  }
  for (const card of input.cards) {
    requireReference(accountsById.get(card.account_id), "Card references an unknown account", {
      ...card.source,
      account_id: card.account_id,
    });
    if (card.first_used_on >= card.expires_on) fail("Card lifecycle dates are inconsistent", { ...card.source, card_id: card.card_id });
  }
  for (const item of input.items) {
    const min = new MoneyDecimal(item.unit_price_min_chf);
    const typical = new MoneyDecimal(item.unit_price_typical_chf);
    const max = new MoneyDecimal(item.unit_price_max_chf);
    if (!min.lte(typical) || !typical.lte(max)) fail("Item price range is inconsistent", { ...item.source, item_id: item.item_id });
  }
  for (const authority of input.authorities) {
    requireReference(customersById.get(authority.customer_id), "Authority references an unknown customer", { ...authority.source, customer_id: authority.customer_id });
    const card = requireReference(cardsById.get(authority.card_id), "Authority references an unknown card", { ...authority.source, card_id: authority.card_id });
    const account = requireReference(accountsById.get(card.account_id), "Authority card references an unknown account", { ...authority.source, account_id: card.account_id });
    if (account.customer_id !== authority.customer_id) fail("Authority customer does not own its card", { ...authority.source, authority_id: authority.authority_id });
    if (Date.parse(authority.valid_from) > Date.parse(authority.valid_until)) fail("Authority validity interval is inverted", { ...authority.source, authority_id: authority.authority_id });
  }

  const attemptsByScenario = new Map<ScenarioId, SourceAttempt[]>();
  for (const attempt of input.attempts) {
    requireReference(scenariosById.get(attempt.scenario_id), "Attempt references an unknown scenario", { ...attempt.source, scenario_id: attempt.scenario_id });
    const authority = requireReference(authoritiesById.get(attempt.authority_id), "Attempt references an unknown authority", { ...attempt.source, authority_id: attempt.authority_id });
    requireReference(cardsById.get(attempt.card_id), "Attempt references an unknown card", { ...attempt.source, card_id: attempt.card_id });
    requireReference(merchantsById.get(attempt.merchant_id), "Attempt references an unknown merchant", { ...attempt.source, merchant_id: attempt.merchant_id });
    if (authority.card_id !== attempt.card_id) fail("Attempt card differs from its authority card", { ...attempt.source, authorization_id: attempt.authorization_id });
    const instant = Date.parse(attempt.timestamp);
    if (instant < Date.parse(authority.valid_from) || instant > Date.parse(authority.valid_until)) fail("Attempt is outside its authority validity interval", { ...attempt.source, authorization_id: attempt.authorization_id });
    if (attempt.related_authorization_id !== null) {
      requireReference(attemptsById.get(attempt.related_authorization_id), "Attempt references an unknown related authorization", { ...attempt.source, related_authorization_id: attempt.related_authorization_id });
      if (attempt.related_authorization_status === null) fail("Related authorization status is missing", { ...attempt.source, authorization_id: attempt.authorization_id });
    } else if (attempt.related_authorization_status !== null) {
      fail("Related authorization status exists without an ID", { ...attempt.source, authorization_id: attempt.authorization_id });
    }
    const grouped = attemptsByScenario.get(attempt.scenario_id) ?? [];
    grouped.push(attempt);
    attemptsByScenario.set(attempt.scenario_id, grouped);
  }

  for (const scenario of input.scenarios) {
    const attempts = attemptsByScenario.get(scenario.scenario_id) ?? [];
    attempts.sort((left, right) => left.replay_order - right.replay_order);
    if (attempts.length !== scenario.event_count) fail("Scenario event_count does not match its attempts", { ...scenario.source, scenario_id: scenario.scenario_id, expected: scenario.event_count, actual: attempts.length });
    const authorities = new Set(attempts.map((attempt) => attempt.authority_id));
    const cards = new Set(attempts.map((attempt) => attempt.card_id));
    if (authorities.size !== 1 || cards.size !== 1) fail("Scenario does not bind exactly one authority and card", { ...scenario.source, scenario_id: scenario.scenario_id });
    attempts.forEach((attempt, index) => {
      if (attempt.replay_order !== index + 1) fail("Scenario replay_order is not contiguous", { ...attempt.source, scenario_id: scenario.scenario_id, expected: index + 1, actual: attempt.replay_order });
      if (index > 0) {
        const previous = attempts[index - 1];
        if (previous !== undefined && previous.timestamp > attempt.timestamp) fail("Scenario timestamps are not monotonic in replay order", { ...attempt.source, scenario_id: scenario.scenario_id });
        const currentTime = Date.parse(attempt.timestamp);
        const expectedRecent = attempts.slice(0, index).filter((candidate) => {
          const candidateTime = Date.parse(candidate.timestamp);
          return currentTime - 10 * 60_000 <= candidateTime && candidateTime < currentTime;
        }).length;
        if (attempt.recent_attempt_count_10m !== expectedRecent) fail("recent_attempt_count_10m is inconsistent", { ...attempt.source, authorization_id: attempt.authorization_id, expected: expectedRecent, actual: attempt.recent_attempt_count_10m });
      } else if (attempt.recent_attempt_count_10m !== 0) {
        fail("First scenario attempt has a non-zero recent counter", { ...attempt.source, authorization_id: attempt.authorization_id });
      }
    });
  }

  const itemsByAttempt = new Map<SourceAuthorizationId, SourceAttemptItem[]>();
  const attemptLineKeys = new Set<string>();
  for (const line of input.attemptItems) {
    requireReference(attemptsById.get(line.authorization_id), "Cart line references an unknown attempt", { ...line.source, authorization_id: line.authorization_id });
    const catalogue = requireReference(itemsById.get(line.item_id), "Cart line references an unknown catalogue item", { ...line.source, item_id: line.item_id });
    const composite = `${line.authorization_id}:${line.line_no}`;
    if (attemptLineKeys.has(composite)) fail("Duplicate cart line key", { ...line.source, authorization_id: line.authorization_id, line_no: line.line_no });
    attemptLineKeys.add(composite);
    if (line.item_name !== catalogue.item_name || line.item_category !== catalogue.item_category) fail("Cart line denormalized item fields differ from the catalogue", { ...line.source, item_id: line.item_id });
    const grouped = itemsByAttempt.get(line.authorization_id) ?? [];
    grouped.push(line);
    itemsByAttempt.set(line.authorization_id, grouped);
  }

  for (const attempt of input.attempts) {
    const lines = itemsByAttempt.get(attempt.authorization_id) ?? [];
    lines.sort((left, right) => left.line_no - right.line_no);
    if (lines.length === 0) fail("Attempt has no cart lines", { ...attempt.source, authorization_id: attempt.authorization_id });
    lines.forEach((line, index) => {
      if (line.line_no !== index + 1) fail("Cart line numbers are not contiguous", { ...line.source, authorization_id: line.authorization_id, expected: index + 1, actual: line.line_no });
      if (line.currency !== attempt.currency) fail("Cart line currency differs from the attempt currency", { ...line.source, authorization_id: line.authorization_id });
    });
    const subtotal = lines.reduce((sum, line) => sum.plus(new MoneyDecimal(line.unit_price).times(line.quantity)), new MoneyDecimal(0));
    if (!equalDecimal(attempt.items_subtotal, subtotal)) fail("Attempt items_subtotal differs from its cart", { ...attempt.source, authorization_id: attempt.authorization_id, expected: subtotal.toFixed(2), actual: attempt.items_subtotal });
    const total = subtotal.plus(attempt.delivery_fee);
    if (!equalDecimal(attempt.amount, total)) fail("Attempt amount does not equal subtotal plus delivery", { ...attempt.source, authorization_id: attempt.authorization_id, expected: total.toFixed(2), actual: attempt.amount });
    const rate = requireReference(fxByCurrency.get(attempt.currency), "Attempt has no FX rate", { ...attempt.source, currency: attempt.currency });
    const billing = total.times(rate.rate).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
    if (!equalDecimal(attempt.billing_amount_chf, billing)) fail("Attempt billing_amount_chf is inconsistent", { ...attempt.source, authorization_id: attempt.authorization_id, expected: billing.toFixed(2), actual: attempt.billing_amount_chf });
    for (const line of lines) {
      const catalogue = requireReference(itemsById.get(line.item_id), "Missing catalogue item", { ...line.source, item_id: line.item_id });
      const lineRate = requireReference(fxByCurrency.get(line.currency), "Cart line has no FX rate", { ...line.source, currency: line.currency });
      const chf = new MoneyDecimal(line.unit_price).times(lineRate.rate).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
      if (chf.lt(catalogue.unit_price_min_chf) || chf.gt(catalogue.unit_price_max_chf)) fail("Cart line price is outside the catalogue range", { ...line.source, item_id: line.item_id, price_chf: chf.toFixed(2) });
    }
  }

  const historyByCard = new Map<CardId, HistoricalAuthorization[]>();
  for (const historical of input.history) {
    const customer = requireReference(customersById.get(historical.customer_id), "History references an unknown customer", { ...historical.source, customer_id: historical.customer_id });
    const account = requireReference(accountsById.get(historical.account_id), "History references an unknown account", { ...historical.source, account_id: historical.account_id });
    const card = requireReference(cardsById.get(historical.card_id), "History references an unknown card", { ...historical.source, card_id: historical.card_id });
    const merchant = requireReference(merchantsById.get(historical.merchant_id), "History references an unknown merchant", { ...historical.source, merchant_id: historical.merchant_id });
    if (card.account_id !== account.account_id || account.customer_id !== customer.customer_id) fail("History customer/account/card hierarchy is inconsistent", { ...historical.source, authorization_id: historical.authorization_id });
    if (historical.merchant_name !== merchant.merchant_name || historical.merchant_category !== merchant.merchant_category || historical.merchant_mcc !== merchant.merchant_mcc || historical.merchant_country !== merchant.merchant_country || historical.merchant_city !== merchant.merchant_city) fail("History merchant snapshot is inconsistent", { ...historical.source, authorization_id: historical.authorization_id });
    if (historical.account_type !== account.account_type || historical.account_purpose !== account.account_purpose || historical.base_currency !== account.base_currency || !new MoneyDecimal(historical.per_transaction_limit_chf).equals(account.per_transaction_limit_chf) || !new MoneyDecimal(historical.monthly_limit_chf).equals(account.monthly_limit_chf)) fail("History account snapshot is inconsistent", { ...historical.source, authorization_id: historical.authorization_id });
    if (historical.card_purpose !== card.card_purpose || historical.online_enabled !== card.online_enabled || historical.international_enabled !== card.international_enabled || historical.virtual_card !== card.virtual_card) fail("History card snapshot is inconsistent", { ...historical.source, authorization_id: historical.authorization_id });
    if (historical.customer_home_region !== customer.home_region || historical.customer_budget_style !== customer.budget_style || historical.customer_persona_name !== customer.persona_name) fail("History customer snapshot is inconsistent", { ...historical.source, authorization_id: historical.authorization_id });
    const rate = requireReference(fxByCurrency.get(historical.currency), "History row has no FX rate", { ...historical.source, currency: historical.currency });
    const billing = new MoneyDecimal(historical.amount).times(rate.rate).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
    if (!new MoneyDecimal(historical.billing_amount_chf).equals(billing)) fail("Historical billing_amount_chf is inconsistent", { ...historical.source, authorization_id: historical.authorization_id, expected: billing.toFixed(2), actual: historical.billing_amount_chf });
    if (historical.related_transaction_id !== null) requireReference(historyById.get(historical.related_transaction_id), "History references an unknown related transaction", { ...historical.source, related_transaction_id: historical.related_transaction_id });
    if (historical.transaction_type === "refund") {
      const related = historical.related_transaction_id === null ? undefined : historyById.get(historical.related_transaction_id);
      if (historical.status !== "approved" || historical.initiator_type !== "merchant" || !new MoneyDecimal(historical.amount).isNegative() || related === undefined || related.transaction_type !== "purchase" || related.card_id !== historical.card_id || related.merchant_id !== historical.merchant_id) fail("Historical refund is inconsistent", { ...historical.source, authorization_id: historical.authorization_id });
    } else if (!new MoneyDecimal(historical.amount).isPositive()) {
      fail("Non-refund historical amount is not positive", { ...historical.source, authorization_id: historical.authorization_id });
    }
    if (historical.status === "approved" && (historical.timestamp.slice(0, 10) < card.first_used_on || historical.timestamp.slice(0, 10) >= card.expires_on)) fail("Approved history row is outside card lifecycle", { ...historical.source, authorization_id: historical.authorization_id });
    const grouped = historyByCard.get(historical.card_id) ?? [];
    grouped.push(historical);
    historyByCard.set(historical.card_id, grouped);
  }

  const chronologicallySorted = [...input.history].sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.authorization_id.localeCompare(right.authorization_id));
  for (let index = 0; index < input.history.length; index += 1) {
    if (input.history[index]?.authorization_id !== chronologicallySorted[index]?.authorization_id) fail("authorization_history.csv is not ordered by (timestamp, authorization_id)", { row: index + 2 });
  }

  type DerivedState = { spend: Decimal; merchants: Map<MerchantId, number>; devices: Map<string, number>; last: string | null };
  const derivedByCard = new Map<CardId, DerivedState>();
  for (const historical of input.history) {
    let state = derivedByCard.get(historical.card_id);
    if (state === undefined) {
      state = { spend: new MoneyDecimal(0), merchants: new Map(), devices: new Map(), last: null };
      derivedByCard.set(historical.card_id, state);
    }
    const merchantCount = state.merchants.get(historical.merchant_id) ?? 0;
    const deviceCount = historical.customer_device_id === null ? 0 : (state.devices.get(historical.customer_device_id) ?? 0);
    if (!new MoneyDecimal(historical.approved_spend_before_chf).equals(state.spend) || historical.approved_merchant_transaction_count_before !== merchantCount || historical.approved_device_transaction_count_before !== deviceCount || historical.last_approved_at !== state.last) fail("Historical derived-before fields are inconsistent", { ...historical.source, authorization_id: historical.authorization_id });
    if (historical.status === "approved") {
      state.spend = state.spend.plus(historical.billing_amount_chf);
      state.merchants.set(historical.merchant_id, merchantCount + 1);
      if (historical.customer_device_id !== null) state.devices.set(historical.customer_device_id, deviceCount + 1);
      state.last = historical.timestamp;
    }
  }

  for (const rows of historyByCard.values()) rows.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.authorization_id.localeCompare(right.authorization_id));

  return {
    ...input,
    customersById,
    accountsById,
    cardsById,
    merchantsById,
    itemsById,
    scenariosById,
    authoritiesById,
    fxByCurrency,
    attemptsByScenario,
    itemsByAttempt,
    historyByCard,
  };
}

function manifestFrom(value: unknown): Manifest {
  const manifest = object(value, "metadata.json");
  if (typeof manifest["pack_version"] !== "string" || !Array.isArray(manifest["files"])) fail("metadata.json has an invalid shape");
  return manifest as Manifest;
}

function schemaHeaders(dataPackSchema: unknown, historySchema: unknown): Map<string, string[]> {
  const pack = object(dataPackSchema, "data_pack.schema.json");
  const contracts = object(pack["x-csv-contracts"], "data_pack.schema.json x-csv-contracts");
  const result = new Map<string, string[]>();
  for (const file of CSV_FILES.filter((name) => name !== "authorization_history.csv")) {
    const contract = object(contracts[file], `${file} contract`);
    result.set(file, stringArray(contract["header"], `${file} header`));
  }
  const history = object(historySchema, "authorization_history.schema.json");
  const properties = object(history["properties"], "authorization_history.schema.json properties");
  const columns = object(properties["columns"], "authorization_history.schema.json columns");
  result.set("authorization_history.csv", stringArray(columns["const"], "authorization_history.csv header"));
  return result;
}

async function verifyManifest(dataDir: string, manifest: Manifest): Promise<number> {
  const seen = new Set<string>();
  let verified = 0;
  for (const file of manifest.files) {
    if (seen.has(file.path)) fail("metadata.json contains a duplicate file path", { path: file.path });
    seen.add(file.path);
    const absolute = resolve(dataDir, file.path);
    const prefix = dataDir.endsWith(sep) ? dataDir : `${dataDir}${sep}`;
    if (!absolute.startsWith(prefix)) fail("metadata.json file path escapes the data directory", { path: file.path });
    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch (error) {
      fail("Manifest file is missing", { path: file.path, cause: error instanceof Error ? error.message : String(error) });
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== file.sha256) fail("Manifest SHA-256 mismatch", { path: file.path, expected: file.sha256, actual: digest });
    verified += 1;
  }
  return verified;
}

export async function loadDataPack(options: LoadDataPackOptions = {}): Promise<DataPack> {
  const dataDir = resolve(options.dataDir ?? resolve(process.cwd(), "data"));
  const [manifestValue, dataPackSchema, historySchema] = await Promise.all([
    readJson(resolve(dataDir, "metadata.json")),
    readJson(resolve(dataDir, "schemas/data_pack.schema.json")),
    readJson(resolve(dataDir, "schemas/authorization_history.schema.json")),
  ]);
  const manifest = manifestFrom(manifestValue);

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validateManifest = ajv.compile(dataPackSchema as object);
  if (!validateManifest(manifestValue)) fail("metadata.json does not satisfy data_pack.schema.json", { errors: validateManifest.errors ?? [] });

  const manifest_hashes_verified = await verifyManifest(dataDir, manifest);
  const headers = schemaHeaders(dataPackSchema, historySchema);
  const manifestByPath = new Map(manifest.files.map((file) => [file.path, file]));

  const parsedEntries = await Promise.all(CSV_FILES.map(async (file) => {
    const contractHeader = headers.get(file);
    if (contractHeader === undefined) fail("Missing CSV header contract", { file });
    const manifestEntry = manifestByPath.get(file);
    if (manifestEntry === undefined) fail("CSV file is absent from metadata.json", { file });
    const contents = await readFile(resolve(dataDir, file), "utf8");
    const parsed = parseCsv(file, contents);
    assertHeader(file, parsed.header, contractHeader);
    if (manifestEntry.rows !== parsed.rows.length) fail("CSV row count differs from metadata.json", { file, expected: manifestEntry.rows, actual: parsed.rows.length });
    return [file, parsed] as const;
  }));
  const tables = new Map<string, ParsedCsv>(parsedEntries);
  const table = (file: (typeof CSV_FILES)[number]): ParsedCsv => requireReference(tables.get(file), "CSV table was not loaded", { file });

  const validated = validateRelations({
    customers: parseCustomers(table("customers.csv")),
    accounts: parseAccounts(table("accounts.csv")),
    cards: parseCards(table("cards.csv")),
    merchants: parseMerchants(table("merchants.csv")),
    items: parseItems(table("items.csv")),
    fxRates: parseFxRates(table("fx_rates.csv")),
    scenarios: parseScenarios(table("scenario_catalogue.csv")),
    authorities: parseAuthorities(table("scenario_authorities.csv")),
    attempts: parseAttempts(table("purchase_attempts.csv")),
    attemptItems: parseAttemptItems(table("purchase_attempt_items.csv")),
    history: parseHistory(table("authorization_history.csv")),
  });

  return {
    pack_version: manifest.pack_version,
    manifest_file_count: manifest.files.length,
    manifest_hashes_verified,
    ...validated,
  };
}
