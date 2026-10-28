"use server";

import { cookies } from "next/headers";

import { getModel, parseSettings } from "./catalog";
import type { GenerationPlane } from "./catalog/types";
import {
  MissingCredentialsError,
  PLATFORM_KEY_COOKIE,
  PLATFORM_KEY_COOKIE_OPTIONS,
  decodeCredentials,
  encodeCredentials,
  parseCredentialInput,
} from "./credentials";
import { PlatformError, createPlatformClient } from "./platform";
import type { QueuedGeneration, StatusResult } from "./platform";
import { toPlatform } from "./to-platform";

/** Server actions return their failures as values. A thrown error in a
    production server action reaches the browser only as React's generic
    "An error occurred in the Server Components render" message, which hides
    the real reason (bad key, no balance, wrong model inputs). */
export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

const DEFAULT_API_BASE_URL = "https://api.higgsfield.ai";

async function attempt<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (caught) {
    return { ok: false, error: describeFailure(caught) };
  }
}

function describeFailure(caught: unknown): string {
  if (caught instanceof PlatformError) {
    if (caught.status === 401) return "Higgsfield rejected the API key (401). Check the key id and secret, or create a new key.";
    if (caught.status === 403) return "Higgsfield refused the request (403). The key may be expired or lack access to this model.";
    if (caught.status === 402) return "Higgsfield reports insufficient API balance (402). Add funds to your API account.";
    if (caught.status === 422 || caught.status === 400) return `Higgsfield rejected the request settings (${caught.status}): ${caught.message}`;
    return caught.message;
  }
  return caught instanceof Error ? caught.message : String(caught);
}

export async function savePlatformCredentials(data: unknown): Promise<ActionResult<null>> {
  return attempt(async () => {
    const { apiKey } = parseCredentialInput(data);
    const jar = await cookies();
    jar.set(PLATFORM_KEY_COOKIE, encodeCredentials(apiKey), PLATFORM_KEY_COOKIE_OPTIONS);
    return null;
  });
}

export async function clearPlatformCredentials(): Promise<ActionResult<null>> {
  return attempt(async () => {
    const jar = await cookies();
    jar.set(PLATFORM_KEY_COOKIE, "", { ...PLATFORM_KEY_COOKIE_OPTIONS, maxAge: 0 });
    return null;
  });
}

export async function hasPlatformCredentials() {
  return (await readStoredCredentials()) !== null;
}

export async function submitGeneration(plane: GenerationPlane): Promise<ActionResult<QueuedGeneration>> {
  return attempt(async () => {
    const model = getModel(plane.model);
    const parsed: GenerationPlane = {
      ...plane,
      settings: parseSettings(model, plane.settings),
    };
    const { path, body } = toPlatform(parsed);
    return createPlatformClient(await readCredentials()).submit(path, body);
  });
}

/** Every request in flight, answered in one round trip. Next dispatches server
    actions one at a time per client, so a poll per run would queue ahead of the
    next submit — the fan-out belongs on this side of the call, where it is
    genuinely parallel. */
export async function getGenerationStatuses(data: unknown): Promise<ActionResult<StatusResult[]>> {
  return attempt(() => statusesFor(data));
}

async function statusesFor(data: unknown): Promise<StatusResult[]> {
  const requestIds = parseRequestIds(data);
  const client = createPlatformClient(await readCredentials());
  return Promise.all(
    requestIds.map(async (requestId): Promise<StatusResult> => {
      try {
        return { requestId, status: await client.status(requestId) };
      } catch (caught) {
        return { requestId, error: caught instanceof Error ? caught.message : String(caught) };
      }
    }),
  );
}

async function readStoredCredentials() {
  const jar = await cookies();
  return decodeCredentials(jar.get(PLATFORM_KEY_COOKIE)?.value);
}

async function readCredentials() {
  const stored = await readStoredCredentials();
  if (!stored) throw new MissingCredentialsError();
  const baseUrl = process.env.HF_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;
  return { ...stored, baseUrl };
}

function parseRequestIds(data: unknown): string[] {
  const payload = asObject(data, "Invalid status payload");
  const requestIds = payload.requestIds;
  if (!Array.isArray(requestIds) || requestIds.length === 0) {
    throw new Error("Invalid request ids");
  }
  return requestIds.map((requestId) => {
    if (typeof requestId !== "string" || !requestId) throw new Error("Invalid request id");
    return requestId;
  });
}

function asObject(data: unknown, message: string): Record<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error(message);
  return data as Record<string, unknown>;
}
