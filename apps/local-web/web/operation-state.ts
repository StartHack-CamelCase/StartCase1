import type { MandateRecord, PolicyDraft } from "../../../packages/contracts/src/policy.js";

/** Selection follows the mandate's provenance, even when newer drafts exist. */
export function selectPolicy(drafts: PolicyDraft[], mandates: MandateRecord[], draftId: string | null, mandateId: string | null): { draft: PolicyDraft | undefined; mandate: MandateRecord | undefined } {
  const explicitMandate = mandateId === null ? undefined : mandates.find((entry) => entry.mandate_id === mandateId);
  const draft = explicitMandate !== undefined
    ? drafts.find((entry) => entry.draft_id === explicitMandate.draft_id)
    : draftId === null ? drafts.at(-1) : drafts.find((entry) => entry.draft_id === draftId);
  const mandate = explicitMandate ?? (draft === undefined ? mandates.at(-1) : mandates.find((entry) => entry.draft_id === draft.draft_id));
  return { draft, mandate };
}

export type PendingOperation = { key: string; path: string; method: "POST" | "PATCH" | "DELETE"; body: string | null; created_at: string };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

/** Persist before sending; only an acknowledged response clears the intent. */
export class OperationJournal {
  constructor(private readonly storage: Storage, private readonly newKey: () => string = () => crypto.randomUUID()) {}
  private slot(path: string, method: string): string { return `viseca.operation.v1:${method}:${path}`; }
  pending(path: string, method: string = "POST"): PendingOperation | null {
    const value = this.storage.getItem(this.slot(path, method));
    if (value === null) return null;
    const operation = JSON.parse(value) as PendingOperation;
    if (operation.path !== path || operation.method !== method || typeof operation.key !== "string") throw new Error("The saved request could not be read. Reconcile it before continuing.");
    return operation;
  }
  begin(path: string, method: PendingOperation["method"], body?: unknown): PendingOperation {
    const serialized = body === undefined ? null : JSON.stringify(body);
    const pending = this.pending(path, method);
    if (pending !== null) {
      if (pending.body !== serialized) throw new Error("A request is waiting for its response. Retry the saved request before changing it.");
      return pending;
    }
    const operation = { key: this.newKey(), path, method, body: serialized, created_at: new Date().toISOString() };
    this.storage.setItem(this.slot(path, method), JSON.stringify(operation));
    return operation;
  }
  acknowledged(operation: PendingOperation): void {
    if (this.pending(operation.path, operation.method)?.key === operation.key) this.storage.removeItem(this.slot(operation.path, operation.method));
  }
}

/** A different action may reconcile an old request, but must never submit it. */
export async function journaledMutation<T>(journal:OperationJournal,path:string,body:unknown,submit:(operation:PendingOperation)=>Promise<T>,recoverPrevious?:(operation:PendingOperation)=>Promise<{allowNext:boolean;message?:string}>):Promise<T>{
  const previous=journal.pending(path);
  if(recoverPrevious&&previous&&previous.body!==JSON.stringify(body)){
    const recovery=await recoverPrevious(previous);
    journal.acknowledged(previous);
    if(!recovery.allowNext)throw new Error(recovery.message??'The previous response already finalized this purchase. Refresh its current status.');
  }
  const operation=journal.begin(path,'POST',body);
  const result=await submit(operation);
  journal.acknowledged(operation);
  return result;
}

export function variableValue(value: unknown, currency: string | null, scope: string | null, periodDays: number | null, operator: string | null): string {
  const label = Array.isArray(value) ? value.join(", ") : String(value);
  const unit = currency !== null && label !== currency && !label.endsWith(` ${currency}`) ? ` ${currency}` : "";
  return `${operator ?? ""} ${label}${unit}${scope === "period" && periodDays !== null ? ` / ${periodDays} days` : ""}`.trim();
}
