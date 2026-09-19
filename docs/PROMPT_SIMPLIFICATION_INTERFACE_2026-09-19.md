# Prompt prêt à utiliser : simplifier l'interface Viseca

Tu interviens comme designer produit et développeur frontend sur ce dépôt. Transforme l'interface actuelle en une expérience calme, claire et simple pour une personne non technique.

L'utilisateur veut définir une demande, comprendre ses limites et intervenir seulement lorsque c'est utile. La majorité des vérifications et du traitement doit se dérouler côté serveur. L'interface doit montrer leur résultat et les actions nécessaires, sans exposer tout le fonctionnement interne.

## 1. Coexistence avec Claude : périmètre strict

Un autre Claude travaille en parallèle sur le système dans le même dossier. Lis l'état courant avant toute modification et préserve son travail, y compris les fichiers non suivis par Git.

Tu peux modifier uniquement :

- `apps/local-web/web/index.html`
- `apps/local-web/web/styles.css`
- `apps/local-web/web/app.ts`, pour la présentation et ses interactions
- De petits modules de présentation ou tests frontend nouveaux dans un dossier dédié, si nécessaires.

Ne modifie pas `apps/local-web/src/`, `packages/`, `data/`, les états locaux, `.env*`, les scripts, dépendances, lockfiles, configurations ou tests système. Préserve `apps/local-web/web/operation-state.ts`. Dans `app.ts`, conserve les garanties de `api`, `mutate`, `OperationJournal`, `selectPolicy` et de la sélection des versions.

Pas de reset/stash/clean, renommage global, formatage du dépôt ou modification des fichiers de Claude. N'arrête pas son serveur et ne lance pas un second écrivain sur son stockage. Le build actuel supprime `dist/` : pour vérifier l'UI en parallèle, utilise des sorties et un éventuel serveur isolés, sans modifier le build partagé. Si un fichier frontend change pendant ton intervention, relis-le et applique un patch localisé ; ne restaure pas ta copie ancienne par-dessus.

Lis l'audit `docs/UX_AUDIT_2026-09-19.md`, les sources frontend, puis les routes et types en lecture seule. Les capacités réellement branchées priment sur les fonctionnalités seulement décrites dans la documentation.

## 2. Direction produit

Le parcours doit répondre dans cet ordre :

1. Quelle est ma demande ?
2. Quelles limites ai-je définies ou confirmées ?
3. Où en est le traitement ?
4. Dois-je faire quelque chose ?

Conserve l'identité Viseca et une interface en français. Utilise une colonne principale, des titres courts, des phrases directes et une action principale par phase. Les actions de retour, modification ou arrêt restent secondaires et accessibles.

La simplification porte d'abord sur le contenu visible : élimine les répétitions, regroupe les informations et révèle les détails au clic. Conserve la traçabilité complète. Le premier écran ne doit pas être une grille de métriques ni une collection de panneaux techniques.

## 3. Parcours proposé, sur les routes existantes

### Accueil : choisir ou reprendre une demande

Conserve `/`. Présente les scénarios comme des exemples de demandes avec un titre lisible et une courte description fidèle aux données. Garde l'action de sélection évidente. Si une inspection est déjà en cours, « Reprendre » est prioritaire.

L'historique reste un accès secondaire compact. Les IDs scénario/carte/run, la provenance et les métadonnées ne sont pas le contenu principal. Préserve l'accès à tous les scénarios et aux archives.

### Préparation : relire ce qui compte

Conserve `/scenarios/:scenarioId`. Présente successivement la demande, son résumé et sa confirmation dans un même espace, avec une seule phase dominante.

- Affiche la demande une fois ; son texte intégral reste consultable. L'instruction source est immuable dans le contrat actuel : pas de faux champ de prompt libre sauvegardable.
- Affiche les limites existantes avec leur sens, unité et période exacts. Une valeur inconnue reste inconnue. Les contraintes ambiguës ou non représentées restent visibles quand elles empêchent de comprendre ce qui sera autorisé.
- Ne montre pas le tableau de tous les champs comme contenu principal. Conserve les sources et le tableau complet sous « Détails de l'analyse ».
- Préserve le déclenchement explicite du décodage et de sa relance. Une navigation, un rafraîchissement ou un enregistrement ne doit pas lancer de requête IA. Renomme éventuellement le bouton avec un intitulé compréhensible qui décrit exactement son effet.
- Distingue clairement « proposition à relire », « brouillon enregistré » et « limites confirmées ». Un décodage réussi ne transforme pas ses variables en règles ni en autorisations.
- Déplace JSON, notes techniques et provenance dans une section avancée. Des champs simples peuvent éditer une règle uniquement si la correspondance avec le contrat et sa validation est exacte. Sinon, conserve l'éditeur avancé et explique sobrement la limite ; n'invente aucun compilateur côté client.
- Ne remplace pas une politique manquante par des permissions implicites pour obtenir un parcours plus court. La confirmation doit porter sur les règles réellement enregistrées, avec les questions encore ouvertes.
- Préserve l'enregistrement, la confirmation explicite et le lancement comme intentions distinctes. Simplifie leur présentation progressive ; ne les enchaîne pas silencieusement. Toute modification après enregistrement doit être clairement distinguée de la version confirmée.

### Activité : état et interventions

Conserve `/runs/:runId`. Place en premier le titre de la demande, le statut réel et un résumé court. Une ligne « X achats parcourus sur Y » suffit pour l'inspection. N'affiche pas de KPI d'approbation vide ou de budget calculé par le navigateur.

- Réduis le snapshot du mandat à un résumé dépliable. Le snapshot du run et le mandat courant restent distinguables ; ne substitue pas la dernière version au snapshot historique.
- Chaque achat montre marchand, montant/devise, état et raison disponible. Le clic ouvre les informations utiles ; le panier complet, les descriptions sources et le diagnostic viennent ensuite.
- Affiche les montants d'origine et CHF lorsque fournis et pertinents ; ne recalcule pas les montants métier en frontend.
- Si le serveur expose réellement une demande de réponse humaine, mets-la en évidence avec la question précise, la raison, les informations nécessaires et les actions correspondant au contrat. Une confirmation du risque, un apport de preuve et une autorisation d'achat ne sont pas interchangeables.
- Si l'orchestration serveur est réellement disponible, le suivi normal se met à jour sans action achat par achat. Si seul le mode inspection existe encore, conserve « Afficher le premier achat / Achat suivant » dans une zone compacte « Contrôles de démonstration ». Elle doit rester facile à trouver lorsque le parcours attend ce clic.
- Aucun appel automatique répété à `/next`, worker, timer métier, calcul de filtre M/C/G ou décision dans le navigateur. Le polling lit uniquement l'état et s'arrête lorsque nécessaire.
- Garde les moyens existants d'annuler l'inspection ou de révoquer les permissions, en expliquant leur effet. N'invente pas une fonction pause si le serveur ne la propose pas.

## 4. États honnêtes et texte utile

Les états et actions doivent provenir des données serveur. Ne déduis jamais une attente humaine du seul compteur `pending` : en inspection, il inclut des achats non évalués.

| Situation attestée | Présentation attendue |
| --- | --- |
| Inspection prête, sans émission automatique | « Inspection prête » et contrôle manuel utile |
| Achat non évalué | « Non évalué » ; ne pas afficher « Approuver » |
| Annulation / interruption / échec | Libellé propre à l'état ; aucune couleur de succès générique |
| Inspection terminée | « Inspection terminée » ; cela n'annonce aucune approbation |
| Futur traitement automatique réellement actif | Statut de traitement serveur, sans pourcentage inventé |
| Future réponse humaine réellement requise | Question et actions spécifiques à cette demande |
| API indisponible / réponse incertaine | Message clair, état précédent conservé si disponible, reprise sûre |

Remplace le jargon visible : « run » par « inspection » ou « activité » selon le mode, « snapshot » par « limites utilisées pour cette inspection », « provenance » par « détails techniques ». Préserve les valeurs des contrats.

Affiche une mention de mode courte et exacte : « Inspection locale · aucun paiement exécuté » pour l'inspection, ou la mention de simulation exigée par le mode effectivement intégré. N'affiche pas « Protection active », « Tout est conforme » ou « Aucune action requise » si le système ne permet pas de le conclure.

En cas d'indisponibilité sur l'accueil, propose « Réessayer » sans bouton de retour pointant vers ce même écran. Les erreurs qui demandent une action restent consultables ; évite les notifications répétées à chaque polling et ne masque pas une erreur importante après quelques secondes seulement.

## 5. Détails avancés et règles visuelles

Les 50 contrôles Merchant/Customer/Protections prévus par la spécification doivent, lorsqu'ils seront disponibles, être consultables dans des groupes repliés. Affiche en priorité les raisons déterminantes et questions utiles. Les traces, modèles, tokens, locks, IDs et données JSON restent dans un diagnostic accessible.

Conserve les couleurs et composants existants quand ils fonctionnent. Réduis les bordures, badges, grands panneaux et avertissements répétés. Privilégie espaces réguliers et séparateurs légers. Utilise une typographie système lisible, un corps proche de 16 px, des boutons d'au moins 44 px et des animations discrètes uniquement utiles au retour d'action. Aucune nouvelle bibliothèque ou refonte de stack.

Sur mobile, conserve une navigation explicite et évite d'empiler métriques, diagnostics et liste complète avant le détail sélectionné. Aucune information nécessaire à une décision ne doit être cachée sous « Détails techniques ». Préserve clavier, focus visible, lien d'évitement, états de chargement et mouvement réduit. Les mises à jour ne doivent pas perdre le focus, la sélection ou les dépliables ouverts ; annonce sobrement les changements utiles aux lecteurs d'écran.

## 6. Contrats à préserver

- Routes `/`, `/scenarios/:scenarioId`, `/runs/:runId` et paramètres `draftId`, `mandateId`, `authorizationId`, y compris accès direct et historique navigateur.
- Endpoints, méthodes, corps stricts, types et validation serveur. Ne code pas contre les routes de simulation seulement proposées dans les documents.
- `Idempotency-Key` et corps original conservés pour une réponse incertaine ; distinction entre « réessayer cette opération » et une nouvelle intention.
- Versions/révisions attendues lorsque requises, sélection du mandat et de son brouillon, snapshot historique, échappement des données avant insertion HTML.
- Aucune activation implicite du mode évaluation, extension de permissions, suppression d'inconnues ou simulation de succès.

Si une capacité cible manque, réalise la simplification frontend compatible et note précisément le raccord serveur manquant. Ne prends pas en charge le chantier système de Claude.

## 7. Vérification et livraison

Vérifie le frontend sur un environnement isolé à 390 px et sur desktop, avec clavier. Parcours : accueil → scénario → brouillon → confirmation → inspection → détail → retour et rechargement. Vérifie aussi indisponibilité, état vide, traitement en cours, annulation, erreur et résultat incertain ; utilise des fixtures clairement identifiées si les états ne sont pas accessibles.

Contrôles de réussite :

1. Un utilisateur comprend demande, état et prochaine action sans ouvrir les diagnostics.
2. Aucun JSON, ID système, nom CSV ou tableau de filtres n'est imposé dans la vue principale.
3. Une seule action principale apparaît par phase ; les confirmations nécessaires restent explicites.
4. Les règles inconnues ou ambiguës ne deviennent pas des permissions et les achats non évalués ne deviennent pas des demandes d'approbation.
5. Consultation et rafraîchissement ne déclenchent aucune mutation ni appel IA.
6. Les liens directs restaurent la bonne sélection ; une réponse perdue ne crée pas une deuxième opération.
7. Le mode manuel reste utilisable tant que l'automatisation serveur manque.
8. Aucun fichier du périmètre système n'a été modifié par ton intervention.

Livre les changements frontend ciblés, une courte comparaison avant/après, les vérifications réellement réalisées et les raccords serveur encore nécessaires. Si le service est indisponible, distingue les vérifications statiques des parcours exécutés. N'annonce pas le fonctionnement d'une capacité uniquement dessinée ou testée avec une fixture.
