/** Portable cryptography: standard WebCrypto primitives; no Node/browser imports. */
export const utf8 = new TextEncoder();
export const text = new TextDecoder();
export function base64(bytes: Uint8Array): string {
  let value = "";
  for (let i = 0; i < bytes.length; i += 8192)
    value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
}
export function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map((item) => canonical(item) ?? "null").join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonical((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}
export async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
/** Device names are app metadata. The cryptographic identity is managed by Keyhive. */
export interface Identity {
  id: string;
  name: string;
}
export type PublicIdentity = Identity;
export const publicIdentity = (identity: Identity): PublicIdentity => ({
  id: identity.id,
  name: identity.name,
});

export function fromHex(value: string): Uint8Array {
  if (!/^(?:[a-f0-9]{2})+$/.test(value))
    throw Error("Invalid hexadecimal identifier");
  return Uint8Array.from(value.match(/../g)!, (byte) => parseInt(byte, 16));
}
