import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPoolConfig } from "../src/db/postgres.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "db", "migrations");

export async function runMigrations(options = {}) {
  const resolvedDatabaseUrl = options.databaseUrl
    ? { databaseUrl: options.databaseUrl, source: "options.databaseUrl" }
    : resolveMigrationDatabaseUrl();
  const {
    databaseUrl = resolvedDatabaseUrl.databaseUrl,
    databaseUrlSource = resolvedDatabaseUrl.source,
    migrationsDir = MIGRATIONS_DIR,
    createClient = defaultCreateClient,
    logger = console,
    clock = () => performance.now(),
    signalSource = null
  } = options;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL nao configurada.");
  }

  const migrations = readdirSync(migrationsDir)
    .filter((fileName) => /^\d+_.+\.sql$/.test(fileName))
    .sort();

  if (!migrations.length) {
    logger.log("Nenhuma migracao encontrada.");
    return { applied: [], skipped: [] };
  }

  const state = createMigrationState(clock);
  logger.log(formatDatabaseTarget(databaseUrl, databaseUrlSource));
  logMigrationEvent(logger, state, "migration_runner_started", databaseTargetDetails(databaseUrl, databaseUrlSource));
  let detachSignalHandlers = () => {};
  let provisionalResult = null;
  let failure = null;
  try {
    state.client = createClient(databaseUrl);
    detachSignalHandlers = installSignalHandlers(signalSource, state, logger);
    setMigrationPhase(state, "connection");
    state.operationActive = true;
    logMigrationEvent(logger, state, "migration_connection_start");
    await awaitMigrationOperation(state.client.connect(), state);
    state.operationActive = false;
    state.connected = true;
    logMigrationEvent(logger, state, "migration_connection_acquired");

    await executeMigrationQuery(state, "connection_validation", "SET search_path TO public");
    logMigrationEvent(logger, state, "migration_connection_validated", { schema: "public" });
    setMigrationPhase(state, "lock_wait");
    logMigrationEvent(logger, state, "migration_lock_wait");
    await executeMigrationQuery(state, "lock_wait", "SELECT pg_advisory_lock(hashtext('almoxarifado_schema_migrations'))");
    state.migrationLockHeld = true;
    logMigrationEvent(logger, state, "migration_lock_acquired");
    const appliedMigrations = await loadAppliedMigrations(state.client, state);
    logMigrationEvent(logger, state, "migration_discovery_complete", { discovered: migrations.length, applied: appliedMigrations.size });
    const result = { applied: [], skipped: [] };

    for (const migration of migrations) {
      const migrationVersion = migration.replace(/\.sql$/, "");
      if (appliedMigrations.has(migrationVersion)) {
        logger.log(`Ignorando ${migration}: ja aplicada.`);
        result.skipped.push(migrationVersion);
        continue;
      }

      const fullPath = join(migrationsDir, migration);
      logger.log(`Aplicando ${migration}`);
      state.currentMigration = migrationVersion;
      logMigrationEvent(logger, state, "migration_apply_start", { migration: migrationVersion });
      await executeMigrationQuery(state, "migration_begin", "BEGIN");
      state.transactionOpen = true;
      try {
        const migrationSql = withoutOuterTransaction(readFileSync(fullPath, "utf8"), migration);
        await executeMigrationQuery(state, "migration_apply", migrationSql);
        await recordAppliedMigration(state.client, migrationVersion, state);
        await executeMigrationQuery(state, "migration_commit", "COMMIT");
        state.transactionOpen = false;
      } catch (error) {
        if (state.interruption) throw state.interruption;
        await rollbackMigrationTransaction(state, logger);
        throw new Error(`Falha ao aplicar ${migration}: ${error.message}`);
      }
      appliedMigrations.add(migrationVersion);
      result.applied.push(migrationVersion);
      logMigrationEvent(logger, state, "migration_apply_complete", { migration: migrationVersion });
      state.currentMigration = null;
    }
    provisionalResult = result;
  } catch (error) {
    failure = state.interruption || error;
  } finally {
    await cleanupMigrationClient(state, logger);
    detachSignalHandlers();
  }
  if (state.interruption) {
    logMigrationEvent(logger, state, "migration_runner_interrupted", {
      signal: state.interruption.signal,
      error: safeMigrationError(state.interruption)
    });
    throw state.interruption;
  }
  if (failure) {
    logMigrationEvent(logger, state, "migration_runner_failed", {
      signal: null,
      error: safeMigrationError(failure)
    });
    throw failure;
  }
  setMigrationPhase(state, "complete");
  logger.log("Migracoes aplicadas com sucesso.");
  logMigrationEvent(logger, state, "migration_runner_complete", provisionalResult);
  return provisionalResult;
}

function createMigrationState(clock) {
  const startedAt = clock();
  let rejectInterruption;
  const interruption = new Promise((_, reject) => {
    rejectInterruption = reject;
  });
  // The race below observes this rejection during work. This handler also
  // prevents an external signal delivered between phases from becoming an
  // unhandled rejection before the next operation starts.
  interruption.catch(() => {});
  return {
    clock,
    startedAt,
    phase: "initializing",
    phaseStartedAt: startedAt,
    client: null,
    connected: false,
    clientClosed: false,
    migrationLockHeld: false,
    transactionOpen: false,
    operationActive: false,
    currentMigration: null,
    interruption: null,
    interruptionPromise: interruption,
    rejectInterruption,
    cleanupPromise: null
  };
}

function installSignalHandlers(signalSource, state, logger) {
  if (!signalSource?.once || !signalSource?.removeListener) return () => {};
  const handlers = new Map();
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const handler = () => {
      if (state.interruption) return;
      const error = new Error(`Migration interrompida por ${signal}.`);
      error.code = "MIGRATION_INTERRUPTED";
      error.exitCode = signal === "SIGTERM" ? 143 : 130;
      error.signal = signal;
      state.interruption = error;
      logMigrationEvent(logger, state, "migration_signal_received", { signal });
      state.rejectInterruption(error);
      void cleanupMigrationClient(state, logger);
    };
    handlers.set(signal, handler);
    signalSource.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) signalSource.removeListener(signal, handler);
  };
}

async function executeMigrationQuery(state, phase, text, params = []) {
  setMigrationPhase(state, phase);
  state.operationActive = true;
  try {
    return await awaitMigrationOperation(state.client.query(text, params), state);
  } finally {
    state.operationActive = false;
  }
}

async function awaitMigrationOperation(operation, state) {
  if (state.interruption) throw state.interruption;
  return Promise.race([operation, state.interruptionPromise]);
}

async function loadAppliedMigrations(client, state) {
  try {
    const result = await executeMigrationQuery(state, "migration_discovery", "SELECT version FROM public.app_schema_migrations");
    return new Set(result.rows.map((row) => row.version));
  } catch (error) {
    if (state.interruption) throw state.interruption;
    if (error.code === "42P01") return new Set();
    throw error;
  }
}

async function recordAppliedMigration(client, version, state) {
  await executeMigrationQuery(
    state,
    "migration_record",
    "INSERT INTO public.app_schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
    [version]
  );
}

async function rollbackMigrationTransaction(state, logger) {
  if (!state.transactionOpen || !state.connected || state.clientClosed) return;
  try {
    setMigrationPhase(state, "rollback");
    await state.client.query("ROLLBACK");
    logMigrationEvent(logger, state, "migration_transaction_rolled_back");
  } catch {
    // Closing the session below rolls back a transaction that could not be rolled back explicitly.
  } finally {
    state.transactionOpen = false;
  }
}

async function cleanupMigrationClient(state, logger) {
  if (state.cleanupPromise) return state.cleanupPromise;
  state.cleanupPromise = (async () => {
    if (!state.client || state.clientClosed) return;
    if (state.connected && !state.operationActive) {
      await rollbackMigrationTransaction(state, logger);
      if (state.migrationLockHeld) {
        try {
          setMigrationPhase(state, "lock_release");
          await state.client.query("SELECT pg_advisory_unlock(hashtext('almoxarifado_schema_migrations'))");
          logMigrationEvent(logger, state, "migration_lock_released");
        } catch {
          // Session close releases the advisory lock if it could not be unlocked explicitly.
        } finally {
          state.migrationLockHeld = false;
        }
      }
    }
    try {
      await state.client.end();
    } catch {
      // There is no further resource to recover after a failed close attempt.
    } finally {
      state.clientClosed = true;
      logMigrationEvent(logger, state, "migration_connection_closed");
    }
  })();
  return state.cleanupPromise;
}

function logMigrationEvent(logger, state, event, details = {}) {
  logger.log(JSON.stringify({
    event,
    elapsedMs: Math.round(state.clock() - state.startedAt),
    durationMs: Math.round(state.clock() - state.phaseStartedAt),
    phase: state.phase,
    migration: state.currentMigration,
    clientState: state.clientClosed ? "closed" : (state.connected ? "connected" : (state.client ? "connecting" : "not_created")),
    ...details
  }));
}

function setMigrationPhase(state, phase) {
  state.phase = phase;
  state.phaseStartedAt = state.clock();
}

function databaseTargetDetails(databaseUrl, source) {
  try {
    const url = new URL(databaseUrl);
    return {
      source,
      host: url.host,
      database: url.pathname.replace(/^\//, "") || "<sem database>",
      sslmode: url.searchParams.get("sslmode") || null
    };
  } catch {
    return { source, host: "<url invalida>" };
  }
}

function safeMigrationError(error) {
  return String(error?.message || "Erro desconhecido")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database-url-redacted]")
    .slice(0, 400);
}

function withoutOuterTransaction(sql, migrationName) {
  const lines = String(sql).split(/\r?\n/);
  const meaningful = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line && !line.startsWith("--"));
  const first = meaningful[0];
  const last = meaningful.at(-1);
  const startsTransaction = /^BEGIN(?:\s+TRANSACTION)?;$/i.test(first?.line || "");
  const endsTransaction = /^COMMIT;$/i.test(last?.line || "");

  if (startsTransaction !== endsTransaction) {
    throw new Error(`${migrationName} possui controle de transacao incompleto.`);
  }
  if (startsTransaction) {
    lines[first.index] = "";
    lines[last.index] = "";
  }
  return lines.join("\n");
}

function defaultCreateClient(databaseUrl) {
  return new pg.Client(createPoolConfig(databaseUrl));
}

export function resolveMigrationDatabaseUrl(environment = process.env) {
  if (environment.DATABASE_URL_MIGRATION) {
    return {
      databaseUrl: environment.DATABASE_URL_MIGRATION,
      source: "DATABASE_URL_MIGRATION"
    };
  }

  if (isNeonPooledUrl(environment.DATABASE_URL)) {
    throw new Error("DATABASE_URL usa endpoint Neon pooled; DATABASE_URL_MIGRATION com a URL direta da mesma branch e database e obrigatoria para migrations, pois o advisory lock exige uma sessao dedicada.");
  }

  return {
    databaseUrl: environment.DATABASE_URL,
    source: "DATABASE_URL"
  };
}

function isNeonPooledUrl(databaseUrl) {
  try {
    const hostname = new URL(databaseUrl).hostname.toLowerCase();
    return hostname.endsWith(".neon.tech")
      && (hostname.includes("-pooler.") || hostname.includes(".pooler."));
  } catch {
    return false;
  }
}

function formatDatabaseTarget(databaseUrl, source) {
  try {
    const url = new URL(databaseUrl);
    const database = url.pathname.replace(/^\//, "") || "<sem database>";
    const sslmode = url.searchParams.get("sslmode") || "<nao informado>";
    return [
      `Banco alvo da migracao: source=${source}`,
      `NODE_ENV=${process.env.NODE_ENV || "<nao definido>"}`,
      `host=${url.host}`,
      `database=${database}`,
      `sslmode=${sslmode}`
    ].join(" ");
  } catch {
    return [
      `Banco alvo da migracao: source=${source}`,
      `NODE_ENV=${process.env.NODE_ENV || "<nao definido>"}`,
      "host=<url invalida>"
    ].join(" ");
  }
}

function loadLocalEnv() {
  const envFile = process.env.NODE_ENV === "production" ? ".env.production" : ".env";
  const envPath = join(ROOT, envFile);
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (!key || process.env[key]) continue;
    process.env[key] = valueParts.join("=").trim();
  }
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMainModule()) {
  loadLocalEnv();
  try {
    await runMigrations({ signalSource: process });
  } catch (error) {
    console.error(safeMigrationError(error));
    process.exitCode = error?.exitCode || 1;
  }
}
