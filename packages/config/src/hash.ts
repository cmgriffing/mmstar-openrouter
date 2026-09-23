/**
 * SHA-256 helpers built on Web Crypto so the same hashing works in Bun, Node,
 * browsers, and worker runtimes without importing runtime-specific modules.
 */
export async function sha256Hex(data: string | ArrayBuffer | ArrayBufferView): Promise<string> {
  const bytes: Uint8Array =
    typeof data === "string" ? new TextEncoder().encode(data) : toBytes(data);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return hex(new Uint8Array(digest));
}

function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}
