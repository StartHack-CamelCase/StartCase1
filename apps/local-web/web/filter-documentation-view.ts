import { filterDocumentation, type FilterDocumentationEntry } from './filter-documentation-data.js';

type FilterGroup = FilterDocumentationEntry['group'];
type GroupSelection = FilterGroup | 'all';
const groups: Array<{ id: FilterGroup; title: string; label: string; description: string }> = [
  { id: 'merchant', title: 'Le vendeur et son offre', label: 'Vendeur & offre', description: 'Identité du marchand, contenu du panier, conditions de vente et montant annoncé.' },
  { id: 'customer', title: 'Vos permissions et votre contexte', label: 'Permissions client', description: 'Mandat, budgets, compte utilisé et situations qui nécessitent votre attention.' },
  { id: 'global', title: 'La sécurité de la décision', label: 'Sécurité', description: 'Validité des réponses, cohérence des données et enregistrement de la décision.' },
];
const esc = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr');

export function matchingFilters(query: string, group: GroupSelection = 'all'): FilterDocumentationEntry[] {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  return filterDocumentation.filter(entry => {
    if (group !== 'all' && entry.group !== group) return false;
    const text = normalize([entry.id, entry.title, entry.summary, entry.activation, ...entry.checks, ...entry.outcomes, entry.example, entry.limits ?? ''].join(' '));
    return terms.every(term => text.includes(term));
  });
}

function renderEntry(entry: FilterDocumentationEntry): string {
  const coverage = entry.status === 'unavailable' ? 'Non couvert' : entry.status === 'partial' ? 'Couverture partielle' : '';
  return `<details class="filter-doc-entry" id="${esc(entry.id)}">
    <summary><span class="filter-doc-code filter-doc-code--${entry.group}">${esc(entry.id)}</span><span class="filter-doc-entry__heading"><span class="filter-doc-entry__title">${esc(entry.title)}</span><span class="filter-doc-entry__summary">${esc(entry.summary)}</span>${coverage ? `<span class="filter-doc-coverage">${coverage}</span>` : ''}</span><span class="filter-doc-entry__toggle" aria-hidden="true"></span></summary>
    <div class="filter-doc-entry__body">
      <section><h4>Quand s’applique ce critère ?</h4><p>${esc(entry.activation)}</p></section>
      <section><h4>Ce qui est vérifié</h4><ul>${entry.checks.map(check => `<li>${esc(check)}</li>`).join('')}</ul></section>
      <section><h4>Effet sur la décision</h4><ul>${entry.outcomes.map(outcome => `<li>${esc(outcome)}</li>`).join('')}</ul></section>
      <aside class="filter-doc-example"><h4>Exemple concret</h4><p>${esc(entry.example)}</p></aside>
      ${entry.limits ? `<section class="filter-doc-limit"><h4>À savoir</h4><p>${esc(entry.limits)}</p></section>` : ''}
      <a class="filter-doc-permalink" href="#${esc(entry.id)}" aria-label="Lien direct vers ${esc(entry.id)} : ${esc(entry.title)}">Lien vers ce critère <span aria-hidden="true">↗</span></a>
    </div>
  </details>`;
}

export function renderFilterResults(entries: FilterDocumentationEntry[]): string {
  if (!entries.length) return '<div class="filter-doc-empty"><h3>Aucun critère trouvé</h3><p>Essayez un autre mot, comme « budget », « livraison » ou « M13 », ou choisissez une autre famille.</p><button type="button" class="button button--secondary" id="filter-doc-reset">Réinitialiser la recherche</button></div>';
  return groups.flatMap(group => {
    const members = entries.filter(entry => entry.group === group.id);
    return members.length ? [`<section class="filter-doc-group" aria-labelledby="filter-group-${group.id}"><header><h3 id="filter-group-${group.id}">${group.title}<span>${members.length}</span></h3><p>${group.description}</p></header>${members.map(renderEntry).join('')}</section>`] : [];
  }).join('');
}

export function renderFilterDocumentationPage(): string {
  return `<article class="filter-doc" lang="fr" aria-labelledby="filter-doc-title">
    <header class="filter-doc-hero"><p class="eyebrow">Documentation · Wallet control</p><h1 id="filter-doc-title">Comprendre chaque<br>critère de filtre.</h1><p>Avant chaque achat, votre agent vérifie l’offre, vos permissions et les conditions de sécurité. Retrouvez ici ce qui est contrôlé, pourquoi et ce qui peut déclencher une confirmation.</p><div class="filter-doc-meta"><span>${filterDocumentation.length} contrôles référencés</span><span>3 familles</span><span>Exemples en CHF</span></div></header>
    <div class="filter-doc-layout">
      <aside class="filter-doc-sidebar"><nav aria-label="Sommaire de la documentation"><p>Dans cette page</p><a href="#comprendre">Comment la décision est prise</a><a href="#criteres">Tous les critères <span>${filterDocumentation.length}</span></a><a href="#statuts">Lire les résultats</a><a href="#exemples">Un achat, plusieurs contrôles</a><a href="#habitudes">Les habitudes apprises</a></nav><div class="filter-doc-sidebar__note"><strong>Votre mandat reste la référence.</strong><p>Une habitude ou un vendeur connu ne peut pas annuler une limite explicite.</p></div><a class="filter-doc-back" href="/wallet/new">Définir mes permissions <span aria-hidden="true">↗</span></a></aside>
      <div class="filter-doc-main">
        <section class="filter-doc-section" id="comprendre" aria-labelledby="filter-doc-decision"><p class="eyebrow">Le principe</p><h2 id="filter-doc-decision">Chaque règle compte.</h2><p>Les critères applicables sont examinés ensemble. Un dépassement certain ne peut pas être compensé par plusieurs contrôles réussis.</p><ol class="filter-doc-decisions"><li><span class="filter-doc-decision-label filter-doc-decision-label--deny">Refuser</span><h3>Une règle est enfreinte</h3><p>Une violation certaine d’une permission bloque cette version de l’achat. Il faut corriger l’offre ou revoir le mandat.</p></li><li><span class="filter-doc-decision-label filter-doc-decision-label--review">Demander</span><h3>Un point reste à vérifier</h3><p>Une information manque ou un risque doit être confirmé. Les questions sur un même fait sont regroupées.</p></li><li><span class="filter-doc-decision-label filter-doc-decision-label--pass">Autoriser</span><h3>Tous les contrôles sont résolus</h3><p>L’achat peut être finalisé lorsque les règles sont respectées, les doutes levés et les vérifications requises terminées.</p></li></ol><p class="filter-doc-technical"><strong>Si une vérification technique requise est indisponible, l’achat reste suspendu.</strong> L’absence de résultat ne vaut jamais autorisation.</p></section>
        <section class="filter-doc-section filter-doc-catalog" id="criteres" aria-labelledby="filter-doc-catalog-title"><p class="eyebrow">Le guide des critères</p><h2 id="filter-doc-catalog-title">Du détail de l’offre à votre accord.</h2><p>Ouvrez une fiche pour consulter ses conditions, ses vérifications et un exemple. Certains critères ne s’activent que si vous les avez demandés.</p>
          <div class="filter-doc-search"><label for="filter-doc-query">Rechercher un critère</label><input id="filter-doc-query" type="search" placeholder="Budget, taille, livraison, M13…" aria-controls="filter-doc-results" autocomplete="off"><p>Recherche dans les codes, les descriptions et les exemples. Les accents sont facultatifs.</p></div>
          <div class="filter-doc-groups" role="group" aria-label="Famille de critères"><button type="button" data-filter-group="all" aria-pressed="true">Tous <span>${filterDocumentation.length}</span></button>${groups.map(group => `<button type="button" data-filter-group="${group.id}" aria-pressed="false">${group.label} <span>${filterDocumentation.filter(entry => entry.group === group.id).length}</span></button>`).join('')}</div>
          <div class="filter-doc-results-toolbar"><p id="filter-doc-count" role="status" aria-live="polite" aria-atomic="true">${filterDocumentation.length} critères affichés</p><div><button type="button" id="filter-doc-expand" aria-controls="filter-doc-results">Tout déplier</button><button type="button" id="filter-doc-collapse" aria-controls="filter-doc-results">Tout replier</button></div></div>
          <div id="filter-doc-results">${renderFilterResults(filterDocumentation)}</div>
        </section>
        <section class="filter-doc-section" id="statuts" aria-labelledby="filter-doc-status-title"><p class="eyebrow">Lire un contrôle</p><h2 id="filter-doc-status-title">Cinq résultats possibles.</h2><p>Le résultat décrit un critère. La décision finale tient compte de l’ensemble des critères applicables.</p><dl class="filter-doc-status-list"><div><dt>Conforme <code>pass</code></dt><dd>Le contrôle est satisfait. Cela ne suffit pas, à lui seul, à autoriser l’achat.</dd></div><div><dt>Échec <code>fail</code></dt><dd>Une contradiction a été détectée. Un motif de refus établi bloque l’achat.</dd></div><div><dt>À vérifier <code>needs_review</code></dt><dd>Une confirmation, une preuve ou une correction est nécessaire avant de poursuivre.</dd></div><div><dt>Non applicable <code>not_applicable</code></dt><dd>La condition n’est pas demandée, ou ce contrôle n’est pas pertinent dans ce contexte.</dd></div><div><dt>Non évalué <code>not_evaluated</code></dt><dd>Le contrôle n’a pas pu être effectué, ou attend une étape ultérieure. S’il est requis maintenant, la finalisation est suspendue.</dd></div></dl><p class="filter-doc-technical"><strong>La couverture est distincte du résultat.</strong> Une fiche « Couverture partielle » ou « Non couvert » précise les limites actuelles du contrôle.</p></section>
        <section class="filter-doc-section" id="exemples" aria-labelledby="filter-doc-examples-title"><p class="eyebrow">En pratique</p><h2 id="filter-doc-examples-title">Un achat, plusieurs contrôles.</h2><div class="filter-doc-worked-example"><blockquote>« Des chaussures de route en taille 43, au maximum 200 CHF, avec au moins 14 jours pour les retourner. »</blockquote><ol><li><strong>Le bon produit.</strong> Des chaussures de trail ne répondent pas à la demande de chaussures de route. <a href="#M10">Voir M10</a></li><li><strong>La bonne variante.</strong> Une taille 42 constitue un écart ; une taille absente doit être vérifiée. <a href="#M11">Voir M11</a></li><li><strong>Les bonnes conditions.</strong> Sept jours de retour ne suffisent pas. Une politique de retour absente doit être clarifiée. <a href="#M13">Voir M13</a></li><li><strong>Le montant total.</strong> Une offre à 195 CHF plus 10 CHF de livraison dépasse le plafond de 200 CHF. <a href="#M19">Voir M19</a> et <a href="#C09">C09</a></li></ol><p>Même si le vendeur est connu, un dépassement certain du plafond reste un motif de refus.</p></div><p><strong>Une confirmation ne remplace pas une preuve.</strong> Accepter un appareil inhabituel résout un signal de contexte. Confirmer « oui » ne transforme pas une taille 42 en taille 43.</p></section>
        <section class="filter-doc-section" id="habitudes" aria-labelledby="filter-doc-learning-title"><p class="eyebrow">Au fil des achats</p><h2 id="filter-doc-learning-title">Ce que vos habitudes peuvent changer.</h2><p>Lorsque l’apprentissage des habitudes confirmées est activé, vos confirmations sur des achats finalement approuvés peuvent réduire certaines demandes liées à l’appareil (<a href="#C15">C15</a>), aux horaires habituels (<a href="#C18">C18</a>) ou au pays du vendeur (<a href="#C19">C19</a>).</p><p>Un contexte doit satisfaire les seuils de répétition, de jours distincts et de récence avant d’être retenu. Les plafonds, les produits autorisés et les plages horaires explicitement fixées restent applicables.</p><p>Les scores de préférence affichés dans les profils décrivent vos réponses. Ils ne constituent pas une probabilité de fraude et ne remplacent pas les règles d’autorisation.</p><a class="filter-doc-back" href="/wallet/profiles">Consulter mes profils <span aria-hidden="true">↗</span></a></section>
        <footer class="filter-doc-footnote"><p>Ce guide décrit les contrôles de la simulation actuelle. Les modes Offline et Online utilisent les mêmes règles d’évaluation ; la source des achats et l’envoi des décisions diffèrent. Les exemples utilisent des données synthétiques, sans paiement réel.</p><a href="#filter-doc-title">Retour en haut ↑</a></footer>
      </div>
    </div>
  </article>`;
}

export function mountFilterDocumentationPage(host: HTMLElement): () => void {
  document.title = 'Critères de filtre · Documentation | Viseca';
  host.setAttribute('aria-live', 'off');
  host.innerHTML = renderFilterDocumentationPage();
  const events = new AbortController();
  const query = host.querySelector<HTMLInputElement>('#filter-doc-query')!;
  const results = host.querySelector<HTMLElement>('#filter-doc-results')!;
  const count = host.querySelector<HTMLElement>('#filter-doc-count')!;
  const buttons = host.querySelectorAll<HTMLButtonElement>('[data-filter-group]');
  const expand = host.querySelector<HTMLButtonElement>('#filter-doc-expand')!;
  const collapse = host.querySelector<HTMLButtonElement>('#filter-doc-collapse')!;
  let selected: GroupSelection = 'all';
  const render = () => {
    const entries = matchingFilters(query.value, selected);
    results.innerHTML = renderFilterResults(entries);
    count.textContent = `${entries.length} critère${entries.length === 1 ? '' : 's'} affiché${entries.length === 1 ? '' : 's'} sur ${filterDocumentation.length}`;
    buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset['filterGroup'] === selected)));
    expand.disabled = collapse.disabled = entries.length === 0;
  };
  query.addEventListener('input', render, { signal: events.signal });
  buttons.forEach(button => button.addEventListener('click', () => { selected = button.dataset['filterGroup'] as GroupSelection; render(); }, { signal: events.signal }));
  results.addEventListener('click', event => {
    if ((event.target as HTMLElement).closest('#filter-doc-reset')) { query.value = ''; selected = 'all'; render(); query.focus(); }
  }, { signal: events.signal });
  const setOpen = (open: boolean) => results.querySelectorAll<HTMLDetailsElement>('details').forEach(details => { details.open = open; });
  expand.addEventListener('click', () => setOpen(true), { signal: events.signal });
  collapse.addEventListener('click', () => setOpen(false), { signal: events.signal });
  const openLinkedFilter = () => {
    const id = location.hash.slice(1);
    if (!filterDocumentation.some(entry => entry.id === id)) return;
    if (!results.querySelector(`#${id}`)) { selected = 'all'; query.value = ''; render(); }
    const target = results.querySelector<HTMLDetailsElement>(`#${id}`)!;
    target.open = true;
    target.scrollIntoView({ block: 'start' });
    target.querySelector('summary')?.focus({ preventScroll: true });
  };
  window.addEventListener('hashchange', openLinkedFilter, { signal: events.signal });
  host.addEventListener('click', event => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]');
    if (link?.getAttribute('href') === location.hash) openLinkedFilter();
  }, { signal: events.signal });
  const frame = requestAnimationFrame(openLinkedFilter);
  return () => { events.abort(); cancelAnimationFrame(frame); };
}
