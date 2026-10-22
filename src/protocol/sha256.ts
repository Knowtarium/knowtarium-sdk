// no DOM or Node types in the library: the one Web API this needs, typed here
interface WebCrypto {
  crypto?: { subtle?: { digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer> } };
}

/**
 * SHA-256 of ASCII text (the agent policy and agent scope hash inputs are all ASCII), as
 * lowercase hex. Uses Web Crypto (`crypto.subtle`), as browsers, Node and Workers all have it.
 * Throws a `TypeError` for text that isn't ASCII and an `Error` where Web Crypto is missing.
 */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = (globalThis as WebCrypto).crypto?.subtle;
  if (subtle === undefined) throw new Error("Web Crypto (crypto.subtle) is not available");
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) throw new TypeError("hash input must be ASCII");
    bytes[i] = code;
  }
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
