import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXPECTED_SCHEMA_MIGRATION,
  REQUIRED_DATABASE_TABLES,
  inspectDatabaseSchema,
  requireConfiguredDatabase
} from "../src/storage.js";

describe("validacao do schema PostgreSQL", () => {
  it("aceita PostgreSQL conectado com todos os objetos e a migration atual", async () => {
    const { query, calls } = createSchemaQuery();

    const inspection = await inspectDatabaseSchema({ databaseConfigured: true, query });

    assert.deepEqual(inspection, {
      configured: true,
      ready: true,
      schema: "public",
      missingObjects: [],
      pendingMigration: null
    });
    assert.deepEqual(calls[0].params, [REQUIRED_DATABASE_TABLES]);
    assert.match(calls[0].text, /to_regclass\(format\('public\.%I', object_name\)\)/);
    assert.match(calls[1].text, /FROM public\.app_schema_migrations/);
    assert.equal(await requireConfiguredDatabase({ databaseConfigured: true, query }), true);
  });

  it("interrompe o startup e nomeia cada tabela obrigatoria ausente", async () => {
    const { query } = createSchemaQuery({ missingObjects: ["app_users", "app_processes"] });

    await assert.rejects(
      () => requireConfiguredDatabase({
        databaseConfigured: true,
        query,
        databaseTarget: { host: "ep-safe.neon.tech", database: "neondb" }
      }),
      (error) => {
        assert.equal(error.statusCode, 503);
        assert.equal(error.databaseState, "schema_incomplete");
        assert.deepEqual(error.missingObjects, ["public.app_processes", "public.app_users"]);
        assert.equal(error.pendingMigration, null);
        assert.match(error.message, /Objetos ausentes: public\.app_processes, public\.app_users\./);
        assert.match(error.message, /historico de migrations esta atual, mas o schema foi alterado ou corrompido/);
        assert.doesNotMatch(error.message, /postgres(?:ql)?:\/\//i);
        return true;
      }
    );
  });

  it("interrompe o startup e informa a migration pendente quando as tabelas existem", async () => {
    const { query } = createSchemaQuery({ migrationCurrent: false });

    await assert.rejects(
      () => requireConfiguredDatabase({ databaseConfigured: true, query }),
      (error) => {
        assert.equal(error.databaseState, "schema_incomplete");
        assert.deepEqual(error.missingObjects, []);
        assert.equal(error.pendingMigration, EXPECTED_SCHEMA_MIGRATION);
        assert.doesNotMatch(error.message, /Objetos ausentes/);
        assert.match(error.message, new RegExp(`Migration pendente: ${EXPECTED_SCHEMA_MIGRATION}`));
        assert.match(error.suggestedAction, /npm run db:migrate:production/);
        return true;
      }
    );
  });

  it("diferencia banco indisponivel de schema incompleto", async () => {
    const unavailable = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });

    await assert.rejects(
      () => requireConfiguredDatabase({
        databaseConfigured: true,
        query: async () => { throw unavailable; },
        databaseTarget: { host: "ep-safe.neon.tech", database: "neondb" }
      }),
      (error) => {
        assert.equal(error.statusCode, 503);
        assert.equal(error.databaseState, "unavailable");
        assert.match(error.message, /indisponivel ou sem permissao/);
        assert.equal(error.missingObjects, undefined);
        return true;
      }
    );
  });

  it("mantem o comportamento sem DATABASE_URL e nao consulta PostgreSQL", async () => {
    let queried = false;
    const query = async () => {
      queried = true;
      throw new Error("nao deveria consultar o banco");
    };

    assert.equal(await requireConfiguredDatabase({ databaseConfigured: false, query }), false);
    assert.deepEqual(await inspectDatabaseSchema({ databaseConfigured: false, query }), {
      configured: false,
      ready: false,
      schema: "public",
      missingObjects: [],
      pendingMigration: null
    });
    assert.equal(queried, false);
  });
});

function createSchemaQuery(options = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (text.includes("FROM unnest")) {
        return {
          rows: (options.missingObjects || [])
            .slice()
            .sort()
            .map((object_name) => ({ object_name }))
        };
      }
      if (text.includes("FROM public.app_schema_migrations")) {
        return { rows: [{ migration_current: options.migrationCurrent !== false }] };
      }
      throw new Error("Consulta de schema inesperada.");
    }
  };
}
