# Le binding : format `binding-1`

Le binding dit quelles opérations d'une spec OpenAPI deviennent un slot MCP, et comment chacune est traduite. C'est le seul fichier qu'on écrit. Le compilateur de mcp-open-api le combine avec la spec pour produire le **manifeste** : l'artefact figé que l'opérateur Tier 4 valide, que le broker hache et qu'il exécute.

```text
spec OpenAPI (JSON ou YAML) ──┐
binding (JSON)            ────┼──> compilateur ──> manifeste (JSON, figé) ──> Tier 4 ──> broker
Overlay x-mcp-* (option)  ────┤
Arazzo (réservé)          ────┘
```

Statut : proposition, version 1 du format. Rien n'est encore implémenté.

## Principes

1. **Refus par défaut.** Une opération absente de `tools` et de `resources` n'existe pas dans le slot. Il n'y a pas de sélection par motif (`*`, tag, préfixe de chemin) : ajouter une opération, c'est écrire sa clé.
2. **Clé = l'opération, pas l'outil.** Une entrée est indexée par l'`operationId` de la spec, ou par `"<MÉTHODE> <chemin>"` quand la spec n'en donne pas (`"GET /valves/{id}"`). Renommer un outil ne casse rien, et une opération qui disparaît de la spec est signalée par sa clé.
3. **Chaque argument est adressé par son emplacement HTTP** : `path.id`, `query.limit`, `header.X-Site`, `body.position`, `body.config.mode`. Le même adressage sert partout : `args`, `resourcePath`, `authorization.value`.
4. **Restreindre, jamais élargir, par construction.** Les restrictions du binding (`pattern`, `enum`, `minimum`, `maximum`, `maxLength`, `maxItems`) ne remplacent pas le schéma de la spec : le compilateur les **compose** avec lui (`allOf`). Une valeur doit satisfaire les deux, donc un `maximum: 200` là où la spec dit 100 reste borné à 100. Le compilateur signale seulement les contradictions (plus aucune valeur possible) et les valeurs d'`enum` invalides pour la spec. Voir [compiler.md](compiler.md).
5. **Rien de masqué sans valeur.** Un argument requis par la spec et masqué (`hide`) doit recevoir une valeur `fixed`, ou avoir un `default` dans la spec.
6. **Sortie explicite.** Chaque outil déclare sa sortie : une sélection de champs (`pick`), ou `"all"` écrit en toutes lettres. Les réponses sont le premier coût côté agent et le premier risque de fuite.
7. **Aucun code.** Des emplacements, des valeurs fixes, des restrictions, des sélections de champs. Les seules expressions admises sont celles d'Arazzo, et seulement dans les workflows.
8. **Aucun secret.** `secretRef` désigne une entrée `upstreamSecrets` du fichier de sécurité du broker, rien d'autre.
9. **Compilation déterministe.** La même spec, le même binding et la même version du compilateur donnent le même manifeste, octet pour octet.
10. **Champs inconnus refusés.** Une faute de frappe (`"hidde": true`) est une erreur, pas un réglage ignoré.

## Structure

```json
{
    "$schema": "https://raw.githubusercontent.com/pandaGaume/mcp-open-api/main/schemas/binding-1.schema.json",
    "binding": 1,
    "slot": "vannes",
    "title": "Vannes du réseau Nord",
    "instructions": "Lecture et commande des vannes du réseau Nord. Toute ouverture est bornée à 0-100 %.",
    "spec": { "path": "specs/ot-gateway.yaml", "sha256": "9f2c…" },
    "target": { "baseUrl": "https://ot-gw.local/api/v2", "auth": { "secretRef": "otGateway" }, "timeoutMs": 10000, "maxResponseBytes": 1048576 },
    "governance": { "domain": "scada", "namespace": "nord" },
    "tools": { "…": {} },
    "resources": { "…": {} },
    "arazzo": { "path": "workflows/vannes.arazzo.yaml", "sha256": "41ab…" }
}
```

| champ | requis | rôle |
| --- | --- | --- |
| `$schema` | non | complétion et validation dans l'éditeur |
| `binding` | oui | version du format, `1` |
| `slot` | oui | nom du slot publié |
| `title` | non | titre du serveur MCP (`serverInfo.title`) |
| `instructions` | non | instructions du serveur MCP, renvoyées à l'`initialize` |
| `spec` | oui | la spec source : `path` (relatif au binding) ou `url`, et son `sha256` |
| `target` | oui | où et comment appeler l'API |
| `governance` | si un outil a une `authorization` | `domain` et `namespace` déclarés au broker |
| `tools` | non | les opérations exposées en outils, par clé d'opération |
| `resources` | non | les opérations `GET` exposées en ressources, par clé d'opération |
| `arazzo` | non | document Arazzo des workflows (réservé, voir plus bas) |

Un binding couvre **une** spec et **un** slot.

### `target`

| champ | requis | défaut | rôle |
| --- | --- | --- | --- |
| `baseUrl` | oui | | origine et préfixe de l'API ; doit figurer dans `slotDefinitions.allowedTargets` du broker. Le `servers[]` de la spec n'est jamais utilisé tel quel |
| `auth.secretRef` | non | | entrée `upstreamSecrets` du fichier de sécurité |
| `auth.scheme` | non | le seul `securityScheme` de la spec | nom du `securityScheme` à appliquer quand la spec en déclare plusieurs |
| `headers` | non | | en-têtes fixes et non secrets (`"Accept-Language": "fr"`) |
| `timeoutMs` | non | 10000 | délai par appel HTTP |
| `maxResponseBytes` | non | 1048576 | au-delà, la lecture est coupée et l'appel échoue |

## Les outils : `tools`

```json
"setValvePosition": {
    "name": "ouvrir_vanne",
    "description": "Fixe l'ouverture d'une vanne du réseau Nord, en pourcentage.",
    "note": "Mode forcé à manual : le mode auto est réservé à la supervision.",
    "args": {
        "path.id": { "name": "vanne", "pattern": "^V-\\d{3}$" },
        "body.position": { "name": "pourcent", "minimum": 0, "maximum": 100 },
        "body.mode": { "fixed": "manual" },
        "query.debug": { "hide": true }
    },
    "output": { "pick": ["id", "position"] },
    "annotations": { "idempotentHint": true, "destructiveHint": false },
    "authorization": {
        "capability": "scada.valve.write",
        "resourcePath": "valves/{path.id}",
        "value": "body.position",
        "resultRequired": true
    }
}
```

| champ | défaut | rôle |
| --- | --- | --- |
| `name` | `operationId` en snake_case | nom de l'outil : `^[a-z][a-z0-9_]{0,47}$`, 48 caractères pour laisser la place au préfixe de `_all` |
| `title` | `summary` de la spec | titre affiché |
| `description` | `summary`, puis `description` de la spec | texte lu par le LLM ; 2 000 caractères au plus |
| `note` | | pourquoi ces choix ; montré au Tier 4, jamais envoyé au client MCP |
| `args` | tous les paramètres de la spec, sous leur nom | voir ci-dessous |
| `output` | **aucun : requis** | voir ci-dessous |
| `annotations` | déduites de la méthode | `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` |
| `authorization` | aucune | voir ci-dessous ; requise pour toute méthode autre que `GET` et `HEAD` |
| `timeoutMs` | celui de `target` | délai propre à cet outil |

### `args`

Chaque clé est un emplacement : `path.<nom>`, `query.<nom>`, `header.<nom>`, `body` (corps entier), `body.<chemin>` (propriété du corps, chemin pointé). Un emplacement absent de `args` est exposé tel que la spec le décrit.

| champ | rôle |
| --- | --- |
| `name` | nom de l'argument côté MCP |
| `description` | remplace la description de la spec |
| `hide` | l'argument n'est pas exposé ; il prend sa valeur `fixed` ou son `default` |
| `fixed` | valeur imposée, jamais choisie par l'appelant ; implique `hide` |
| `pattern`, `enum`, `minimum`, `maximum`, `maxLength`, `maxItems` | restrictions, composées avec le schéma de la spec (`allOf`) : elles ne peuvent que resserrer |

Règles de nommage par défaut :

- un paramètre `path`, `query` ou `header` garde son nom ;
- un corps JSON objet est aplati au premier niveau : `body.position` devient l'argument `position` ;
- un corps qui n'est pas un objet devient un argument unique, `body` ;
- deux emplacements qui donneraient le même nom (`path.id` et `query.id`) sont une **erreur** : le binding doit en renommer un ;
- les en-têtes `Authorization`, `Cookie` et ceux que pose `target.auth` ne sont jamais exposés.

Corps acceptés en version 1 : `application/json` seulement. Une opération dont le corps est `multipart/form-data` ou `application/octet-stream` est refusée par le compilateur.

### `output`

| forme | effet |
| --- | --- |
| `"all"` | la réponse JSON entière, en `structuredContent` et en texte |
| `{ "pick": [...] }` | seulement ces champs, chemins pointés ; `[]` parcourt un tableau : `"items[].id"` |
| `{ "pick": [...], "maxItems": 20 }` | en plus, les tableaux sont coupés à 20 éléments, et le nombre total est indiqué |

Le compilateur dérive l'`outputSchema` MCP de la première réponse 2xx de la spec, réduite à `pick`. Un chemin de `pick` absent du schéma de réponse est une erreur.

Une réponse 4xx ou 5xx donne `isError: true` avec le statut HTTP. Si le corps est un *problem details* ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)), son `title` et son `detail` sont repris. Sinon, le corps n'est pas renvoyé : une page d'erreur peut contenir n'importe quoi.

### `annotations` par défaut

| méthode | annotations |
| --- | --- |
| `GET`, `HEAD` | `readOnlyHint: true` |
| `PUT` | `idempotentHint: true` |
| `DELETE` | `destructiveHint: true`, `idempotentHint: true` |
| `POST`, `PATCH` | aucune ; le compilateur avertit tant que le binding n'en pose pas |

### `authorization`

| champ | rôle |
| --- | --- |
| `capability` | capacité vérifiée par `broker/authorize` ; doit être sous `<governance.domain>.*` |
| `resourcePath` | chemin de ressource, relatif au `namespace` ; les gabarits utilisent l'adressage des `args` : `valves/{path.id}` |
| `value` | l'argument qui porte la valeur écrite. Les limites déclarées au broker pour cette ressource sont **déduites de son schéma** : `minimum` et `maximum` donnent `minValue` et `maxValue`, `enum` donne `allowedValues`. Une décision `allow-with-constraints` s'applique à cet argument |
| `resultRequired` | le résultat de l'appel doit être rapporté au broker (`broker/audit/result`) |

Le compilateur produit la déclaration du slot à partir de toutes les entrées : une capacité par capacité distincte, une ressource par gabarit de `resourcePath`, avec ses limites.

## Les ressources : `resources`

Une opération `GET` sans corps peut être exposée en ressource MCP plutôt qu'en outil.

```json
"getValve": {
    "uri": "valve://nord/{path.id}",
    "name": "vanne",
    "description": "État d'une vanne du réseau Nord.",
    "output": { "pick": ["id", "position", "state", "updatedAt"] },
    "authorization": { "capability": "scada.valve.read", "resourcePath": "valves/{path.id}" }
}
```

Une `uri` avec gabarit devient un *resource template* ; sans gabarit, une ressource fixe. Les arguments du gabarit doivent couvrir tous les paramètres requis de l'opération. Les abonnements (`resources/subscribe`) passent par le broker comme pour tout provider ; mcp-open-api n'interroge pas l'API en boucle pour les alimenter en version 1.

Une même opération peut figurer à la fois dans `tools` et dans `resources`.

## Overlay : la même chose, dans la spec

Un [Overlay 1.0](https://spec.openapis.org/overlay/v1.0.0.html) peut porter le binding sous forme d'extensions. Le contenu est **exactement le même objet** :

| extension | où | contenu |
| --- | --- | --- |
| `x-mcp-slot` | racine de la spec | les champs de premier niveau du binding, sauf `tools`, `resources` et `spec` |
| `x-mcp-tool` | une opération | une entrée de `tools` |
| `x-mcp-resource` | une opération | une entrée de `resources` |

```json
{
    "overlay": "1.0.0",
    "info": { "title": "Binding vannes", "version": "1" },
    "extends": "specs/ot-gateway.yaml",
    "actions": [
        {
            "target": "$.paths['/valves/{id}'].get",
            "update": {
                "x-mcp-tool": {
                    "name": "lire_vanne",
                    "args": { "path.id": { "name": "vanne", "pattern": "^V-\\d{3}$" } },
                    "output": { "pick": ["id", "position", "state"] },
                    "authorization": { "capability": "scada.valve.read", "resourcePath": "valves/{path.id}" }
                }
            }
        }
    ]
}
```

Le compilateur applique l'Overlay, puis ramène le résultat à un binding : il ne retient **que** les opérations qui portent `x-mcp-tool` ou `x-mcp-resource`, ce qui préserve le refus par défaut. Il compare ensuite la spec avant et après l'Overlay, et refuse tout schéma élargi par une action `update`.

Le designer sait aussi produire un Overlay à partir d'un binding, pour l'équipe qui maintient la spec. L'aller-retour est sans perte.

## Arazzo : les workflows (réservé)

Le format réserve dès la version 1 la place des outils à plusieurs appels. Leur exécution viendra au lot « outils à plusieurs étapes ».

```json
"arazzo": { "path": "workflows/vannes.arazzo.yaml", "sha256": "41ab…" },
"tools": {
    "ouvertureSecurisee": {
        "from": "workflow",
        "name": "ouvrir_vanne_securisee",
        "description": "Vérifie que la vanne n'est pas verrouillée, puis fixe son ouverture.",
        "output": { "pick": ["id", "position"] },
        "authorization": { "capability": "scada.valve.write", "resourcePath": "valves/{inputs.vanne}" }
    }
}
```

La clé est le `workflowId`. Les entrées du workflow donnent le schéma d'entrée de l'outil, ses sorties le `structuredContent`. Les gabarits adressent les entrées par `inputs.<nom>`.

Règles :

- chaque étape appelle une opération que le binding déclare aussi dans `tools`, avec ses restrictions : un workflow n'atteint rien que le binding n'expose pas ;
- toutes les autorisations (celle du workflow et celle de chaque étape) sont vérifiées **avant** la première étape ;
- le runtime borne le nombre d'étapes exécutées (20 par défaut) et les `retry`, parce que `goto` permet des boucles ;
- il n'y a pas de transaction : un workflow qui écrit est signalé « non atomique » sur la page Tier 4 ;
- les expressions Arazzo (`$inputs`, `$steps`, `$response`) sont admises ici, et nulle part ailleurs dans le binding.

Tant que l'exécution n'existe pas, le compilateur refuse `from: "workflow"` avec un message qui le dit.

## Compilation

Le compilateur lit la spec, applique l'Overlay éventuel, vérifie le `sha256` de la spec, puis produit le manifeste et son empreinte. Il renvoie **toutes** les erreurs, pas la première.

Erreurs :

- `sha256` de la spec différent de celui du binding ;
- clé d'opération introuvable dans la spec ;
- emplacement d'`args` introuvable dans l'opération ;
- restriction contradictoire avec la spec (plus aucune valeur possible), ou valeur d'`enum` invalide pour la spec ;
- argument requis masqué sans `fixed` ni `default` ;
- deux arguments du même nom, ou nom d'outil invalide, ou en double ;
- `output` absent, ou chemin de `pick` absent du schéma de réponse ;
- méthode autre que `GET` ou `HEAD` sans `authorization` ;
- capacité hors de `<domain>.*`, gabarit de `resourcePath` qui vise un argument inexistant ;
- `value` qui ne vise pas un argument numérique ou énuméré ;
- corps d'un type autre que `application/json` ;
- champ inconnu ;
- `from: "workflow"` tant que l'exécution n'existe pas.

Avertissements :

- `POST` ou `PATCH` sans annotations ;
- description vide, ou reprise de la spec sans retouche ;
- plus de 40 outils (plafond réglable côté broker) ;
- `output: "all"` sur une réponse dont le schéma dépasse 20 propriétés ou contient un tableau sans `maxItems`.

Le manifeste contient tout ce qu'il faut pour exécuter sans la spec ni le binding : schémas d'entrée et de sortie résolus, appels HTTP explicites (méthode, gabarit de chemin, placement de chaque argument, valeurs fixes), sélections de sortie, annotations, déclaration d'autorisation, et la version du compilateur. C'est ce document que la page Tier 4 montre et que le broker publie.

## Exemple complet

```json
{
    "$schema": "https://raw.githubusercontent.com/pandaGaume/mcp-open-api/main/schemas/binding-1.schema.json",
    "binding": 1,
    "slot": "vannes",
    "title": "Vannes du réseau Nord",
    "instructions": "Lecture et commande des vannes du réseau Nord. Toute ouverture est bornée à 0-100 %.",
    "spec": { "path": "specs/ot-gateway.yaml", "sha256": "9f2c4e1b7a0d3c5f8e6b2a1d4c7f0e9b3a6d5c8f1e4b7a0d2c5f8e1b4a7d0c3f" },
    "target": {
        "baseUrl": "https://ot-gw.local/api/v2",
        "auth": { "secretRef": "otGateway" },
        "timeoutMs": 10000,
        "maxResponseBytes": 1048576
    },
    "governance": { "domain": "scada", "namespace": "nord" },
    "tools": {
        "getValve": {
            "name": "lire_vanne",
            "description": "Lit la position (0-100 %) et l'état d'une vanne du réseau Nord.",
            "args": {
                "path.id": { "name": "vanne", "description": "Repère de la vanne, ex. V-012", "pattern": "^V-\\d{3}$" },
                "query.debug": { "hide": true }
            },
            "output": { "pick": ["id", "position", "state", "updatedAt"] },
            "authorization": { "capability": "scada.valve.read", "resourcePath": "valves/{path.id}" }
        },
        "listValves": {
            "name": "lister_vannes",
            "description": "Liste les vannes du réseau Nord et leur état.",
            "output": { "pick": ["items[].id", "items[].state"], "maxItems": 50 },
            "authorization": { "capability": "scada.valve.read", "resourcePath": "valves" }
        },
        "setValvePosition": {
            "name": "ouvrir_vanne",
            "description": "Fixe l'ouverture d'une vanne du réseau Nord, en pourcentage.",
            "note": "Mode forcé à manual : le mode auto est réservé à la supervision.",
            "args": {
                "path.id": { "name": "vanne", "pattern": "^V-\\d{3}$" },
                "body.position": { "name": "pourcent", "minimum": 0, "maximum": 100 },
                "body.mode": { "fixed": "manual" }
            },
            "output": { "pick": ["id", "position"] },
            "annotations": { "idempotentHint": true, "destructiveHint": false },
            "authorization": {
                "capability": "scada.valve.write",
                "resourcePath": "valves/{path.id}",
                "value": "body.position",
                "resultRequired": true
            }
        }
    },
    "resources": {
        "getValve": {
            "uri": "valve://nord/{path.id}",
            "name": "vanne",
            "output": { "pick": ["id", "position", "state", "updatedAt"] },
            "authorization": { "capability": "scada.valve.read", "resourcePath": "valves/{path.id}" }
        }
    }
}
```

## Décisions prises

| question | décision |
| --- | --- |
| format du binding | JSON, avec `$schema` ; `note` remplace les commentaires et fait partie de la revue |
| format de la spec et de l'Overlay | JSON ou YAML : ce ne sont pas nos formats |
| gabarits de `resourcePath` | adressage par emplacement (`{path.id}`), indépendant des renommages |
| sortie par défaut | aucune : `output` est requis, `"all"` s'écrit explicitement |
| limites de gouvernance | déduites du schéma de l'argument désigné par `authorization.value` |
| plusieurs specs par binding | non : une spec, un binding, un slot |
| Overlay | en entrée et en sortie, équivalence exacte avec `x-mcp-tool` et `x-mcp-resource` |
| Arazzo | réservé dans le format dès la version 1, exécuté au lot « outils à plusieurs étapes » |

## Questions ouvertes

- **Pagination.** Faut-il un champ qui décrit la pagination d'une opération (curseur, page, `Link`), pour que le runtime suive les pages jusqu'à `maxItems` ? En version 1, le curseur est un argument ordinaire.
- **Plusieurs réponses 2xx.** Une opération qui répond 200 ou 202 avec des schémas différents : on prend la première, ou on exige que le binding choisisse ?
- **Collisions avec `_all`.** Le préfixe de `_all` est ajouté par le broker. Faut-il que le compilateur vérifie la longueur finale `<slot>-<nom>` plutôt que le seul nom ?
