# Wallet control test guide

This guide covers the English wallet journey implemented by the local web app. It is a review flow for synthetic purchases; it does not claim that the Viseca challenge has been accepted.

## Run locally

Use Node 24.15.x (the project targets Node 24). From the repository root:

```sh
npm run build
npm run start:local
```

No pnpm installation is required for this guide. Open the local address printed by the server and start at `/`.

## Journey to exercise

1. Choose a scenario from the wallet home page. The original scenario instruction is shown and remains the source text for the preparation.
2. Select **Set my spending permissions** or open a scenario directly. Edit the local instruction if needed; hosted mode requires the original instruction.
3. Select **Decode instruction**. Preparation is explicit and is polled with `GET`; navigation does not trigger another decode. The preparation uses the configured extraction model (`gpt-5.4-mini`, no reasoning) when available. A `GET` never calls the model. Retry only by pressing Decode again.
4. Review the plain-English permissions, warnings and clarifications. You can lower the purchase limit in the review; raising it beyond the instruction is rejected. Optional structured details are collapsed under the technical review. Missing facts require a real value and source excerpt; a generic “yes” cannot create a fact.
5. Tick the review confirmation and select **Confirm and start**. This is the only action that starts a run. Local mode uses synthetic data and cannot move real money.
6. The run page polls automatically for offers. Clear offers show **Approved** or **Declined** with the reasons and basket. A doubt shows a typed human question. Provide the value, where it was verified and the exact supporting text, or decline the purchase. No automatic “yes” is sent after a model result or a repair.
7. Use **View structured JSON**, the 50 checks and the audit timeline to inspect evidence. Use **Revoke permissions** to stop pending local work.

The operation journal keeps request bodies and idempotency keys across a lost response. Retry the saved operation only through the visible retry action; do not refresh by inventing a new key.

## Hosted simulator boundary

Hosted mode is available only when `LEASH_BASE_URL` and `TEAM_API_KEY` are configured. It uses the challenge protocol and keeps the local snapshot separate from the platform result. A submitted decision, a `204`, and an accepted platform result are different states; a lost response is reconciled before retrying.

The local tests exercise the mock/local engine and its durable journal. They do not verify hosted Viseca exchanges. Hosted verification requires the access described in [`challenge.md`](../challenge.md) and [`technical_details.md`](../technical_details.md), including the bootstrap, real human responses, deadlines, reconciliation and observed platform acceptance. A successful local run must not be presented as challenge validation.

## Useful checks

- Ordinary purchase: confirm a scenario and verify the run feed and audit entries.
- Uncertain offer: answer with a source-backed fact or decline; verify that the question is not replaced by an approval button.
- Certain violation: verify the decline reason, all responsible filters and the absence of a confirmation bypass.
- Technical interruption: verify an amber recovery message and retry action, with no implicit approval.
- Revisit the run while typing a response: the polling update must preserve the focused field and its value.

## Verification recorded on 19 September 2026

The browser journey for SCEN0001 completed all ten synthetic purchases after one confirmation. The Responses API returned `gpt-5.4-mini-2026-03-17` in 2,848 ms (2,799 input tokens, 228 output tokens, zero reasoning tokens). This is one measured request, not a latency guarantee. The adapter defaults to `gpt-5.4-mini` with reasoning disabled; see the [official model documentation](https://developers.openai.com/api/docs/models/gpt-5.4-mini).

Automated tests cover the 204 → 200 transition with an official purchase fixture, all 50 checks, platform acceptance, durable restart, bootstrap timeouts, idempotency, and real customer-channel validation. Hosted network execution remains unverified until Viseca access is supplied.

The SCEN0003 browser check also verified two automatic approvals, an unfamiliar-device question, approval only after the explicit customer click, rejection of a later unfamiliar-shop purchase, and revocation while preserving earlier approvals. Routine reads now reuse a validated SQLite snapshot; changes from another connection invalidate the cache and trigger integrity verification again.

Final checks: TypeScript validation and production build passed; 192 tests passed in 21 files. After restart, the same local run endpoint returned HTTP 200 in 18.7 ms with the approved history and revocation intact. This timing is a single local measurement.
