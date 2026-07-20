// Long-running engine HTTP service entry. Flips the container from a per-run job to a service.
import { loadDotenv } from "../src/env.ts";
import { create_engine_server } from "../src/server/investigate_server.ts";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? fallback : value;
}

function main(): void {
  loadDotenv();
  const server = create_engine_server({
    port: intEnv("ENGINE_PORT", intEnv("PORT", 8787)),
    auth_token: process.env.ENGINE_AUTH_TOKEN ?? "",
    max_concurrency: intEnv("ENGINE_MAX_CONCURRENCY", 4),
    request_timeout_ms: intEnv("ENGINE_REQUEST_TIMEOUT_MS", 300_000),
    shutdown_drain_ms: intEnv("ENGINE_SHUTDOWN_DRAIN_MS", 300_000),
    graphql_url: process.env.GRAPHQL_URL,
  });
  const shutdown = () => {
    void server.stop().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.stdout.write(`engine service listening on :${server.port}\n`);
}

main();
