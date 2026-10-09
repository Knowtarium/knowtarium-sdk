import {
  type HistoryRetentionDays,
  type HistorySettingsResponse,
  routes,
  type SetHistorySettingsResponse,
} from "../../protocol/index.js";
import { isSyncApiError } from "../errors/index.js";
import type { SyncContext } from "./context.js";

type SettingsContext = Pick<SyncContext, "api" | "workspaceId">;

/**
 * The workspace's history setting (session, the owner): the period, the last cleanup, what the
 * history holds by age (`historyFreedAt` says what a shorter period would remove) and the
 * account's usage.
 */
export async function readHistorySettings(
  context: SettingsContext,
): Promise<HistorySettingsResponse> {
  const { data } = await context.api.call(routes.getHistorySettings, {
    params: { workspaceId: context.workspaceId },
  });
  return data;
}

/**
 * The owner sets the history period (session). A shorter one removes older versions at once,
 * after the person confirmed it: `freed` says what went, `more` that the rest goes within about a
 * minute. Nothing removed comes back with a longer one.
 */
export async function setHistorySettings(
  context: SettingsContext,
  retentionDays: HistoryRetentionDays,
): Promise<SetHistorySettingsResponse> {
  const { data } = await context.api.call(routes.setHistorySettings, {
    params: { workspaceId: context.workspaceId },
    body: { retentionDays },
  });
  return data;
}

/**
 * The workspace's history period in days, read-only (an agent or a person). Null when the server
 * doesn't answer it (one from before the setting existed), so callers say nothing about it.
 */
export async function readHistoryRetention(
  context: SettingsContext,
): Promise<HistoryRetentionDays | null> {
  try {
    const { data } = await context.api.call(routes.getHistoryRetention, {
      params: { workspaceId: context.workspaceId },
    });
    return data.retentionDays;
  } catch (error) {
    if (isSyncApiError(error, "not_found")) return null;
    throw error;
  }
}
