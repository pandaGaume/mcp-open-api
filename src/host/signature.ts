import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { canonicalJson } from "../compiler/canonical";
import type { IManifest } from "../manifest/manifest.types";

/**
 * A detached manifest signature, stored next to the manifest as
 * `<manifest>.sig`. It signs the manifest's canonical form (RFC 8785), so a
 * reformatted file still verifies and an edited one never does.
 */
export interface IManifestSignature {
    readonly alg: "Ed25519";
    /** SHA-256 of the canonical manifest: the identity the operator approved. */
    readonly manifest: string;
    /** Ed25519 signature of the canonical manifest, base64. */
    readonly signature: string;
}

export interface IKeyPair {
    readonly privateKeyPem: string;
    readonly publicKeyPem: string;
}

/** A new Ed25519 key pair, PEM encoded (PKCS#8 and SPKI). */
export function generateSigningKeys(): IKeyPair {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    return {
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
}

/** Signs a manifest (any JSON value) with an Ed25519 private key. */
export function signManifest(manifest: unknown, privateKeyPem: string): IManifestSignature {
    const key = createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error(`manifests are signed with Ed25519, not ${key.asymmetricKeyType}`);
    const canonical = Buffer.from(canonicalJson(manifest));
    return { alg: "Ed25519", manifest: createHash("sha256").update(canonical).digest("hex"), signature: sign(null, canonical, key).toString("base64") };
}

/** Why a signature was not accepted; `null` when one trusted key verifies it. */
export function signatureProblem(manifest: unknown, signature: unknown, trustedKeys: readonly KeyObject[]): string | null {
    if (!isSignature(signature)) return "the signature file is not an Ed25519 manifest signature";
    if (trustedKeys.length === 0) return "no trusted key is configured";
    const canonical = Buffer.from(canonicalJson(manifest));
    const digest = createHash("sha256").update(canonical).digest("hex");
    if (digest !== signature.manifest) return `the manifest is ${digest}, the signature is for ${signature.manifest}: it changed after signing`;
    const bytes = Buffer.from(signature.signature, "base64");
    return trustedKeys.some((key) => verify(null, canonical, key, bytes)) ? null : "no trusted key verifies the signature";
}

/** A manifest that is not signed by a trusted key, with why. */
export class ManifestSignatureError extends Error {
    constructor(readonly reason: string) {
        super(`the manifest is not accepted: ${reason}`);
        this.name = "ManifestSignatureError";
    }
}

/**
 * Reads a manifest and checks its signature against trusted Ed25519 keys:
 * what a host does before serving one. Texts or parsed values are accepted,
 * as read from `<slot>.json` and `<slot>.json.sig`. Throws
 * {@link ManifestSignatureError} with the reason.
 */
export function verifyManifest(manifest: unknown, signature: unknown, trustedKeyPems: readonly string[]): IManifest {
    const parsed = (typeof manifest === "string" ? JSON.parse(manifest) : manifest) as IManifest;
    const sig = typeof signature === "string" ? JSON.parse(signature) : signature;
    const problem = signatureProblem(parsed, sig, trustedKeysFrom(trustedKeyPems));
    if (problem) throw new ManifestSignatureError(problem);
    return parsed;
}

/** Reads PEM public keys, refusing anything but Ed25519. */
export function trustedKeysFrom(pems: readonly string[]): KeyObject[] {
    return pems.map((pem) => {
        const key = createPublicKey(pem);
        if (key.asymmetricKeyType !== "ed25519") throw new Error(`trusted keys are Ed25519, not ${key.asymmetricKeyType}`);
        return key;
    });
}

function isSignature(value: unknown): value is IManifestSignature {
    const s = value as Partial<IManifestSignature> | null;
    return typeof s === "object" && s !== null && s.alg === "Ed25519" && typeof s.manifest === "string" && typeof s.signature === "string";
}
