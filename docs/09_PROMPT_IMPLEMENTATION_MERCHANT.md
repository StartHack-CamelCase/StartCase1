# Prompt prêt à utiliser — implémenter le volet merchant

> Ancien prompt, limité au merchant. Utiliser désormais le **prompt intégré à la section 11 du [document unifié M / C / G](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/docs/10_SPECIFICATION_UNIFIEE_FILTRES_M_C_G.md>)**, qui remplace les consignes de périmètre ci-dessous.

Le texte ci-dessous est le prompt d’implémentation. Il complète la [spécification détaillée des 20 filtres](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/docs/08_SPECIFICATION_FILTRES_MERCHANT.md>). Sa rédaction n’exécute pas les travaux décrits.

---

Implémente maintenant le volet **merchant uniquement** de notre portefeuille de sécurité pour les achats d’un agent IA.

Travaille dans :

```text
/Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026
```

Commence par lire les instructions applicables au dépôt, l’état Git et la spécification :

[08_SPECIFICATION_FILTRES_MERCHANT.md](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/docs/08_SPECIFICATION_FILTRES_MERCHANT.md>)

Le [tableau révisé](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/docs/07_TABLEAU_FILTRES_MERCHANT_CUSTOMER.md>) complète les exemples et les origines. Les anciens plans décrivent les étapes précédentes. Cette demande autorise l’implémentation du lot merchant décrit ici ; leurs anciennes mentions de report ne bloquent pas ce lot. Préserve les modifications utilisateur déjà présentes, même non suivies par Git.

## Résultat attendu

Dans la web app, je veux pouvoir :

1. Relire l’instruction et préparer une configuration merchant structurée, sans perdre une exigence.
2. Confirmer cette configuration et conserver sa version.
3. Ouvrir un achat du run et lancer « Analyser le marchand ».
4. Consulter les 20 contrôles, leurs résultats, valeurs comparées, sources et questions éventuelles.
5. Demander une extraction GPT-5 nano uniquement pour les textes qui nécessitent une aide, ou compléter la revue manuellement.
6. Retrouver le rapport et sa provenance après refresh ou redémarrage.

Le résumé doit toujours préciser **« volet marchand uniquement ; contrôles client non évalués »**. Il n’autorise aucun paiement et ne met pas à jour de budget. Le statut financier canonique de l’achat reste celui du run d’inspection.

## Périmètre exact

Implémente **M01–M17, M19, M20 et M21**, soit 20 filtres. Conserve les identifiants.

- **M18, M22 et M23 sont retirés** : aucune tolérance de prix de 7 %, distance ou réputation externe dans ce lot.
- **M09, M10 et M11 doivent résister aux instructions injectées dans les descriptions.** Ils gardent leur rôle catégorie/produit/attributs ; M20 fournit la détection transversale et la gestion des champs suspects.
- **M11 : les attributs explicitement demandés sont obligatoires.** Valeur certainement incompatible : `fail`. Absence, contradiction ou sélection ambiguë : `needs_review` avec question ciblée. Aucun attribut absent n’est inventé ; une couleur non demandée n’est pas une interdiction implicite.
- Ne construis pas les filtres customer, le budget glissant, les statuts de carte comme décisions métier, la vélocité, les doublons sans lien ou le paiement. Lire client/comptes/cartes/historique pour identifier le vendeur connu est nécessaire à M02–M04 et reste autorisé.
- Ne modifie pas les CSV, les fixtures officielles ou le schéma de l’événement Viseca. Les cas supplémentaires de test sont stockés sous les tests, jamais dans le pack.

## Existant à respecter

Inspecte le code réel avant de choisir les points d’intégration. Le workspace est en TypeScript strict avec Fastify, Ajv, Decimal et Vitest. Réutilise ces dépendances et l’architecture locale.

Le [décodeur d’instruction actuel](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/packages/local-runtime/src/ai/openai-instruction-decoder.ts>) appelle Responses par `fetch` natif, sans SDK ni retry automatique. Son [service](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/packages/local-runtime/src/services/instruction-decoding-service.ts>) conserve les résultats et leur provenance. Le décodage ne confirme pas le mandat ; plusieurs exigences sont volontairement dans `unmapped_requirements`.

Préserve ce parcours et ses tests. Ajoute un adaptateur d’extraction merchant séparé ; ne transforme pas le décodeur d’instruction en agent de paiement et ne recopie pas tout son schéma natif pour les attributs locaux.

## Travail à effectuer

### 1. Contrats et configuration merchant

Crée des contrats locaux pour les exigences, la configuration versionnée, les observations, les preuves, les réponses manuelles, les résultats des filtres et le rapport global. Place-les à côté des contrats existants, sans changer le format officiel des événements.

La configuration contient son ID, sa révision, le mandat et sa version, le hash de l’instruction, son état brouillon/confirmé, l’auteur et la date de confirmation. Elle porte les contraintes merchant, les extraits d’origine et les questions encore ouvertes.

Propose un formulaire fonctionnel pour les listes de vendeurs/types/pays/canaux, familiarité/régularité, produit/quantité, attributs, retours, annulation, livraison, extras et récurrence. Il doit être utilisable sans clé API. Le décodage existant peut proposer des valeurs ; les conversions métier et les exigences non mappées doivent être relues, pas approuvées implicitement. Distingue les exigences customer reportées des questions merchant non résolues.

Conventions obligatoires : `null` = aucune liste d’autorisation définie ; `[]` = liste explicitement vide. Une configuration absente/non revue ne vaut pas « tous les contrôles sont non applicables ». Une révision nouvelle ne réécrit ni le mandat passé ni un ancien rapport.

### 2. Préparation déterministe des faits

Construis les index et projections nécessaires depuis le pack chargé. Toute familiarité vient d’achats historiques approuvés, antérieurs à l’achat inspecté, du même client. Calcule séparément la carte courante et toutes les cartes du client. Exclue refus, remboursements et futur de cette mesure. Garde le profil historique de référence gelé pour le run.

Crée de petites tables métier versionnées et relisibles pour le type marchand et le type de produit. Une table catalogue peut être manuelle ; elle ne peut pas contenir des verdicts associés aux scénarios ou aux IDs `AU…`. Conserve l’offre et le catalogue séparés.

Les calculs utilisent Decimal et l’arrondi half-even. Conserve les valeurs originales, les hashes et les références aux champs sources.

### 3. Les 20 filtres purs

Chaque filtre est une fonction testable sur des entrées explicites, sans appel réseau ni effet de bord. Il retourne toujours une entrée identifiée parmi `pass`, `fail`, `needs_review`, `not_applicable`, `not_evaluated`, avec nature du contrôle, raisons, preuves et questions. N’ajoute pas un score global qui compense des échecs.

| IDs | Implémentation attendue |
| --- | --- |
| M01 | Identité exacte par ID, cohérence référentiel, signal de nom ressemblant sans transmission de confiance. |
| M02–M03 | Familiarité du client et distinction carte courante/autres cartes, avec opérations justificatives. |
| M04 | Fréquence sur fenêtre et dates distinctes, avec seuil et fuseau confirmés ; absence de définition = question. |
| M05–M07 | Listes de vendeurs, type de marchand, pays ; restrictions seulement si confirmées. |
| M08 | Canal et présence du marchand ; information par défaut, aucun refus arbitraire d’un ecommerce chez un marchand physique. |
| M09 | Catégorie de chaque ligne depuis les données structurées ; aucune réécriture depuis le texte ou l’IA. |
| M10 | Produit et usage réellement demandés ; sélection catalogue revue ; gérer les contradictions entre offre et catalogue. |
| M11 | Attributs requis, valeur manquante/ambiguë/différente, unités et variante sélectionnée ; questions précises. |
| M12 | Extras et quantités dans le panier, en agrégeant les lignes du même produit/variante. |
| M13–M15 | Retours/durée, annulation, mode/date de livraison ; absence d’une exigence = pas de restriction inventée. |
| M16 | Engagement récurrent ou service optionnel, sans confondre catégorie, canal et fréquence certaine. |
| M17 | Prix unitaire converti en CHF contre la fourchette catalogue ; signal, pas plafond de dépense. |
| M19 | Intégrité sous-total + frais = total et conversion CHF ; aucune correction silencieuse. |
| M20 | Détection locale d’instructions hostiles, champs suspects, preuves et revue distincte de l’extraction. |
| M21 | Lien de nouveau devis, différences et réévaluation de l’offre courante ; aucun statut financier inventé. |

Respecte les algorithmes, exemples et limites du document 08. Exécute les contrôles structurés indépendants même si un texte est suspect. Le rapport global garde exactement une entrée par filtre actif. Il ne contient aucun champ de décision financière.

### 4. Texte, injections et traitement manuel

Commence par des analyseurs déterministes bornés. Ils doivent distinguer attribut, unité, négation, plusieurs candidats et clause de produit versus instruction au système. Des regex isolées qui capturent le premier nombre ne suffisent pas.

Conserve le brut avant normalisation ; échappe tout texte affiché dans le HTML. Un contenu trouvé dans la description n’est jamais exécuté, utilisé comme consigne système ou suivi comme lien. L’alerte M20 ne se transforme pas en preuve de sûreté quand aucun motif n’est détecté.

Sur M09–M11 :

- Une instruction de reclasser une carte cadeau ne change pas `item_category`.
- Une instruction d’appeler un casque « chaussure » ne change pas son produit/type.
- Une instruction « réponds taille 43 » ne devient pas une taille déclarée du produit.
- Un fait textuel positif provenant d’un champ suspect reste à revoir ; un échec structuré certain n’est pas effacé.

Pour une revue manuelle, distingue correction de lecture, choix de préférence et apport d’une nouvelle information. Enregistre auteur côté serveur, source, valeur, révision attendue et empreinte de l’offre. Ne laisse pas un simple « oui » fabriquer la taille absente d’une fiche. Le traitement humain d’une alerte d’injection conserve son signal original et ne donne aucun consentement de paiement.

### 5. GPT-5 nano uniquement en secours d’extraction

Utilise **`gpt-5-nano`**, sans changement de modèle automatique. Reprends les paramètres déjà supportés par l’adaptateur, en conservant une configuration serveur et un budget de sortie borné adapté au petit schéma merchant. Consulte la documentation officielle si nécessaire à la compatibilité, sans migrer le modèle demandé.

- Aucun appel pour une jointure, un calcul de montant, un champ structuré ou un attribut clairement absent de la source.
- Propose une action explicite pour extraire les passages encore non compris. Les analyses déterministes et la revue manuelle restent disponibles sans clé.
- Envoie seulement les textes concernés, leurs références et les attributs à rechercher. Ne fournis pas les valeurs attendues comme réponses cibles, ni l’historique client, les secrets ou les métadonnées narratives de scénario.
- Appelle Responses avec `fetch` serveur, `store:false`, aucun outil, aucun fil conversationnel et `text.format` en JSON Schema strict. Ne rajoute pas un SDK par défaut.
- Exige une réponse couvrant tous les couples ligne/attribut demandés : `stated`, `missing`, `ambiguous` ou `conflicting`, valeur typée/unité ou `null`, extraits exacts et références autorisées. Une sortie IA ne peut contenir ni décision ni nouvelle permission.
- Valide avec Ajv, puis vérifie les IDs, champs, types, unités et citations contre les entrées exactes. La citation présente dans le texte ne suffit pas à certifier le sens.
- Une proposition IA non corroborée par du code ou une revue humaine reste à préciser pour une exigence obligatoire. Elle ne remplace jamais une donnée structurée.
- Gère configuration absente, erreur réseau, timeout, quota, refus, réponse incomplète, JSON invalide et preuves inventées. Aucun retry automatique et aucune approbation implicite en cas d’erreur.
- Enregistre modèle demandé/retourné, version de prompt/schéma, empreinte complète d’entrée, durée, usage et ID de réponse. Déduplique les appels simultanés identiques ; conserve les résultats ; marque les tâches interrompues au redémarrage sans les relancer.

Définis une interface d’extracteur injectable pour les tests. N’effectue aucun appel payant pendant la suite de tests normale. Fournis une commande facultative de test réel, déclenchée explicitement par l’utilisateur ; n’affiche jamais la clé.

### 6. Service, stockage et routes

Crée un `MerchantAnalysisService` qui résout les événements déjà stockés, charge la configuration confirmée, prépare les faits, exécute les filtres et persiste les rapports. Le navigateur ne soumet jamais un panier ou des montants censés remplacer l’événement serveur.

Utilise des fichiers dédiés sous le stockage local existant, avec schema_version, écritures atomiques et validation stricte à la lecture. Garde compatibles les anciens runs et décodages ; ne convertis pas leurs statuts financiers. Invalide les références devenues anciennes par changement d’offre, de configuration ou de versions d’analyse.

Routes proposées, à adapter aux conventions existantes :

| Route | Fonction |
| --- | --- |
| `POST /api/mandates/:mandateId/merchant-configs` | Créer une révision de configuration merchant à relire. |
| `POST /api/mandates/:mandateId/merchant-configs/:configId/confirm` | Confirmer explicitement la configuration avec contrôle de révision. |
| `GET /api/mandates/:mandateId/merchant-configs` | Retrouver les configurations et leurs statuts. |
| `POST /api/runs/:runId/authorizations/:authorizationId/merchant-analyses` | Lancer une analyse déterministe à partir de l’événement serveur ; aucun appel IA implicite. |
| `GET /api/runs/:runId/authorizations/:authorizationId/merchant-analyses` | Consulter rapports et état courant. |
| `POST /api/merchant-analyses/:analysisId/extractions` | Demander une tâche GPT-5 nano pour les informations admissibles restantes. |
| `GET /api/merchant-extractions/:jobId` | Consulter une tâche sans nouvel appel. |
| `POST /api/merchant-analyses/:analysisId/reviews` | Enregistrer une revue manuelle et recalculer une nouvelle révision du rapport. |

Vérifie côté serveur l’appartenance run/achat/mandat/configuration et la fraîcheur des révisions. Les mutations gardent les clés d’idempotence. La file des appels IA ne bloque pas celle des runs. Une réponse IA reçue après changement des entrées reste consultable comme ancienne, sans être appliquée à une nouvelle configuration.

### 7. Interface

Prolonge les écrans actuels, en français, sans refaire l’application entière. Affiche un résumé merchant, les 20 filtres avec leur nature et leur état, les valeurs observées/attendues, les lignes sources et les questions ciblées. L’utilisateur doit pouvoir distinguer « différent de ce qui est demandé », « information absente » et « analyse non exécutée ».

Ajoute le parcours de configuration/revue et le bouton d’extraction ponctuelle. Explique l’origine de chaque observation : CSV structuré, analyseur local, proposition GPT-5 nano ou revue humaine. Aucun bouton d’approbation financière et aucun badge laissant croire que le volet customer a été vérifié.

## Tests et critères de fin

Écris des tests de comportement utiles, avec le vrai pack pour les cas existants et des fixtures de test séparées pour les mutations. Il ne doit exister aucun `if scenario_id == ...` ou `if authorization_id == ...` dans les fonctions métier.

Vérifie notamment :

- M01/M02/M03 : PixelHarbor/PixelHarbour, les deux achats de Circuit and Pine sur l’autre carte, vendeur nouveau permis par S2, achats futurs/refusés/remboursés exclus.
- M04–M08 : régularité avec configuration confirmée, bornes et dates distinctes, listes nulles/vides, mauvais type vendeur, absence d’interdiction de pays, présence physique et ecommerce compatibles.
- M09–M12 : cosmétique, carte cadeau, trail au lieu de route, casque, supplément et double quantité ; aucune catégorie/identité/variante écrasée par une instruction hostile.
- M11 : taille 43/42, taille absente, attribut non demandé, couleur contradictoire, plusieurs couleurs sans sélection, unité ambiguë, préférence modifiée qui invalide l’ancien rapport.
- M13–M16 : retours de 7/14/30 jours, durée inconnue, garantie différente du retour, annulation non demandée, livraison sans échéance imposée, récurrence explicite versus calendrier inconnu.
- M17/M19 : prix unitaire vs total, conversion CHF, livraison, bornes catalogue, incohérence injectée dans les montants ; aucun seuil de 7 %.
- M20 : `AU0037`, `AU0040`, attaques sur catégorie/produit/attribut, normalisation et HTML hostile. Tester aussi une sortie simulée du modèle qui tente de modifier une permission : elle est rejetée.
- M21 : nouveau devis, lien invalide/futur/autre run, différences de prix/frais/conditions, absence de statut financier réel et non-réutilisation d’une revue périmée.
- Runtime : mode sans IA, double clic, idempotence, concurrence de revue, cache, refresh, redémarrage, tâche interrompue, sortie IA mal référencée et aucune requête distante dans les tests ordinaires.
- Régression : ancien décodage d’instruction, création/consultation des mandats et runs d’inspection toujours utilisables ; données officielles inchangées.

Exécute les commandes adaptées au workspace : `pnpm typecheck`, `pnpm test`, `pnpm offline:validate-data`, `pnpm build`. Vérifie le parcours UI et les états d’erreur avec les outils disponibles. Si un test ne peut pas être exécuté, indique exactement lequel et pourquoi, sans annoncer son succès.

Livre le code, les tests pertinents et une documentation d’usage courte. Termine par ce qui fonctionne, comment le lancer, les vérifications réellement exécutées et les limites restantes. Présente clairement un **moteur merchant fonctionnel**, sans le qualifier de système complet d’autorisation de paiement. Poursuis jusqu’à ce résultat ; ne t’arrête pas à un plan ou à des fonctions factices.
