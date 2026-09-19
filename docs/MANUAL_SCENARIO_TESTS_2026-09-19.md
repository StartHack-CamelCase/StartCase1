# Manual scenario verification — 19 September 2026

All five official scenarios were exercised through the English wallet UI, using the instruction → decode → review → explicit confirmation → automatic proposals flow. The 45 official proposals were inspected. Testing used an isolated local state directory; the user's main history and official input files were preserved. Payments were synthetic. The hosted Viseca simulator was unavailable because access is not configured, so HTTP 204 → 200 and remote decision recovery were covered with simulated API tests, not a real Viseca run.

## Final manually inspected runs

| Scenario | Proposals | Final outcome | Approved total |
|---|---:|---|---:|
| SCEN0000 — Connection check | 1 | 1 approved | CHF 20.00 |
| SCEN0001 — Household budget | 10 | 5 approved, 5 declined | CHF 387.50 |
| SCEN0002 — Requested item and order terms | 12 | 1 approved, 11 declined | CHF 165.00 |
| SCEN0003 — Session integrity | 11 | 5 approved, 1 declined, 2 cancelled, 3 expired | CHF 841.05 |
| SCEN0004 — Manipulated agent | 11 | 1 approved, 10 declined | CHF 289.00 |

The SCEN0001 total covers the whole run. Its CHF 300 rule applies to a rolling seven-day window, so the final CHF 88 purchase can be approved after an earlier purchase leaves that window. The reviewed SCEN0002 and SCEN0004 permissions explicitly limit the entire shopping mission to one item; subsequent quotes therefore remain declined even if another individual product check passes.

## Manual interaction evidence

- Confirmed the numeric shoe-size convention and selected the exact 27-inch monitor before starting.
- Inspected budget refusals including delivery charges, wrong product/size, insufficient or unavailable returns, unrequested extras, gift vouchers, and merchant type.
- SCEN0003: clicked confirmation for the CHF 165 unfamiliar-device purchase; the card became Approved and its confirmation controls disappeared.
- Clicked Reject for the CHF 232 purchase; it became Cancelled without increasing spending. Other proposals continued while review was outstanding.
- Let four requests expire after the default 120 seconds. Re-evaluated the expired CHF 245 purchase through the visible button, observed a new review request, then rejected it. Final reserved count: zero; approved total unchanged.
- Restarted the isolated server during SCEN0004. It resumed the remaining proposals, preserved the original CHF 289 approval, and did not approve the duplicate.
- Confirmed the main local server starts on port 3210 after the final build. A SQLite backup was created before migrating its command journal.

## Defects found and corrected

1. An ordinary single grocery item could appear as an unresolved AI requirement even though both its category and quantity were enforced. Only that precise redundant requirement is now treated as covered; genuinely additional requirements still block confirmation.
2. The literal parser accepted “inches” but missed “inch”, including “27-inch”. It now handles singular/plural and decimal display sizes without treating negated attributes as approval evidence.
3. Merchant text claiming that spending limits do not apply or that checks may be skipped now triggers the injection review signal. It cannot change the confirmed amount limit.
4. The review explicitly proposes a 24-hour duplicate check and one monitor for the whole mission. Similarity alone requests review; a proven quantity violation is declined.
5. Missing merchant familiarity previously offered an ineffective free-text proof form. The UI now explains that verified history or a new permission setup is needed, with a Review permissions link. A generic yes cannot invent a prior purchase.
6. The SQLite snapshot repeatedly copied every prior command response. Responses now live in a separate checksummed journal, committed atomically with the business state. Legacy migration validates the old checksum and refuses conflicting records. Projections no longer load every historical response. New runs also freeze only the relevant customer's history, retaining all their cards and the source coverage interval; old runs remain intact.

## Validation and limits

- `npm test`: **232 tests passed**, 27 test files.
- `npm run typecheck` and `npm run build`: passed.
- Regression checks cover rollback on both write fault points, exact replay after commit/restart, migration integrity and collisions, command corruption, literal monitor attributes, duplicate handling, and customer-history scope. All 45 proposals retain the same 50 filter outcomes when unrelated customers' history is removed.
- Decoder records for the five official instructions use `gpt-5.4-mini-2026-03-17`: 2,533–3,372 ms per recorded model call. Household/session runs reused successful earlier decodings; the other three were decoded during this manual pass. These are observations, not a latency guarantee.
- The UI journeys cover all official proposals, not every possible human-evidence combination. The one-item mission limit deliberately takes precedence over further product ambiguities after the first approval.
- Evidence, final run IDs, parameters, per-proposal outcomes and decoder timings: [manual-scenarios-2026-09-19.json](test-results/manual-scenarios-2026-09-19.json).

## Follow-up: saved permission review diagnostics

- Reproduced the reported SCEN0000 blocker in the existing browser tab. Its saved v9 decoding classified `shop I use regularly` as `merchant_category`, although the permission JSON already enforced regularity.
- Added narrow coverage for that literal history predicate, with negative tests for exclusions, extra qualifiers and missing history rules. Archived AI output stays unchanged.
- Unconfirmed saved reviews now recompile once per permission compiler version. Confirmed permissions stay unchanged; their saved checksums were verified after restarting the main server.
- Reloaded the existing SCEN0000 page: the false diagnostic disappeared, the full editable JSON retained its CHF 20 maximum, one grocery item and history rule, and `Confirm JSON and start` was enabled. No new run was started in the user's saved state during this check.
- Actual unsupported constraints now expose the decoded field, value, source and reason. Empty warning arrays are omitted from the interface.
- Verification: **320 tests passed across 29 files**, including stale-review retrieval, direct confirmation, idempotent replay and rejection of weakened permissions. Typecheck and build passed.

## Follow-up: household categories and current decoder variants

- Reproduced the saved SCEN0001 v11 output: `Household groceries are requested.` was marked unsupported despite the executable grocery/household category restriction, delivery method, CHF 120 order ceiling and CHF 300 rolling seven-day budget.
- Plain category requirements now require both matching literal source text and a compatible compiled category whitelist. Qualifiers, exclusions and unrelated permitted categories remain blocked. Saved unconfirmed reviews refresh through permission compiler v3; approved history is retained.
- Repeated all five browser journeys in a separate local state directory. SCEN0000/1 reused existing v11 decodings; SCEN0002/3/4 received new v11 decodings. A fresh SCEN0003 output incorrectly paraphrased `used before` as `uses regularly`; history coverage now follows the literal source while preserving the recorded AI output. Regression fixtures include both the earlier outputs and these new variants.
- Confirmed each JSON through the interface and observed automatic processing of all **45 proposals**. SCEN0001 completed its 10 proposals with five approvals and five refusals. The whole-run total was CHF 387.50 across the scenario dates; the constraint is CHF 300 in any seven-day window, not a whole-run ceiling.
- SCEN0003 continued processing all 11 proposals with reviews pending. The CHF 165 device-review purchase became Approved after manual confirmation; the CHF 232 purchase became Cancelled after rejection. Four other reviews remained pending when this check was recorded; they were not automatically approved.
- Validation: **353 tests passed in 30 files**, typecheck and build passed. Main-page SCEN0001 was refreshed with no unresolved diagnostic and its original JSON limits intact. All testing purchases ran in isolated local simulation; no hosted Viseca run was created.
- Recorded parameters, decoding IDs, run IDs and all decisions: [permission-coverage-2026-09-19.json](test-results/permission-coverage-2026-09-19.json).

## Follow-up: purchase cards and grouped step-up

- Exercised a new isolated SCEN0003 run (`SIM_d57a97e2-b695-42e7-9e62-c521b45ad5c4`) with clothing, CHF 250 and session-integrity rules. Merchant familiarity was omitted in this test instruction to isolate two answerable risk questions on the CHF 248 purchase.
- Observed the waiting skeleton while new proposals arrived, then its removal when all 11 proposals were processed. Existing cards remained in chronological order. Polling preserved the selected carousel position and the focused navigation control.
- The CHF 248 card listed both unfamiliar-device and rapid-purchase alerts with exactly one confirmation button. Clicking it approved the purchase once, increased the total from CHF 814.05 to CHF 1,062.05, and removed the confirmation controls.
- Rejected the CHF 245.28 purchase through its card; it became Cancelled and the approved total remained unchanged.
- Observed the countdown decrease from 2:00 into its final 30 seconds without resetting on polling or arrival of other proposals. The final 30 seconds use a more visible warning treatment.
- After expiry, the pending cards removed their confirmation controls and exposed one Re-evaluate action. Re-evaluating CHF 245 restarted a 2:00 countdown with exactly one confirmation button; rejecting it left zero reserved purchases and CHF 1,062.05 approved.
- Inspected desktop and a 390-pixel CSS viewport. Mobile cards expose the next card, scroll horizontally, and scroll their own content vertically. The page had no horizontal overflow at that width. The browser console reported no JavaScript errors.
- Server regression coverage exercises atomic multi-question submissions, full rollback for incomplete evidence, unsupported question types, exact-deadline expiry, stale revisions, authenticated channels and idempotent replay. No hosted Viseca payment was executed.
- Recorded decisions and grouped answers: [purchase-cards-2026-09-19.json](test-results/purchase-cards-2026-09-19.json).
- Final integrated validation: **590 tests passed across 38 files**, including the concurrent learning and offline-audit additions; typecheck and build passed. Restarted port 3210 and verified the new horizontal carousel on the user's existing 11-purchase run. Its complete saved run hash was unchanged across the restart; the browser reported no JavaScript errors.
