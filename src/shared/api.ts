/** Types shared by the API server and the web UI. */

export interface HealthResponse {
  status: "ok";
  app: "sumday";
  version: string;
  /** Highest database migration applied. */
  schemaVersion: number;
  /** Whether the first-run household setup has been completed (Phase 1). */
  setupComplete: boolean;
}
