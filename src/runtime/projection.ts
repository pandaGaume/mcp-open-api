import type { ManifestOutput } from "../manifest/manifest.types";

/** What a projection keeps, and the arrays it cut. */
export interface IProjection {
    readonly value: unknown;
    /** Arrays cut at `maxItems`: where, and how many items they had. */
    readonly truncated: readonly { readonly path: string; readonly total: number }[];
}

interface INode {
    each: boolean;
    children: Map<string, INode> | null;
}

/**
 * Compiles `output` into a function, at load. `pick` paths are dotted, `[]`
 * walks an array: `items[].id`. A response that is an array is projected item
 * by item. Fields absent from the response are left out, never invented.
 */
export function compileProjection(output: ManifestOutput): (value: unknown) => IProjection {
    if (output === "all") return (value) => ({ value, truncated: [] });
    const root = new Map<string, INode>();
    for (const path of output.pick) {
        let level = root;
        const segments = path.split(".");
        segments.forEach((segment, i) => {
            const each = segment.endsWith("[]");
            const key = each ? segment.slice(0, -2) : segment;
            if (!key) throw new Error(`invalid pick path "${path}"`);
            let node = level.get(key);
            if (!node) level.set(key, (node = { each, children: null }));
            else if (node.each !== each) throw new Error(`pick path "${path}" walks "${key}" both as an array and as a value`);
            if (i < segments.length - 1) level = node.children ??= new Map();
            else node.children = null;
        });
    }
    const maxItems = output.maxItems ?? Infinity;

    return (value) => {
        const truncated: { path: string; total: number }[] = [];
        const cut = (items: unknown[], path: string): unknown[] => {
            if (items.length <= maxItems) return items;
            truncated.push({ path, total: items.length });
            return items.slice(0, maxItems);
        };
        const projectObject = (src: unknown, tree: Map<string, INode>, path: string): unknown => {
            if (src === null || typeof src !== "object" || Array.isArray(src)) return undefined;
            const out: Record<string, unknown> = {};
            for (const [key, node] of tree) {
                if (!Object.hasOwn(src, key)) continue;
                const v = (src as Record<string, unknown>)[key];
                const at = path ? `${path}.${key}` : key;
                if (node.each) {
                    if (!Array.isArray(v)) continue;
                    const items = cut(v, `${at}[]`);
                    out[key] = node.children ? items.map((item, i) => projectObject(item, node.children!, `${at}[${i}]`) ?? null) : items;
                } else if (node.children) {
                    const inner = projectObject(v, node.children, at);
                    if (inner !== undefined) out[key] = inner;
                } else {
                    out[key] = v;
                }
            }
            return out;
        };
        const projected = Array.isArray(value) ? cut(value, "[]").map((item, i) => projectObject(item, root, `[${i}]`) ?? null) : (projectObject(value, root, "") ?? null);
        return { value: projected, truncated };
    };
}
