import { AppError, asId } from "../../../contracts/src/index.js";
import type {
  DataPack,
  DraftId,
  MandateId,
  ScenarioDetail,
  ScenarioId,
  ScenarioSummary,
} from "../../../contracts/src/index.js";
import type { PolicyService } from "./policy-service.js";

const INITIAL_GUIDANCE =
  "Business interpretation is not configured. No rule is extracted automatically.";
const INITIAL_QUESTION =
  "Define and manually validate the transcription of this instruction requirements.";

export class ScenarioService {
  constructor(
    private readonly pack: DataPack,
    private readonly policies: PolicyService,
  ) {}

  list(): ScenarioSummary[] {
    return this.pack.scenarios.map((scenario) => this.summary(scenario.scenario_id));
  }

  get(
    scenarioId: ScenarioId,
    selection?: { draftId?: DraftId; mandateId?: MandateId },
  ): ScenarioDetail {
    const summary = this.summary(scenarioId);
    const drafts = this.policies.listDraftsForScenario(scenarioId);
    const mandates = this.policies.listMandatesForScenario(scenarioId);

    if (selection?.draftId !== undefined && !drafts.some((draft) => draft.draft_id === selection.draftId)) {
      throw new AppError(404, "draft_not_found", "The requested draft does not exist for this scenario.");
    }
    if (
      selection?.mandateId !== undefined &&
      !mandates.some((mandate) => mandate.mandate_id === selection.mandateId)
    ) {
      throw new AppError(404, "mandate_not_found", "The requested mandate does not exist for this scenario.");
    }

    return {
      ...summary,
      initial_policy: {
        instruction: summary.scenario.cardholder_instruction,
        hard_rules: [],
        uncertainty_policy: "ask",
        guidance: [INITIAL_GUIDANCE],
        open_questions: [INITIAL_QUESTION],
        interpretation: {
          status: "not_started",
          producer: null,
          version: null,
          model_id: null,
          requirements: [],
        },
      },
      drafts,
      mandates,
    };
  }

  private summary(scenarioId: ScenarioId): ScenarioSummary {
    const scenario = this.pack.scenariosById.get(scenarioId);
    if (scenario === undefined) {
      throw new AppError(404, "scenario_not_found", "The requested scenario does not exist.", {
        scenario_id: scenarioId,
      });
    }
    const attempts = this.pack.attemptsByScenario.get(scenarioId) ?? [];
    const firstAttempt = attempts[0];
    if (firstAttempt === undefined) {
      throw new AppError(503, "data_pack_invalid", "The scenario contains no purchase.", {
        scenario_id: scenarioId,
      });
    }
    const authority = this.pack.authoritiesById.get(firstAttempt.authority_id);
    const card = this.pack.cardsById.get(firstAttempt.card_id);
    if (authority === undefined || card === undefined) {
      throw new AppError(503, "data_pack_invalid", "Scenario relations are incomplete.", {
        scenario_id: scenarioId,
      });
    }
    const account = this.pack.accountsById.get(card.account_id);
    const customer = account === undefined ? undefined : this.pack.customersById.get(account.customer_id);
    if (customer === undefined) {
      throw new AppError(503, "data_pack_invalid", "Scenario identity is incomplete.", {
        scenario_id: scenarioId,
      });
    }

    return {
      scenario,
      event_count: attempts.length,
      customer: {
        customer_id: customer.customer_id,
        persona_name: customer.persona_name,
        home_region: customer.home_region,
      },
      card: {
        card_id: card.card_id,
        card_type: card.card_type,
        card_purpose: card.card_purpose,
        status: card.status,
      },
      authority,
    };
  }
}

export function scenarioId(value: string): ScenarioId {
  if (!/^SCEN[0-9]{4}$/.test(value)) {
    throw new AppError(400, "invalid_scenario_id", "The scenario identifier is invalid.");
  }
  return asId<ScenarioId>(value);
}
