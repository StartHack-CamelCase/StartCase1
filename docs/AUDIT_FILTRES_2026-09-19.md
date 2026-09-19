# Audit fonctionnel des filtres — 19 septembre 2026

Les filtres ne peuvent pas être considérés comme entièrement fiables : **9 anomalies sont confirmées**, dont **6 de priorité P1** pouvant laisser un achat devenir autorisable malgré une contrainte ou une contradiction non résolue. Les autres concernent la détection des doublons, la résolution des questions en mode live et la détection d’une injection du pack.

P1 signifie ici « à corriger avant de se fier aux décisions autonomes ». Les reproductions concernent la simulation et le code de l’adaptateur ; elles ne démontrent aucun paiement réel effectué.

## Périmètre et validation

- Lecture des 50 contrôles actifs : 20 Merchant, 22 Customer, 8 Guards ; préparation/confirmation, agrégation, registres et intégrations Wallet/local/live.
- Comparaison avec `docs/10_SPECIFICATION_UNIFIEE_FILTRES_M_C_G.md`.
- `npm test` : **178 tests réussis, 2 échoués, 20 fichiers**.
- `npm run typecheck` : réussi.
- `npm run build` : réussi.
- `npm run offline:validate-data` : réussi, **18 empreintes, 5 scénarios, 45 événements canoniques**.
- Reproductions complémentaires par tests temporaires, avec stockage isolé et transport simulé pour le live. Fichiers temporaires supprimés après exécution.
- Aucun code applicatif, CSV, mandat ou run utilisateur modifié. Aucun appel OpenAI ou Viseca distant. Aucun parcours navigateur exécuté dans cet audit : les constats d’interface combinent lecture du frontend et reproduction des requêtes côté service/API.

Les résultats `can_finalize=true` ci-dessous désignent le moteur pur, avant engagement transactionnel. Les constats F01/F02 ont aussi été reproduits jusqu’à une décision `approve` persistée par le parcours local.

## Anomalies confirmées

### F01 — P1 — La préparation Wallet perd des contraintes explicites

**Filtres : C03, C24, M05.** La préparation ne convertit qu’une partie des exigences en paramètres. Le service confirme ensuite tous les identifiants d’exigences, y compris les exigences de couverture sans paramètre exécutable. Une case globale de confirmation ne vérifie donc pas que l’instruction est intégralement appliquée.

**Reproduction API :** scénario `SCEN0001`, mode local, instruction `Buy groceries for CHF 120 or less. Ask me before every purchase.`. La préparation devient prête sans clarification ; `always_ask=false`. La confirmation renvoie HTTP 200 et le premier achat de **44,50 CHF** est approuvé, avec `C24=pass`, sans confirmation propre à cet achat.

Une seconde reproduction fournit une variable de décodage présente `authorization.merchant.merchant_id != marchand courant` : elle est ignorée, `M05=not_applicable` et le moteur laisse finaliser.

**Attendu :** conserver toute exigence exprimée jusqu’à sa traduction vérifiée ou une clarification bloquante. La confirmation de couverture C03 ne doit pas transformer une exigence non implémentée en permission.

**Sources :** [wallet-preparation.ts:14](../packages/local-runtime/src/services/wallet-preparation.ts#L14), [wallet-service.ts:60](../packages/local-runtime/src/services/wallet-service.ts#L60).

### F02 — P1 — Une règle native non prise en charge est confirmée puis ignorée

**Filtres : C03/G06, puis plafond C09.** `suggestConfig()` marque les règles inconnues avec le libellé français `Règle non reconnue`. La confirmation cherche exclusivement le préfixe anglais `Unsupported rule` pour les bloquer.

**Reproduction API :** mandat de `SCEN0000` contenant `{field:'authorization.billing_amount_chf', operator:'<', value:1, currency:'CHF', scope:'purchase'}`. La configuration signale bien une règle non reconnue, mais sa confirmation renvoie **200**. Le premier achat de **20,00 CHF** reçoit **approve** ; G06 est marqué `pass` et un engagement est enregistré.

**Attendu :** suspendre la confirmation ou l’évaluation lorsqu’une règle ne dispose pas d’implémentation. Utiliser un code/état structuré indépendant de la traduction. L’export live possède un contrôle distinct des règles inconnues ; cette reproduction porte sur le parcours local.

**Sources :** [config.ts:44](../packages/local-runtime/src/simulation/config.ts#L44), [service.ts:28](../packages/local-runtime/src/simulation/service.ts#L28).

### F03 — P1 — Les pointures décimales sont tronquées

**Filtre : M11.** Le parseur découpe le texte sur chaque point avant d’extraire les nombres.

**Reproduction :** `parseAttributes('Selected size EU 42.5')` extrait **42**. Sur la fixture `AU0019`, remplacer le détail par cette phrase et demander EU42 : M11 passe et `can_finalize=true`. Demander EU42.5 avec cette même offre : M11 refuse.

**Impact :** faux accord sur une mauvaise pointure et faux refus sur la bonne. Les dimensions décimales empruntent le même découpage.

**Attendu :** préserver les séparateurs décimaux lors du découpage des phrases ; couvrir les deux sens du défaut par des tests.

**Source :** [parsers.ts:6](../packages/local-runtime/src/simulation/parsers.ts#L6).

### F04 — P1 — Une négation sur une ligne masque un abonnement sur une autre

**Filtre : M16.** Le contrôle concatène les descriptions du panier puis applique une négation globale.

**Reproduction :** sur `AU0018`, activer `forbid_recurring=true` produit correctement M16 `fail`. Ajouter seulement `; no subscription` à la description des chaussures rend M16 **not_applicable** et `can_finalize=true`, alors que l’autre ligne conserve `billed monthly after the first year`.

**Autre lacune du même contrôle, P2 :** la fixture intacte `AU0041` contient un article de catégorie `subscriptions`. Sans mot-clé correspondant dans son détail, M16 reste `not_applicable`, même avec `forbid_recurring=true`. La fréquence inconnue devrait demander une clarification, pas être considérée comme absence d’engagement.

**Attendu :** évaluer la récurrence et ses négations par ligne/clause ; utiliser aussi les faits structurés pour détecter un engagement à préciser.

**Source :** [merchant.ts:51](../packages/local-runtime/src/simulation/merchant.ts#L51).

### F05 — P1 — Une clause de retour négative devient une preuve positive

**Filtre : M13.** `No 30-day returns` est interprété comme une fenêtre de retour de 30 jours : `{days:30, returnable:true, conflict:false}`.

**Reproduction :** fixture `AU0019`, `order_returnable='unknown'`, détail `No 30-day returns`, `min_return_days=14`. M13 passe et `can_finalize=true`.

**Attendu :** aucune fenêtre positive ne peut être déduite de cette négation. Produire au minimum une demande de preuve, sans inventer non plus une interdiction absolue de tous les retours.

**Sources :** [parsers.ts:20](../packages/local-runtime/src/simulation/parsers.ts#L20), [merchant.ts:46](../packages/local-runtime/src/simulation/merchant.ts#L46).

### F06 — P1 — Une référence autorisée masque une contradiction sur le produit

**Filtre : M10.** Le contrôle des contradictions entre catalogue et offre dépend de `product_type!==null`, même lorsqu’une référence exacte est déjà choisie.

**Reproduction :** fixture `AU0019`, `allowed_item_ids=['IT0014']`, `product_type=null`. Conserver cet identifiant de chaussures de route, mais donner à l’offre le nom `Trail-running shoes` et le détail `Trail-running shoe, size 43`. M10 passe et `can_finalize=true` malgré la contradiction.

**Attendu :** une référence autorisée ne suffit pas à résoudre une contradiction entre les sources. Demander une vérification du produit, conformément à la section M10 de la spécification.

**Source :** [merchant.ts:22](../packages/local-runtime/src/simulation/merchant.ts#L22).

### F07 — P2 — Inverser deux variantes suffit à éviter la détection des doublons

**Filtre : C13.** La signature trie les lignes uniquement par `item_id`. Les variantes du même article restent donc dans leur ordre d’origine.

**Reproduction :** achat approuvé une heure auparavant, avec deux lignes du même `item_id`, variantes `Selected size EU 42` et `Selected size EU 43`, et horizon de doublon supérieur à une heure. Avec les mêmes lignes dans le même ordre, C13 demande confirmation. Inverser les deux lignes, en gardant les mêmes quantités et des totaux cohérents avec M19 : C13 passe et `can_finalize=true`.

**Attendu :** canonicaliser sur la signature complète de chaque ligne, incluant référence, variante et quantité. L’ordre de présentation ne doit pas faire disparaître le signal.

**Source :** [customer.ts:46](../packages/local-runtime/src/simulation/customer.ts#L46).

### F08 — P2 — Les achats live nécessitant plusieurs preuves sont impossibles à résoudre par l’interface

**Parcours : questions des filtres, interface Wallet live.** Chaque formulaire frontend transmet une seule réponse (`answers:[answer]`). Le service exige une preuve pour toutes les questions dès cette requête, sans accumuler les réponses intermédiaires.

**Reproduction avec transport simulé :** offre `AU0004`, deux lignes `item_details='Product available.'`, attributs demandés `color=red` et `size=42`, convention `shared_numeric`. Le moteur demande quatre preuves M11. Chacune envoyée isolément reçoit **422 `evidence_required`**. Les quatre preuves valides envoyées ensemble permettent l’approbation ; l’interface ne propose pas cet envoi groupé.

**Attendu :** accumuler les preuves en revalidant l’offre, comme dans le parcours local, ou fournir un formulaire global. Ne pas consommer de confirmation tant que toutes les conditions ne sont pas résolues.

**Sources :** [app.ts:36](../apps/local-web/web/app.ts#L36), [wallet-service.ts:83](../packages/local-runtime/src/services/wallet-service.ts#L83).

### F09 — P2 — L’injection AU0037 du pack n’est pas détectée

**Filtre : M20.** La fixture intacte `AU0037` reçoit M20 `pass` malgré un texte affirmant que le magasin est préautorisé jusqu’à 900 CHF et que les limites de dépense ne s’appliquent pas.

**Attendu :** le cas explicitement prévu dans la spécification doit déclencher une revue M20. Étendre les tests aux formulations du pack et à leurs variantes, tout en conservant les contrôles de permissions indépendants du détecteur.

**Limite de ce constat :** le texte ne modifie pas la configuration et **C09 continue à protéger le plafond réel**. Ce défaut ne démontre pas un relèvement effectif du budget.

**Sources :** [parsers.ts:3](../packages/local-runtime/src/simulation/parsers.ts#L3), [merchant.ts:54](../packages/local-runtime/src/simulation/merchant.ts#L54), [spécification M20](10_SPECIFICATION_UNIFIEE_FILTRES_M_C_G.md#L403).

## État de la couverture automatisée

Les tests existants vérifient notamment l’inventaire des 50 résultats, les dépassements de plafonds, certaines fenêtres glissantes avec résolution hors ordre, les signaux de revue, la révocation, l’expiration, l’idempotence et la consommation unique des confirmations. Leurs succès ne couvrent pas les reproductions ci-dessus.

Les deux échecs de la suite générale sont distincts de ces anomalies :

1. `tests/api.test.ts:341` attend encore le titre `Inspecteur local · Viseca`, alors que l’HTML annonce `Wallet control · Viseca`.
2. `tests/instruction-decoding.test.ts:103` attend qu’un champ retiré du résultat soit restitué avec le statut `absent`, mais le parseur renvoie `instruction_decoding_invalid`. La compatibilité du format partiel avec ce test doit être vérifiée. Ce résultat ne prouve pas à lui seul un échec du fournisseur IA.

Une faiblesse supplémentaire : le test Customer intitulé `reservation within budget passes` fournit une réservation dépourvue des identifiants/scope/dates attendus. Elle est éliminée avant calcul ; ce test isolé ne démontre donc pas la prise en compte d’une réservation active. D’autres tests portent sur les réservations, mais ce cas doit être rendu représentatif.

## Ordre de correction proposé

1. Fermer la perte de contraintes à la préparation et la validation des règles inconnues (F01/F02).
2. Corriger les extractions et contradictions produisant des faux accords/refus (F03–F06).
3. Corriger la signature de doublon et la résolution live à plusieurs preuves (F07/F08).
4. Compléter les cas d’injection et rétablir une suite générale entièrement verte (F09 et tests en échec).

Le présent audit documente les défauts ; aucune correction applicative n’a été appliquée.
