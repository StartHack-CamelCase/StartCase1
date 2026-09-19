# Corrections de l’audit du moteur et du parcours de confirmation

Vérification du 19 septembre 2026. Les données utilisateur existantes sont conservées. Aucun appel réel à Viseca et aucun nouveau décodage OpenAI n’ont été nécessaires pour cette vérification.

| Point signalé | Comportement vérifié |
| --- | --- |
| Une règle « < 1 CHF » pouvait être ignorée | Les règles non compilables sont détectées par leur type G06, indépendamment de leur libellé. Elles bloquent confirmation, démarrage, export et exécution. Le mandat source est recompilé aussi pour les anciens enregistrements confirmés, même si leur exigence G06 a disparu. L’historique reste consultable. L’opérateur `<` reste non pris en charge : il est explicitement bloqué, jamais transformé en autorisation. |
| Une attente humaine arrêtait le scénario local | Les propositions suivantes sont traitées. Test SCEN0003 : deux achats en attente, puis achat ultérieur clair approuvé ; les réservations restent distinctes des montants approuvés. |
| Aucun bouton après expiration | Le bouton anglais « Re-evaluate purchase » utilise la révision courante. Test API et navigateur : expiration → nouvelle attente humaine, zéro dépense, nouvelle échéance. Une ancienne réponse ne peut pas être réutilisée. La relance est réservée aux achats locaux expirés ou en attente technique. |
| Plusieurs informations manquantes en live | Le formulaire collecte toutes les valeurs et leurs preuves dans une seule réponse. Une réponse partielle est bloquée avant envoi. Une correction de devis ne peut pas être remplacée par un simple oui. |
| Affichage périmé après confirmation live | L’état accepté par la plateforme pilote l’affichage. Les questions et boutons sont retirés après approbation/refus ou expiration. Le résultat initial reste conservé pour l’audit. |
| Reprise après coupure | Les sessions actives et leur outbox sont restaurées. La réconciliation démarre immédiatement, indépendamment du polling. Une réponse humaine dont l’envoi est incertain n’est jamais renvoyée automatiquement. Si l’état courant de la plateforme confirme une attente, l’utilisateur peut répondre de nouveau dans la fenêtre initiale. Un ancien événement step-up seul ne suffit pas à rouvrir la confirmation. |
| Réponse à 119 secondes retardée par le polling | Les attentes réseau du polling, de la réconciliation et de l’envoi sont hors de la file de mutation. Le test confirme l’envoi à 119 secondes alors que le long polling reste bloqué jusqu’à 121 secondes. Les réponses réellement tardives sont toujours rejetées. |

Un test supplémentaire couvre une fin de run annoncée pendant qu’une proposition est encore en cours de réception : le polling en cours est traité avant de marquer le run terminé.

## Validation

- `npm run typecheck` : OK.
- `npm test` : **211 tests réussis, 26 fichiers**.
- `npm run build` : OK.
- Navigateur, serveur temporaire isolé : le bouton de réévaluation fait passer un achat expiré à « Needs your review », avec CHF 0.00 approuvé et une réservation, sans approuver automatiquement.
- Respect du contrat local `technical_details.md` : attente 204 distincte de la fin du run, décisions finales comptées après acceptation plateforme, réponse humaine via `/resolve`, fenêtre issue du bootstrap (120 secondes par défaut), conservation des IDs et déduplication.

## Limites

Les parcours live sont vérifiés contre une API simulée. La connexion et les délais réseau du service Viseca réel restent à vérifier avec ses accès. Une création de mandat/run interrompue avant réception de son identifiant reste signalée comme ambiguë et n’est pas rejouée automatiquement. Aucune nouvelle période de consentement n’est accordée en live après expiration ; la plateforme conserve l’autorité sur le résultat final.
