import { Effect } from "every-plugin/effect";
import { generateKeyPairSync } from "crypto";
import JSEncrypt from "jsencrypt";
import { formatError } from "./utils";

type CryptoDecryptFn = (
  ciphertext: Buffer,
  privateKey: string
) => Buffer | string | ArrayBufferView | null | undefined;

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?){0,1}$/;

const defaultDecryptFn: CryptoDecryptFn = (ciphertext, privateKey) => {
  const decrypt = new JSEncrypt();
  decrypt.setPrivateKey(privateKey);
  const decrypted = decrypt.decrypt(ciphertext.toString("base64"));
  if (!decrypted) {
    throw new Error("Decryption failed");
  }
  return Buffer.from(decrypted, "utf-8");
};

const normalizeDecryptedValue = (value: unknown): Buffer => {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (typeof value === "string") {
    return Buffer.from(value, "utf-8");
  }

  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }

  throw new Error("Decryption produced empty result");
};

/**
 * Handles RSA key generation and decryption
 */
export class CryptoService {
  private readonly minCiphertextBytes: number;
  private readonly maxCiphertextBytes: number;

  constructor(
    private readonly decryptFn: CryptoDecryptFn = defaultDecryptFn,
    options: { minCiphertextBytes?: number; maxCiphertextBytes?: number } = {}
  ) {
    const min = options.minCiphertextBytes;
    const max = options.maxCiphertextBytes;
    this.minCiphertextBytes =
      typeof min === "number" && Number.isFinite(min) && min > 0 ? min : 64;
    this.maxCiphertextBytes =
      typeof max === "number" &&
      Number.isFinite(max) &&
      max > this.minCiphertextBytes
        ? max
        : 1024;
  }

  generateKeyPair() {
    return Effect.try(() => {
      const { publicKey, privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });

      return { publicKey, privateKey };
    });
  }

  /**
   * Decrypts a payload that was encrypted with the matching public key using
   * PKCS#1 v1.5 padding. Uses jsencrypt to avoid Node.js 18+ deprecation of
   * RSA_PKCS1_PADDING for private decryption.
   */
  decryptPayload(encryptedPayload: string, privateKey: string) {
    return Effect.try({
      try: () => {
        const normalizedPayload = encryptedPayload.replace(/\s+/g, "");
        const maxBase64Length = Math.ceil(this.maxCiphertextBytes / 3) * 4;

        if (normalizedPayload.length === 0) {
          throw new Error("invalid base64: empty payload");
        }

        if (normalizedPayload.length > maxBase64Length) {
          throw new Error("invalid base64: unexpected length");
        }

        if (!BASE64_PATTERN.test(normalizedPayload)) {
          throw new Error("invalid base64");
        }

        let ciphertext: Buffer;
        try {
          ciphertext = Buffer.from(normalizedPayload, "base64");
        } catch (error) {
          throw new Error(`invalid base64: ${formatError(error)}`);
        }

        if (ciphertext.length === 0) {
          throw new Error("invalid base64: empty payload");
        }

        if (
          ciphertext.length < this.minCiphertextBytes ||
          ciphertext.length > this.maxCiphertextBytes
        ) {
          throw new Error("invalid ciphertext: unexpected length");
        }

        let decryptedValue:
          | Buffer
          | string
          | ArrayBufferView
          | null
          | undefined;
        try {
          decryptedValue = this.decryptFn(ciphertext, privateKey);
        } catch (error) {
          throw new Error(`invalid ciphertext: ${formatError(error)}`);
        }

        const decrypted = normalizeDecryptedValue(decryptedValue);

        let data: any;
        try {
          data = JSON.parse(decrypted.toString("utf-8"));
        } catch (error) {
          throw new Error(`invalid JSON: ${formatError(error)}`);
        }

        if (typeof data.key !== "string" || !data.key.trim()) {
          throw new Error("Decryption produced empty result");
        }

        return data.key.trim();
      },
      catch: (error: unknown) =>
        new Error(`Decrypt failed: ${formatError(error)}`),
    });
  }
}
