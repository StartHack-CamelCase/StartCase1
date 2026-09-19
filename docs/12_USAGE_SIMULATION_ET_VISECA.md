# Simulation M/C/G et Viseca

## Parcours local

Avec Node 24.15 et pnpm 11.19 :

```sh
pnpm typecheck
pnpm test
pnpm offline:validate-data
pnpm build
pnpm start:local
```

Ouvrir `http://127.0.0.1:3210`. Enregistrer un brouillon, **Confirmer pour inspection**, puis **Configurer la simulation M/C/G**. La confirmation d’inspection conserve un document ; elle ne permet aucune décision autonome. Préparer la configuration, relire chaque exigence et modifier les paramètres JSON avant confirmation. Les catégories, références d’articles, convention domestique, unités et seuils restent des choix explicites. `null` signifie absence de restriction ; une liste autorisée vide interdit tous ses éléments. Les règles natives inconnues bloquent la configuration.

**Commencer la simulation locale** émet les achats uniquement au clic. Chaque évaluation expose exactement 20 résultats Merchant, 22 Customer et 8 Protections, les preuves et l’historique. Les résultats locaux sont `approve`, `deny`, `step_up` ou une suspension technique. Un doute ne devient jamais un refus par accumulation. Un « oui » ne lève ni un refus certain ni un fait manquant.

La configuration peut être revue depuis un run : appliquer la nouvelle version au **run existant** préserve ses engagements. Un run distinct constitue une autre simulation. Le budget mesure les décisions du run, pas la consommation bancaire globale. L’historique synthétique est gelé ; aucune identité d’agent n’est inventée. Le canal humain local est une démonstration avec cookie serveur et CSRF, pas une authentification bancaire.

L’inspection initiale reste disponible via `pnpm offline:inspect --scenario SCEN0001` ou `pnpm offline:inspect-all`. Elle ne prend aucune décision.

## Stockage et reprise

- Inspection : `output/<run>/run.json` version 2 fait autorité pour événements, commandes et audit. Les JSONL sont reconstruits depuis ce snapshot. Le verrou SQLite d’écriture et la vérification de révision protègent les écritures concurrentes. Les formats historiques sont relus sans supprimer l’état.
- Simulation : `.local-state/simulations.sqlite`, transaction `BEGIN IMMEDIATE`, checksum, registre, réservations, réponses et audit enregistrés ensemble.
- Frontend : intention, corps et clé d’idempotence restent en `sessionStorage` tant qu’une réponse manque. **Réessayer cette opération** retrouve le résultat initial.
- Viseca : `.viseca/live-outbox.sqlite`, distinct de la simulation locale. Une réponse perdue conserve une réservation et exige une réconciliation. Les décisions proposées ne sont pas des dépenses acceptées.

Les erreurs de schéma, de provenance ou d’intégrité arrêtent le chargement ; aucune remise à zéro automatique. Utiliser une seule instance de l’application par dossier de politique/cache.

## IA facultative

GPT-5 nano intervient uniquement après une action explicite de préparation ou d’extraction. Responses, schéma JSON strict, `store:false`, aucun outil, aucun retry automatique ; jobs, cache et versions sont persistés. Les propositions obsolètes restent archivées. L’extraction ciblée d’offre est asynchrone, cite un texte et une ligne exacts, et n’entre pas automatiquement dans une décision. Aucun appel IA pendant une navigation ou la deadline Viseca.

## Worker Viseca

La recette hébergée n’a pas été exécutée : `LEASH_BASE_URL` et `TEAM_API_KEY` sont absents de l’environnement du projet. Aucun résultat de plateforme ni accord humain distant n’est revendiqué.

1. Configurer ces deux variables côté serveur ou dans `.env.local`, ignoré par Git.
2. Créer un mandat distant selon `technical_details.md`, afficher intégralement ses permissions au client et le confirmer seulement après son accord explicite. Le worker ne crée aucun consentement et ne réinitialise pas la session d’équipe.
3. Depuis la configuration locale confirmée, **Exporter la préparation Viseca**. Dans le fichier exporté, renseigner `live_mandate_id` avec l’ID réellement retourné par la plateforme. L’instruction, les règles natives et `ask` doivent correspondre exactement au snapshot distant. Une migration vers `ask` peut exiger un nouveau mandat et un nouveau run.
4. Préparer puis lancer :

```sh
pnpm live prepare
pnpm live create-run --config viseca-binding.json
```

`create-run` prépare le client, le bootstrap et le moteur avant de créer le run, puis suit immédiatement les demandes. Pour reprendre ou lire un run existant :

```sh
pnpm live follow --config viseca-binding.json --run-id LIVE_RUN_ID
pnpm live status --config viseca-binding.json --run-id LIVE_RUN_ID
```

Un fichier d’outbox appartient à un run et à un snapshot immuables ; pour un nouveau run, fournir un autre chemin `outbox` dans le fichier exporté. Les propositions n’utilisent ni les statuts source comme résultats, ni un appel GPT. Le worker utilise les IDs live, traite `204` comme une absence temporaire de demande et relit la deadline réelle. Il traduit `deny` en `decline` et une incertitude ou panne en `step_up` lorsqu’il reste du temps pour envoyer.

Après un `step_up` accepté, le terminal affiche l’achat et ses questions. Un opérateur humain utilise explicitement `approve ID` pour confirmer des signaux de risque, ou `decline ID`. Pour une preuve manquante :

```text
approve ID [{"question_id":"Q_…","value":"43","source_ref":"référence consultée","source_excerpt":"Selected size EU 43"}]
```

La preuve est revalidée par le moteur et ne peut remplacer une violation certaine. Ce terminal est un canal opérateur de démonstration, soumis aux accès OS ; il ne constitue pas une authentification bancaire du client. L’entrée doit être interactive : aucun « oui » automatique ni pipeline de résolutions. Seul `/resolve` est utilisé après `step_up`. Une soumission au résultat inconnu n’est pas renvoyée automatiquement. La réconciliation doit établir le résultat accepté avant de consommer ou libérer sa capacité.

Recette hébergée restante : achat ordinaire, intervention utile, approbation et rejet par un vrai humain, révocation observée, deadline, réponse perdue et modèle indisponible. La révocation d’un mandat déjà en file n’est affichée comme annulation distante que si la plateforme la confirme.

## Vérification navigateur reproductible

`scripts/browser-recovery.mts` démarre un serveur sur `127.0.0.1:3211` avec un état temporaire dont le chemin est affiché. Il coupe les réponses de la première commande d’inspection **après son écriture serveur**, y compris les reprises automatiques du navigateur. Recharger la page : le bouton reste **Réessayer cette opération**. Créer le fichier `allow-retry` dans ce seul répertoire temporaire, puis cliquer sur ce bouton. L’autorisation et le compteur doivent rester identiques. Le serveur de test ne charge aucune clé et n’appelle aucun modèle.
