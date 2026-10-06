# Le compilateur et l'exécution

Le compilateur transforme un binding et sa spec en **manifeste** : un plan d'exécution figé, que l'opérateur Tier 4 approuve et qu'un **hôte mcp-open-api** exécute comme un slot du broker. Ce document décrit la compilation, le format du manifeste, son exécution par l'hôte, et comment on certifie ce qui s'exécute.

Le manifeste est un format de mcp-open-api : le broker ne le connaît pas. Pour lui, un hôte est un provider comme un autre, qui publie des slots et déclare ses domaines.

Le format du binding est dans [binding.md](binding.md).

**État (2026-10-06).** Implémentés : le compilateur (`src/compiler/`, entrée `@cyanmycelium/mcp-open-api/compiler`), le moteur (`src/runtime/`), l'hôte et la signature des manifestes (`src/host/`, entrée `@cyanmycelium/mcp-open-api/host`), et la CLI (`mcp-open-api compile | keygen | sign | serve`). Le manifeste compilé depuis la spec OpenAPI de l'API de vannes de test, signé, est servi par un hôte derrière un vrai broker 1.7.0 et se comporte comme le manifeste écrit à la main (`tests/compiler.test.ts`, `tests/host.test.ts`, `scripts/serve-check.mjs`). Pas encore : l'Overlay, Arazzo, les ressources MCP, les secrets lus dans mcp-vault, la seconde sortie `.mcpb`.

Limites de la version 1 du compilateur, chacune signalée par un diagnostic, jamais ignorée en silence :

- mots-clés de validation que le moteur ne vérifie pas encore : `multipleOf`, `uniqueItems`, `minProperties`, `maxProperties`, `patternProperties`, `propertyNames`, `dependentRequired`, `if` / `then` / `else`, `not`, `prefixItems`, `contains`, `unevaluated*`. Les retirer élargirait le schéma : c'est une erreur (`schema.unsupported-keyword`) ;
- paramètres : styles par défaut seulement (`simple` pour le chemin et les en-têtes, `form` éclaté pour la query), pas d'objet en query, pas de paramètre décrit par `content`, pas de cookie obligatoire ;
- corps : JSON seulement ; une valeur imbriquée (`body.a.b`) ne peut être que fixée ;
- authentification : `bearer`, `basic`, `apiKey` en en-tête ou en query ; pas encore OAuth 2 ni OpenID Connect ;
- les mots-clés `format`, `xml`, `example`, `discriminator`, `readOnly`, `writeOnly` sont retirés : ce sont des annotations. Une propriété `readOnly` quitte le schéma d'entrée, une propriété `writeOnly` celui de sortie.

La forme canonique trie les clés des objets : les propriétés d'un `inputSchema` sortent dans l'ordre alphabétique, pas dans celui de la spec. L'ordre des `required`, un tableau, est conservé.

## En une phrase

On compile **au design time** des données (le manifeste), jamais du code ; un hôte mcp-open-api les **interprète** avec un code fixe, livré et signé avec le paquet, et publie chaque manifeste au broker comme un slot ; l'opérateur approuve une empreinte que n'importe qui peut recalculer.

```text
                     design time                                hôte mcp-open-api (un processus par API)      broker
binding.json ─┐                                 ┌──────────────────────────────────────────────────────┐
spec (octets) ┼─> compilateur ─> manifeste ─> Tier 4 ─> signature ─> vérification ─> fermetures ─> provider ──> slot
Overlay ──────┘   (fonction pure)  + sha256      approuve           au chargement   (aucun code généré)
```

## La compilation

### Une fonction pure

```ts
compile({ binding, spec, overlay? }): { manifest, sha256, diagnostics }
```

- `spec` est donnée en **octets**, pas en URL : le compilateur ne fait aucun accès réseau. Le designer ou la CLI vont chercher la spec ; le compilateur ne voit que ce qu'on lui donne.
- Ni horloge, ni hasard, ni état : la même entrée donne le même manifeste, octet pour octet.
- Il renvoie **tous** les diagnostics, pas le premier.

### Les étapes

1. **Charger et vérifier.** Valider le binding contre `binding-1.schema.json`. Calculer le `sha256` des octets bruts de la spec et le comparer à `spec.sha256`. Lire la spec en JSON ou YAML, OpenAPI 3.0 ou 3.1.
2. **Appliquer l'Overlay**, s'il y en a un : actions JSONPath ([RFC 9535](https://www.rfc-editor.org/rfc/rfc9535)), puis seules les opérations portant `x-mcp-tool` ou `x-mcp-resource` sont retenues et ramenées à un binding.
3. **Normaliser la spec.**
    - résoudre les `$ref` internes ; les `$ref` externes sont refusés en version 1 (spec en un seul fichier) ;
    - convertir les schémas OpenAPI 3.0 en JSON Schema 2020-12 : `nullable`, `exclusiveMinimum` booléen, `example` ;
    - fusionner les paramètres déclarés au niveau du chemin et de l'opération ;
    - indexer les opérations par clé, signaler les `operationId` en double.
4. **Traduire chaque entrée** de `tools` et `resources` :
    - **arguments** : lister les emplacements (paramètres, corps JSON aplati), appliquer `args`, vérifier les valeurs `fixed` contre le schéma de la spec, les noms en double, les arguments requis masqués sans valeur ;
    - **plan HTTP** : méthode, chemin découpé en morceaux fixes et références d'arguments, query, en-têtes, gabarit de corps mêlant références et valeurs fixes. Les styles de sérialisation OpenAPI autres que les défauts (`deepObject`, `pipeDelimited`...) sont refusés en version 1 ;
    - **sortie** : première réponse 2xx JSON, vérification des chemins de `pick`, `outputSchema` réduit ;
    - **autorisation** : capacité sous le domaine, gabarit de `resourcePath` qui vise des arguments existants, `value` sur un argument numérique ou énuméré, limites déduites.
5. **Assembler le slot** : déclaration complète pour le broker (capacités, ressources et leurs limites, `resultsRequired`), unicité des noms, longueur des noms une fois préfixés pour `_all`, plafond d'outils.
6. **Émettre** le manifeste en JSON canonique ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) : clés triées, nombres normalisés), outils triés par nom, sans horodatage. Son `sha256` est son identité.

### Restreindre par composition, sans preuve

Le binding ne peut que restreindre le schéma de la spec (principe 4 de binding.md). Prouver qu'une restriction est plus étroite est facile pour `minimum` ou `enum`, impossible en général pour `pattern`. Le compilateur ne prouve donc rien : il **compose**.

```json
{ "allOf": [{ "type": "number", "minimum": 0, "maximum": 150 }, { "minimum": 0, "maximum": 100 }] }
```

Le premier schéma vient de la spec, le second du binding. Une valeur doit satisfaire les deux : le binding restreint par construction. Le compilateur ne garde que deux contrôles : une contradiction évidente (`minimum` au-dessus du `maximum`, plus aucune valeur possible) est une erreur, et une valeur d'`enum` invalide pour la spec aussi.

### Les diagnostics

```json
{ "code": "args.required-hidden", "severity": "error", "message": "body.mode is required by the spec and hidden without a fixed value", "binding": "/tools/setValvePosition/args/body.mode", "spec": "/paths/~1valves~1{id}~1position/put/requestBody" }
```

Chaque diagnostic porte un code stable, la gravité, un message, et un pointeur JSON ([RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)) dans le binding et, quand il y a lieu, dans la spec. La page Tier 4 s'en sert pour surligner le champ en cause. Les codes reprennent la liste d'erreurs et d'avertissements de binding.md.

## Le manifeste : format `manifest-1`

Le manifeste parle en noms MCP, après renommage : c'est un plan d'exécution, pas un document d'édition. Il contient tout ce qu'il faut pour exécuter sans la spec ni le binding, et seulement leurs empreintes pour savoir d'où il vient.

```json
{
    "manifest": 1,
    "slot": "vannes",
    "compiler": "@cyanmycelium/mcp-open-api@0.2.0",
    "provenance": { "binding": "c41e…", "spec": "9f2c…" },
    "instructions": "Lecture et commande des vannes du réseau Nord. Toute ouverture est bornée à 0-100 %.",
    "target": { "baseUrl": "https://ot-gw.local/api/v2", "auth": { "secretRef": "otGateway", "kind": "bearer" }, "timeoutMs": 10000, "maxResponseBytes": 1048576 },
    "declaration": {
        "domain": "valves",
        "namespace": "/site/nord",
        "capabilities": ["valves.read", "valves.write"],
        "resources": [{ "resource": "valves:/site/nord/valves/V-012", "resourcePath": "valves/V-012", "limits": { "minValue": 0, "maxValue": 40 } }],
        "resultsRequired": ["valves.write"]
    },
    "tools": [
        {
            "name": "ouvrir_vanne",
            "description": "Fixe l'ouverture d'une vanne du réseau Nord, en pourcentage.",
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["vanne", "pourcent"],
                "properties": {
                    "vanne": { "allOf": [{ "type": "string" }, { "pattern": "^V-\\d{3}$" }] },
                    "pourcent": { "allOf": [{ "type": "number", "minimum": 0, "maximum": 150 }, { "minimum": 0, "maximum": 100 }] }
                }
            },
            "outputSchema": { "type": "object", "properties": { "id": { "type": "string" }, "position": { "type": "number" } } },
            "annotations": { "idempotentHint": true, "destructiveHint": false },
            "http": {
                "method": "PUT",
                "path": ["/valves/", { "arg": "vanne" }, "/position"],
                "body": [
                    { "pointer": "/position", "arg": "pourcent" },
                    { "pointer": "/mode", "value": "manual" }
                ]
            },
            "output": { "pick": ["id", "position"] },
            "authorization": { "capability": "valves.write", "resourcePath": ["valves/", { "arg": "vanne" }], "value": "pourcent", "resultRequired": true }
        }
    ]
}
```

| champ | rôle |
| --- | --- |
| `manifest` | version du format ; le runtime refuse une version qu'il ne connaît pas |
| `compiler` | paquet et version du compilateur : avec `provenance`, ce qu'il faut pour recompiler |
| `provenance` | `sha256` du binding et de la spec compilés |
| `target` | comme dans le binding, avec le type d'authentification résolu depuis la spec |
| `declaration` | ce que le runtime déclare au broker (`broker/authorization/declare`) ; `namespace` est un chemin de ressource absolu, les `resources` sont des ressources concrètes ou des motifs (voir plus bas) |
| `tools[].inputSchema` | schéma composé spec et binding, en noms MCP ; seuls les mots-clés que le validateur du runtime connaît y figurent |
| `tools[].http.path` | une liste de morceaux fixes et de `{ "arg": nom }` ; les valeurs d'arguments sont encodées (`encodeURIComponent`), un argument ne peut donc ni ajouter un segment ni changer d'origine |
| `tools[].http.query`, `headers` | des listes `{ name, arg }` ou `{ name, value }` ; un argument absent est omis, un tableau répète le paramètre |
| `tools[].http.body` | une liste d'affectations `{ pointer, arg }` ou `{ pointer, value }`, par pointeur JSON (RFC 6901) ; `""` désigne le corps entier. Une liste plate plutôt qu'un arbre : aucune ambiguïté entre une valeur fixe et une référence d'argument, et chaque ligne se relit seule |
| `tools[].output` | la projection, appliquée avant de répondre |
| `tools[].authorization` | ce que le runtime demande à `broker/authorize` à chaque appel ; l'identifiant natif envoyé est le nom qualifié `<domaine>:<chemin de ressource>` : une ressource appartient à son domaine, pas au slot, et `valves:/site/nord/**` n'est pas `scada:/site/nord/**` |

Ce format remplace celui de la « définition de slot » du document de conception. Il est implémenté dans `src/manifest/manifest.types.ts`, et le moteur qui l'exécute dans `src/runtime/`.

### Limites d'ingénierie : concrètes et par motif (broker 1.7.0)

Le broker 1.6 ne retrouvait les limites que par l'identifiant natif **exact** d'une ressource : une limite se déclarait pour `V-012`, jamais pour `valves/{id}`. Le banc du moteur l'a montré. Le broker 1.7.0 accepte aussi des motifs dans une déclaration, et des limites posées par l'exploitant dans le fichier de sécurité ; il intersecte toutes celles qui s'appliquent. Le manifeste déclare donc les deux formes :

```json
"resources": [
    { "resource": "valves:/site/nord/valves/V-012", "resourcePath": "valves/V-012", "limits": { "maxValue": 40 } },
    { "resourcePattern": "valves/{id}", "where": { "id": "V-1\d{2}" }, "limits": { "maxValue": 60 } }
]
```

Les chemins sont relatifs au namespace ; le moteur les rend absolus au moment de déclarer. Le compilateur dérivera le motif du gabarit de `resourcePath` et ses limites du schéma de l'argument `value`.

### Une déclaration par slot, un domaine par slot (broker 1.7.0)

Une ressource gouvernée est un nom qualifié `<domaine>:<chemin>`, et un domaine n'a qu'un propriétaire. Chaque slot déclare donc **son** domaine, jamais celui d'un autre provider. Le broker 1.7.0 indexe les déclarations par (identité, slot) : un même hôte peut servir plusieurs slots, chacun avec son domaine, sans qu'une déclaration écrase l'autre. Si le broker refuse une déclaration, `serveManifest` arrête le slot et lève `ManifestDeclarationError` avec toutes les raisons : un slot dont chaque appel serait refusé n'est pas servi.

Le moteur applique les contraintes que le broker renvoie (`allow-with-constraints`) à l'argument désigné par `authorization.value`. Une limite borne une valeur **écrite** : un outil `GET` ou `HEAD` sans `value` n'en écrit aucune, il passe. Un outil qui écrit sans désigner sa valeur est refusé : il ne doit jamais contourner une limite. C'est la méthode HTTP qui décide, pas l'annotation `readOnlyHint`, que MCP présente comme une simple indication.

## Où tourne le compilateur

Le même code, à quatre endroits : le provider `designer`, la page Tier 4 dans le navigateur (recompilation à chaque modification, diagnostics en direct), une CLI (`npx @cyanmycelium/mcp-open-api compile binding.json`, pour la CI de l'équipe qui maintient l'API), et les tests.

**L'hôte ne compile jamais.** Il reçoit un manifeste approuvé et signé, le vérifie et l'exécute. Le compilateur reste ainsi hors de la base de confiance : un compilateur bogué ou compromis ne fait rien passer, puisque l'opérateur approuve le manifeste lui-même, pas le binding. Le binaire charge d'ailleurs le compilateur à la demande, pour la seule commande `compile` : le processus `serve` n'importe jamais Ajv.

## L'exécution : l'hôte mcp-open-api

### Un provider, un ou plusieurs processus

L'hôte (`mcp-open-api serve`, ou `OpenApiHost` dans du code) lit les manifestes d'un dossier, vérifie leurs signatures, résout leurs secrets, et publie chaque manifeste au broker comme un slot, sur **une seule socket** (`MultiplexTransport`), sous **son** identité de provider. Le broker 1.7.0 garde une déclaration par slot : un hôte sert plusieurs slots, chacun dans son domaine, sans qu'ils s'écrasent.

```json
{
    "broker": { "url": "ws://broker.local:3000/providers", "secretEnv": "VANNES_PROVIDER_SECRET" },
    "manifests": "manifests/vannes",
    "trustedKeys": ["keys/operateurs-ot.pub.pem"],
    "allowedTargets": ["https://ot-gw.local"],
    "secrets": { "otGateway": { "env": "OT_GATEWAY_TOKEN" } }
}
```

**Recommandation : un hôte par API.** Chaque processus a sa config, son dossier, son identité de provider (une entrée `providers` du fichier de sécurité du broker, avec ses `allowedResources`) et ses secrets.

- **Moindre privilège** : le processus de l'API de vannes ne voit que le jeton de la passerelle OT ; un hôte compromis n'expose pas les secrets des autres API.
- **Isolation** : une API lente, ou qui renvoie de grosses réponses, ne pèse que sur son processus, ni sur le broker ni sur les autres API. C'était le pire résultat du banc quand le moteur tournait dans le broker.
- **Cycles de vie indépendants** : on redémarre l'hôte d'une API sans toucher aux autres (`tests/host.test.ts` le vérifie avec deux hôtes).
- **Jamais le même slot dans deux hôtes** : le broker appliquerait sa règle de reprise de slot (`providerTakeover`). Des dossiers de manifestes distincts suffisent.

Une application qui embarque le broker peut aussi servir un manifeste dans son propre processus, sans socket (`serveManifest`, en loopback). C'est le cas des tests et des bancs ; un déploiement utilise l'hôte.

### Interpréter, ne rien générer

Le manifeste est interprété par un code fixe, livré avec le paquet. Au chargement, ce code parcourt le manifeste **une fois** et fabrique des **fermetures** : des fonctions qui gardent leurs paramètres en mémoire.

```ts
// ["/valves/", { arg: "vanne" }, "/position"] devient, au chargement :
const parts = tool.http.path;
const buildPath = (args) => parts.map((p) => (typeof p === "string" ? p : encodeURIComponent(args[p.arg]))).join("");
```

Chaque fermeture est du code du paquet, écrit et relu à l'avance ; le manifeste ne fait que le paramétrer. Il n'a aucun moyen d'exprimer « exécute ceci ». Tout est préparé au chargement (gabarits, plans de corps, projections, validateurs), ce que le [banc de plomberie](../bench/run.mjs) a montré nécessaire pour que la traduction reste autour de 0,3 ms par appel.

### L'hôte sans génération de code

Node peut interdire la génération de code à partir de texte : `--disallow-code-generation-from-strings`. Mesuré le 2026-10-05 et le 2026-10-06 :

- le broker 1.6.1, puis l'hôte mcp-open-api (moteur, `mcp-core`, `mcp-uns`, le paquet provider, `re2js`) fonctionnent normalement avec cette option ;
- Ajv échoue immédiatement (`EvalError`), parce qu'il génère une fonction JavaScript par schéma.

**Décision : l'hôte tourne avec `--disallow-code-generation-from-strings` par défaut.** `mcp-open-api serve` se relance lui-même avec l'option s'il ne l'a pas, et annonce au démarrage `code generation: disallowed` ; `MCP_OPEN_API_ALLOW_CODE_GENERATION=1` la désactive. `scripts/serve-check.mjs` le vérifie sur le binaire construit, en CI. Le moteur ne peut donc pas utiliser Ajv.

Ce que l'option garantit, et ce qu'elle ne garantit pas, mesuré aussi :

- elle bloque `eval`, `new Function` et les chaînes passées à `setTimeout`, dans le contexte principal : c'est par là que passent les bibliothèques qui génèrent du code, comme Ajv ;
- elle **ne bloque pas `node:vm`** : `vm.Script` et `vm.runInNewContext` compilent toujours du texte, avec ou sans l'option ;
- elle **ne s'active pas après le démarrage** : `v8.setFlagsFromString()` laisse `eval` et `new Function` permis. Elle doit être sur la ligne de commande de Node, ou dans `NODE_OPTIONS`.

L'option n'est donc pas un bac à sable. Elle empêche qu'une bibliothèque génère du code par accident ; la vraie garantie reste la conception de l'interpréteur, où aucune donnée du manifeste n'atteint un chemin de génération de code. Deux contrôles la complètent :

- **en CI** : ni le moteur ni aucune dépendance de l'hôte n'importe `node:vm` ou ne l'obtient par `process.getBuiltinModule()` (vérifié : aucune) ;
- **au démarrage** : l'hôte essaie `new Function("")` et annonce le résultat.

Comment l'option est activée par défaut :

- **le CLI** vérifie `process.execArgv` ; s'il n'y trouve pas l'option, il se relance lui-même avec, en transmettant arguments, entrées-sorties, signaux et code de sortie. La relance coûte un processus Node de plus au démarrage, rien ensuite. `MCP_BROKER_ALLOW_CODE_GENERATION=1` la désactive, et `broker_diagnose` le signale ;
- **le broker embarqué** (`WsTunnelBuilder` dans une application) ne peut pas imposer l'option à son hôte. Il charge quand même les manifestes, et `broker_diagnose` signale `code-generation-allowed`.

### La validation des arguments : un validateur précompilé

Trois façons de valider les arguments d'un appel, mesurées par [bench/validate.mjs](../bench/validate.mjs) (Node 22.20, Intel Core Ultra 7 255H, médiane de 5 séries de 100 000 validations) :

| cas | Ajv (génère du code) | `@cfworker/json-schema` (interprété) | validateur précompilé (fermetures) |
| --- | --- | --- | --- |
| `ouvrir_vanne`, 2 arguments, valide | 23 ns | 2 700 ns | 145 ns |
| `ouvrir_vanne`, 120 % refusé | 33 ns | 2 740 ns | 136 ns |
| 12 arguments et 20 points, valide | 424 ns | 43 300 ns | 3 450 ns |
| 12 arguments et 20 points, dernier point faux | 458 ns | 41 800 ns | 3 330 ns |
| chargement du gros schéma, une fois par outil | 6 300 µs | 12 µs | 17 µs |
| sous `--disallow-code-generation-from-strings` | **échoue** | fonctionne | fonctionne |

Le validateur précompilé parcourt le schéma une fois, au chargement, et construit un arbre de fermetures ; à l'appel, il n'exécute que ces fonctions. Le validateur interprété relit le schéma à chaque appel.

**Décision : le runtime valide avec un validateur précompilé maison**, limité aux mots-clés que le compilateur émet (`type`, `enum`, `const`, bornes numériques, longueurs, `pattern`, `properties`, `required`, `additionalProperties`, `items`, `minItems`, `maxItems`, `allOf`, `anyOf`, `oneOf`). Un mot-clé inconnu est refusé au chargement, jamais ignoré.

Pourquoi c'est acceptable :

- il est 6 à 8 fois plus lent qu'Ajv, mais 145 ns représentent 0,05 % des 0,3 ms de plomberie mesurées, et 3,4 µs pour un gros outil environ 1 % ;
- il est 12 à 19 fois plus rapide qu'un validateur interprété générique ;
- il se charge 370 fois plus vite qu'Ajv : 40 outils se chargent en moins d'une milliseconde, contre un quart de seconde avec Ajv ;
- il ne génère aucun code, donc il est compatible avec l'option de Node.

Ajv reste l'outil du design time : compilateur, CLI, CI, tests, et le bundle `.mcpb` (plus bas), où il est généré à l'avance en mode *standalone*.

### Comment être sûr d'un validateur écrit pour l'occasion

Le compilateur est hors de la base de confiance : ce qu'il produit est relu et se recompile. Le validateur, lui, tourne dans l'hôte et fait foi. Il ne se prouve pas en le relisant, mais en le **comparant à une référence** : Ajv, le validateur JSON Schema de référence en JavaScript. Quatre défenses, chacune couvrant un angle mort de la précédente.

1. **Un sous-ensemble fermé.** Il ne connaît qu'une quinzaine de mots-clés et refuse tous les autres au chargement. Un mot-clé ignoré en silence est le bug le plus dangereux d'un validateur : il laisse tout passer sans rien dire.
2. **La suite de tests officielle** ([JSON-Schema-Test-Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite), draft 2020-12), pour chaque mot-clé couvert : les cas limites que la communauté a déjà rencontrés.
3. **La comparaison aléatoire avec Ajv** ([bench/validator.fuzz.mjs](../bench/validator.fuzz.mjs)) : des schémas tirés au hasard dans le sous-ensemble, des valeurs tirées au hasard, le même verdict exigé des deux. Le générateur est déterministe : un désaccord se rejoue depuis sa graine.
4. **L'injection de bugs**, pour prouver que la comparaison sait trouver quelque chose. Un banc qui ne voit jamais rien ne prouve rien.

Résultats sur le prototype, le 2026-10-05 :

| vérification | résultat |
| --- | --- |
| bugs injectés : `maximum` strict, `maxLength` décalé de 1, `integer` qui accepte 1,5, `required` ignoré, `oneOf` traité comme `anyOf`, `pattern` sans drapeau `u` | **6 sur 6 détectés**, en 3 000 schémas |
| prototype initial, 20 000 schémas et 200 000 valeurs au hasard | aucun désaccord |
| un objet dans un `enum` avec ses clés dans un autre ordre (`{"b":2,"a":1}` contre `[{"a":1,"b":2}]`) | **bug réel** : refusé par le prototype, accepté par Ajv, à raison. La comparaison aléatoire **ne l'avait pas trouvé** |
| générateur complété (la moitié des valeurs d'un `enum` ou `const` sont des copies réordonnées de ses membres), ancien prototype | bug attrapé 257 fois |
| prototype corrigé, 100 000 schémas et 1 000 000 de valeurs | **aucun désaccord** |

La leçon du bug de l'`enum` : le hasard seul ne suffit pas. Une valeur tirée au hasard ne tombe presque jamais sur un membre d'un `enum`, encore moins sur une copie réordonnée. D'où la suite officielle, et des générateurs dirigés vers les égalités structurelles et les bornes.

Ces vérifications entrent dans la CI : la suite officielle et une comparaison aléatoire courte à chaque commit, une comparaison longue avant chaque version. En plus, chaque manifeste produit par les tests du compilateur est validé par les deux validateurs sur des valeurs générées depuis son propre schéma.

Le validateur n'est pas non plus la seule barrière : les limites de la ressource sont vérifiées à nouveau par `broker/authorize` (`allow-with-constraints`), et l'API cible valide ses propres entrées.

**Le compilateur** se teste autrement, puisqu'il n'est pas dans la base de confiance :

- un corpus de specs réelles (Petstore, GitHub, Stripe, et l'annuaire APIs.guru) qui doit compiler sans planter, avec un binding généré qui expose tout en lecture seule ;
- des fichiers de référence : pour chaque binding de test, le manifeste attendu, comparé octet pour octet ;
- des invariants : compiler deux fois donne la même empreinte ; tout manifeste produit est valide pour `manifest-1` et se charge dans le runtime ; un aller-retour binding, Overlay, binding est sans perte ; ajouter une restriction ne fait jamais accepter une valeur de plus.

### Les expressions régulières

Un `pattern` est exécuté sur chaque argument reçu. Le moteur de V8 procède par retour arrière : une expression comme `^(a+)+$` peut bloquer la boucle d'événements du broker pendant des secondes sur une entrée piégée (ReDoS), avec le même effet que les grosses réponses mesurées au banc. Tous les slots attendent.

Mesuré par [bench/regex.mjs](../bench/regex.mjs) (Node 22.20, Intel Core Ultra 7 255H) avec `re2js` 2.8 (portage JavaScript de RE2). La colonne du module natif `re2` 1.24 a été mesurée une fois, le 2026-10-05, avant qu'il soit écarté ; le banc ne l'inclut plus.

| cas | V8 | `re2` natif | `re2js` |
| --- | --- | --- | --- |
| `^V-\d{3}$` sur `V-012` | 10 ns | 36 ns | 125 ns |
| `^[A-Z]{2}-\d{3}$` sur `PT-007` | 11 ns | 35 ns | 113 ns |
| adresse e-mail de 30 caractères | 22 ns | 76 ns | 604 ns |
| `^(a+)+$` sur 20 `a` et `!` | 3,1 ms | 64 ns | 1,0 µs |
| `^(a+)+$` sur 24 `a` et `!` | 52,7 ms | 67 ns | 0,9 µs |
| `^(a+)+$` sur 28 `a` et `!` | **860 ms** | **71 ns** | **1,0 µs** |
| compilation d'un motif, au chargement | 94 ns | 6,5 µs | 4,7 µs |

Sur un motif ordinaire, RE2 est plus lent que V8, de quelques dizaines à quelques centaines de nanosecondes : rien devant les 0,3 ms de plomberie. Sur un motif piégé, V8 explose (860 ms pour 29 caractères, et le double à chaque caractère de plus) quand RE2 reste autour de la microseconde. Le gain de RE2 n'est pas la vitesse moyenne, c'est **le pire cas borné**, et c'est le pire cas qui bloque le broker.

**Décision : le runtime évalue les `pattern` avec `re2js`, et seulement avec lui.**

Le module natif `re2` est plus rapide, mais il a été écarté pour ce qu'il coûte à l'installation et à l'exploitation (constaté sur `re2` 1.24.1) :

| | `re2` natif | `re2js` |
| --- | --- | --- |
| versions de Node | 22 et plus seulement, alors que le broker supporte Node 20 | toutes |
| installation | télécharge un binaire depuis GitHub au moment de `npm install`, sinon le compile avec `node-gyp` (Python et compilateur C++, Visual Studio Build Tools sous Windows) | JavaScript pur |
| hors ligne, derrière un proxy, ou `--ignore-scripts` | pas de binaire, ou échec de compilation | rien de particulier |
| intégrité | le binaire téléchargé échappe à l'empreinte du lockfile, et `re2` 1.24.1 ne publie aucune empreinte : il n'est vérifié par rien, à part TLS | couvert par l'empreinte du lockfile, comme tout paquet |
| taille et dépendances | 17 Mo, plus `node-gyp`, `nan`, `install-artifact-from-github` | 872 Ko, aucune dépendance |
| code natif dans l'hôte | oui | non |

Pour le runtime :

- `re2js` fonctionne avec `--disallow-code-generation-from-strings` (vérifié) ;
- le moteur de V8 n'est jamais utilisé pour un `pattern` venu d'un manifeste ;
- RE2 ne connaît ni les références arrière (`\1`) ni les assertions avant ou arrière (`(?=`, `(?<=`) : un motif que RE2 ne compile pas est une **erreur de compilation** du binding, ce qui écarte d'office la plupart des motifs dangereux ;
- la longueur de l'argument reste vérifiée **avant** son `pattern`, et le compilateur exige un `maxLength` sur tout argument qui porte un `pattern` : RE2 est linéaire, pas gratuit.

### Le moteur réel, mesuré

Le moteur de `src/runtime/` a été mesuré le 2026-10-05 avec [bench/run.mjs](../bench/run.mjs), dans un broker 1.6.1 lancé avec `--disallow-code-generation-from-strings` (confirmé : `new Function` y lève `EvalError`). Le prototype du banc de plomberie tourne dans le même passage, pour comparer.

| scénario | p50 | p99 | débit |
| --- | --- | --- | --- |
| HTTP direct, 1 Ko | 0,32 ms | 0,80 ms | 2 879 req/s |
| broker + prototype, 1 Ko | 0,74 ms | 1,46 ms | 1 303 req/s |
| broker + **moteur**, 1 Ko | 0,81 ms | 2,71 ms | 1 087 req/s |
| broker + **moteur** + `authorize`, 1 Ko | 0,80 ms | 1,58 ms | 1 213 req/s |
| broker + **moteur**, 64 Ko | 1,21 ms | 2,11 ms | 805 req/s |
| HTTP direct, 1 Ko, 100 concurrents | 12,8 ms | 38,5 ms | 6 910 req/s |
| broker + prototype, 100 concurrents | 27,5 ms | 55,4 ms | 3 458 req/s |
| broker + **moteur**, 100 concurrents | 29,3 ms | 46,9 ms | 3 340 req/s |
| broker + **moteur** + `authorize`, 100 concurrents | 39,3 ms | 60,7 ms | 2 449 req/s |
| slot voisin pendant 4 réponses de 5 Mo | 45,6 ms | 104 ms | |

- Le moteur coûte à peine plus que le prototype : 0,07 ms en p50, 3 % de débit à saturation. Les couches mcp-core et RE2 sont donc négligeables.
- Le surcoût par rapport à l'HTTP direct est d'environ 0,5 ms en p50 ce jour-là, sur une machine plus chargée que lors du premier banc (le débit direct y est 30 % plus bas) : seules les comparaisons d'un même passage valent.
- `authorize` coûte 27 % du débit à saturation, contre 17 % au premier banc. La ligne d'audit écrite à chaque décision y pèse : un puits d'audit asynchrone reste à mesurer côté broker.
- Les grosses réponses restent le vrai risque : avec des réponses de 5 Mo admises (le banc monte `maxResponseBytes` à 8 Mo), un slot voisin passe à 46 ms en p50 et 104 ms en p99. D'où la limite à 1 Mo par défaut, et l'hôte hors du broker : ce banc mesurait le moteur dans le processus du broker ; servi par un hôte, il ne retarde que les slots de ce même hôte.

Le validateur réel (`bench/validate.mjs`) coûte 442 ns sur `ouvrir_vanne` et 10 µs sur le gros outil, contre 145 ns et 3,4 µs pour le prototype : c'est le prix de RE2 sur les `pattern`, que le prototype évaluait avec V8. Il se charge en 87 µs pour le gros schéma, à cause de la compilation des motifs RE2. Comparé à Ajv sur 100 000 schémas et 1 000 000 de valeurs (`bench/validator.fuzz.mjs`), il ne donne aucun désaccord.

### Le chargement, dans l'ordre

Pour chaque fichier du dossier, l'hôte :

1. lit le manifeste et sa signature (`<fichier>.sig`), recalcule l'empreinte canonique, la compare à celle qui est signée, et vérifie la signature contre ses clés de confiance (`trustedKeys`) ;
2. refuse une version de format inconnue, puis vérifie `baseUrl` dans ses `allowedTargets` et chaque `secretRef` dans ses `secrets` ;
3. construit les fermetures ;
4. publie le slot au broker et déclare son autorisation ; le broker vérifie le propriétaire du domaine et les `allowedResources` de l'identité.

Un manifeste refusé à une étape n'est pas servi, avec ses raisons ; les autres le sont. Les plafonds (nombre d'outils, taille des schémas) restent à ajouter.

## La certification

Trois choses sont certifiées, chacune par son propre moyen.

| quoi | comment | ce qui fait foi |
| --- | --- | --- |
| **le code** : l'hôte et son interpréteur | paquet npm publié avec provenance (sigstore), intégrité du lockfile ; version dans le champ `compiler` du manifeste | la chaîne de publication |
| **le manifeste** | JSON canonique, donc une empreinte `sha256` unique | l'empreinte |
| **l'approbation Tier 4** | une signature sur cette empreinte | la clé qui signe |

### La signature

Signature détachée Ed25519 (`src/host/signature.ts`), dans un fichier `<manifeste>.sig` :

```json
{ "alg": "Ed25519", "manifest": "<sha256 du manifeste canonique>", "signature": "<base64>" }
```

Elle porte sur la **forme canonique** du manifeste : un fichier reformaté vérifie toujours, un fichier modifié jamais. L'hôte n'accepte que les clés de **sa** config (`trustedKeys`, des PEM Ed25519). Avec un hôte par API, chaque API a ses signataires : la clé de l'équipe OT, listée dans l'hôte des vannes, ne fait pas foi pour l'hôte de l'historien. `allowUnsigned` existe pour le développement, faux par défaut.

Deux façons de publier, une seule vérification :

- **par la page Tier 4** (à venir) : l'opérateur approuve, et le manifeste est signé avec la clé de l'opérateur ou du designer, à décider ;
- **par un dépôt Git** : `mcp-open-api compile`, puis `mcp-open-api sign --key`, dans la CI ou sur le poste d'un responsable ; on dépose le manifeste et sa signature dans le dossier de l'hôte.

Un manifeste dont la signature ne vérifie pas est refusé au démarrage, avec sa raison. Un fichier modifié à la main sur le disque n'est jamais chargé. Pour changer de clé, on ajoute la nouvelle aux `trustedKeys`, on re-signe, puis on retire l'ancienne : l'hôte accepte toute clé de la liste.

### La compilation reproductible

Le compilateur est déterministe : n'importe qui peut recompiler binding et spec avec la même version et retrouver la même empreinte. Une CI peut attester que ce manifeste est exactement `compile(binding@c41e…, spec@9f2c…, compiler@0.2.0)`. L'opérateur n'a pas à faire confiance au designer : il approuve un manifeste dont l'origine se vérifie.

### Le pire cas

Un manifeste malveillant, signé par une clé volée, ne peut qu'appeler des origines listées dans `allowedTargets`, utiliser des secrets désignés par référence qu'il ne voit jamais, et exposer des outils soumis à `authorize`, à l'audit et aux limites d'exécution. Il ne peut ni exécuter de code, ni lire un fichier, ni ouvrir une connexion arbitraire : l'interpréteur ne sait pas le faire. `--disallow-code-generation-from-strings` empêche en plus qu'une bibliothèque de l'hôte génère du code par accident, sans être un bac à sable (`node:vm` y échappe, d'où le contrôle en CI). Une clé volée ne compromet que les hôtes qui la listent, et un hôte compromis que son API : il ne détient que ses secrets, et le broker borne ce qu'il peut déclarer à ses `allowedResources`.

## La seconde sortie : un bundle `.mcpb` (lot ultérieur)

Générer du code au design time a sa place, mais pas dans l'hôte qui interprète les manifestes. Y charger du code généré ferait reposer toute la sécurité sur une signature : un signataire ou un générateur compromis exécuterait n'importe quoi dans le processus qui détient les secrets de l'API. Le gain, quelques microsecondes, ne le justifie pas, d'autant que l'hôte tourne déjà hors du broker.

Le compilateur peut en revanche produire, en option, un bundle `.mcpb` qui contient :

- le manifeste approuvé par le Tier 4 ;
- le code généré à partir de ce manifeste : validateurs Ajv *standalone*, fonctions de chemin, projections ;
- une attestation de build reproductible : ce code est exactement `generate(manifest@<empreinte>, generator@<version>)`.

Le broker sait déjà vérifier un `.mcpb` et le lancer **dans un processus séparé**, qu'on peut restreindre avec le modèle de permissions de Node (`--permission`). L'hôte mcp-open-api lui-même peut d'ailleurs être livré ainsi.

| sortie | exécution | quand |
| --- | --- | --- |
| **manifeste** (par défaut) | interprété par un hôte mcp-open-api, sans génération de code | le cas courant |
| **bundle `.mcpb`** (option) | code généré, processus séparé, signé comme les autres bundles | débit très élevé, plus tard transformations calculées et workflows Arazzo |

Dans les deux cas, l'opérateur approuve la même chose : le manifeste.

## Dépendances

| dépendance | où | pourquoi |
| --- | --- | --- |
| `yaml` | compilateur | specs en YAML |
| Ajv | compilateur, CLI, tests, bundle `.mcpb` | validation du binding et des manifestes au design time, génération *standalone* |
| validateur précompilé (maison) | runtime | validation des arguments dans l'hôte, sans génération de code |
| `@cyanmycelium/mcp-broker-provider` | hôte | publication des slots sur une socket partagée, `broker/authorize` |
| `re2js` | runtime, compilateur | `pattern` en temps linéaire, JavaScript pur ; le compilateur vérifie que RE2 accepte chaque motif |
| `$ref` internes, JSON canonique (maison) | compilateur | peu de code, aucune dépendance |
| JSONPath RFC 9535 | compilateur, avec l'Overlay | application des actions |

## Décisions prises

| question | décision |
| --- | --- |
| que compile-t-on | des données (le manifeste), jamais du code |
| qui compile | le designer, la page, la CLI, la CI ; jamais l'hôte |
| qui exécute | un hôte mcp-open-api, provider du broker ; un processus par API recommandé. Le broker ne connaît pas le manifeste |
| restriction des schémas | par composition `allOf` spec et binding, sans preuve |
| génération de code dans l'hôte | `--disallow-code-generation-from-strings` par défaut : `serve` se relance avec et l'annonce ; vérifié en CI sur le binaire |
| validation des arguments | validateur précompilé maison ; Ajv au design time seulement |
| expressions régulières | `re2js` seul, jamais le moteur de V8 ni le module natif `re2` ; un motif que RE2 refuse est une erreur de compilation |
| certification | signature Ed25519 détachée sur le manifeste canonique |
| clés qui font foi | les `trustedKeys` de la config de l'hôte |
| secrets des API cibles | lus par l'hôte, dans son environnement (mcp-vault ensuite), jamais dans le manifeste |
| cibles autorisées | les `allowedTargets` de la config de l'hôte |
| code généré | seulement dans un bundle `.mcpb`, processus séparé, lot ultérieur |

## Questions ouvertes

- **Signature depuis la page Tier 4** : avec la clé de l'opérateur, ou avec une clé du designer qui atteste l'approbation de l'opérateur ?
- **Secrets dans mcp-vault** : l'hôte lirait les jetons des API dans le slot `vault` du broker, scellés pour sa clé et autorisés par la politique (audience par API), au lieu de variables d'environnement.
- **Rechargement** : l'hôte charge ses manifestes au démarrage ; faut-il surveiller le dossier, ou un signal, pour publier un nouveau manifeste sans redémarrer ?