export type BrandedId<TName extends string> = string & {
  readonly __id: TName;
};

export type CustomerId = BrandedId<"CustomerId">;
export type AccountId = BrandedId<"AccountId">;
export type CardId = BrandedId<"CardId">;
export type MerchantId = BrandedId<"MerchantId">;
export type ItemId = BrandedId<"ItemId">;
export type ScenarioId = BrandedId<"ScenarioId">;
export type AuthorityId = BrandedId<"AuthorityId">;
export type HistoricalAuthorizationId = BrandedId<"HistoricalAuthorizationId">;
export type SourceAuthorizationId = BrandedId<"SourceAuthorizationId">;
export type DraftId = BrandedId<"DraftId">;
export type MandateId = BrandedId<"MandateId">;
export type RunId = BrandedId<"RunId">;
export type RuntimeAuthorizationId = BrandedId<"RuntimeAuthorizationId">;
export type RequestId = BrandedId<"RequestId">;
export type ProfileId = BrandedId<"ProfileId">;

export function asId<TId extends string>(value: string): TId {
  return value as TId;
}
