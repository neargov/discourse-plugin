import { Effect } from "every-plugin/effect";
import { randomBytes, generateKeyPairSync } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { verify } from "near-sign-verify";
import type { z } from "every-plugin/zod";

// Import types from contract
import type { LinkageSchema } from "./contract";

// Infer types from schemas
type Linkage = z.infer<typeof LinkageSchema> & {
  discourseUserId: number;
  userApiKey: string;
};

const execAsync = promisify(exec);

/**
 * DiscourseService - Handles Discourse User API operations
 */
export class DiscourseService {
  constructor(
    private readonly baseUrl: string,
    private readonly systemApiKey: string,
    private readonly systemUsername: string
  ) {}

  generateAuthUrl(params: {
    clientId: string;
    applicationName: string;
    nonce: string;
    publicKey: string;
  }) {
    return Effect.try(() => {
      const publicKeyEncoded = encodeURIComponent(params.publicKey);
      const queryParams = [
        `client_id=${encodeURIComponent(params.clientId)}`,
        `application_name=${encodeURIComponent(params.applicationName)}`,
        `nonce=${encodeURIComponent(params.nonce)}`,
        `scopes=${encodeURIComponent("read,write")}`,
        `public_key=${publicKeyEncoded}`,
      ].join("&");

      return `${this.baseUrl}/user-api-key/new?${queryParams}`;
    });
  }

  getCurrentUser(userApiKey: string) {
    return Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${this.baseUrl}/session/current.json`, {
          headers: { "User-Api-Key": userApiKey },
        });

        if (!response.ok) {
          throw new Error(`Failed to get user: ${response.status}`);
        }

        const data = await response.json();
        const user = data.current_user;

        return {
          id: user.id as number,
          username: user.username as string,
          name: user.name as string,
        };
      },
      catch: (error: unknown) =>
        new Error(
          `Get user failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        ),
    });
  }

  createPost(params: {
    title: string;
    raw: string;
    category?: number;
    username: string;
  }) {
    return Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${this.baseUrl}/posts.json`, {
          method: "POST",
          headers: {
            "Api-Key": this.systemApiKey,
            "Api-Username": params.username,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: params.title,
            raw: params.raw,
            category: params.category,
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(
            `Discourse API error (posting as ${params.username}): ${response.status} - ${error}`
          );
        }

        const data = await response.json();
        return {
          id: data.id as number,
          topic_id: data.topic_id as number,
          topic_slug: data.topic_slug as string,
        };
      },
      catch: (error: unknown) =>
        new Error(
          `Create post failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        ),
    });
  }
}

/**
 * CryptoService - Handles RSA key generation and decryption
 */
export class CryptoService {
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

  decryptPayload(encryptedPayload: string, privateKey: string) {
    return Effect.tryPromise({
      try: async () => {
        const tempKeyPath = join(process.cwd(), `.temp-key-${Date.now()}.pem`);
        writeFileSync(tempKeyPath, privateKey);

        try {
          const { stdout, stderr } = await execAsync(
            `echo "${encryptedPayload}" | base64 -d | openssl pkeyutl -decrypt -inkey "${tempKeyPath}" -pkeyopt rsa_padding_mode:pkcs1`
          );

          if (stderr) {
            console.error("[CryptoService] Decryption stderr:", stderr);
          }

          if (!stdout || stdout.trim().length === 0) {
            throw new Error("Decryption produced empty result");
          }

          const data = JSON.parse(stdout.trim());
          return data.key as string;
        } finally {
          unlinkSync(tempKeyPath);
        }
      },
      catch: (error: unknown) =>
        new Error(
          `Decrypt failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        ),
    });
  }
}

/**
 * NEARService - Handles NEAR signature verification
 */
export class NEARService {
  constructor(private readonly recipient: string) {}

  verifySignature(authToken: string, nonceMaxAge: number = 600000) {
    return Effect.tryPromise({
      try: async () => {
        const result = await verify(authToken, {
          expectedRecipient: this.recipient,
          nonceMaxAge,
        });

        return result.accountId;
      },
      catch: (error: unknown) =>
        new Error(
          `NEAR verification failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        ),
    });
  }
}

/**
 * NonceManager - Manages temporary nonces with private keys
 */
export class NonceManager {
  private nonces = new Map<
    string,
    { clientId: string; privateKey: string; timestamp: number }
  >();
  private readonly TTL = 10 * 60 * 1000; // 10 minutes

  create(clientId: string, privateKey: string): string {
    const nonce = randomBytes(32).toString("hex");
    this.nonces.set(nonce, { clientId, privateKey, timestamp: Date.now() });
    return nonce;
  }

  get(
    nonce: string
  ): { clientId: string; privateKey: string; timestamp: number } | null {
    return this.nonces.get(nonce) || null;
  }

  verify(nonce: string, clientId: string): boolean {
    const data = this.nonces.get(nonce);
    if (!data) return false;
    if (Date.now() - data.timestamp > this.TTL) {
      this.nonces.delete(nonce);
      return false;
    }
    return data.clientId === clientId;
  }

  getPrivateKey(nonce: string): string | null {
    return this.nonces.get(nonce)?.privateKey || null;
  }

  consume(nonce: string): void {
    this.nonces.delete(nonce);
  }

  cleanup(): void {
    const now = Date.now();
    for (const [nonce, data] of this.nonces.entries()) {
      if (now - data.timestamp > this.TTL) {
        this.nonces.delete(nonce);
      }
    }
  }
}

/**
 * LinkageStore - Stores NEAR account to Discourse user mappings
 */
export class LinkageStore {
  private linkages = new Map<string, Linkage>();

  set(nearAccount: string, linkage: Linkage): void {
    this.linkages.set(nearAccount, linkage);
  }

  get(nearAccount: string): Linkage | null {
    return this.linkages.get(nearAccount) || null;
  }

  getAll(): Linkage[] {
    return Array.from(this.linkages.values());
  }
}
