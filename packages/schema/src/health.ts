export type SubsystemHealth = {
  status: "ok" | "error";
  latency_ms?: number;
  error?: string;
  details?: Record<string, unknown>;
};
