# Tableau des filtres — domaine marchand et domaine client

Ce document rassemble les pistes de la photo, les contrôles des deux dépôts et les propositions issues de l’analyse de nos données : **42 filtres ou signaux métier, puis 8 protections d’exécution**. Plusieurs détaillent un même filtre du [document de conception][analyse] ; ce ne sont pas 50 moteurs indépendants à développer.

**Objectif : décider si l’agent peut engager l’argent du client pour cet achat précis.** Une information rassurante ne compense pas une interdiction du mandat. Les décisions indiquées sont des propositions pour notre produit, pas un corrigé officiel des scénarios.

> Mise à jour M/C/G : M18/M22/M23 et C07/C17/C21/C23/C27 retirés. C08/C18/C19/C20/C22 déclenchent uniquement un doute. Les huit protections G sont confirmées. La référence complète, avec fonctionnement, messages, locks et prompt, est le [document unifié](</Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/docs/10_SPECIFICATION_UNIFIEE_FILTRES_M_C_G.md>).

## Comment lire les tableaux

| Repère | Signification |
| --- | --- |
| **Photo** | Idée lisible dans tes notes manuscrites, reformulée pour le projet. |
| **AC** | Mécanisme du repo `agentic-commerce`, adapté à notre contrat Viseca. |
| **MC** | Contrôle du repo `mandate-agent-control`, adapté à notre projet. |
| **Analyse** | Proposition ou adaptation formulée à partir de nos données et du besoin produit. |
| **Direct** | Les champs existent ; le calcul ou la règle restent à implémenter s’ils ne le sont pas déjà. |
| **Texte** | Une partie du contrôle exige d’extraire une information d’une description non fiable comme instruction. |
| **État local** | Le moteur doit conserver ses décisions, versions, réservations ou confirmations. |
| **Partiel / absent** | Le pack ne permet pas de conclure complètement ; la limite est indiquée dans la ligne. |

**La note est mon appréciation de l’intérêt pour notre prototype**, en tenant compte de la protection apportée, de l’exploitation de nos données et de la facilité à montrer un cas utile. Ce n’est ni une probabilité de fraude ni une mesure de précision : **9–10 = cœur du produit ; 7–8 = utile rapidement ; 4–6 = complément ; 1–3 = faible intérêt ou données insuffisantes aujourd’hui.** Une protection peu sollicitée par les 45 cas peut rester indispensable à un produit réel.

**Marchand** couvre le vendeur, son identité et ce qu’il propose : produits, prix, texte et conditions. **Client** couvre les permissions, l’argent, les cartes, les habitudes et la session. Certains contrôles croisent les deux domaines ; ils sont rangés selon leur question principale. Par exemple, « connais-je ce vendeur ? » reste côté marchand, même si sa réponse utilise l’historique du client.

`approve` signifie toujours « ce filtre est satisfait et les autres contrôles passent ». `step_up` signifie demander au client, sans dépenser. Une erreur technique ne devient pas une autorisation.

## Nos phrases de référence

Les phrases ci-dessous sont des **traductions françaises des instructions anglaises du pack**, pas de nouvelles permissions. Les tableaux les reprennent par extraits. Les exemples marqués **Extension** ajoutent une règle proposée qui n’existe pas dans ces phrases ; **Test à ajouter** désigne une situation absente des 45 tentatives.

| Référence | Instruction du projet |
| --- | --- |
| **S0 — Petit achat** | « Achète un article alimentaire ordinaire pour 20 CHF ou moins, dans un magasin que j’utilise régulièrement. Demande-moi en cas d’incertitude. » |
| **S1 — Courses** | « Commande nos courses du ménage en livraison. Chaque commande doit rester à 120 CHF maximum, livraison comprise, et le total sur n’importe quelle période de sept jours à 300 CHF maximum. Demande-moi en cas d’incertitude. » |
| **S2 — Chaussures** | « Remplace mes chaussures usées de course sur route, en taille 43. Achète uniquement chez un spécialiste du sport, avec un délai de retour d’au moins 14 jours, pour 200 CHF maximum. Demande-moi en cas d’incertitude. » |
| **S3 — Session** | « L’agent peut m’acheter des vêtements, jusqu’à 250 CHF par commande, dans des magasins que j’ai déjà utilisés. Mets en pause ce qui laisse penser que quelqu’un d’autre pilote la session. Demande-moi en cas d’incertitude. » |
| **S4 — Moniteur** | « Achète le moniteur 27 pouces que j’ai choisi, chez un vendeur où j’ai déjà acheté, pour 400 CHF ou moins. N’ajoute rien que je n’ai pas demandé. Demande-moi en cas d’incertitude. » |

Source : [instructions exactes des cinq scénarios][scenarios]. Les identifiants `AU…` ci-dessous renvoient aux [tentatives][attempts] et à leurs [lignes de panier][lines].

## 1. Domaine marchand — qui vend et quelle offre est présentée ?

| ID / filtre | Origine | Données et faisabilité | Exemple lié à nos phrases et au pack | Cas d’utilisation et réaction proposée | Intérêt /10 et pourquoi |
| --- | --- | --- | --- | --- | --- |
| **M01 — Identité exacte et nom ressemblant** | Photo + Analyse | **Direct** : `merchant_id`, `merchant_name`, historique. | S4 « chez un vendeur où j’ai déjà acheté » : `AU0039` vient de **PixelHarbour / ME0059**, différent de **PixelHarbor / ME0022**. | Identité non résolue ou nom ressemblant → doute ; aucune confiance héritée. | **10/10** — Cas concret du pack ; empêche une confusion que le nom seul laisserait passer. |
| **M02 — Vendeur déjà utilisé par le client** | Photo + MC adapté + Analyse | **Direct** : achats historiques `purchase/approved`, `customer_id`, `merchant_id`. | S3 « magasins que j’ai déjà utilisés » : `AU0028`, Cobalt Coatworks, n’a pas d’achat antérieur observé pour ce client. | Preuve antérieure → passe ; absence dans historique limité → doute. Refus seulement pour une règle historique bornée, confirmée et certainement non satisfaite. | **10/10** — Traduit directement deux mandats, avec des preuves compréhensibles. |
| **M03 — Vendeur connu sur une autre carte** | Analyse | **Direct** : jointure client → comptes → cartes → achats approuvés. | S4 : `AU0044`, **Circuit and Pine**, a **0 achat sur CA0039 mais 2 sur CA0038** du même client. | Conserver la preuve sur toutes les cartes du client ; ne pas dupliquer le doute M02. | **10/10** — Exploite une richesse propre à nos données et améliore la décision sans assouplir le mandat. |
| **M04 — Vendeur fréquent, régulier et récent** | Photo + Analyse | **Direct** : nombre d’achats, dates distinctes, dernière date, fenêtre choisie. | S0 « un magasin que j’utilise régulièrement » : Alpine Basket a 47 achats approuvés sur les cartes de `CU0001` sur tout l’historique. | Seuil non défini/couverture incomplète → doute ; seuil confirmé certainement non satisfait → refus. | **8/10** — Plus fidèle à la phrase « régulièrement » qu’un simple oui/non ; le seuil reste un choix produit. |
| **M05 — Liste de vendeurs autorisés ou interdits** | AC + MC | **Direct + permission à créer** : listes d’IDs dans la politique locale. | **Extension** de S4 : « Uniquement PixelHarbor ; jamais PixelHarbour. » | Liste confirmée et ID certainement exclu → refus ; configuration contradictoire → clarification. | **8/10** — Simple, robuste et facile à expliquer ; plus restrictif que les phrases actuelles. |
| **M06 — Type de marchand / spécialiste requis** | AC/MC pour les catégories + Analyse | **Direct** : `merchant_category`, `merchant_mcc`, mandat. | S2 « uniquement chez un spécialiste du sport » : `AU0022` propose les chaussures chez GreenLoop, catégorie `sustainable_goods`. | Type fiable hors taxonomie confirmée → refus ; classification incertaine → doute. | **9/10** — Un bon produit ne suffit pas si le client a aussi imposé le type de vendeur. |
| **M07 — Pays du vendeur permis par le mandat** | MC + Photo | **Direct + permission éventuelle** : `merchant_country`, pays autorisés. | **Extension** de S4 : « Achète uniquement chez un vendeur suisse. » `AU0038` est vendu par HarborByte aux États-Unis. | Pays explicitement exclu → refus ; pays inconnu → doute si restriction applicable. | **6/10** — Facile à construire, mais aucun des cinq mandats n’interdit les pays étrangers. |
| **M08 — Présence en ligne et canal réellement utilisé** | Photo + Analyse | **Direct**, valeur limitée : `availability`, `channel`. | S1 « en livraison » ; les **45 tentatives sont en ecommerce**, même chez des vendeurs ayant aussi un magasin. | Contexte informatif ; incohérence à clarifier, aucune interdiction déduite de la présence physique. | **5/10** — Utile pour ne pas mal interpréter le marchand, peu discriminant dans les scénarios actuels. |
| **M09 — Catégorie de chaque ligne du panier** | AC + MC adapté + Analyse | **Direct** : `items[].item_category`, mandat. | S1 « nos courses du ménage » : `AU0007` inclut un coffret cosmétique de 32 CHF chez un supermarché. S4 : `AU0043` contient une carte cadeau. | Catégorie hors besoin confirmé → refus ; classement non établi → doute. Une injection ne change pas la catégorie. | **10/10** — Détecte des écarts invisibles dans le seul libellé marchand. |
| **M10 — Produit exact et usage demandé** | Photo + AC adapté + Analyse | **Direct + texte** : `item_id`, nom, catégorie et description de l’offre. | S2 « chaussures de course sur route » : `AU0017` contient des chaussures de trail ; `AU0020`, un casque de vélo. | Substitution certaine → refus ; produit choisi ou correspondance incertaine → doute. | **10/10** — Protège l’intention du client au-delà du montant et de la catégorie. |
| **M11 — Taille et autres caractéristiques de l’offre** | Photo + AC adapté + Analyse | **Texte** : `item_details`; attributs structurés locaux à extraire. | S2 « en taille 43 » : `AU0013` contient « size 42 », malgré le même `item_id` que d’autres chaussures conformes. | Attribut demandé différent avec certitude → refus ; absent/ambigu/choix non résolu → doute. | **10/10** — Cas direct où l’identité catalogue ne suffit pas à contrôler la variante. |
| **M12 — Ajout non demandé et quantité du panier** | Photo + AC adapté + Analyse | **Direct + texte** : toutes les lignes, `quantity`, exigences confirmées. | S4 « n’ajoute rien que je n’ai pas demandé » : `AU0041` ajoute une protection de 79 CHF. S2 : `AU0018` ajoute un service tout en restant à 194 CHF. | Ajout/quantité certainement contraire à la demande → refus ; contenu de lot ambigu → doute. | **10/10** — Empêche que « budget respecté » soit confondu avec « achat autorisé ». |
| **M13 — Droit de retour et durée minimale** | Analyse | **Direct + texte** : `order_returnable` et nombre de jours dans `item_details`. | S2 « au moins 14 jours » : `AU0014` est une vente finale ; `AU0015` offre 7 jours ; `AU0016` ne précise pas les retours ; `AU0019` offre 14 jours. | Retour certainement impossible/trop court → refus ; fait absent ou réellement contradictoire → doute. | **10/10** — Traduit une condition essentielle que les données structurées seules couvrent partiellement. |
| **M14 — Possibilité d’annuler la commande** | Analyse | **Partiel** : `order_cancellable`, souvent non précisé dans nos tentatives. | **Extension** de S2 : « Commande uniquement si je peux encore annuler avant expédition. » | Annulation exigée certainement impossible → refus ; condition non vérifiable → doute ; non demandée → inapplicable. | **5/10** — Pertinent pour un portefeuille prudent, mais absent des exigences des cinq phrases. |
| **M15 — Livraison, date et frais convenus** | Photo pour le contexte de livraison + Analyse | **Direct / partiel** : `fulfillment_method`, `delivery_by`, `delivery_fee`. | S1 « en livraison » ; **Extension** : « livrées avant vendredi ». Une date absente ne prouve pas le respect de l’échéance. | Mode/date certainement incompatible avec la demande → refus ; échéance requise inconnue → doute. | **8/10** — Le mode de livraison existe déjà dans la demande ; les échéances apportent une extension utile. |
| **M16 — Abonnement ou engagement futur caché** | Photo + Analyse | **Direct + texte** : catégorie `subscriptions`/`membership`, termes de l’offre ; `recurring_capable` ne suffit pas. | S2 « remplace mes chaussures » : `AU0018` ajoute un service « billed monthly after the first year ». | Engagement certainement interdit → refus ; engagement ou consentement indéfini → doute. | **10/10** — Un faible montant initial peut engager le client durablement ; le cas existe dans le pack. |
| **M17 — Prix de l’article hors référence catalogue** | Photo + Analyse | **Direct** : `unit_price`, FX, `unit_price_min/typical/max_chf`. | S4 : `AU0037` propose le moniteur à 520 CHF, dans une fourchette catalogue allant jusqu’à 650 CHF, mais au-dessus du mandat de 400 CHF. | Prix hors référence → doute uniquement ; aucune limite de dépense déduite du catalogue. | **7/10** — Bon signal complémentaire ; le catalogue ne remplace ni le mandat ni un prix de marché actuel. |
| **M19 — Cohérence des lignes, du total et de la devise** | AC/MC pour les montants + Analyse | **Direct** : quantité × prix, sous-total, livraison, `billing_amount_chf`, `fx_rates`. | S1 « livraison comprise » : `AU0004` = 118 CHF d’articles + 8 CHF = 126 CHF. **Test à ajouter** : annoncer 118 CHF comme total. | Incohérence arithmétique certaine → refus de cette version ; taux/source/convention absent → doute ou suspension technique. | **10/10** — Tous les plafonds deviennent inutiles si le montant comparé est incorrect. |
| **M20 — Instructions injectées dans le texte marchand** | Photo + AC + MC + Analyse | **Texte + séparation des permissions** : `item_details`, origine du texte, mandat confirmé. | S4 « 400 CHF ou moins » : `AU0037` prétend autoriser 900 CHF ; `AU0040` demande d’ignorer les instructions et d’approuver immédiatement. | Consigne injectée → isoler et demander ; jamais refus automatique sur le seul signal. | **10/10** — Risque propre aux agents IA et cas démontrable ; le plafond doit tenir même si la détection échoue. |
| **M21 — Nouveau devis après un refus** | Analyse | **Direct + état local** : `related_authorization_id`, résultat effectif précédent, différences entre offres. | S4 : `AU0042` propose 350 CHF et référence `AU0037`, proposé à 520 CHF. | Nouvelle offre → réévaluation complète ; lien non résolu → doute, aucun refus hérité. | **9/10** — Autorise une correction légitime et évite un système qui reste bloqué après une erreur. |

**Distinction utile :** M06 décrit ce que le magasin vend habituellement ; M09 vérifie ce que contient réellement le panier. M07 applique une restriction géographique du mandat ; C19 compare le pays aux habitudes du client.

## 2. Domaine client — qui autorise, combien et dans quel contexte ?

| ID / filtre | Origine | Données et faisabilité | Exemple lié à nos phrases et au pack | Cas d’utilisation et réaction proposée | Intérêt /10 et pourquoi |
| --- | --- | --- | --- | --- | --- |
| **C01 — Carte et compte appartenant au bon client** | Analyse | **Direct** : client → compte → carte, autorité de fixture, identités du run et du mandat. | S4 est lié à `CU0019` et `CA0039`. **Test à ajouter** : présenter une carte appartenant à un autre client. | Propriétaire certainement différent → refus ; référentiel illisible → suspension technique. | **10/10** — Précondition fondamentale : une politique correcte appliquée à la mauvaise personne reste dangereuse. |
| **C02 — Mandat actif, valide et non révoqué** | MC + AC adapté + Analyse | **Direct + état local** : statut, version, validité de l’autorité ; durée du mandat si ajoutée. | « L’agent peut acheter… » ne doit plus s’appliquer après révocation. **Test à ajouter** : révoquer pendant un achat en attente. | Mandat certainement inactif → refus ; relecture au commit, version nouvelle → réévaluation. | **10/10** — Le client doit pouvoir reprendre immédiatement le contrôle des dépenses encore en attente. |
| **C03 — Mandat compris intégralement et confirmé** | Analyse | **État local** : instruction, exigences, provenance de l’interprétation, règles, version revue. | S2 contient produit, taille 43, spécialiste, retour ≥ 14 jours et plafond 200 CHF. Une compilation qui oublie les retours est incomplète. | Exigence oubliée/non revue → clarification ; panne de compilation → suspension technique. | **10/10** — Empêche une omission de l’IA de devenir une permission implicite. |
| **C04 — Statut du compte et cycle de vie de la carte** | Photo + Analyse | **Direct** : statut du compte, `card_status_at_attempt`, `expires_on`, dates de la carte. | Le référentiel contient `CA0009` bloquée et `CA0026` expirée. **Test à ajouter** pour une nouvelle tentative : les 45 actuelles ont une carte active. | Statut invalide au bon instant → refus ; provenance temporelle incertaine → doute. | **8/10** — Indispensable au produit, mais n’explique pas les différences entre les 45 cas actuels. |
| **C05 — Paiement en ligne permis sur la carte** | Photo + Analyse | **Direct** : `online_enabled` et `channel`. | S1 est un achat en ligne. **Test à ajouter** : la même commande avec `online_enabled=false` ; les 41 cartes du pack sont à `true`. | Ecommerce certainement désactivé → refus ; capacité inconnue → doute. | **7/10** — Contrôle peu coûteux et utile, mais aucun cas négatif actuel à démontrer. |
| **C06 — Paiement international permis sur la carte** | Photo + Analyse | **Direct / convention** : `international_enabled`, pays du marchand ; pays de référence à déclarer. | `CA0007` a l’international désactivé. **Test à ajouter** : achat étranger avec cette carte. `AU0038` utilise une carte permettant l’international. | International établi et désactivé → refus ; convention/pays inconnu nécessaire → doute. | **8/10** — Applique une capacité de carte réelle, tout en séparant pays, devise et habitudes. |
| **C08 — Usage prévu du compte et de la carte** | Analyse | **Direct + permission** : `account_purpose`, `card_purpose`, mandat confirmé. | `CU0018` sépare le personnel du compte `shared_household`. **Extension** de S1 : « Utilise uniquement le compte du ménage. » | Usage du compte/carte discordant → demander uniquement ; aucun refus produit par ce signal. | **8/10** — Exploite directement les comptes multiples et donne un contrôle concret au client. |
| **C09 — Plafond par commande, frais compris, en CHF** | Photo + AC + MC + Analyse | **Direct** : total CHF, mandat et `per_transaction_limit_chf` du compte. | S1 : `AU0004`, 126 CHF, dépasse 120. S3 : `AU0032`, **260 EUR = 247 CHF**, respecte le critère de montant à 250 CHF. | Total fiable supérieur au plafond applicable → refus ; montant ou règle ambiguë → doute. | **10/10** — Contrôle central, déterministe et immédiatement vérifiable par le client. |
| **C10 — Budget glissant sur sept jours / fractionnement** | AC/MC pour les budgets + Analyse | **État local** : décisions réellement approuvées, dates simulées, montants CHF, périmètre du mandat. | S1 « total sur sept jours ≤ 300 CHF » : après `AU0006`, le cumul illustratif atteint **299,50 CHF** ; `AU0008` ajouterait 65,50 CHF. | Dépenses finales + demande dépassant une fenêtre → refus ; réservation concurrente → doute C12. | **10/10** — Empêche de contourner le budget par des achats fractionnés ; excellent cas de démo. |
| **C11 — Budget quotidien et mensuel** | AC + MC + Analyse | **État local / partiel** : limites du mandat, `monthly_limit_chf`, opérations datées. | **Extension** de S1 : « Pas plus de 150 CHF par jour. » Le compte `AC0001` a aussi un plafond mensuel de 4 500 CHF. | Budget local confirmé dépassé → refus ; couverture exigée insuffisante → doute, pas de disponible inventé. | **7/10** — Bonne généralisation du budget ; la portée bancaire réelle est limitée par la couverture des données. |
| **C12 — Budget réservé pour les confirmations en attente** | Analyse | **État local à créer** : réservations, expiration, statut de l’autorisation, montant. | **Test à ajouter** autour de S1 : deux demandes de 80 CHF attendent confirmation alors qu’il reste 100 CHF. | Réserver si possible ; contention temporaire → attente/choix, jamais refus définitif pour une réservation seule. | **9/10** — Évite deux approbations individuellement valides qui dépassent ensemble le budget. |
| **C13 — Répétition d’un achat déjà approuvé ou en attente** | Analyse | **État local** : panier comparable, marchand, client, temps, statut du premier achat. | S4 : `AU0035` et `AU0036`, même moniteur à 289 CHF, espacés de **25 minutes**. | Achat similaire déjà approuvé/en attente → demander si un exemplaire supplémentaire est voulu. | **10/10** — Protège directement contre les boucles d’agent et les répétitions involontaires. |
| **C14 — Besoin ponctuel déjà couvert / quantité totale** | Analyse | **Partiel + état local à créer** : mission, quantité confirmée, achats autorisés sous ce besoin. | S4 « le moniteur » et S2 « remplace mes chaussures » suggèrent une mission ponctuelle. **Test à ajouter** : un deuxième moniteur le lendemain. | Quantité de mission certaine dépassée → refus ; quantité non définie ou seulement réservée → doute. | **9/10** — Étend la protection au-delà d’une courte fenêtre de doublon ; nécessite un contrat de mission explicite. |
| **C15 — Appareil nouveau pour la carte ou pour le client** | Photo pour les habitudes + Analyse | **Direct** : `customer_device_id`, achats antérieurs carte/client. | S3 « quelqu’un d’autre pilote la session » : `AU0026` utilise `DVC-4C0E9B`, absent de l’historique du client. | Appareil nouveau/manquant sous vigilance active → doute uniquement. | **9/10** — Signal de session concret et exploitable dans les données. |
| **C16 — Rafale et fréquence des tentatives** | Photo + AC + MC + Analyse | **Direct + état local** : `recent_attempt_count_10m`, timestamps. | S3 : `AU0030` arrive après **3 tentatives précédentes en dix minutes**. | Rafale au seuil confirmé → doute uniquement ; refus antérieurs inclus dans le compteur. | **9/10** — Détecte une session qui se dégrade avant que le budget soit nécessairement épuisé. |
| **C18 — Heure inhabituelle : doute uniquement** | AC + Analyse | **Direct + contexte** : timestamps, habitudes, fuseau explicite, éventuelle règle client. | S3 : plusieurs tentatives surviennent vers 02 h UTC. À l’inverse, la persona `CU0004` décrit des horaires hospitaliers tardifs. | Horaire à confirmer → doute uniquement, même pour une plage configurée. | **6/10** — Facile à calculer, mais risque de faux positifs si l’on ignore les habitudes et le fuseau. |
| **C19 — Pays inhabituel par rapport au client** | Photo + MC adapté + Analyse | **Direct** : pays des achats antérieurs, fréquence, `merchant_country`. | S3 : Milano Weave en Italie totalise **30 achats approuvés** pour le client ; `AU0025` n’est pas suspect du seul fait d’être italien. | Pays inhabituel → doute uniquement ; pays du vendeur ≠ localisation du client. | **7/10** — Aide autant à expliquer une anomalie qu’à éviter un mauvais blocage à l’étranger. |
| **C20 — Montant inhabituel pour ce type d’achat** | MC + Analyse | **Direct**, dépend du volume : montants historiques par client/carte et catégorie. | S4 autorise un moniteur jusqu’à 400 CHF ; sa comparaison avec une moyenne de petites courses serait trompeuse. | Montant inhabituel dans une cohorte pertinente → doute uniquement ; aucun plafond implicite. | **7/10** — Plus utile qu’un seuil universel « trois fois la moyenne », mais nécessite suffisamment de données comparables. |
| **C22 — Préférence personnelle : demander** | Analyse | **Texte + consentement** : `shopping_preferences`, style de budget, mandat. | La persona `CU0001` évite les bons cadeaux ; **Extension** : « N’achète jamais de carte cadeau avec cet agent. » | Écart à une préférence revue → doute uniquement ; la persona seule n’interdit rien. | **7/10** — Rend les permissions plus personnelles sans inventer un consentement. |
| **C24 — Seuil d’autonomie et confirmation systématique** | AC + MC | **Permission + état local** : seuil d’approbation autonome, option « toujours demander ». | **Extension** de S4 : « Jusqu’à 400 CHF, mais demande-moi au-dessus de 300 CHF » ; un achat à 350 CHF demande confirmation. | Seuil d’autonomie ou always_ask → confirmation ; le plafond absolu reste C09. | **8/10** — Rend le degré d’autonomie réglable et compréhensible ; la valeur du seuil n’existe pas encore dans nos phrases. |
| **C25 — Gestion explicite de l’incertitude** | AC + MC + Analyse | **Direct + état local** : `uncertainty_policy`, observations inconnues ou ambiguës. | Toutes les phrases : « Demande-moi en cas d’incertitude. » `AU0016` ne précise pas le retour. | Regrouper les incertitudes et leurs filtres sources ; ne pas confondre oui, preuve et nouvelle permission. | **10/10** — Respecte une demande commune aux cinq scénarios et empêche une approbation par défaut. |
| **C26 — Agent activé, suspendu ou identifié** | MC | **Absent / état local à créer** : registre d’agents authentifiés et statut. Le pack ne donne que `initiator_type`. | **Extension** de S3 : « J’ai suspendu mon agent d’achat. » | Non couvert/inapplicable dans la simulation ; statut suspendu vérifiable → refus dans une extension authentifiée. | **4/10** — Utile à terme, mais l’identité et le statut d’agent ne sont pas fournis par nos CSV. |

### Protections de l’autorisation du client — à distinguer des filtres métier

Ces protections appartiennent au **domaine client**, car elles garantissent que son consentement est respecté. Elles ne disent pas si le vendeur est fiable ou si le produit convient. Elles empêchent qu’une bonne décision soit contournée pendant son exécution.

| ID / protection | Origine | Données et faisabilité | Exemple lié à notre projet | Cas d’utilisation et réaction proposée | Intérêt /10 et pourquoi |
| --- | --- | --- | --- | --- | --- |
| **G01 — Idempotence de la même requête** | AC + socle existant | **État local** : ID d’achat, clé d’idempotence, empreinte de la requête, résultat. | Le réseau transmet deux fois `AU0035` dans le même run. | Même commande → même résultat ; clé/contenu contradictoires → conflit HTTP, pas refus d’achat. | **10/10** — Évite une double dépense causée par les retries ; il faut prolonger cette propriété jusqu’à la finalisation. |
| **G02 — Consentement lié au panier exact** | AC + Analyse | **État local** : empreinte marchand, articles, variantes, prix, frais, conditions, carte, mandat et version. | S4 : après confirmation du moniteur à 289 CHF, l’offre ajoute une protection ou change le prix. | Lier le consentement au panier et aux règles exacts ; changement → nouvelle évaluation. | **10/10** — Le client approuve ce qu’il a vu, pas tout ce que l’agent pourrait présenter ensuite. |
| **G03 — L’agent ne peut pas se faire passer pour le client** | AC + Analyse | **État local + contrôle d’accès** : canal humain distinct ; identité et origine de la réponse établies côté serveur. | S4 : le texte de `AU0040` affirme que le client est indisponible et demande l’approbation immédiate. | Seul le canal humain protégé répond ; appel interdit → rejet de commande. | **10/10** — Une confirmation demandée à l’agent lui-même n’apporte aucune séparation de pouvoir. |
| **G04 — Confirmation à usage unique et durée limitée** | AC + Analyse | **État local** : confirmation, expiration, consommation atomique, horloge réelle. | **Test à ajouter** : réutiliser le « oui » donné au premier moniteur pour en acheter un second. | Consentement unique et expirant ; expiration/rejeu → reprise ou conflit, pas faux refus métier. | **10/10** — Empêche de réutiliser un consentement légitime pour de nouvelles dépenses. |
| **G05 — États légaux et finalisation atomique** | AC + Analyse | **État local** : statut, révision, mandat courant, budget, file de commandes et persistance. | **Test à ajouter** : approbation humaine et révocation arrivent ensemble ; ou deux réponses contradictoires sont envoyées. | Relire et finaliser atomiquement décision, budget, réservation, consentement, lock et trace. | **10/10** — Empêche les courses de concurrence de contourner les filtres et le consentement. |
| **G06 — Erreur de règle ou d’analyse : aucune autorisation implicite** | AC + Analyse | **Direct + état local** : registre de champs valides, état de l’analyse, erreurs, couverture des exigences. | S2 : l’extracteur échoue sur les retours ; **Test à ajouter** : règle contenant un champ inconnu. | Doute → clarification ; panne → suspension ; jamais autorisation implicite. | **10/10** — Une faute de champ ou une panne d’IA ne doit pas supprimer une restriction. |
| **G07 — Trace des preuves et vérification du journal** | AC + MC + Analyse | **État local** : décision, valeurs comparées, sources, versions, confirmation ; hashes en extension. | S1 : « Refusé : 118 + 8 = 126 CHF, plafond 120 CHF. » | Journal de tous les résultats, causes, preuves et transitions, consultable depuis l’achat. | **9/10** — Essentiel à une démonstration crédible et au diagnostic ; le hash ne remplace pas le contenu des preuves. |
| **G08 — Priorité des règles dures sur tout score favorable** | AC/MC + Analyse | **Direct** : résultats des règles obligatoires et signaux séparés. | S3 : `AU0034` vaut 268 CHF, malgré le retour à l’appareil connu et un marchand habituel. | Violation certaine → refus ; doute → step-up ; aucune compensation ou addition de signaux en refus. | **10/10** — Préserve la signification des permissions quand plusieurs filtres sont combinés. |

## 3. Les filtres que je retiendrais pour la première démonstration

| Bloc à montrer | Filtres concernés | Phrase et scène de démonstration | Pourquoi commencer ici |
| --- | --- | --- | --- |
| **Le bon panier** | M09–M13, M16 | S2 : bonne taille, bon usage, retour suffisant ; service non demandé à `AU0018`. | Montre que notre portefeuille comprend les conditions d’achat au-delà du prix. |
| **Le bon budget** | M19, C09–C12 | S1 : livraison comprise et cumul de sept jours, avec `AU0004` et `AU0008`. | Preuve simple, chiffrée et immédiatement convaincante. |
| **Le bon vendeur** | M01–M04, M06 | S4 : PixelHarbour distinct de PixelHarbor ; Circuit and Pine connu sur une autre carte. | Exploite précisément la structure de nos données. |
| **La bonne session** | C15, C16 | S3 : appareil nouveau, rafale, puis retour à la normale. | Donne une raison claire de demander une confirmation sans tout bloquer. |
| **Une IA qui ne peut pas élargir ses permissions** | M20, C03, C25, G03, G06, G08 | S4 : la description de `AU0037` prétend relever le plafond à 900 CHF. | Le moteur doit rester sûr même si l’agent d’achat se laisse convaincre. |
| **Une seule dépense pour un consentement précis** | M21, C13, C14, G01–G05 | S4 : double proposition à 289 CHF, puis nouveau devis corrigé à 350 CHF. | Distingue retries, doublons, correction et consentement valide. |

Mon choix de priorité : **d’abord panier + budget + vendeur, puis session et confirmation complète**. Les protections d’identité, de mandat et d’exécution doivent accompagner ces blocs dès qu’ils peuvent produire une approbation. M18, M22 et M23 sont retirés du périmètre merchant actuel. C07/C17/C21/C23/C27 sont retirés ; les G sont confirmés.

## 4. Correspondance avec les 24 filtres du premier document

Cette table permet de vérifier que les propositions précédentes ont toutes été reprises. Les nouvelles lignes détaillent les notes de la photo, les options des repos et les extensions de produit.

| Ancien filtre | Lignes de ce tableau |
| --- | --- |
| F01 — Identité et autorité | C01, C02 |
| F02 — Compte, carte et capacités | C04–C06 |
| F03 — Montants et conversion | M19 |
| F04 — Couverture du mandat | C03, G06 |
| F05 — Plafond par achat | C09 |
| F06 — Budget glissant | C10–C12 |
| F07 — Catégories des articles | M09 |
| F08 — Produit et caractéristiques | M10, M11 |
| F09 — Retours | M13 |
| F10 — Extras et quantités | M12 |
| F11 — Type de vendeur | M06 |
| F12 — Anomalie de prix | M17 (M18 retiré) |
| F13 — Livraison | M15 |
| F14 — Engagement récurrent | M16 |
| F15 — Familiarité du vendeur | M02–M04 |
| F16 — Appareil | C15 |
| F17 — Vélocité | C16 |
| F18 — Pays et horaire | C18, C19 |
| F19 — Montant inhabituel | C20 |
| F20 — Usage du compte | C08 |
| F21 — Injection marchand | M20 |
| F22 — Ressemblance de vendeur | M01 |
| F23 — Répétition d’achat | C13, C14 |
| F24 — Nouveau devis | M21 |

## Sources et précautions d’interprétation

Le classement est une proposition d’implémentation ; il ne signifie pas que tous ces filtres sont déjà présents dans la web app. Il reprend les mécanismes utiles des repos, pas leurs seuils par défaut ni une garantie de sécurité en production. Les états « autorisé/refusé » historiques ne sont pas des labels de fraude.

Les mécanismes AC de recherche de catalogue, de gestion de stock et de paiement fournisseur ne sont pas ajoutés comme filtres Viseca : nous évaluons des tentatives déjà fournies, sans stock temps réel ni exécution de paiement dans le pack. Le contrôle AC « consultation libre / checkout contrôlé » inspire la séparation entre inspection et autorisation, plutôt qu’un nouveau filtre marchand.

| Source | Ce qu’elle justifie |
| --- | --- |
| Photo transmise dans la conversation | Prix et marge, fréquence, reconnaissance du marchand, description, distance, achat en ligne, international, abonnement et carte. |
| [Analyse détaillée du projet][analyse] | Jointures vérifiées, chiffres, 24 filtres initiaux et limites. |
| [Dictionnaire du pack][dictionary] | Chronologie, nulls, devises, fenêtres, statuts et distinction historique/runtime. |
| [Historique][history], [marchands][merchants], [cartes][cards], [comptes][accounts], [personas][customers] | Identités, capacités et contexte observé. |
| [Politique AC][ac-policy] | Budgets, catégories, vendeurs autorisés, horaires, vélocité et seuil d’autonomie. |
| [Sécurité du texte AC][ac-safety] | Provenance, séparation du texte et détection d’instructions hostiles. |
| [Approbations AC][ac-approvals], [empreinte du panier][ac-cart], [machine à états][ac-fsm], [idempotence][ac-idempotency], [audit][ac-audit] | Protections de l’exécution et du consentement. |
| [Politique MC][mc-policy], [facteurs de risque MC][mc-risk] | Restrictions, expiration, statut d’agent, approbation humaine et signaux comportementaux. |

[analyse]: </Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/docs/05_PROPOSITIONS_FILTRES_AGENTIC_COMMERCE.md>
[scenarios]: </Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/data/scenario_catalogue.csv>
[attempts]: </Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/data/purchase_attempts.csv>
[lines]: </Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/data/purchase_attempt_items.csv>
[dictionary]: </Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/data/data_dictionary.md>
[history]: </Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/data/authorization_history.csv>
[merchants]: </Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/data/merchants.csv>
[cards]: </Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/data/cards.csv>
[accounts]: </Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/data/accounts.csv>
[customers]: </Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/viseca-2026/data/customers.csv>
[ac-policy]: </Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/agentic-commerce-repos/agentic-commerce/policies/default.yaml>
[ac-safety]: </Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/agentic-commerce-repos/agentic-commerce/src/safety/boundary.ts>
[ac-approvals]: </Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/agentic-commerce-repos/agentic-commerce/src/approvals/service.ts>
[ac-cart]: </Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/agentic-commerce-repos/agentic-commerce/src/session/cartHash.ts>
[ac-fsm]: </Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/agentic-commerce-repos/agentic-commerce/src/session/fsm.ts>
[ac-idempotency]: </Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/agentic-commerce-repos/agentic-commerce/src/payments/idempotency.ts>
[ac-audit]: </Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/agentic-commerce-repos/agentic-commerce/src/audit/log.ts>
[mc-policy]: </Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/agentic-commerce-repos/mandate-agent-control/services/api/src/policy.ts>
[mc-risk]: </Users/hedifourati/Documents/Perso/hackathon/St Gall 18:09/agentic-commerce-repos/mandate-agent-control/services/api/src/risk.ts>
