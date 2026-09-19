# Audit de cohérence — code, challenge, spécifications, données et PLAN

Audit du 19 septembre 2026, sur l'état de travail local. Aucun code applicatif, document de conception, CSV, mandat ou run utilisateur n'a été modifié. Seul ce rapport a été ajouté ; les reproductions ont utilisé des stockages temporaires supprimés ensuite. Aucun appel OpenAI ou Viseca n'a été lancé.

**Conclusion : le socle d'inspection est globalement cohérent avec la phase A du PLAN. Il ne satisfait pas encore le challenge de décision de paiement. Les anomalies les plus importantes concernent la conservation des intentions client, l'affichage de la bonne politique et la robustesse du registre. Le pack fourni ne présente pas d'anomalie confirmée dans les contrôles effectués.**

## 1. Périmètre et travail des autres agents

Les tâches voisines ont été consultées en lecture seule :

- **« Initialiser l’application Viseca »** avait terminé un diagnostic de latence, de structure du décodage et du doublon « CHF CHF ». Les constats correspondants ci-dessous confirment ce diagnostic ; ils ne sont pas présentés comme des découvertes nouvelles.
- **« Proposer filtres de sécurité IA »** consolidait les filtres M/C/G dans [docs/10_SPECIFICATION_UNIFIEE_FILTRES_M_C_G.md](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/docs/10_SPECIFICATION_UNIFIEE_FILTRES_M_C_G.md>). Ce fichier est apparu pendant l'audit. Ses choix sont traités comme une spécification du prochain lot, pas comme des fonctionnalités déjà livrées.

L'index documentaire a été actualisé pendant l'audit et désigne désormais le document 10 comme référence du prochain développement. Je ne retiens donc pas comme anomalie l'absence transitoire de ce lien. Les documents 07–09 sont remplacés pour ce lot ; le document 06 comporte un avertissement de périmètre historique.

## 2. Correspondance entre demande et réalisation

| Demande / contrat | État vérifié | Lecture correcte |
| --- | --- | --- |
| Travailler sur le pack fourni et préserver ses faits | 11 CSV, 18 empreintes, 45 achats et 56 lignes panier ; jointures et montants vérifiés | Socle aligné |
| Conserver l'instruction exacte du client | Contrôle à la création du brouillon, texte conservé dans le mandat et son snapshot | Aligné |
| Traduire toutes les exigences en permissions exécutables | Variables IA proposées ; règles encore manuelles ; aucune compilation métier | Partiel, avec défauts sémantiques confirmés |
| Confirmation, resserrement, révocation | Services présents, versions contrôlées, confirmation explicite pour inspection | Socle présent ; défaut d'affichage des permissions courantes |
| Décider `approve`, `decline`, `step_up` | `RunService` refuse l'évaluation ; chaque achat reste `not_evaluated` | Report volontaire du PLAN, mais exigence finale non satisfaite |
| Approbation et rejet humains d'un achat | Route de résolution explicitement indisponible | Report volontaire ; parcours de démonstration encore absent |
| Budgets glissants et décisions précédentes | Aucun registre d'approbations ; dépense approuvée de période à `null` | Phase B indispensable avant activation du moteur |
| Respect de la deadline et pannes prévisibles | Deadlines synthétiques sans effet en inspection ; pas de worker Viseca | Non validé pour le challenge live |
| Interface séparée du traitement | Web/API/services/contrats séparés ; CLI partage le runtime | Bonne base architecturale |
| 20 M + 22 C + 8 G du document 10 | Spécifiés, pas implémentés | Travail futur, pas régression |

Références : [challenge.md:17](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/challenge.md:17>), [challenge.md:32](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/challenge.md:32>), [technical_details.md:245](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/technical_details.md:245>), [technical_details.md:306](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/technical_details.md:306>), [technical_details.md:405](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/technical_details.md:405>), [docs/04_PLAN_ACTION.md:3](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/docs/04_PLAN_ACTION.md:3>), [packages/local-runtime/src/services/run-service.ts:85](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/packages/local-runtime/src/services/run-service.ts:85>), [packages/local-runtime/src/services/run-service.ts:327](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/packages/local-runtime/src/services/run-service.ts:327>).

## 3. Anomalies confirmées du code actuel

Les constats A1–A5 sont de priorité **P2 dans le produit d'inspection actuel**. A1–A3 doivent être corrigés avant de transformer ces données en permissions exécutables ; A4 doit l'être avant d'utiliser le journal comme registre financier. Aucun de ces constats ne signifie qu'un paiement réel est actuellement autorisé.

### A1. Des exigences explicites disparaissent du décodage accepté

**Preuve réelle :** le résultat enregistré `instruction-variables-v6` de `SCEN0000` ne conserve que la devise, le plafond de 20 CHF, la quantité 1 et `ask`. Les exigences « ordinary grocery item » et « shop I use regularly » ne figurent dans aucune variable ni dans `unmapped_requirements`, qui vaut `[]`. Le résultat passe encore `validateInstructionFields`.

Le validateur contrôle les types, l'inventaire des champs et l'existence littérale des citations. Il ne vérifie pas que chaque exigence a été conservée. L'écran peut donc annoncer zéro exigence sans correspondance alors que certaines ont disparu. Le schéma d'un événement d'achat ne constitue pas à lui seul un schéma suffisant des intentions du client.

**Impact :** une future compilation naïve pourrait autoriser un produit non alimentaire ou ignorer l'exigence de marchand habituel. Aujourd'hui, le résultat reste une proposition à relire et ne déclenche aucune décision.

**Correction attendue :** conserver un inventaire des exigences indépendant des champs de transaction, avec source, statut et correspondance ; vérifier leur couverture avant activation. Ajouter une recette sémantique sur les cinq instructions et des reformulations. Ces tests doivent contrôler les exigences, sans coder les décisions par ID de scénario.

Sources : [data/scenario_catalogue.csv:2](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/data/scenario_catalogue.csv:2>), [.local-state/instruction-decodings.json:2127](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/.local-state/instruction-decodings.json:2127>), [packages/local-runtime/src/ai/openai-instruction-decoder.ts:30](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/packages/local-runtime/src/ai/openai-instruction-decoder.ts:30>), [packages/local-runtime/src/ai/instruction-schema.ts:200](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/packages/local-runtime/src/ai/instruction-schema.ts:200>), [apps/local-web/web/app.ts:256](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/apps/local-web/web/app.ts:256>).

### A2. Un plafond en CHF devient à tort une obligation de payer en CHF

Les résultats v6 enregistrés de `SCEN0000` et `SCEN0002` contiennent `authorization.currency = "CHF"`, alors que le client exprime un plafond en CHF sans imposer la devise du paiement. Ces résultats passent la validation locale, malgré l'interdiction explicite dans le prompt.

**Impact :** un futur filtre pourrait refuser inutilement un achat en EUR qui respecte le plafond après conversion. C'est distinct du défaut visuel « CHF CHF », causé par la concaténation de `value` et `currency`. L'opérateur est bien un champ séparé dans le JSON : son regroupement dans la cellule d'affichage n'est pas une corruption de la structure.

**Correction attendue :** différencier plafond facturé en CHF et devise de transaction ; valider la pertinence de la métadonnée `currency` selon le champ ; adapter l'affichage. Prévoir aussi l'invalidation/versionnement des résultats erronés déjà persistés : `decode(..., retry=true)` réutilise un résultat `completed` pour la même clé.

Sources : [.local-state/instruction-decodings.json:1829](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/.local-state/instruction-decodings.json:1829>), [technical_details.md:94](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/technical_details.md:94>), [packages/local-runtime/src/ai/openai-instruction-decoder.ts:25](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/packages/local-runtime/src/ai/openai-instruction-decoder.ts:25>), [packages/local-runtime/src/services/instruction-decoding-service.ts:80](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/packages/local-runtime/src/services/instruction-decoding-service.ts:80>), [apps/local-web/web/app.ts:251](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/apps/local-web/web/app.ts:251>).

### A3. L'écran peut afficher une politique différente de celle du run

**Reproduction locale :** créer un mandat A à 20 CHF, puis un brouillon B à 10 CHF. Ouvrir la sélection avec seulement `?mandateId=A`. Le sélecteur frontend prend le dernier brouillon B pour le formulaire, mais le bouton de lancement utilise A. Résultat reproduit avec les services et les mêmes sélecteurs que le frontend : **plafond affiché 10 ; plafond du snapshot lancé 20**.

Autre manifestation : après un PATCH ajoutant une limite plus stricte au mandat, le formulaire continue d'afficher le brouillon immuable antérieur. Le panneau « Mandat actif » montre version, état et date, mais pas ses règles actuelles.

**Correction attendue :** résoudre le brouillon via `selectedMandate.draft_id`, afficher les permissions du mandat sélectionné et sa version, et distinguer explicitement cette vue du brouillon éditable. Tester lien direct, deux mandats et resserrement après confirmation.

Sources : [apps/local-web/web/app.ts:155](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/apps/local-web/web/app.ts:155>), [apps/local-web/web/app.ts:206](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/apps/local-web/web/app.ts:206>), [apps/local-web/web/app.ts:321](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/apps/local-web/web/app.ts:321>), [apps/local-web/web/app.ts:406](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/apps/local-web/web/app.ts:406>), [docs/03_ROUTES_ET_PARCOURS.md:15](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/docs/03_ROUTES_ET_PARCOURS.md:15>), [technical_details.md:368](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/technical_details.md:368>).

### A4. Une sauvegarde partiellement échouée peut doubler le journal

`RunService.next` ajoute l'événement à `events.jsonl`, ajoute la trace, puis sauvegarde le nouvel état. Ces écritures ne forment pas une transaction commune. Une erreur de sauvegarde laisse les ajouts dans les journaux alors que l'état mémoire conserve l'ancienne position.

**Reproduction avec panne injectée uniquement dans le stockage temporaire :** faire échouer `store.save` une fois après les ajouts, puis relancer `next`. Résultat : **1 achat dans le registre, 2 événements portant le même ID dans le journal, séquences de trace `[1, 2, 2]`**.

**Impact :** la trace et le registre se contredisent ; un consommateur du journal pourrait compter deux fois. La sérialisation des commandes et le remplacement atomique de `run.json` ne suffisent pas à rendre l'ensemble atomique.

**Correction attendue :** une source de vérité transactionnelle, ou un journal avec engagement et reprise idempotente permettant de reconstruire/réconcilier les autres fichiers. Tester les pannes entre chaque écriture et leur reprise, pas seulement les doubles clics réussis.

Sources : [packages/local-runtime/src/services/run-service.ts:270](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/packages/local-runtime/src/services/run-service.ts:270>), [packages/local-runtime/src/storage/run-file-store.ts:213](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/packages/local-runtime/src/storage/run-file-store.ts:213>), [docs/02_STRUCTURE_DONNEES.md:404](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/docs/02_STRUCTURE_DONNEES.md:404>).

### A5. Le rechargement accepte des événements incomplets

Le parseur du stockage ne revalide pas l'événement complet avec le schéma officiel. Il contrôle quelques champs et la présence des objets racines, puis convertit le résultat en `AuthorizationEvent`.

**Reproduction :** supprimer `event.authorization.items` dans une copie temporaire d'un run. Le runtime redémarre sans rejeter le fichier. L'ouverture de l'achat échoue ensuite avec `Cannot read properties of undefined (reading 'map')`.

**Correction attendue :** appliquer au rechargement le validateur canonique déjà utilisé à la construction, puis contrôler les invariants du registre et les liens avec la provenance. Retourner une erreur de stockage explicite avant de publier un état utilisable.

Sources : [packages/local-runtime/src/storage/run-file-store.ts:213](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/packages/local-runtime/src/storage/run-file-store.ts:213>), [packages/local-runtime/src/storage/run-file-store.ts:232](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/packages/local-runtime/src/storage/run-file-store.ts:232>), [packages/local-runtime/src/services/run-service.ts:208](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/packages/local-runtime/src/services/run-service.ts:208>).

### A6. La reprise frontend après réponse perdue reste incomplète

Constat statique, **non reproduit dans le navigateur** : `mutate` crée une nouvelle clé à chaque appel. Si le serveur a exécuté `/next` mais que sa réponse est perdue, un nouveau clic avant réconciliation peut avancer à l'achat suivant. Le polling à une seconde atténue ce cas, mais ne réutilise pas l'intention initiale. L'achat précédent reste enregistré ; le risque est de ne pas l'avoir présenté à l'utilisateur lors de cette reprise.

Correction : conserver clé et corps jusqu'à réception ou réconciliation de l'opération ; distinguer « réessayer » d'une nouvelle intention « achat suivant ». Sources : [apps/local-web/web/app.ts:576](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/apps/local-web/web/app.ts:576>), [apps/local-web/web/app.ts:617](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/apps/local-web/web/app.ts:617>), [apps/local-web/web/app.ts:667](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/apps/local-web/web/app.ts:667>), [docs/03_ROUTES_ET_PARCOURS.md:111](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/docs/03_ROUTES_ET_PARCOURS.md:111>).

## 4. Écarts à fermer pour satisfaire le challenge

### B1. Terminer le PLAN A ne termine pas la solution demandée

Le PLAN réduit reporte explicitement le moteur, les budgets, les décisions et le live. Ce choix est cohérent avec le code, mais il manque encore une phase de livraison du challenge : permissions exécutables revues, évaluation, registre des résultats, step-up humain, worker Viseca et recette de délais. Les trois démonstrations demandées dans [technical_details.md:405](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/technical_details.md:405>) ne sont pas réalisables aujourd'hui.

Le document 10 fournit une spécification substantielle pour la simulation. Il ne remplace pas la recette de connexion au simulateur fourni. Ajouter au plan une étape finale distincte, avec critères mesurables et responsables, évitera de confondre « 50 contrôles codés » avec « challenge validé ».

### B2. Le contrat du document 10 nécessite une frontière explicite avec Viseca

La spécification du prochain lot assume `scope="local_simulation"`. Ses états internes sont légitimes, mais ne sont pas les réponses de l'API officielle :

| Futur état / action locale | Exigence de raccordement |
| --- | --- |
| `deny` | Envoyer `decline` au protocole officiel ; conserver les codes de filtres séparément |
| Réponse humaine négative → `cancelled` | Utiliser `/resolve` avec `decision="decline"` ; ne pas assimiler ce refus à une fraude |
| `decision=null`, `technical_hold` | Définir une réponse autorisée avant `deadline_at` et conserver le blocage technique ; ne pas attendre indéfiniment |
| Modifier le mandat puis recalculer l'achat | Respecter le snapshot du run existant ; une nouvelle politique ne modifie pas rétroactivement ce snapshot |

Sources : [docs/10_SPECIFICATION_UNIFIEE_FILTRES_M_C_G.md:89](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/docs/10_SPECIFICATION_UNIFIEE_FILTRES_M_C_G.md:89>), [docs/10_SPECIFICATION_UNIFIEE_FILTRES_M_C_G.md:892](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/docs/10_SPECIFICATION_UNIFIEE_FILTRES_M_C_G.md:892>), [docs/10_SPECIFICATION_UNIFIEE_FILTRES_M_C_G.md:1044](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/docs/10_SPECIFICATION_UNIFIEE_FILTRES_M_C_G.md:1044>), [docs/10_SPECIFICATION_UNIFIEE_FILTRES_M_C_G.md:1048](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/docs/10_SPECIFICATION_UNIFIEE_FILTRES_M_C_G.md:1048>), [technical_details.md:306](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/technical_details.md:306>), [technical_details.md:350](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/technical_details.md:350>), [technical_details.md:380](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/technical_details.md:380>).

La politique `ask` seule retenue dans C25 suit les cinq instructions du pack et les dernières demandes de l'équipe. Ce n'est pas un bug à annuler. En revanche, l'interface actuelle accepte aussi `approve`/`decline` : la migration/reconfirmation prévue doit être réellement implémentée et visible, sans réinterprétation silencieuse d'un ancien mandat (`document 10:706`).

### B3. Budgets et achats liés doivent utiliser le registre réel des décisions

Le compteur `context.approved_spend_in_period_chf` vaut toujours `null`. C'est acceptable en inspection ; un évaluateur branché seul sur ces événements ne pourra pas appliquer le plafond glissant de S1. Il faudra compter les approbations finales, utiliser les timestamps simulés, traiter les résolutions tardives et éviter les doubles comptes.

L'ID d'un achat lié est correctement réécrit pour le run, mais son statut reste celui de la fixture. Ainsi AU0042 peut décrire AU0037 comme `declined` alors que son enregistrement local est encore `pending`. Ce fait source doit rester distinct du résultat observé par notre moteur ; le futur contrôle des doublons doit consulter le registre faisant autorité.

Sources : [packages/local-runtime/src/data/event-builder.ts:164](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/packages/local-runtime/src/data/event-builder.ts:164>), [packages/local-runtime/src/data/event-builder.ts:180](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/packages/local-runtime/src/data/event-builder.ts:180>), [tests/data.test.ts:187](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/tests/data.test.ts:187>), [tests/data.test.ts:202](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/tests/data.test.ts:202>), [data/data_dictionary.md:223](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/data/data_dictionary.md:223>), [technical_details.md:353](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/technical_details.md:353>).

### B4. La latence de préparation n'est pas la latence de décision

Le décodeur actuel prévoit 90 secondes, un effort de raisonnement `medium` et jusqu'à 16 000 tokens de sortie. L'autre tâche a mesuré environ 70 secondes sur les résultats enregistrés. Cette lenteur concerne la préparation du mandat, avant le run ; elle ne démontre donc pas à elle seule une violation actuelle de la deadline de huit secondes.

Elle interdit néanmoins de réutiliser ce parcours tel quel dans le chemin de décision. Séparer les budgets de temps, préparer les faits en amont lorsque possible et tester la réponse bornée en cas de panne. Un changement de modèle ne corrige pas automatiquement les omissions sémantiques d'A1/A2. Source : [packages/local-runtime/src/ai/openai-instruction-decoder.ts:55](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/packages/local-runtime/src/ai/openai-instruction-decoder.ts:55>).

## 5. Vérifications et limites

- `pnpm typecheck` : réussi, Node 24.15.0 et pnpm 11.19.0.
- `pnpm test` : **42 tests réussis dans 5 fichiers**. Ils valident le socle, pas les décisions métier encore absentes.
- Contrôles indépendants du pack : **18/18 empreintes**, 4 701 opérations historiques, 45 tentatives, 56 lignes panier ; aucune incohérence détectée de jointure, montant, conversion half-even, chronologie, remboursement ou compteur dérivé dans les vérifications effectuées.
- Parcours des 45 achats couvert par les tests existants ; aucun résultat de paiement inventé.
- Reproductions temporaires : mauvaise sélection de politique, double journal après échec d'écriture, événement invalide accepté au rechargement.
- Résultats IA existants analysés et repassés dans la validation locale ; aucun nouvel appel facturé.
- Pas de recette navigateur complète, pas de test live Viseca, pas de build de livraison dans cet audit. A6 reste un constat statique avec sa condition de déclenchement explicitée.

## 6. Ordre de correction proposé

1. Corriger la couverture des exigences, la confusion devise/plafond et le traitement des caches erronés ; raccorder chaque exigence aux futurs filtres.
2. Corriger la sélection et l'affichage des permissions du mandat ; vérifier le lien direct et le resserrement.
3. Fiabiliser la transaction registre/journal, le rechargement et la reprise des commandes.
4. Implémenter le document 10 avec des tests métier sur faits, ambiguïtés, retours, injections, budgets, doublons et réponses humaines ; conserver l'inspection explicitement séparée.
5. Ajouter puis exécuter la recette Viseca : connexion, événements sous enveloppe, IDs live, `204` de long-polling, décisions, résolution, snapshots, deadlines et résultats acceptés par la plateforme.

Ce rapport ne lance ni corrections ni nouveaux travaux dans les deux tâches existantes. Il fournit les écarts et les preuves pour coordonner leur suite sans modifier leur travail en cours.
