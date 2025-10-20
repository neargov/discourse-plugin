import { Effect } from "every-plugin/effect";
import { describe, expect, it } from "vitest";
import {
  DiscourseService,
  CryptoService,
  NEARService,
  NonceManager,
  LinkageStore,
} from "../../service";

describe("DiscourseService", () => {
  const service = new DiscourseService(
    "https://discuss.near.vote",
    "test-api-key",
    "system"
  );

  describe("generateAuthUrl", () => {
    it("should generate valid auth URL", async () => {
      const result = await Effect.runPromise(
        service.generateAuthUrl({
          clientId: "test-client",
          applicationName: "Test App",
          nonce: "test-nonce",
          publicKey:
            "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
        })
      );

      expect(result).toContain("https://discuss.near.vote/user-api-key/new");
      expect(result).toContain("client_id=test-client");
      expect(result).toContain("application_name=Test%20App");
      expect(result).toContain("nonce=test-nonce");
      expect(result).toContain("scopes=read%2Cwrite");
    });
  });
});

describe("CryptoService", () => {
  const service = new CryptoService();

  describe("generateKeyPair", () => {
    it("should generate RSA key pair", async () => {
      const result = await Effect.runPromise(service.generateKeyPair());

      expect(result.publicKey).toContain("BEGIN PUBLIC KEY");
      expect(result.privateKey).toContain("BEGIN PRIVATE KEY");
      expect(result.publicKey).not.toBe(result.privateKey);
    });
  });
});

describe("NonceManager", () => {
  const manager = new NonceManager();

  describe("create and verify", () => {
    it("should create and verify valid nonce", () => {
      const nonce = manager.create("test-client", "test-private-key");

      expect(nonce).toBeDefined();
      expect(typeof nonce).toBe("string");
      expect(nonce.length).toBeGreaterThan(0);

      const isValid = manager.verify(nonce, "test-client");
      expect(isValid).toBe(true);
    });

    it("should reject invalid nonce", () => {
      const isValid = manager.verify("invalid-nonce", "test-client");
      expect(isValid).toBe(false);
    });

    it("should reject mismatched client ID", () => {
      const nonce = manager.create("client-1", "test-key");
      const isValid = manager.verify(nonce, "client-2");
      expect(isValid).toBe(false);
    });
  });

  describe("get", () => {
    it("should retrieve nonce data", () => {
      const privateKey = "test-private-key-123";
      const clientId = "test-client";
      const nonce = manager.create(clientId, privateKey);

      const data = manager.get(nonce);
      expect(data).toBeDefined();
      expect(data?.clientId).toBe(clientId);
      expect(data?.privateKey).toBe(privateKey);
      expect(data?.timestamp).toBeDefined();
    });

    it("should return null for invalid nonce", () => {
      const data = manager.get("invalid-nonce");
      expect(data).toBeNull();
    });
  });

  describe("getPrivateKey", () => {
    it("should retrieve private key for valid nonce", () => {
      const privateKey = "test-private-key-123";
      const nonce = manager.create("test-client", privateKey);

      const retrieved = manager.getPrivateKey(nonce);
      expect(retrieved).toBe(privateKey);
    });

    it("should return null for invalid nonce", () => {
      const retrieved = manager.getPrivateKey("invalid-nonce");
      expect(retrieved).toBeNull();
    });
  });

  describe("consume", () => {
    it("should remove nonce after consumption", () => {
      const nonce = manager.create("test-client", "test-key");
      expect(manager.verify(nonce, "test-client")).toBe(true);

      manager.consume(nonce);
      expect(manager.verify(nonce, "test-client")).toBe(false);
    });
  });
});

describe("LinkageStore", () => {
  const store = new LinkageStore();

  describe("set and get", () => {
    it("should store and retrieve linkage", () => {
      const linkage = {
        nearAccount: "test.near",
        discourseUsername: "testuser",
        discourseUserId: 123,
        userApiKey: "test-api-key",
        verifiedAt: new Date().toISOString(),
      };

      store.set("test.near", linkage);
      const retrieved = store.get("test.near");

      expect(retrieved).toEqual(linkage);
    });

    it("should return null for non-existent account", () => {
      const retrieved = store.get("nonexistent.near");
      expect(retrieved).toBeNull();
    });

    it("should overwrite existing linkage", () => {
      const linkage1 = {
        nearAccount: "test.near",
        discourseUsername: "user1",
        discourseUserId: 1,
        userApiKey: "key1",
        verifiedAt: new Date().toISOString(),
      };

      const linkage2 = {
        nearAccount: "test.near",
        discourseUsername: "user2",
        discourseUserId: 2,
        userApiKey: "key2",
        verifiedAt: new Date().toISOString(),
      };

      store.set("test.near", linkage1);
      store.set("test.near", linkage2);

      const retrieved = store.get("test.near");
      expect(retrieved?.discourseUsername).toBe("user2");
    });
  });

  describe("getAll", () => {
    it("should return all linkages", () => {
      const store2 = new LinkageStore();

      const linkage1 = {
        nearAccount: "user1.near",
        discourseUsername: "user1",
        discourseUserId: 1,
        userApiKey: "key1",
        verifiedAt: new Date().toISOString(),
      };

      const linkage2 = {
        nearAccount: "user2.near",
        discourseUsername: "user2",
        discourseUserId: 2,
        userApiKey: "key2",
        verifiedAt: new Date().toISOString(),
      };

      store2.set("user1.near", linkage1);
      store2.set("user2.near", linkage2);

      const all = store2.getAll();
      expect(all).toHaveLength(2);
      expect(all).toContainEqual(linkage1);
      expect(all).toContainEqual(linkage2);
    });
  });
});
