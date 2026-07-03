// Minimal .env loader + LangSmith env sync.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function loadDotenv(path?: string, opts: { override?: boolean } = {}): string | null {
  const envPath = path ?? findDotenv();
  if (envPath === null || !existsSync(envPath)) {
    return null;
  }
  const text = readFileSync(envPath, { encoding: "utf-8" });
  for (const line of text.split(/\r?\n/)) {
    const [key, value] = parseEnvLine(line);
    if (!key) {
      continue;
    }
    if (opts.override || !(key in process.env)) {
      process.env[key] = value;
    }
  }
  syncLangsmithEnv();
  return envPath;
}

export function findDotenv(start?: string): string | null {
  let current = resolve(start ?? process.cwd());
  if (existsSync(current) && statSync(current).isFile()) {
    current = dirname(current);
  }
  // walk current + parents
  let dir = current;
  while (true) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

function parseEnvLine(line: string): [string | null, string] {
  const stripped = line.trim();
  if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) {
    return [null, ""];
  }
  const eq = stripped.indexOf("=");
  let key = stripped.slice(0, eq).trim();
  let value = stripped.slice(eq + 1).trim();
  if (!key || key.startsWith("export ")) {
    key = key.replace(/^export /, "").trim();
  }
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === "'" || value[0] === '"')) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

function syncLangsmithEnv(): void {
  if (process.env.LANGSMITH_TRACING && !process.env.LANGCHAIN_TRACING_V2) {
    process.env.LANGCHAIN_TRACING_V2 = process.env.LANGSMITH_TRACING;
  }
  if (process.env.LANGCHAIN_TRACING_V2 && !process.env.LANGSMITH_TRACING) {
    process.env.LANGSMITH_TRACING = process.env.LANGCHAIN_TRACING_V2;
  }
}
