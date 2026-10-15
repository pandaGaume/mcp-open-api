# AGENT.md, mcp-open-api

Ce guide s'adresse à une IA chargée de modifier, intégrer ou déployer ce projet sans contexte préalable. Lire les sources citées avant de modifier leur contrat. Les commandes partent de la racine du dépôt, sauf indication contraire.

Les pratiques de diagnostic, de choix de topologie et de tests sont adaptées du `AGENTS.md` de `mcp-broker`. Pour le déploiement conteneur, le Dockerfile de référence est celui de `mcp-broker` : le slot open-api doit être livré avec le broker dans ce conteneur. Ce dépôt possède ses propres commandes et contraintes.

## 0. Règles de travail

- Ne jamais utiliser le caractère U+2014 dans les réponses, commentaires, documents ou commits.
- Examiner `git status` et préserver les modifications de l'utilisateur.
- Modifier les sources dans `src/` et `ui/`. `dist/` est généré et ignoré par Git.
- Vérifier les scripts de `package.json` et les workflows avant de proposer une commande.
- Respecter les signatures, l'autorisation du broker et les limites du moteur. Corriger la cause d'un refus au lieu de désactiver ces contrôles.
- Garder les secrets et les clés privées hors du dépôt, des images et des journaux. Le `.gitignore` actuel ne protège pas les fichiers `.env` ou `.pem`.
- Distinguer une procédure proposée, une commande exécutée et un résultat vérifié. Une compilation réussie ne prouve pas le déploiement.
- Le fichier demandé est `AGENT.md`. Certains agents chargent automatiquement `AGENTS.md` : vérifier les conventions de l'outil avant de supposer que ce guide sera lu.

## 1. Ce que fait le projet

`@cyanmycelium/mcp-open-api` transforme une spécification OpenAPI et un binding en manifest canonique. Un opérateur examine les outils et approuve le manifest en le signant avec une clé Ed25519. Un host interprète ce manifest et publie un slot MCP auprès d'un broker.

```text
OpenAPI + binding -> compilation -> manifest -> approbation et signature
                                                     |
                                                     v
client MCP -> broker -> host mcp-open-api -> API REST
```

La page de conception est statique : elle importe une spécification, permet de choisir et configurer les opérations, effectue une simulation, puis exporte le manifest et sa signature. L'import par URL fait des requêtes depuis le navigateur et dépend du CORS de la source. La simulation ne prouve pas qu'un appel réel fonctionne.

Le host vérifie les manifests, résout les secrets depuis son environnement et exécute les appels avec l'autorisation, les contraintes et l'audit du broker. Il peut fonctionner comme processus Node distinct ou être intégré au processus du broker via la bibliothèque. Le broker ne lit pas lui-même les manifests.

Un host peut publier plusieurs manifests, avec un slot par manifest. Lorsque des API exigent une isolation de leurs secrets par processus, utiliser des hosts distincts ; le déploiement conteneur attendu ici les livre avec le broker.

## 2. Choisir le cas d'usage

| Besoin | Action |
| --- | --- |
| Modifier la page ou essayer la conception | Compiler, puis lancer `npm run demo:designer` |
| Concevoir sans interface | Utiliser la CLI `compile`, puis faire approuver et signer le manifest |
| Exécuter des manifests avec un broker existant | Utiliser `node dist/bin.js serve --config <fichier>` |
| Intégrer dans une application Node | Vérifier la signature, puis utiliser les exports de la bibliothèque |
| Exécuter dans le processus du broker | Configurer `@cyanmycelium/mcp-open-api/plugin` dans `plugins[]` ; utiliser `serveManifest` pour une intégration manuelle |
| Publier la page | Utiliser le workflow GitHub Pages, artefact `dist/ui/` |
| Déployer en conteneur | Utiliser le Dockerfile de mcp-broker et livrer le slot open-api avec le broker, voir section 7 |
| Publier une version npm | Utiliser le workflow de release déclenché par un tag `v*` |

## 3. Où intervenir

| Chemin | Responsabilité |
| --- | --- |
| `src/binding/`, `schemas/binding-1.schema.json` | Format et validation du binding |
| `src/compiler/` | Lecture OpenAPI, diagnostics, compilation, JSON canonique |
| `src/designer/` | Session de conception et import de spécifications |
| `ui/` | HTML, CSS et JavaScript de la page |
| `src/manifest/` | Contrat du manifest |
| `src/runtime/` | Validation, requêtes HTTP, autorisation, projections et transports |
| `src/host/` | Configuration, signatures et cycle de vie des slots |
| `src/cli.ts`, `src/bin.ts` | CLI et démarrage du processus |
| `tests/`, `scripts/serve-check.mjs` | Tests unitaires, intégrations et preuve du binaire compilé |
| `docs/binding.md`, `docs/compiler.md` | Conception et contrats détaillés |
| `tsup.config.ts` | Bundles Node et navigateur, copie de `ui/` dans `dist/ui/` |

Certaines sections des documents décrivent des évolutions prévues. Confirmer les fonctionnalités dans le code et les tests. Overlay, Arazzo, ressources MCP, lecture des secrets depuis mcp-vault et essais réels depuis la page ne sont pas actuellement des fonctionnalités livrées.

## 4. Développement local

Utiliser Node 22, comme la CI. Le minimum déclaré par le package est 20.11 pour le compilateur seul ; le host avec authentification provider demande Node 22 ou ultérieur.

```sh
npm ci
npm run build
npm run demo:designer
```

Ouvrir l'URL imprimée, par défaut `http://127.0.0.1:3790/`. La démonstration lance aussi une API de vannes fictive sur un port libre, et écrit une configuration de host et une paire de clés temporaires. Elle affiche leurs emplacements. Elle ne démarre pas le broker. Arrêter avec Ctrl+C.

Pour choisir le port de la page :

```sh
npm run demo:designer -- 3791
```

Il n'existe pas de script `npm run dev` ni de rechargement automatique configuré. Après modification, relancer la compilation et recharger la page ; redémarrer la démonstration si nécessaire. Les données et clés de démonstration sont temporaires et réservées au développement.

### Vérifier une modification

Reproduire le problème et choisir les tests qui couvrent le comportement modifié. Avant de déclarer une modification exécutable prête, suivre les contrôles de la CI :

```sh
npm run format
npm run build
npm run smoke
npm run typecheck
npm test
```

`smoke` charge les exports compilés avec Node puis démarre un vrai broker de test, signe un manifest et appelle un outil via le binaire. Vitest seul ne vérifie pas le chargement ESM réel ni l'exécution sans génération dynamique de code.

Pour les intégrations, reprendre `startTestBroker()` depuis `@cyanmycelium/mcp-broker/testing`, comme les tests existants. Il permet de tester de vrais échanges avec des identités et une politique sans serveur OAuth externe. Éviter de remplacer les contrôles d'autorisation par des mocks qui autorisent tout.

Une modification documentaire seule ne nécessite pas de relancer toute la suite. Vérifier ses commandes, ses liens et sa cohérence avec le code.

## 5. Compiler, approuver et servir une API

Après compilation du projet, utiliser le binaire local pour tester les changements présents dans ce checkout :

```sh
node dist/bin.js compile /data/vannes.binding.json --out /data/vannes.json
node dist/bin.js keygen --out /secure/operator
node dist/bin.js sign /data/vannes.json --key /secure/operator.pem
node dist/bin.js serve --config /data/mcp-open-api.json
```

Ces chemins sont des exemples à adapter. Créer les répertoires avant utilisation. Générer une clé uniquement lors de l'initialisation d'une identité de signature ; conserver la clé existante pour les publications suivantes. La signature représente une approbation opérateur : l'IA prépare le manifest pour revue et signe lorsque cette approbation est autorisée.

La spécification est lue depuis `spec.path`, relatif au binding, ou depuis `--spec <fichier>`. La CLI attend une spécification locale. Le compilateur travaille sur des octets et ne récupère pas lui-même les URL.

Configuration de host illustrative :

```json
{
    "broker": {
        "url": "ws://127.0.0.1:3000/providers",
        "secretEnv": "MCP_OPEN_API_SECRET",
        "aggregate": false
    },
    "manifests": ["manifests/vannes.json"],
    "trustedKeys": ["keys/operator.pub.pem"],
    "allowedTargets": ["https://ot-gw.local"],
    "secrets": {
        "otGateway": { "env": "OT_GATEWAY_TOKEN" }
    }
}
```

- Adapter l'origine à la cible réelle du manifest et les références de secrets à son `target.auth`.
- Résoudre `manifests` et `trustedKeys` relativement au fichier de configuration.
- Fournir `vannes.json.sig` à côté de `vannes.json`. Une modification du contenu signé impose une nouvelle approbation et signature ; un simple reformatage conserve la signature canonique.
- Pour charger un dossier, y placer uniquement les manifests : le host examine ses fichiers `*.json`, sans parcours récursif.
- Injecter les variables nommées par `secretEnv` et `secrets`. Le host ne charge pas automatiquement un fichier `.env`.
- Laisser `allowUnsigned` désactivé en production. Cette option est réservée au développement.
- Garder la génération dynamique de code désactivée au runtime. La CLI `serve` se relance avec `--disallow-code-generation-from-strings` ; ne pas utiliser `MCP_OPEN_API_ALLOW_CODE_GENERATION=1` pour masquer une régression.
- Après mise à jour des fichiers, redémarrer le host : aucun rechargement automatique n'est implémenté.

Pour intégrer la bibliothèque, consulter le README, `verifyManifest`, `serveManifestOver`, `serveManifest` et `buildManifestDeclaration`. Vérifier la signature avant de servir un manifest via ces fonctions. Installer le peer runtime `@cyanmycelium/mcp-core` dans l'application consommatrice.

## 6. Appliquer les bonnes pratiques mcp-broker

Si un broker est accessible via MCP, commencer par `broker_diagnose({ slot })`. Consulter `broker_info`, `providers_list`, `provider_status({ name })` et `broker_guide({ topic: "deploy" })` ou `broker_guide({ topic: "troubleshooting" })`. Son guide reflète sa configuration effective et sa version.

Respecter les couples transport et URL :

| Usage | Transport | URL |
| --- | --- | --- |
| CLI `serve`, plusieurs slots | `MultiplexTransport` | `ws://<broker>:3000/providers` |
| Intégration dédiée à un slot | `DirectTransport` | `ws://<broker>:3000/provider/<slot>` |
| Client MCP | Streamable HTTP | `http://<broker>:3000/<slot>/mcp` |
| Intégration dans le broker | Loopback | Pas de socket |

`/providers/<slot>` n'est pas une URL provider valide. Utiliser `wss` et `https` lorsque la terminaison TLS le demande.

Le provider doit avoir sa propre identité dans le fichier de sécurité du broker, avec un secret, des `subjects` si nécessaires et des `allowedResources` couvrant ses déclarations. Déclarer un domaine décrit les capacités et les limites ; les rôles et affectations du broker accordent les droits aux clients. Une identité différente ne peut pas reprendre un domaine déjà possédé pendant la vie du broker.

Utiliser un broker 1.7.0 ou ultérieur pour les déclarations par slot et les limites par motifs, et 1.10.0 ou ultérieur pour le chargement via `plugins[]`. Les tests de développement utilisent la référence 1.10.0 ou ultérieure de `package.json`. Ne pas affaiblir les limites retournées par le broker. Conserver les références d'appelant, les résultats d'audit et le `traceparent` à travers le parcours d'exécution.

L'agrégation dans `_all` est explicite : configurer `broker.aggregate: true` si nécessaire et vérifier `tools/list` sur `_all`. Reprendre les noms d'outils retournés par le broker sans reconstruire leurs préfixes. Pour un pont stdio, suivre la configuration du broker avec `_all` et vérifier l'identité du client lorsque l'autorisation est activée. Les slots protégés restent soumis aux restrictions du broker.

Un socket ouvert ne prouve ni l'acceptation d'une déclaration ni la réussite d'un appel. Vérifier le slot, l'initialisation MCP, `tools/list` et un appel de lecture autorisé. Arrêter les hosts et fermer les sessions de test à la fin.

## 7. Déployer le slot avec le conteneur mcp-broker

Le Dockerfile de référence est `node/packages/broker/Dockerfile` dans le dépôt `mcp-broker`. Le déploiement attendu livre le broker et le slot open-api dans ce même conteneur. Toute évolution de l'image et de son démarrage doit s'intégrer à ce déploiement commun.

### Contrat de plugins générique

Le broker central reste indépendant des implémentations de slots. Ne pas ajouter mcp-open-api aux dépendances, dépendances optionnelles ou branches spécifiques du broker. Sa configuration générique `plugins[]` désigne des modules fournis par le déploiement.

Le chargeur est disponible dans mcp-broker à partir de la version 1.10.0. L'adaptateur est dans `src/plugin/index.ts`, exporté sous `@cyanmycelium/mcp-open-api/plugin`. Utiliser une version de mcp-open-api contenant cet export, ou son build local.

Le contrat API v1 comprend `apiVersion: 1` et `start(context, config)`, qui retourne un handle `stop()`. Le contexte expose `baseDir`, `registerSlot`, `onCleanup` et `log`. Les identités provider viennent du fichier de sécurité du broker ; la configuration choisit l'identité et l'agrégation, le plugin ne reçoit pas son secret provider. Le broker conserve les décisions d'autorisation et la protection des slots. Les plugins sont du code de confiance dans le même processus, sans isolation de leurs privilèges.

Le plugin open-api vérifie toutes les signatures et les doublons de slots avant de publier le lot. Il utilise un pool HTTP commun, les secrets référencés par variables d'environnement et l'intégration loopback. En cas d'échec ultérieur, il arrête les slots déjà démarrés. Le chargeur nettoie les ressources partielles et arrête les plugins dans l'ordre inverse avant le tunnel. Un plugin requis en échec fait échouer le démarrage ; un plugin explicitement optionnel produit un diagnostic. Une erreur de nettoyage reste fatale.

Suivre `docs/plugin.md` pour la configuration complète et les commandes de déploiement. La section `plugins[].config` reçoit `manifests`, `trustedKeys`, `allowedTargets` et `secrets`. Elle n'utilise pas `broker.url` : le plugin publie dans le processus existant. Les chemins des manifests et clés sont relatifs à la configuration du broker. Le plugin impose les signatures et n'accepte pas `allowUnsigned`.

Ne pas configurer `mcp-open-api serve` comme `stdioUpstreams` : cette commande parle au broker par WebSocket, pas sur stdin/stdout. Les manifests JSON de ce projet ne sont pas des bundles `.mcpb`. La CLI autonome reste utile en développement ou pour une isolation par processus.

### Préparer l'image commune

Le Dockerfile du broker utilise Node 22 et un build multiétape. Construire depuis son dossier `node/` avec `docker build -f packages/broker/Dockerfile -t broker-with-plugins .`. Le build utilise le lockfile du workspace et compile d'abord le codec provider, puis le broker.

La couche de plugins lit `node/packages/broker/plugins/package.json` et son lockfile, vides par défaut. Le déploiement y installe les versions choisies ou un tarball produit par `npm pack`, puis le Dockerfile exécute `npm ci --omit=dev` et copie cette composition dans `/opt/mcp-broker-plugins`. Ajouter un slot ne change pas le package du broker. Le chargeur ne télécharge rien au démarrage. `MCP_BROKER_PLUGINS_DIR` choisit le répertoire des packages installés, tandis que les modules locaux relatifs sont résolus depuis la configuration du broker.

Monter configuration et fichier de sécurité du broker, manifests avec leurs `.sig` et clés publiques en lecture seule. Injecter les secrets à l'exécution et garder les clés privées hors de l'image. Vérifier la présence du peer runtime mcp-core dans la composition du plugin. Exécuter avec l'utilisateur non privilégié de l'image et conserver les fichiers privés hors des montages publics.

### Réseau, page et vérification

Le broker fournit le port public, par défaut 3000, et écoute sur `0.0.0.0` dans le conteneur. Le plugin loopback n'ouvre aucun port supplémentaire. L'API REST doit être accessible depuis ce conteneur ; fixer cette URL avant compilation et signature, puis aligner `allowedTargets` sur son origine exacte.

Pour héberger aussi la page de conception, monter uniquement `dist/ui/` avec `www.mounts`, par exemple sous `/open-api/`. Ce montage statique ne démarre pas le slot. Les requêtes MCP depuis une page restent soumises à la configuration des origines autorisées du broker.

Après compilation des deux projets, `node scripts/plugin-check.mjs ../mcp-broker/node/packages/broker` vérifie le chargement depuis la configuration de la CLI, un appel direct, un appel agrégé, le secret API et un refus d'autorisation. `node scripts/plugin-check.mjs --docker <image>` effectue le même contrôle dans une image où le plugin est installé et vérifie aussi l'arrêt du plugin sur SIGTERM.

Conserver le contrôle TCP de santé du broker et vérifier chaque slot attendu via ses diagnostics, l'initialisation MCP et `tools/list`. Le port peut écouter pendant le démarrage des plugins et un plugin optionnel peut être absent alors que le broker reste actif. Les manifests nécessitent un redémarrage après modification, sans rechargement automatique.

## 8. Publier la page sur GitHub Pages

Le workflow `.github/workflows/pages.yml` compile le projet, prépare Pages et publie `dist/ui/`. Il se déclenche sur certains changements de `main` et manuellement via `workflow_dispatch`. Une modification documentaire seule ne déclenche pas ce workflow.

Prérequis du dépôt GitHub : **Settings > Pages > Build and deployment > Source > GitHub Actions**. Le workflow suppose Pages déjà activé. Si `actions/configure-pages@v5` renvoie `Get Pages site failed` et `Not Found`, vérifier ce réglage puis relancer tous les jobs. Ajouter `enablement` sans vérifier les permissions et le token ne suffit pas à garantir l'activation.

Conserver `contents: read` et `pages: read` pour la préparation, et `pages: write` et `id-token: write` pour le job de déploiement. Celui-ci dépend du build et utilise l'environnement `github-pages`.

Après un déploiement réussi, ouvrir `https://pandagaume.github.io/mcp-open-api/` et vérifier HTML, CSS, JavaScript et import d'une spécification. Garder les chemins d'assets compatibles avec le sous-chemin `/mcp-open-api/`. GitHub Pages héberge la page de conception ; l'exécution des manifests nécessite le host et le broker.

## 9. Publication npm

Le workflow `.github/workflows/release.yml` répond aux tags `v*`, exécute les contrôles, publie le package public avec provenance via OIDC puis crée une release GitHub. Le trusted publisher npm doit correspondre au dépôt et au workflow.

Lorsqu'une release est demandée, vérifier la version dans `package.json` et le lockfile, exécuter les contrôles, puis suivre la procédure de version et de tag autorisée. Pousser explicitement le tag prévu : ne pas supposer que `--follow-tags` publie un tag léger. Contrôler le résultat de la publication avant d'annoncer la version disponible.

## 10. Diagnostic par symptôme

| Symptôme | Vérification et action |
| --- | --- |
| La page locale ne démarre pas | Compiler, vérifier `dist/ui/designer-core.js`, puis vérifier le port de démonstration |
| L'import d'URL échoue dans la page | Examiner le réseau du navigateur et le CORS de la source ; essayer un fichier local de la spécification |
| Aucun manifest compilé | Lire tous les diagnostics, vérifier hash de spécification, opérations, schémas et arguments requis |
| Signature refusée | Vérifier le fichier `.sig`, le contenu signé et la clé publique de confiance ; faire approuver de nouveau tout changement de contenu |
| Variable de secret absente | Vérifier l'environnement réel du processus et les noms dans `secretEnv` et `secrets` sans afficher les valeurs |
| Cible refusée | Comparer l'origine exacte de `target.baseUrl` à `allowedTargets` |
| Slot absent ou initialisation bloquée | Appeler le diagnostic broker, vérifier le couple transport/URL et la connectivité |
| Déclaration refusée | Lire les raisons complètes ; vérifier identité provider, propriétaire du domaine, namespace et `allowedResources` |
| Slot accessible directement mais absent de `_all` | Vérifier `broker.aggregate` et la politique du broker |
| Appel refusé ou contraint | Vérifier identité client, capacités, affectations et intersection des limites ; conserver les contrôles |
| Fonctionne en local mais pas en conteneur | Vérifier DNS, URL utilisant `localhost`, réseau, droits sur montages, peer runtime et variables injectées |
| Host actif mais certains outils manquent | Lire les lignes `refused`, comparer les manifests attendus aux slots réellement servis |
| GitHub Pages renvoie 404 | Vérifier Source GitHub Actions, workflow, artefact `dist/ui/`, puis résultat du job de déploiement |

Terminer toute intervention avec les fichiers modifiés, la validation effectuée et les limites restantes. Indiquer explicitement si le déploiement réel ou un appel de bout en bout n'a pas été vérifié.
