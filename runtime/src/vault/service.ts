import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  CreateCredentialRequest,
  CreateVaultRequest,
  CredentialInfo,
  CredentialSelection,
  RotateCredentialRequest,
  VaultInfo,
} from "@nylorun/core/contracts";
import { canonical } from "../core/store.js";
import {
  decryptSecret,
  encryptSecret,
  VaultCryptoError,
} from "./crypto.js";
import { VaultError } from "./error.js";
import { normalizeVaultUrl } from "./url.js";

const REFRESH_SKEW_MS = 60_000;

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
  type: "bearer" | "oauth";
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
        `SELECT id FROM vaults WHERE owner_user_id=? ORDER BY created_at, id`,
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
    if (!row) throw new VaultError(404, "Vault not found");
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
      }
    | undefined {
    return this.db
      .prepare(
        `SELECT id, name, owner_user_id, metadata_json, created_at FROM vaults WHERE id=?`,
      )
      .get(id) as
      | {
          id: string;
          name: string;
          owner_user_id: string;
          metadata_json: string | null;
          created_at: string;
        }
      | undefined;
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

  private credentialRow(vaultId: string, id: string): CredentialRow {
    const row = this.db
      .prepare(
        `SELECT id, vault_id, name, type, binding_json, expires_at, created_at, rotated_at,
                kek_id, nonce, ciphertext, wrapped_dek
         FROM vault_credentials WHERE id=? AND vault_id=?`,
      )
      .get(id, vaultId) as CredentialRow | undefined;
    if (!row || (row.type !== "bearer" && row.type !== "oauth"))
      throw new VaultError(404, "Credential not found");
    return row;
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
