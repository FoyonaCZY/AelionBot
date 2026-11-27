import { AelionError, throwIfAborted, type JsonObject } from '@aelionsdk/core';

import type { ExportProfileId } from './profiles.js';

export const REMOTE_EXPORT_PROTOCOL_VERSION = '1.0.0' as const;

export interface RemoteExportAuthorization {
  readonly scheme: string;
  readonly token: string;
  readonly expiresAtMs?: number;
}

export interface RemoteExportAuthorizer {
  authorize(signal?: AbortSignal): Promise<RemoteExportAuthorization>;
}

export interface RemoteExportAsset {
  readonly assetId: string;
  readonly contentId: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly mediaType?: string;
  readonly locator?: JsonObject;
}

export interface RemoteExportAssetAuthorization extends RemoteExportAuthorization {
  readonly assetId: string;
}

export interface RemoteExportAssetAuthorizer {
  authorizeAsset(asset: RemoteExportAsset, signal?: AbortSignal): Promise<RemoteExportAssetAuthorization>;
}

export interface RemoteExportRequest {
  readonly protocolVersion: typeof REMOTE_EXPORT_PROTOCOL_VERSION;
  readonly contentId: string;
  readonly idempotencyKey: string;
  readonly profileId: ExportProfileId;
  readonly projectId: string;
  readonly sequenceId: string;
  readonly revision: string;
  readonly manifest: JsonObject;
  readonly assets: readonly RemoteExportAsset[];
  /** Ephemeral credentials; providers must not persist them in manifests or logs. */
  readonly assetAuthorizations: readonly RemoteExportAssetAuthorization[];
}

export interface RemoteExportNegotiationRequest {
  readonly supportedProtocolVersions: readonly [typeof REMOTE_EXPORT_PROTOCOL_VERSION];
  readonly profileId: ExportProfileId;
  readonly assets: readonly RemoteExportAsset[];
}

export interface RemoteExportNegotiation {
  /** Untrusted provider response; callers validate it against the supported version. */
  readonly protocolVersion: string;
  readonly acceptedProfileIds: readonly ExportProfileId[];
  readonly maxAssetBytes: number;
}

export type RemoteExportEvent =
  | { readonly type: 'progress'; readonly progress: number; readonly stage?: string }
  | {
      readonly type: 'completed';
      readonly result: RemoteExportResult;
    };

export interface RemoteExportResult {
  readonly providerJobId: string;
  readonly contentId: string;
  readonly profileId: ExportProfileId;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly outputUrl?: string;
  readonly outputToken?: string;
}

export interface RemoteExportSession {
  readonly providerJobId: string;
  readonly events: AsyncIterable<RemoteExportEvent>;
  cancel(reason?: unknown): Promise<void>;
  cleanup(reason?: unknown): Promise<void>;
}

export interface RemoteExportProvider {
  readonly id: string;
  negotiate(
    request: RemoteExportNegotiationRequest,
    authorization: RemoteExportAuthorization,
    signal?: AbortSignal,
  ): Promise<RemoteExportNegotiation>;
  start(
    request: RemoteExportRequest,
    authorization: RemoteExportAuthorization,
    signal?: AbortSignal,
  ): Promise<RemoteExportSession>;
}

export interface RunRemoteExportOptions {
  readonly provider: RemoteExportProvider;
  readonly authorizer: RemoteExportAuthorizer;
  readonly request: RemoteExportRequest;
  readonly assetAuthorizer?: RemoteExportAssetAuthorizer;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: number, stage?: string) => void;
}

function boundedProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function validAuthorization(value: RemoteExportAuthorization): boolean {
  return (
    value.scheme.length > 0 &&
    value.token.length > 0 &&
    (value.expiresAtMs === undefined || value.expiresAtMs > Date.now())
  );
}

function validateAsset(asset: RemoteExportAsset): void {
  if (
    asset.assetId.length === 0 ||
    asset.contentId.length === 0 ||
    !Number.isSafeInteger(asset.byteLength) ||
    asset.byteLength < 0 ||
    !/^[0-9a-f]{64}$/u.test(asset.sha256)
  ) {
    throw new TypeError(`Invalid remote export asset ${asset.assetId || '<empty>'}`);
  }
}

export async function runRemoteExport(options: RunRemoteExportOptions): Promise<RemoteExportResult> {
  throwIfAborted(options.signal, 'Remote export');
  const authorization = await options.authorizer.authorize(options.signal);
  throwIfAborted(options.signal, 'Remote export');
  if (!validAuthorization(authorization)) {
    throw new AelionError([
      {
        code:
          authorization.expiresAtMs !== undefined && authorization.expiresAtMs <= Date.now()
            ? 'REMOTE_EXPORT_AUTH_EXPIRED'
            : 'REMOTE_EXPORT_AUTH_INVALID',
        severity: 'error',
        message: 'Remote export authorization is empty or expired',
        recoverable: true,
      },
    ]);
  }
  for (const asset of options.request.assets) validateAsset(asset);
  const negotiation = await options.provider.negotiate(
    {
      supportedProtocolVersions: [REMOTE_EXPORT_PROTOCOL_VERSION],
      profileId: options.request.profileId,
      assets: options.request.assets,
    },
    authorization,
    options.signal,
  );
  if (
    negotiation.protocolVersion !== REMOTE_EXPORT_PROTOCOL_VERSION ||
    !negotiation.acceptedProfileIds.includes(options.request.profileId) ||
    !Number.isSafeInteger(negotiation.maxAssetBytes) ||
    negotiation.maxAssetBytes < 0 ||
    options.request.assets.some((asset) => asset.byteLength > negotiation.maxAssetBytes)
  ) {
    throw new AelionError([
      {
        code: 'REMOTE_EXPORT_INCOMPATIBLE',
        severity: 'error',
        message: 'Remote export protocol, profile, or asset budget is incompatible',
        recoverable: false,
      },
    ]);
  }
  if (options.request.assets.length > 0 && options.assetAuthorizer === undefined) {
    throw new AelionError([
      {
        code: 'REMOTE_EXPORT_ASSET_AUTH_REQUIRED',
        severity: 'error',
        message: 'Remote export assets require an explicit authorizer',
        recoverable: true,
      },
    ]);
  }
  const assetAuthorizations: RemoteExportAssetAuthorization[] = [];
  for (const asset of options.request.assets) {
    const assetAuthorization = await options.assetAuthorizer?.authorizeAsset(asset, options.signal);
    if (
      assetAuthorization === undefined ||
      assetAuthorization.assetId !== asset.assetId ||
      !validAuthorization(assetAuthorization)
    ) {
      throw new AelionError([
        {
          code: 'REMOTE_EXPORT_ASSET_AUTH_INVALID',
          severity: 'error',
          message: `Remote export asset authorization is invalid for ${asset.assetId}`,
          recoverable: true,
        },
      ]);
    }
    assetAuthorizations.push(assetAuthorization);
  }
  let session: RemoteExportSession | undefined;
  let lastProgress = 0;
  try {
    session = await options.provider.start({ ...options.request, assetAuthorizations }, authorization, options.signal);
    for await (const event of session.events) {
      throwIfAborted(options.signal, 'Remote export');
      if (event.type === 'progress') {
        const progress = boundedProgress(event.progress);
        if (progress < lastProgress) {
          throw new Error('Remote export progress must be monotonic');
        }
        lastProgress = progress;
        options.onProgress?.(progress, event.stage);
        continue;
      }
      if (
        event.result.providerJobId !== session.providerJobId ||
        event.result.contentId !== options.request.contentId ||
        event.result.profileId !== options.request.profileId ||
        !Number.isSafeInteger(event.result.byteLength) ||
        event.result.byteLength < 0 ||
        !/^[0-9a-f]{64}$/u.test(event.result.sha256)
      ) {
        throw new Error('Remote export result identity does not match the request');
      }
      options.onProgress?.(1, 'completed');
      return event.result;
    }
    throw new Error('Remote export event stream ended without a result');
  } catch (cause) {
    await Promise.resolve(session?.cancel(cause)).catch(() => undefined);
    await Promise.resolve(session?.cleanup(cause)).catch(() => undefined);
    if (cause instanceof AelionError) throw cause;
    throw new AelionError([
      {
        code: options.signal?.aborted === true ? 'OPERATION_ABORTED' : 'REMOTE_EXPORT_FAILED',
        severity: 'error',
        message:
          options.signal?.aborted === true
            ? 'Remote export was aborted'
            : cause instanceof Error
              ? cause.message
              : 'Remote export failed',
        recoverable: true,
        cause,
      },
    ]);
  }
}

export async function createRemoteExportContentId(
  canonicalManifestBytes: Uint8Array,
  profileId: ExportProfileId,
  revision: string,
): Promise<string> {
  const prefix = new TextEncoder().encode(`${profileId}\n${revision}\n`);
  const bytes = new Uint8Array(prefix.byteLength + canonicalManifestBytes.byteLength);
  bytes.set(prefix);
  bytes.set(canonicalManifestBytes, prefix.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}
