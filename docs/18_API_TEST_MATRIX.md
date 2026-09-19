# Matrice API offline / online — 19 septembre 2026

Cette recette vérifie le protocole API, les décisions du moteur réel, la réponse humaine par `/resolve` et les reprises après incident dans la version fusionnée. Les requêtes de cette matrice restent locales : Fastify reçoit les vrais chemins HTTP, corps JSON, en-têtes et statuts grâce à `inject`; les appels du client live traversent un transport injecté vers le simulateur. Aucun mandat ni achat distant n'est créé par ces tests.

## Matrice de protocole exécutée

`tests/api-contract-matrix.test.ts` : **187 tests réussis**, **2 318 requêtes**, **25 runs terminés**, **225 achats vérifiés**, **332 validations du schéma canonique**.

Les cinq scénarios officiels sont chacun rejoués avec cinq stratégies de test : `approve`, `decline`, `step_up` puis réponse humaine `approve`, `step_up` puis réponse humaine `decline`, et alternance des trois chemins. Ces stratégies servent à éprouver le protocole; elles ne sont pas des recommandations du moteur et ne constituent pas un corrigé métier des scénarios.

| Scénario | Achats par run | Runs | Achats contrôlés |
| --- | ---: | ---: | ---: |
| SCEN0000 | 1 | 5 | 5 |
| SCEN0001 | 10 | 5 | 50 |
| SCEN0002 | 12 | 5 | 60 |
| SCEN0003 | 11 | 5 | 55 |
| SCEN0004 | 11 | 5 | 55 |
| Total | 45 | 25 | 225 |

Pour chaque achat : conservation de l'instruction exacte, des montants/devise/frais et du temps simulé; identifiants live distincts des IDs source; relation entre achats remappée dans le même run; panier non vide; validation du schéma officiel; échéance réelle cohérente. Les résultats finaux, compteurs, curseurs et événements sont ensuite comparés. Chaque achat doit avoir exactement un événement final et chaque run exactement une clôture.

| Statut HTTP observé | Nombre | Signification vérifiée |
| --- | ---: | --- |
| 200 | 1 845 | Lectures, confirmations, décisions et reprises acceptées |
| 201 | 272 | Création de drafts et runs |
| 204 | 25 | File vide avec corps réellement vide |
| 400 | 83 | Corps, enums, identité ou paramètres invalides |
| 401 | 48 | Les 16 endpoints protégés × 3 credentials invalides |
| 404 | 15 | Identifiants absents, périmètre incorrect ou ancien état effacé |
| 409 | 30 | Conflits de décision, transition interdite, expiration ou mandat invalide |

Les compteurs de réponses réussies comprennent les relectures et reprises idempotentes. Ils ne représentent pas un nombre de paiements distincts.

## `/resolve` et cohérence des dépenses

La matrice contrôle les deux choix humains après `step_up`, avec les invariants suivants :

- Une autorisation reste `awaiting_human` tant qu'aucune réponse humaine n'est acceptée. Un `step_up` ne constitue pas une approbation.
- `/resolve` refuse un achat encore `pending`, déjà finalisé automatiquement, absent, issu d'une autre instance ou supprimé par reset. La décision `step_up` est interdite sur cette route.
- Répéter exactement une réponse conserve le résultat initial. Une réponse opposée reçoit 409. Douze réponses humaines identiques simultanées produisent un seul événement final; deux choix opposés simultanés donnent exactement une acceptation et un conflit.
- Les échéances automatiques et humaines sont testées une milliseconde avant, exactement à l'échéance et une milliseconde après. L'échéance fait foi dès la mise en file pour la décision automatique.
- Une attente humaine survit au redémarrage avec la même échéance. L'approbation survit à un second redémarrage; son rejeu reste idempotent et son remplacement reste refusé.
- Un achat en attente ou refusé ne majore pas le total approuvé. Une approbation humaine et son rejeu augmentent une seule fois le contexte de dépenses des propositions suivantes. Les runs et instances gardent des IDs et historiques distincts.

Les erreurs de type sur `decision`, `reason_codes`, `customer_message`, `evidence`, `engine_version` et les champs inconnus sont vérifiées sur les deux routes. Les lectures du registre et du flux avant/après prouvent qu'une requête rejetée ne modifie pas les résultats enregistrés.

## Recette du moteur réel et tests importés

`tests/api-readiness.test.ts` : **17 tests réussis**, dont dix parcours complets supplémentaires : cinq scénarios × deux choix humains synthétiques, via préparation, consentement, vrai worker, moteur, `/decision`, `/resolve`, registre et projection wallet. Ces dix parcours vérifient **90 achats** et **12 résolutions humaines**. Chaque achat doit finir avec 50 résultats de contrôle, un statut identique sur la plateforme et dans le wallet, un total CHF calculé au centime et aucune réservation résiduelle. Une approbation humaine n'est fournie que pour des questions de consentement auxquelles le test répond explicitement; les exigences de preuve ou d'offre corrigée ne sont pas contournées.

| Scénario | Choix humain du test | Approuvés | Refusés | `/resolve` | Total approuvé CHF |
| --- | --- | ---: | ---: | ---: | ---: |
| SCEN0000 | approve / decline | 1 | 0 | 0 | 20.00 |
| SCEN0001 | approve / decline | 5 | 5 | 0 | 387.50 |
| SCEN0002 | approve / decline | 1 | 11 | 0 | 165.00 |
| SCEN0003 | approve lorsque consentement suffisant | 5 | 6 | 6 | 841.05 |
| SCEN0003 | decline | 4 | 7 | 6 | 676.05 |
| SCEN0004 | approve / decline | 1 | 10 | 0 | 289.00 |

Les lignes `approve / decline` représentent deux exécutions distinctes aboutissant aux mêmes décisions automatiques. SCEN0001 couvre plusieurs fenêtres de sept jours; le total du scénario peut donc dépasser CHF 300. Les plafonds par achat et chaque fenêtre glissante sont recalculés indépendamment depuis les événements finaux. Les chiffres ci-dessus sont des résultats observés du moteur, pas des labels attendus fournis par l'organisateur.

La recette a révélé un retard de clôture visible : après la dernière décision, le wallet attendait la fin d'un long-poll vide de 25 secondes malgré la clôture déjà confirmée par la plateforme. La session live annule maintenant ce polling et termine après son drainage. La projection finale devient visible sans laisser les achats finalisés affichés en attente.

Les 17 fichiers uniques repris de la version API préservent les tests offline existants. Ils couvrent aussi : réponse de création perdue, résolution perdue avant/après réception, abandon durable d'une intention remplacée, pagination du flux, curseurs cycliques, historique incomplet, suspension/reprise, maintien des réservations, portée des négations marchandes, compilation des instructions et reprise frontend. Leurs confirmations utilisent le contrat fusionné `parameters` complet.

La validation ciblée côté API/backend compte **384 tests réussis dans 15 fichiers** : matrice 187, intégration moteur 17, simulateur 18 et douze fichiers de régression 162. Les tests frontend importés et la suite globale font l'objet de la recette générale de fusion. Une revue indépendante des routes, de l'authentification conditionnelle et de la session partagée entre onglets a également exécuté **45 tests réussis**; ce groupe recoupe la suite globale et ne doit pas être ajouté comme s'il s'agissait de nouveaux tests.

Le simulateur conserve ses 18 tests dédiés : authentification, métadonnées et CSV, snapshots de mandat, restrictions PATCH, révocation, deadlines, verrou de stockage, persistance, rollback après erreur disque ou événement invalide et annulation du long-poll. Ces **18 tests passent**, portant les contrôles protocole/simulateur à **205 tests réussis**.

## Reproduction

```sh
VISECA_API_MATRIX_REPORT=/tmp/viseca-api-contract-metrics.json \
node ./node_modules/vitest/vitest.mjs run tests/api-contract-matrix.test.ts tests/mock-api.test.ts

VISECA_API_ENGINE_REPORT=/tmp/viseca-api-engine-metrics.json \
node ./node_modules/vitest/vitest.mjs run tests/api-readiness.test.ts

npm run typecheck
npm test
npm run api:test
```

Les deux variables de rapport sont facultatives; elles exportent uniquement les comptes et résultats synthétiques. Les états de test persistants utilisent des répertoires temporaires supprimés après chaque test.

Les comptes de requêtes et les sorties des dix parcours moteur sont archivés dans [18_API_TEST_MATRIX_RESULTS.json](18_API_TEST_MATRIX_RESULTS.json).

## Limites

Le simulateur représente le contrat documenté dans `technical_details.md`; il ne prouve pas que le service hébergé applique exactement les mêmes règles d'idempotence, de pagination ou de concurrence. Les mesures ci-dessus concernent des injections HTTP locales, sans traversée TCP ni latence réseau réelle. Le contrôle distant de disponibilité et d'authentification appartient à la recette d'intégration générale et doit être distingué de ces tests. Les réponses humaines de cette suite sont des fixtures explicites de test, jamais une confirmation réelle du client.
