import * as WorkspaceAPI from "trimble-connect-workspace-api";
import type { EventId, WorkspaceEventCallback } from "trimble-connect-workspace-api";

export type WorkspaceApi = Awaited<ReturnType<typeof WorkspaceAPI.connect>>;

let apiPromise: Promise<WorkspaceApi> | null = null;

const onWorkspaceEvent = ((event: EventId, data: unknown) => {
  window.dispatchEvent(
    new CustomEvent("tc-workspace-event", { detail: { event, data } }),
  );
}) as WorkspaceEventCallback;

export function getWorkspaceApi(): Promise<WorkspaceApi> {
  if (!apiPromise) {
    apiPromise = WorkspaceAPI.connect(window.parent, onWorkspaceEvent);
  }

  return apiPromise;
}
