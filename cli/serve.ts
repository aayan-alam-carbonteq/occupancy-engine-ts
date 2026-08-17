// Long-running engine HTTP service entry. Flips the container from a per-run job to a service.
import { loadDotenv } from "../src/env.ts";
import { resolve_data_url } from "../src/agents/data_client.ts";
import { create_engine_server } from "../src/server/investigate_server.ts";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? fallback : value;
}

/** The bearer token guarding POST /investigate and /fingerprint. Never empty. */
function requireAuthToken(): string {
  const token = (process.env.ENGINE_AUTH_TOKEN ?? "").trim();
  if (token === "") {
    // REFUSE, rather than serve an open endpoint. The guard compares the header against
    // `Bearer ${auth_token}`, so an empty token does not disable auth — it makes the literal
    // string "Bearer " (with its trailing space) a valid credential, which is worse than no
    // check at all because the endpoint still looks protected.
    //
    // Empty is a state an operator reaches by accident, not by choice: compose reads
    // `${ENGINE_AUTH_TOKEN:-dev-engine-token}`, and `:-` substitutes its default when the
    // variable is EMPTY as well as unset. So an .env with a blank `ENGINE_AUTH_TOKEN=` line
    // silently publishes the well-known dev token — which appears in compose.yaml, README.md
    // and several docs — as production's credential. Nothing downstream can tell the
    // difference, so it has to be caught here.
    process.stderr.write(
      "ENGINE_AUTH_TOKEN is empty. It is the bearer token for POST /investigate and " +
        "POST /fingerprint; serving without it would leave both endpoints open on this port. " +
        "Set it to a value you generated (openssl rand -hex 32) and restart. Note that a blank " +
        "line in .env is NOT the same as leaving it out: compose substitutes its published " +
        "dev default for an empty value.\n",
    );
    process.exit(2);
  }
  return token;
}

function main(): void {
  loadDotenv();
  // Resolved here (rather than left to the server's own default) so the startup line can print
  // exactly the data service /fingerprint's probe AND every investigation will read — the same
  // resolve_data_url() investigate_server.ts calls internally, given the same (absent) override.
  const data_url = resolve_data_url();
  const server = create_engine_server({
    port: intEnv("ENGINE_PORT", intEnv("PORT", 8787)),
    auth_token: requireAuthToken(),
    max_concurrency: intEnv("ENGINE_MAX_CONCURRENCY", 4),
    request_timeout_ms: intEnv("ENGINE_REQUEST_TIMEOUT_MS", 300_000),
    shutdown_drain_ms: intEnv("ENGINE_SHUTDOWN_DRAIN_MS", 300_000),
    data_url,
  });
  const shutdown = () => {
    void server.stop().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // engine=<hash> is what POST /fingerprint reports; graph=<url> is what its probe reads. The graph
  // MUST match the data_url the backend sends in /investigate — see AGENTS.md.
  process.stdout.write(
    `engine service listening on :${server.port} (engine=${server.engine_hash.slice(0, 12)} graph=${data_url})\n`,
  );
}

main();
