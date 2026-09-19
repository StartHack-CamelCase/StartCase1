# Bilan de validation — 19 septembre 2026

## A — Socle

- A1 : inventaire indépendant des intentions avec extraits conservés ; cinq instructions et reformulations testées. La configuration du moteur exige la revue explicite des exigences.
- A2 : plafond CHF distinct d’une restriction de devise ; achat EUR sous plafond CHF et restriction CHF explicite testés. Les anciennes propositions IA sont invalidées sans effacer leur trace. Affichage CHF dédoublonné.
- A3 : sélection par `mandate.draft_id`, affichage distinct du brouillon, du mandat et du snapshot du run ; tests de sélection et de version des permissions.
- A4 : snapshot d’inspection faisant autorité, reprise des écritures et réponses idempotentes. Pannes injectées après snapshot, événements et traces ; absence de double émission vérifiée après reprise.
- A5 : validation canonique complète et liens de provenance avant publication ; événement incomplet et stockage corrompu rejetés explicitement.
- A6 : réponse HTTP réellement coupée après exécution serveur dans un navigateur. Après rechargement puis retry, même autorisation et compteur inchangé à 1. Vérification réalisée dans un état temporaire séparé.

## B — Simulation locale

Les 50 contrôles actifs sont présents : 20 M, 22 C, 8 G. Les tests couvrent notamment refus certains, ambiguïtés, cinq signaux ne pouvant produire un refus, questions et preuves typées, choix de variante, montant et FX, fenêtres budgétaires affectées par une confirmation hors ordre, réservations distinctes, consentement unique, expiration, révocation et reprise durable.

Parcours navigateur vérifiés : configuration manuelle et confirmation, émission d’achat, step-up et confirmation de démonstration, conversion de réservation en engagement de 44,50 CHF, expiration, refus C09 pour 126 CHF au-dessus de 120 CHF, puis révocation conservant l’engagement déjà autorisé et bloquant l’achat suivant. Aucun paiement exécuté. Le canal humain local est simulé.

Commandes réussies sur le code livré :

- `pnpm typecheck`
- `pnpm test` : 18 fichiers, 168 tests
- `pnpm offline:validate-data` : 18 empreintes intactes, 5 scénarios, 45 événements canoniques
- `pnpm build`

Les tests ordinaires utilisent des fournisseurs simulés ; aucun appel IA payant n’a été effectué. Les données officielles et l’état utilisateur ont été préservés.

## C — Raccordement Viseca

Client, worker distinct, outbox SQLite et projection vers le même moteur livrés. Tests avec transport simulé : enveloppe, validation canonique, 204, IDs live, délais, snapshot immuable, réponse perdue, état inconnu, réconciliation, résolution humaine et budgets ne comptant que les approbations acceptées. L’export complet de configuration a été validé par le moteur live.

**Recette hébergée non exécutée** : `LEASH_BASE_URL` et `TEAM_API_KEY` ne sont pas configurés dans le processus ni dans `.env.local`. Aucun échange accepté par une plateforme distante ni aucune validation du challenge n’est revendiqué.

Restent à vérifier sur la plateforme configurée : achat ordinaire, intervention utile, approbation et rejet par un vrai humain, révocation observée, deadlines, réponses perdues et indisponibilité du modèle. Le [guide d’usage](12_USAGE_SIMULATION_ET_VISECA.md) décrit la préparation et le lancement. Aucune session d’équipe n’a été réinitialisée.
