# Le compilateur et l'exécution

Le compilateur transforme un binding et sa spec en **manifeste** : un plan d'exécution figé, que l'opérateur Tier 4 approuve et que le broker exécute. Ce document décrit la compilation, le format du manifeste, son exécution dans le broker, et comment on certifie ce qui s'exécute.

Le format du binding est dans [binding.md](binding.md).

**État (2026-10-06).** Implémentés : le compilateur (`src/compiler/`, entrée `@cyanmycelium/mcp-open-api/compiler`) et le moteur (`src/runtime/`). Le manifeste compilé depuis la spec OpenAPI de l'API de vannes de test est servi derrière un vrai broker 1.7.0 et se comporte comme le manifeste écrit à la main (`tests/compiler.test.ts`). Pas encore : l'Overlay, Arazzo, les ressources MCP, la CLI, la signature des manifestes, la seconde sortie `.mcpb`.

Limites de la version 1 du compilateur, chacune signalée par un diagnostic, jamais ignorée en silence :

- mots-clés de validation que le moteur ne vérifie pas encore : `multipleOf`, `uniqueItems`, `minProperties`, `maxProperties`, `patternProperties`, `propertyNames`, `dependentRequired`, `if` / `then` / `else`, `not`, `prefixItems`, `contains`, `unevaluated*`. Les retirer élargirait le schéma : c'est une erreur (`schema.unsupported-keyword`) ;
- paramètres : styles par défaut seulement (`simple` pour le chemin et les en-têtes, `form` éclaté pour la query), pas d'objet en query, pas de paramètre décrit par `content`, pas de cookie obligatoire ;
- corps : JSON seulement ; une valeur imbriquée (`body.a.b`) ne peut être que fixée ;
- authentification : `bearer`, `basic`, `apiKey` en en-tête ou en query ; pas encore OAuth 2 ni OpenID Connect ;
- les mots-clés `format`, `xml`, `example`, `discriminator`, `readOnly`, `writeOnly` sont retirés : ce sont des annotations. Une propriété `readOnly` quitte le schéma d'entrée, une propriété `writeOnly` celui de sortie.

La forme canonique trie les clés des objets : les propriétés d'un `inputSchema` sortent dans l'ordre alphabétique, pas dans celui de la spec. L'ordre des `required`, un tableau, est conservé.

## En une phrase

On compile **au design time** des données (le manifeste), jamais du code ; le broker les **interprète** avec un code fixe, livré et signé avec lui ; l'opérateur approuve une empreinte que n'importe qui peut recalculer.

```text
                     design time                                      broker
binding.json ─┐                                 ┌──────────────────────────────────────────────┐
spec (octets) ┼─> compilateur ─> manifeste ─> Tier 4 ─> signature ─> vérification ─> fermetures ─> slot
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

**Le broker ne compile jamais.** Il reçoit un manifeste approuvé, le vérifie et l'exécute. Le compilateur reste ainsi hors de la base de confiance : un compilateur bogué ou compromis ne fait rien passer, puisque l'opérateur approuve le manifeste lui-même, pas le binding.

## L'exécution dans le broker

### Interpréter, ne rien générer

Le manifeste est interprété par un code fixe, livré avec le paquet. Au chargement, ce code parcourt le manifeste **une fois** et fabrique des **fermetures** : des fonctions qui gardent leurs paramètres en mémoire.

```ts
// ["/valves/", { arg: "vanne" }, "/position"] devient, au chargement :
const parts = tool.http.path;
const buildPath = (args) => parts.map((p) => (typeof p === "string" ? p : encodeURIComponent(args[p.arg]))).join("");
```

Chaque fermeture est du code du paquet, écrit et relu à l'avance ; le manifeste ne fait que le paramétrer. Il n'a aucun moyen d'exprimer « exécute ceci ». Tout est préparé au chargement (gabarits, plans de corps, projections, validateurs), ce que le [banc de plomberie](../bench/run.mjs) a montré nécessaire pour que la traduction reste autour de 0,3 ms par appel.

### Le broker sans génération de code

Node peut interdire la génération de code à partir de texte : `--disallow-code-generation-from-strings`. Mesuré le 2026-10-05 :

- le broker 1.6.1 démarre et répond normalement avec cette option : ni lui ni ses dépendances (`mcp-core`, `ws`, `jose`, `open`) ne génèrent de code ;
- Ajv échoue immédiatement (`EvalError`), parce qu'il génère une fonction JavaScript par schéma.

**Décision : le broker tourne avec `--disallow-code-generation-from-strings` par défaut.** Le runtime ne peut donc pas utiliser Ajv.

Ce que l'option garantit, et ce qu'elle ne garantit pas, mesuré aussi :

- elle bloque `eval`, `new Function` et les chaînes passées à `setTimeout`, dans le contexte principal : c'est par là que passent les bibliothèques qui génèrent du code, comme Ajv ;
- elle **ne bloque pas `node:vm`** : `vm.Script` et `vm.runInNewContext` compilent toujours du texte, avec ou sans l'option ;
- elle **ne s'active pas après le démarrage** : `v8.setFlagsFromString()` laisse `eval` et `new Function` permis. Elle doit être sur la ligne de commande de Node, ou dans `NODE_OPTIONS`.

L'option n'est donc pas un bac à sable. Elle empêche qu'une bibliothèque génère du code par accident ; la vraie garantie reste la conception de l'interpréteur, où aucune donnée du manifeste n'atteint un chemin de génération de code. Deux contrôles la complètent :

- **en CI** : ni le runtime ni aucune dépendance du broker n'importe `node:vm` ou ne l'obtient par `process.getBuiltinModule()` (vérifié aujourd'hui : aucune) ;
- **au démarrage** : le broker essaie `new Function("")`. S'il réussit alors que des manifestes sont chargés, `broker_diagnose` le signale (`code-generation-allowed`).

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

Le compilateur est hors de la base de confiance : ce qu'il produit est relu et se recompile. Le validateur, lui, tourne dans le broker et fait foi. Il ne se prouve pas en le relisant, mais en le **comparant à une référence** : Ajv, le validateur JSON Schema de référence en JavaScript. Quatre défenses, chacune couvrant un angle mort de la précédente.

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
| code natif dans le broker | oui | non |

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
- Les grosses réponses restent le vrai risque : avec des réponses de 5 Mo admises (le banc monte `maxResponseBytes` à 8 Mo), un slot voisin passe à 46 ms en p50 et 104 ms en p99. D'où la limite à 1 Mo par défaut.

Le validateur réel (`bench/validate.mjs`) coûte 442 ns sur `ouvrir_vanne` et 10 µs sur le gros outil, contre 145 ns et 3,4 µs pour le prototype : c'est le prix de RE2 sur les `pattern`, que le prototype évaluait avec V8. Il se charge en 87 µs pour le gros schéma, à cause de la compilation des motifs RE2. Comparé à Ajv sur 100 000 schémas et 1 000 000 de valeurs (`bench/validator.fuzz.mjs`), il ne donne aucun désaccord.

### Le chargement, dans l'ordre

1. Lire le manifeste et sa signature, vérifier la signature contre la clé du broker ou une clé déclarée pour ce slot dans `slotSigners`.
2. Recalculer l'empreinte canonique et la comparer à celle qui est signée.
3. Valider la forme (`manifest-1`), refuser une version de format inconnue.
4. Appliquer les plafonds : nombre d'outils, profondeur et taille des schémas, longueur des `pattern`.
5. Contrôles du broker : `baseUrl` dans `allowedTargets`, `secretRef` présent dans le fichier de sécurité, propriétaire du domaine.
6. Construire les fermetures, enregistrer le slot, déclarer son autorisation.

## La certification

Trois choses sont certifiées, chacune par son propre moyen.

| quoi | comment | ce qui fait foi |
| --- | --- | --- |
| **le code** : interpréteur, broker | paquet npm publié avec provenance (sigstore), intégrité du lockfile ; version visible dans `broker_info` | la chaîne de publication |
| **le manifeste** | JSON canonique, donc une empreinte `sha256` unique | l'empreinte |
| **l'approbation Tier 4** | une signature sur cette empreinte | la clé qui signe |

### La signature

Le mécanisme est celui des bundles `.mcpb`, déjà dans le broker : signature détachée Ed25519, vérifiée contre une clé publique. Un seul mécanisme de confiance pour tout ce que le broker charge et exécute.

**Décision : deux sortes de clés font foi.**

| clé | ce qu'elle peut signer | où elle est déclarée |
| --- | --- | --- |
| **la clé du broker** | tous les slots | générée par le broker, privée sur son disque ; sa clé publique est dans `broker_info` |
| **une clé déclarée pour un slot** | ce slot seulement | le fichier de sécurité, par slot |

```json
{
    "slotSigners": {
        "vannes": ["keys/equipe-ot.pub.pem"],
        "historique": ["keys/equipe-data.pub.pem", "keys/ci-data.pub.pem"]
    }
}
```

Une équipe ne peut ainsi signer que ses propres slots : la clé de l'équipe OT ne fait pas foi pour `historique`. Les clés vivent dans le fichier de sécurité, qui refuse de démarrer s'il est invalide et dont l'empreinte entre dans `policyVersion` : ajouter ou retirer un signataire est un changement de politique, tracé comme tel.

Deux façons de publier, une seule vérification :

- **par la page Tier 4** : l'opérateur approuve avec son jeton ; le broker signe le manifeste avec **sa** clé, joint l'approbation (empreinte, sujet, date, `policyVersion`), l'audite et l'écrit sur disque ;
- **hors ligne, par un dépôt Git** : une équipe signe le manifeste dans sa CI ou sur le poste d'un responsable, avec **la clé déclarée pour ce slot** ; le broker le charge sans passer par l'API d'administration.

Au démarrage comme à chaque publication, un manifeste dont la signature ne vérifie pas est refusé. Un fichier modifié à la main sur le disque n'est jamais chargé.

### La compilation reproductible

Le compilateur est déterministe : n'importe qui peut recompiler binding et spec avec la même version et retrouver la même empreinte. Une CI peut attester que ce manifeste est exactement `compile(binding@c41e…, spec@9f2c…, compiler@0.2.0)`. L'opérateur n'a pas à faire confiance au designer : il approuve un manifeste dont l'origine se vérifie.

### Le pire cas

Un manifeste malveillant, signé par une clé volée, ne peut qu'appeler des origines listées dans `allowedTargets`, utiliser des secrets désignés par référence qu'il ne voit jamais, et exposer des outils soumis à `authorize`, à l'audit et aux limites d'exécution. Il ne peut ni exécuter de code, ni lire un fichier, ni ouvrir une connexion arbitraire : l'interpréteur ne sait pas le faire. `--disallow-code-generation-from-strings` empêche en plus qu'une bibliothèque du broker génère du code par accident, sans être un bac à sable (`node:vm` y échappe, d'où le contrôle en CI). Une clé d'équipe volée ne compromet que les slots déclarés pour elle.

## La seconde sortie : un bundle `.mcpb` (lot ultérieur)

Générer du code au design time a sa place, mais **hors du broker**. Charger du code généré dans le broker ferait reposer toute la sécurité sur une signature : un signataire ou un générateur compromis exécuterait n'importe quoi dans le processus qui détient tous les secrets. Le gain, quelques microsecondes, ne le justifie pas.

Le compilateur peut en revanche produire, en option, un bundle `.mcpb` qui contient :

- le manifeste approuvé par le Tier 4 ;
- le code généré à partir de ce manifeste : validateurs Ajv *standalone*, fonctions de chemin, projections ;
- une attestation de build reproductible : ce code est exactement `generate(manifest@<empreinte>, generator@<version>)`.

Le broker sait déjà vérifier un `.mcpb` et le lancer **dans un processus séparé**, qu'on peut restreindre avec le modèle de permissions de Node (`--permission`). C'est aussi la réponse au problème des grosses réponses mesuré au banc : une API lourde tourne hors du broker et ne bloque pas les autres slots.

| sortie | exécution | quand |
| --- | --- | --- |
| **manifeste** (par défaut) | interprété dans le broker, sans génération de code | le cas courant |
| **bundle `.mcpb`** (option) | code généré, processus séparé, signé comme les autres bundles | grosses réponses, débit élevé, plus tard transformations calculées et workflows Arazzo |

Dans les deux cas, l'opérateur approuve la même chose : le manifeste.

## Dépendances

| dépendance | où | pourquoi |
| --- | --- | --- |
| `yaml` | compilateur | specs en YAML |
| Ajv | compilateur, CLI, tests, bundle `.mcpb` | validation du binding et des manifestes au design time, génération *standalone* |
| validateur précompilé (maison) | runtime | validation des arguments dans le broker, sans génération de code |
| `re2js` | runtime, compilateur | `pattern` en temps linéaire, JavaScript pur ; le compilateur vérifie que RE2 accepte chaque motif |
| `$ref` internes, JSON canonique (maison) | compilateur | peu de code, aucune dépendance |
| JSONPath RFC 9535 | compilateur, avec l'Overlay | application des actions |

## Décisions prises

| question | décision |
| --- | --- |
| que compile-t-on | des données (le manifeste), jamais du code chargé dans le broker |
| qui compile | le designer, la page, la CLI, la CI ; jamais le broker |
| restriction des schémas | par composition `allOf` spec et binding, sans preuve |
| génération de code dans le broker | `--disallow-code-generation-from-strings` par défaut : le CLI se relance avec ; contrôle `node:vm` en CI ; `broker_diagnose` signale un broker qui l'autorise |
| validation des arguments | validateur précompilé maison ; Ajv au design time seulement |
| expressions régulières | `re2js` seul, jamais le moteur de V8 ni le module natif `re2` ; un motif que RE2 refuse est une erreur de compilation |
| certification | signature Ed25519 détachée, comme les `.mcpb`, sur le manifeste canonique |
| clés qui font foi | la clé du broker pour tous les slots, et les clés déclarées par slot dans le fichier de sécurité (`slotSigners`) pour leur slot seulement |
| code généré | seulement dans un bundle `.mcpb`, hors du broker, lot ultérieur |

## Questions ouvertes

- **Rotation de la clé du broker** : que deviennent les manifestes signés par l'ancienne clé ? Proposition : la clé précédente reste valide pour vérifier, jamais pour signer, jusqu'à ce que chaque manifeste ait été re-signé.