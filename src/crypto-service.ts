import { Effect } from "every-plugin/effect";
import { generateKeyPairSync, privateDecrypt, constants } from "crypto";
import { formatError } from "./utils";

/**
 * CryptoService - Handles RSA key generation and decryption
 */
export class CryptoService {
  private readonly minCiphertextBytes: number;
  private readonly maxCiphertextBytes: number;

  constructor(
    private readonly decryptFn = privateDecrypt,
    options: { minCiphertextBytes?: number; maxCiphertextBytes?: number } = {}
  ) {
    const min = options.minCiphertextBytes;
    const max = options.maxCiphertextBytes;
    this.minCiphertextBytes =
      typeof min === "number" && Number.isFinite(min) && min > 0 ? min : 64;
    this.maxCiphertextBytes =
      typeof max === "number" && Number.isFinite(max) && max > this.minCiphertextBytes
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
   * RSA_PKCS1_PADDING. Callers must encrypt with the same padding and a 2048-bit
   * key; ciphertext must be base64-encoded PKCS#1 v1.5 block containing JSON
   * with a `key` field.
   */
  decryptPayload(encryptedPayload: string, privateKey: string) {
    return Effect.tryPromise({
      try: async () => {
        const normalizedPayload = encryptedPayload.trim();
        const maxBase64Length = Math.ceil(this.maxCiphertextBytes / 3) * 4;

        if (normalizedPayload.length > maxBase64Length) {
          throw new Error("invalid base64: unexpected length");
        }

        let decoded: Buffer;
        try {
          decoded = Buffer.from(normalizedPayload, "base64");
        } catch (error) {
          throw new Error(
            `invalid base64: ${formatError(error)}`
          );
        }

        if (decoded.length === 0) {
          throw new Error("invalid base64: empty payload");
        }

        if (
          decoded.length < this.minCiphertextBytes ||
          decoded.length > this.maxCiphertextBytes
        ) {
          throw new Error("invalid ciphertext: unexpected length");
        }

        let decrypted: Buffer;
        try {
          decrypted = this.decryptFn(
            {
              key: privateKey,
              padding: constants.RSA_PKCS1_PADDING,
            },
            decoded
          );
        } catch (error) {
          throw new Error(
            `invalid ciphertext: ${formatError(error)}`
          );
        }

        let data: any;
        try {
          data = JSON.parse(decrypted.toString("utf-8"));
        } catch (error) {
          throw new Error(
            `invalid JSON: ${formatError(error)}`
          );
        }

        if (typeof data.key !== "string" || !data.key.trim()) {
          throw new Error("Decryption produced empty result");
        }

        const key = data.key.trim();
        return key;
      },
      catch: (error: unknown) =>
        new Error(
          `Decrypt failed: ${
            formatError(error)
          }`
        ),
    });
  }
}
