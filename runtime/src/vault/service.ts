import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  CreateCredentialRequest,
  CreateVaultRequest,
  CredentialInfo,
  CredentialSelection,
  HostModelProviderInfo,
  HostModelView,
  PutHostModelRequest,
  RotateCredentialRequest,
  SelectHostModelRequest,
  VaultInfo,
} from "@nylorun/core/contracts";
import { canonical } from "../core/store.js";
import {
  decryptSecret,
  encryptSecret,
  VaultCryptoError,
} from "./crypto.js";
import { VaultError } from "./error.js";
import { hostModelCatalog } from "../model/catalog.js";
import { normalizeVaultUrl } from "./url.js";

const REFRESH_SKEW_MS = 60_000;
const HOST_VAULT_ID = "host";
const HOST_MODEL_ID = "host-model";

export type HostModelSecret = {
  provider: string;
  model: string;
  baseUrl?: string;
  authType: "api_key" | "oauth";
  credential: {
    type: "api_key" | "oauth";
    key?: string;
    env?: Record<string, string>;
    refresh?: string;
    access?: string;
    expires?: number;
    [key: string]: unknown;
  };
};

type SecretPayload = {
  token?: string;
  accessToken?: string;
  refreshToken?: string;
  clientSecret?: string;
  tokenEndpoint?: string;
  clientId?: string;
  tokenEndpointAuth?: "none" | "client_secret_basic" | "client_secret_post";
};

type CredentialRow = {
  id: string;
  vault_id: string;
  name: string;
  type: "bearer" | "oauth" | "model";
  binding_json: string;
  expires_at: string | null;
  created_at: string;
  rotated_at: string | null;
  kek_id: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  wrapped_dek: Uint8Array;
};

export type AuthorizeResult =
  | {
      status: "unauthenticated";
      url: string;
      headers: Record<string, string>;
    }
  | {
      status: "authorized";
      url: string;
      headers: { authorization: string };
    }
  | {
      status: "refused";
      url: string;
      credentialIds: string[];
      reason: string;
    };

export class VaultService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tx: <T>(fn: () => T) => T,
    private readonly kek: () => Buffer,
    private readonly fetchImpl: typeof fetch,
  ) {}

  createVault(body: CreateVaultRequest): VaultInfo {
    return this.tx(() =>
      this.replay(`create-vault:${body.idempotencyKey}`, body, () => {
        const now = new Date().toISOString();
        const id = randomUUID();
        this.db
          .prepare(
            `INSERT INTO vaults(id,name,owner_user_id,metadata_json,created_at) VALUES(?,?,?,?,?)`,
          )
          .run(
            id,
            body.name,
            body.ownerUserId,
            body.metadata ? JSON.stringify(body.metadata) : null,
            now,
          );
        const info = this.vaultInfo(id);
        this.audit({
          actor: "application",
          action: "create",
          vaultId: id,
          outcome: "created",
        });
        return info;
      }),
    );
  }

  listVaults(ownerUserId: string): VaultInfo[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM vaults WHERE owner_user_id=? AND scope='user' ORDER BY created_at, id`,
      )
      .all(ownerUserId) as { id: string }[];
    return rows.map((row) => this.vaultInfo(row.id));
  }

  getVault(id: string): VaultInfo {
    return this.vaultInfo(id);
  }

  deleteVault(id: string): { id: string } {
    return this.tx(() => {
      this.vaultInfo(id);
      const credentials = this.db
        .prepare(`SELECT id FROM vault_credentials WHERE vault_id=?`)
        .all(id) as { id: string }[];
      for (const credential of credentials) {
        this.audit({
          actor: "application",
          action: "delete",
          vaultId: id,
          credentialId: credential.id,
          outcome: "deleted",
        });
      }
      this.db.prepare(`DELETE FROM vault_credentials WHERE vault_id=?`).run(id);
      this.db.prepare(`DELETE FROM vaults WHERE id=?`).run(id);
      this.audit({
        actor: "application",
        action: "delete",
        vaultId: id,
        outcome: "deleted",
      });
      return { id };
    });
  }

  createCredential(
    vaultId: string,
    body: CreateCredentialRequest,
  ): CredentialInfo {
    return this.tx(() =>
      this.replay(
        `create-credential:${vaultId}:${body.idempotencyKey}`,
        body,
        () => {
          this.vaultInfo(vaultId);
          const id = randomUUID();
          const url = normalizeVaultUrl(body.auth.url);
          const payload = payloadFromCreate(body);
          this.insertCredential({
            id,
            vaultId,
            name: body.name,
            type: body.auth.type,
            url,
            expiresAt: expiresFromCreate(body),
            payload,
            rotatedAt: null,
          });
          this.audit({
            actor: "application",
            action: "create",
            vaultId,
            credentialId: id,
            outcome: "created",
          });
          return this.credentialInfo(vaultId, id);
        },
      ),
    );
  }

  listCredentials(vaultId: string): CredentialInfo[] {
    this.vaultInfo(vaultId);
    const rows = this.db
      .prepare(
        `SELECT id FROM vault_credentials WHERE vault_id=? ORDER BY created_at, id`,
      )
      .all(vaultId) as { id: string }[];
    return rows.map((row) => this.credentialInfo(vaultId, row.id));
  }

  getCredential(vaultId: string, id: string): CredentialInfo {
    return this.credentialInfo(vaultId, id);
  }

  rotateCredential(
    vaultId: string,
    id: string,
    body: RotateCredentialRequest,
  ): CredentialInfo {
    return this.tx(() =>
      this.replay(
        `rotate:${vaultId}:${id}:${body.idempotencyKey}`,
        body,
        () => {
          const row = this.credentialRow(vaultId, id);
          if (row.type !== body.auth.type)
            throw new VaultError(409, "Credential type cannot change");
          const current = this.readPayload(row);
          const next: SecretPayload = { ...current };
          let expiresAt = row.expires_at;
          if (body.auth.type === "bearer") next.token = body.auth.token;
          else {
            next.accessToken = body.auth.accessToken;
            expiresAt =
              body.auth.expiresAt === undefined || body.auth.expiresAt === null
                ? null
                : requireTimestamp(body.auth.expiresAt);
          }
          this.writePayload(row, next, expiresAt, new Date().toISOString());
          this.audit({
            actor: "application",
            action: "rotate",
            vaultId,
            credentialId: id,
            outcome: "rotated",
          });
          return this.credentialInfo(vaultId, id);
        },
      ),
    );
  }

  deleteCredential(vaultId: string, id: string): { id: string } {
    return this.tx(() => {
      this.credentialRow(vaultId, id);
      this.db
        .prepare(`DELETE FROM vault_credentials WHERE id=? AND vault_id=?`)
        .run(id, vaultId);
      this.audit({
        actor: "application",
        action: "delete",
        vaultId,
        credentialId: id,
        outcome: "deleted",
      });
      return { id };
    });
  }

  assertAttachment(
    ownerUserId: string,
    vaultIds: readonly string[],
    selections: readonly CredentialSelection[],
  ): void {
    if (new Set(vaultIds).size !== vaultIds.length)
      throw new VaultError(400, "Duplicate vault id");
    if (new Set(selections.map((item) => item.serverName)).size !== selections.length)
      throw new VaultError(400, "Duplicate credential selection");
    for (const id of vaultIds) {
      const vault = this.vaultRow(id);
      if (!vault) throw new VaultError(404, "Vault not found");
      if (vault.scope === "host")
        throw new VaultError(400, "Host vault cannot be attached to a session");
      if (vault.owner_user_id !== ownerUserId)
        throw new VaultError(403, "Vault belongs to another user");
    }
    for (const selection of selections) {
      const row = this.db
        .prepare(`SELECT vault_id FROM vault_credentials WHERE id=?`)
        .get(selection.credentialId) as { vault_id: string } | undefined;
      if (!row || !vaultIds.includes(row.vault_id))
        throw new VaultError(400, "Credential is not in an attached vault");
    }
  }

  recordAttachment(sessionId: string, vaultIds: readonly string[]): void {
    this.audit({
      actor: "application",
      action: "attach",
      sessionId,
      target: vaultIds.join(","),
      outcome: "attached",
    });
  }

  async authorize(input: {
    sessionId: string;
    vaultIds: readonly string[];
    credentialSelections: readonly CredentialSelection[];
    url: string;
    serverName?: string;
  }): Promise<AuthorizeResult> {
    const url = normalizeVaultUrl(input.url);
    const missing = input.vaultIds.filter((id) => !this.vaultRow(id));
    if (missing.length > 0) {
      this.audit({
        actor: "host",
        action: "use",
        sessionId: input.sessionId,
        target: url,
        outcome: "refused",
      });
      return {
        status: "refused",
        url,
        credentialIds: [],
        reason: "vault_missing",
      };
    }
    const matches = input.vaultIds
      .flatMap((vaultId) => this.rowsForVault(vaultId))
      .filter((row) => JSON.parse(row.binding_json).url === url)
      .sort((a, b) => a.id.localeCompare(b.id));
    const selection = input.serverName
      ? input.credentialSelections.find(
          (item) => item.serverName === input.serverName,
        )
      : undefined;
    if (matches.length === 0)
      return { status: "unauthenticated", url, headers: {} };
    const chosen = choose(matches, selection);
    if (chosen.kind === "refused") {
      this.audit({
        actor: "host",
        action: "use",
        sessionId: input.sessionId,
        target: url,
        outcome: "refused",
      });
      return {
        status: "refused",
        url,
        credentialIds: chosen.credentialIds,
        reason: chosen.reason,
      };
    }
    let row = chosen.row;
    let payload: SecretPayload;
    try {
      payload = this.readPayload(row);
    } catch (error) {
      if (!(error instanceof VaultCryptoError)) throw error;
      this.audit({
        actor: "host",
        action: "use",
        vaultId: row.vault_id,
        credentialId: row.id,
        sessionId: input.sessionId,
        target: url,
        outcome: "refused",
      });
      return {
        status: "refused",
        url,
        credentialIds: [row.id],
        reason: "unreadable",
      };
    }
    if (row.type === "oauth" && dueForRefresh(row.expires_at)) {
      const refreshed = await this.refresh(row, payload, input.sessionId, url);
      if (refreshed.status === "refused") return refreshed;
      row = this.credentialRow(row.vault_id, row.id);
      payload = refreshed.payload;
    }
    const token = row.type === "bearer" ? payload.token : payload.accessToken;
    if (!token) {
      return {
        status: "refused",
        url,
        credentialIds: [row.id],
        reason: "unreadable",
      };
    }
    this.audit({
      actor: "host",
      action: "use",
      vaultId: row.vault_id,
      credentialId: row.id,
      sessionId: input.sessionId,
      target: url,
      outcome: "approved",
    });
    return {
      status: "authorized",
      url,
      headers: { authorization: `Bearer ${token}` },
    };
  }

  getHostModel(): HostModelView {
    const row = this.activeHostCredentialRow();
    if (!row) return { configured: false };
    const binding = modelBinding(row);
    return {
      configured: true,
      provider: binding.provider,
      model: binding.model,
      authType: binding.authType,
      ...(binding.baseUrl ? { baseUrl: binding.baseUrl } : {}),
    };
  }

  listHostProviders(): { providers: HostModelProviderInfo[] } {
    const active = this.activeProviderId();
    const catalog = new Map(
      hostModelCatalog().providers.map((provider) => [provider.id, provider.name]),
    );
    const providers = this.hostModelRows().map((row) => {
      const binding = modelBinding(row);
      return {
        id: binding.provider,
        name:
          catalog.get(binding.provider) ??
          (binding.provider === "custom"
            ? "Custom OpenAI-compatible"
            : binding.provider),
        model: binding.model,
        authType: binding.authType,
        ...(binding.baseUrl ? { baseUrl: binding.baseUrl } : {}),
        lastUpdated: row.rotated_at ?? row.created_at,
        active: binding.provider === active,
      };
    });
    providers.sort((left, right) => left.name.localeCompare(right.name));
    return { providers };
  }

  putHostModel(body: PutHostModelRequest): HostModelView {
    return this.tx(() =>
      this.replay(`host-model:${body.idempotencyKey}`, body, () => {
        this.validateHostModel(body);
        this.ensureHostVault();
        const credentialId = hostModelCredentialId(body.provider);
        this.deleteHostProviderRows(body.provider);
        const payload =
          body.auth.type === "api_key"
            ? {
                apiKey: body.auth.key,
                ...(body.auth.env ? { env: body.auth.env } : {}),
              }
            : { oauth: body.auth };
        this.insertHostCredential({
          id: credentialId,
          provider: body.provider,
          model: body.model,
          baseUrl: body.baseUrl,
          authType: body.auth.type,
          payload,
        });
        this.setActiveProvider(body.provider);
        this.audit({
          actor: "application",
          action: "rotate",
          vaultId: HOST_VAULT_ID,
          credentialId,
          outcome: "rotated",
        });
        return this.getHostModel();
      }),
    );
  }

  selectHostModel(body: SelectHostModelRequest): HostModelView {
    return this.tx(() =>
      this.replay(`host-model-select:${body.idempotencyKey}`, body, () => {
        this.validateHostModel(body);
        const row = this.hostCredentialRowFor(body.provider);
        if (!row)
          throw new VaultError(404, "Model provider is not configured");
        const binding = modelBinding(row);
        const payload = this.readHostPayload(row, binding);
        const credentialId = hostModelCredentialId(body.provider);
        this.deleteHostProviderRows(body.provider);
        this.insertHostCredential({
          id: credentialId,
          provider: body.provider,
          model: body.model,
          baseUrl: body.baseUrl,
          authType: binding.authType,
          payload,
        });
        this.setActiveProvider(body.provider);
        this.audit({
          actor: "application",
          action: "rotate",
          vaultId: HOST_VAULT_ID,
          credentialId,
          outcome: "rotated",
        });
        return this.getHostModel();
      }),
    );
  }

  readHostModel(): HostModelSecret | undefined {
    const row = this.activeHostCredentialRow();
    if (!row) return undefined;
    const binding = modelBinding(row);
    const payload = this.readHostPayload(row, binding);
    const credential =
      binding.authType === "oauth"
        ? { type: "oauth" as const, ...payload.oauth }
        : {
            type: "api_key" as const,
            key: payload.apiKey,
            ...(payload.env ? { env: payload.env } : {}),
          };
    return {
      provider: binding.provider,
      model: binding.model,
      ...(binding.baseUrl ? { baseUrl: binding.baseUrl } : {}),
      authType: binding.authType,
      credential,
    };
  }

  updateHostCredential(credential: {
    type: "api_key" | "oauth";
    key?: string;
    env?: Record<string, string>;
    refresh?: string;
    access?: string;
    expires?: number;
  }): void {
    this.tx(() => {
      const row = this.activeHostCredentialRow();
      if (!row) throw new VaultError(404, "Model provider is not configured");
      const binding = modelBinding(row);
      const payload =
        credential.type === "oauth"
          ? { oauth: credential }
          : {
              apiKey: credential.key,
              ...(credential.env ? { env: credential.env } : {}),
            };
      const aad = hostModelAad(binding.provider, binding.model);
      const sealed = encryptSecret(
        this.kek(),
        aad,
        Buffer.from(JSON.stringify(payload), "utf8"),
      );
      this.db
        .prepare(
          `UPDATE vault_credentials
           SET type='model', binding_json=?, kek_id=?, nonce=?, ciphertext=?, wrapped_dek=?, rotated_at=?
           WHERE id=?`,
        )
        .run(
          JSON.stringify({ ...binding, authType: credential.type }),
          sealed.kekId,
          sealed.nonce,
          sealed.ciphertext,
          sealed.wrappedDek,
          new Date().toISOString(),
          row.id,
        );
    });
  }

  reject(route: string): void {
    this.audit({
      actor: "executor",
      action: "reject",
      target: route,
      outcome: "rejected",
    });
  }

  private async refresh(
    row: CredentialRow,
    payload: SecretPayload,
    sessionId: string,
    url: string,
  ): Promise<
    | { status: "ok"; payload: SecretPayload }
    | Extract<AuthorizeResult, { status: "refused" }>
  > {
    const failRefresh = (): Extract<AuthorizeResult, { status: "refused" }> => {
      this.audit({
        actor: "host",
        action: "refresh",
        vaultId: row.vault_id,
        credentialId: row.id,
        sessionId,
        target: payload.tokenEndpoint,
        outcome: "refresh_failed",
      });
      return {
        status: "refused",
        url,
        credentialIds: [row.id],
        reason: "refresh_failed",
      };
    };
    if (!payload.refreshToken || !payload.tokenEndpoint || !payload.clientId)
      return failRefresh();
    try {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: payload.refreshToken,
        client_id: payload.clientId,
      });
      const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
      };
      if (payload.tokenEndpointAuth === "client_secret_post") {
        if (!payload.clientSecret) return failRefresh();
        body.set("client_secret", payload.clientSecret);
      }
      if (payload.tokenEndpointAuth === "client_secret_basic") {
        if (!payload.clientSecret) return failRefresh();
        const encoded = Buffer.from(
          `${encodeURIComponent(payload.clientId)}:${encodeURIComponent(payload.clientSecret)}`,
        ).toString("base64");
        headers.authorization = `Basic ${encoded}`;
      }
      const response = await this.fetchImpl(payload.tokenEndpoint, {
        method: "POST",
        headers,
        body: body.toString(),
        redirect: "error",
      });
      if (!response.ok) return failRefresh();
      const json = (await response.json()) as {
        access_token?: unknown;
        expires_in?: unknown;
        refresh_token?: unknown;
      };
      if (typeof json.access_token !== "string" || json.access_token.length === 0)
        return failRefresh();
      const next: SecretPayload = {
        ...payload,
        accessToken: json.access_token,
        refreshToken:
          typeof json.refresh_token === "string"
            ? json.refresh_token
            : payload.refreshToken,
      };
      const expiresAt =
        typeof json.expires_in === "number" && Number.isFinite(json.expires_in)
          ? new Date(Date.now() + json.expires_in * 1000).toISOString()
          : null;
      this.tx(() => {
        const current = this.credentialRow(row.vault_id, row.id);
        this.writePayload(current, next, expiresAt, new Date().toISOString());
        this.audit({
          actor: "host",
          action: "refresh",
          vaultId: row.vault_id,
          credentialId: row.id,
          sessionId,
          target: payload.tokenEndpoint,
          outcome: "approved",
        });
      });
      return { status: "ok", payload: next };
    } catch {
      return failRefresh();
    }
  }

  private replay<T>(key: string, body: unknown, create: () => T): T {
    const hash = createHash("sha256")
      .update(requestHash(body))
      .digest("hex");
    const existing = this.db
      .prepare(`SELECT body_hash, response FROM vault_idempotency WHERE id=?`)
      .get(key) as { body_hash: string; response: string } | undefined;
    if (existing) {
      if (existing.body_hash !== hash)
        throw new VaultError(409, "Idempotency key already binds another request");
      return JSON.parse(existing.response) as T;
    }
    const created = create();
    this.db
      .prepare(
        `INSERT INTO vault_idempotency(id, body_hash, response) VALUES(?,?,?)`,
      )
      .run(key, hash, JSON.stringify(created));
    return created;
  }

  private insertCredential(input: {
    id: string;
    vaultId: string;
    name: string;
    type: "bearer" | "oauth";
    url: string;
    expiresAt: string | null;
    payload: SecretPayload;
    rotatedAt: string | null;
  }): void {
    const aad = credentialAad(input.vaultId, input.id, input.type, input.url);
    const sealed = encryptSecret(
      this.kek(),
      aad,
      Buffer.from(JSON.stringify(input.payload), "utf8"),
    );
    this.db
      .prepare(
        `INSERT INTO vault_credentials(
          id, vault_id, name, type, binding_json, expires_at, created_at, rotated_at,
          kek_id, nonce, ciphertext, wrapped_dek
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        input.vaultId,
        input.name,
        input.type,
        JSON.stringify({ url: input.url }),
        input.expiresAt,
        new Date().toISOString(),
        input.rotatedAt,
        sealed.kekId,
        sealed.nonce,
        sealed.ciphertext,
        sealed.wrappedDek,
      );
  }

  private writePayload(
    row: CredentialRow,
    payload: SecretPayload,
    expiresAt: string | null,
    rotatedAt: string,
  ): void {
    const url = JSON.parse(row.binding_json).url as string;
    const aad = credentialAad(row.vault_id, row.id, row.type, url);
    const sealed = encryptSecret(
      this.kek(),
      aad,
      Buffer.from(JSON.stringify(payload), "utf8"),
    );
    this.db
      .prepare(
        `UPDATE vault_credentials
         SET expires_at=?, rotated_at=?, kek_id=?, nonce=?, ciphertext=?, wrapped_dek=?
         WHERE id=?`,
      )
      .run(
        expiresAt,
        rotatedAt,
        sealed.kekId,
        sealed.nonce,
        sealed.ciphertext,
        sealed.wrappedDek,
        row.id,
      );
  }

  private readPayload(row: CredentialRow): SecretPayload {
    const url = JSON.parse(row.binding_json).url as string;
    const aad = credentialAad(row.vault_id, row.id, row.type, url);
    const plaintext = decryptSecret(
      this.kek(),
      aad,
      Buffer.from(row.nonce),
      Buffer.from(row.ciphertext),
      Buffer.from(row.wrapped_dek),
      row.kek_id,
    );
    try {
      return JSON.parse(plaintext.toString("utf8")) as SecretPayload;
    } finally {
      plaintext.fill(0);
    }
  }

  private vaultInfo(id: string): VaultInfo {
    const row = this.vaultRow(id);
    if (!row || row.scope === "host") throw new VaultError(404, "Vault not found");
    return {
      id: row.id,
      name: row.name,
      ownerUserId: row.owner_user_id,
      ...(row.metadata_json
        ? { metadata: JSON.parse(row.metadata_json) as Record<string, string> }
        : {}),
      createdAt: row.created_at,
    };
  }

  private vaultRow(id: string):
    | {
        id: string;
        name: string;
        owner_user_id: string;
        metadata_json: string | null;
        created_at: string;
        scope: "user" | "host";
      }
    | undefined {
    return this.db
      .prepare(
        `SELECT id, name, owner_user_id, metadata_json, created_at, scope FROM vaults WHERE id=?`,
      )
      .get(id) as
      | {
          id: string;
          name: string;
          owner_user_id: string;
          metadata_json: string | null;
          created_at: string;
          scope: "user" | "host";
        }
      | undefined;
  }

  private ensureHostVault(): void {
    const existing = this.vaultRow(HOST_VAULT_ID);
    if (existing?.scope === "host") return;
    if (existing) throw new VaultError(409, "Host vault id is already used");
    this.db
      .prepare(
        `INSERT INTO vaults(id,name,owner_user_id,metadata_json,created_at,scope) VALUES(?,?,?,?,?,?)`,
      )
      .run(
        HOST_VAULT_ID,
        "Host",
        "host",
        null,
        new Date().toISOString(),
        "host",
      );
  }

  private validateHostModel(body: {
    provider: string;
    model: string;
    baseUrl?: string;
  }): void {
    if (body.provider === "custom") {
      if (!body.baseUrl)
        throw new VaultError(
          400,
          "A base URL is required for a custom provider.",
        );
      let url: URL;
      try {
        url = new URL(body.baseUrl);
      } catch {
        throw new VaultError(400, "Base URL must be an HTTP(S) URL.");
      }
      if (!["http:", "https:"].includes(url.protocol))
        throw new VaultError(400, "Base URL must be an HTTP(S) URL.");
      return;
    }
    if (body.baseUrl)
      throw new VaultError(
        400,
        "A base URL is only valid for a custom provider.",
      );
    const provider = hostModelCatalog().providers.find(
      (item) => item.id === body.provider,
    );
    if (!provider) throw new VaultError(400, "Unknown model provider.");
    if (!provider.models.some((item) => item.id === body.model))
      throw new VaultError(400, "Unknown model.");
  }

  private insertHostCredential(input: {
    id: string;
    provider: string;
    model: string;
    baseUrl?: string;
    authType: "api_key" | "oauth";
    payload: HostSecretPayload;
  }): void {
    const aad = hostModelAad(input.provider, input.model);
    const sealed = encryptSecret(
      this.kek(),
      aad,
      Buffer.from(JSON.stringify(input.payload), "utf8"),
    );
    this.db
      .prepare(
        `INSERT INTO vault_credentials(
          id, vault_id, name, type, binding_json, expires_at, created_at, rotated_at,
          kek_id, nonce, ciphertext, wrapped_dek
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        HOST_VAULT_ID,
        input.provider,
        "model",
        JSON.stringify({
          provider: input.provider,
          model: input.model,
          ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
          authType: input.authType,
        }),
        null,
        new Date().toISOString(),
        null,
        sealed.kekId,
        sealed.nonce,
        sealed.ciphertext,
        sealed.wrappedDek,
      );
  }

  private readHostPayload(
    row: CredentialRow,
    binding: ModelBinding,
  ): HostSecretPayload {
    const plaintext = decryptSecret(
      this.kek(),
      hostModelAad(binding.provider, binding.model),
      Buffer.from(row.nonce),
      Buffer.from(row.ciphertext),
      Buffer.from(row.wrapped_dek),
      row.kek_id,
    );
    try {
      return JSON.parse(plaintext.toString("utf8")) as HostSecretPayload;
    } finally {
      plaintext.fill(0);
    }
  }

  private hostModelRows(): CredentialRow[] {
    return (
      this.db
        .prepare(
          `SELECT id, vault_id, name, type, binding_json, expires_at, created_at, rotated_at,
                  kek_id, nonce, ciphertext, wrapped_dek
           FROM vault_credentials WHERE vault_id=? AND type='model'
           ORDER BY created_at, id`,
        )
        .all(HOST_VAULT_ID) as CredentialRow[]
    ).filter((row) => {
      try {
        modelBinding(row);
        return true;
      } catch {
        return false;
      }
    });
  }

  private hostCredentialRowFor(provider: string): CredentialRow | undefined {
    const preferred = hostModelCredentialId(provider);
    const rows = this.hostModelRows();
    return (
      rows.find((row) => row.id === preferred) ??
      rows.find((row) => modelBinding(row).provider === provider)
    );
  }

  private activeHostCredentialRow(): CredentialRow | undefined {
    const active = this.activeProviderId();
    if (!active) return undefined;
    return this.hostCredentialRowFor(active);
  }

  private activeProviderId(): string | undefined {
    const vault = this.vaultRow(HOST_VAULT_ID);
    if (vault?.metadata_json) {
      try {
        const metadata = JSON.parse(vault.metadata_json) as {
          activeProvider?: unknown;
        };
        if (
          typeof metadata.activeProvider === "string" &&
          metadata.activeProvider &&
          this.hostCredentialRowFor(metadata.activeProvider)
        )
          return metadata.activeProvider;
      } catch {
        /* Fall through to the only configured provider. */
      }
    }
    const rows = this.hostModelRows();
    if (rows.length === 0) return undefined;
    if (rows.length === 1) return modelBinding(rows[0]!).provider;
    const legacy = rows.find((row) => row.id === HOST_MODEL_ID);
    if (legacy) return modelBinding(legacy).provider;
    return modelBinding(rows[0]!).provider;
  }

  private setActiveProvider(provider: string): void {
    this.ensureHostVault();
    this.db
      .prepare(`UPDATE vaults SET metadata_json=? WHERE id=?`)
      .run(JSON.stringify({ activeProvider: provider }), HOST_VAULT_ID);
  }

  private deleteHostProviderRows(provider: string): void {
    const ids = this.hostModelRows()
      .filter((row) => modelBinding(row).provider === provider)
      .map((row) => row.id);
    ids.push(hostModelCredentialId(provider));
    for (const id of new Set(ids))
      this.db
        .prepare(`DELETE FROM vault_credentials WHERE id=? AND vault_id=?`)
        .run(id, HOST_VAULT_ID);
  }

  private credentialInfo(vaultId: string, id: string): CredentialInfo {
    const row = this.credentialRow(vaultId, id);
    return {
      id: row.id,
      vaultId: row.vault_id,
      name: row.name,
      type: row.type,
      binding: JSON.parse(row.binding_json) as { url: string },
      ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
      createdAt: row.created_at,
      ...(row.rotated_at ? { rotatedAt: row.rotated_at } : {}),
    };
  }

  private credentialRow(
    vaultId: string,
    id: string,
  ): CredentialRow & { type: "bearer" | "oauth" } {
    const row = this.db
      .prepare(
        `SELECT id, vault_id, name, type, binding_json, expires_at, created_at, rotated_at,
                kek_id, nonce, ciphertext, wrapped_dek
         FROM vault_credentials WHERE id=? AND vault_id=?`,
      )
      .get(id, vaultId) as CredentialRow | undefined;
    if (!row || row.type === "model")
      throw new VaultError(404, "Credential not found");
    return row as CredentialRow & { type: "bearer" | "oauth" };
  }

  private rowsForVault(vaultId: string): CredentialRow[] {
    return this.db
      .prepare(
        `SELECT id, vault_id, name, type, binding_json, expires_at, created_at, rotated_at,
                kek_id, nonce, ciphertext, wrapped_dek
         FROM vault_credentials WHERE vault_id=?`,
      )
      .all(vaultId) as CredentialRow[];
  }

  private audit(entry: {
    actor: string;
    action: string;
    outcome: string;
    vaultId?: string;
    credentialId?: string;
    sessionId?: string;
    target?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO vault_audit(id, at, actor, action, vault_id, credential_id, session_id, target, outcome)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        new Date().toISOString(),
        entry.actor,
        entry.action,
        entry.vaultId ?? null,
        entry.credentialId ?? null,
        entry.sessionId ?? null,
        entry.target ?? null,
        entry.outcome,
      );
  }
}

function choose(
  matches: CredentialRow[],
  selection: CredentialSelection | undefined,
):
  | { kind: "use"; row: CredentialRow }
  | { kind: "refused"; credentialIds: string[]; reason: string } {
  const ids = matches.map((row) => row.id);
  if (matches.length === 1) {
    const only = matches[0]!;
    if (selection && selection.credentialId !== only.id)
      return {
        kind: "refused",
        credentialIds: ids,
        reason: "selection_mismatch",
      };
    return { kind: "use", row: only };
  }
  if (!selection)
    return { kind: "refused", credentialIds: ids, reason: "ambiguous" };
  const chosen = matches.find((row) => row.id === selection.credentialId);
  if (!chosen)
    return {
      kind: "refused",
      credentialIds: ids,
      reason: "selection_mismatch",
    };
  return { kind: "use", row: chosen };
}

function dueForRefresh(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return Date.parse(expiresAt) - Date.now() <= REFRESH_SKEW_MS;
}

function payloadFromCreate(body: CreateCredentialRequest): SecretPayload {
  if (body.auth.type === "bearer") return { token: body.auth.token };
  const refresh = body.auth.refresh;
  const tokenEndpoint = refresh
    ? normalizeVaultUrl(refresh.tokenEndpoint, { httpsOnly: true })
    : undefined;
  if (body.auth.expiresAt) requireTimestamp(body.auth.expiresAt);
  return {
    accessToken: body.auth.accessToken,
    ...(refresh
      ? {
          refreshToken: refresh.refreshToken,
          tokenEndpoint,
          clientId: refresh.clientId,
          tokenEndpointAuth: refresh.tokenEndpointAuth.type,
          ...(refresh.tokenEndpointAuth.type === "none"
            ? {}
            : { clientSecret: refresh.tokenEndpointAuth.clientSecret }),
        }
      : {}),
  };
}

function expiresFromCreate(body: CreateCredentialRequest): string | null {
  if (body.auth.type !== "oauth" || !body.auth.expiresAt) return null;
  return requireTimestamp(body.auth.expiresAt);
}

function requireTimestamp(value: string): string {
  if (Number.isNaN(Date.parse(value)))
    throw new VaultError(400, "Credential expiry is invalid");
  return new Date(Date.parse(value)).toISOString();
}

type ModelBinding = {
  provider: string;
  model: string;
  baseUrl?: string;
  authType: "api_key" | "oauth";
};

type HostSecretPayload = {
  apiKey?: string;
  env?: Record<string, string>;
  oauth?: HostModelSecret["credential"];
};

function modelBinding(row: CredentialRow): ModelBinding {
  const binding = JSON.parse(row.binding_json) as ModelBinding;
  if (!binding.provider || !binding.model || !binding.authType)
    throw new VaultError(500, "Host model credential is unreadable");
  return binding;
}

function hostModelCredentialId(provider: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(provider))
    throw new VaultError(400, "Invalid provider id");
  return `${HOST_MODEL_ID}:${provider}`;
}

function hostModelAad(provider: string, model: string): Buffer {
  return Buffer.from(
    canonical({
      scope: "host",
      vaultId: HOST_VAULT_ID,
      credentialId: HOST_MODEL_ID,
      type: "model",
      provider,
      model,
    }),
    "utf8",
  );
}

function credentialAad(
  vaultId: string,
  credentialId: string,
  type: string,
  url: string,
): Buffer {
  return Buffer.from(
    canonical({ vaultId, credentialId, type, url }),
    "utf8",
  );
}

function requestHash(body: unknown): string {
  const { requestId: _requestId, ...rest } = body as { requestId?: string };
  return canonical(rest);
}
