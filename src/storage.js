import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensurePrivateDirectory,
  openDirectoryNoFollow,
  openRegularFileNoFollow,
  readRegularFileLimited
} from "./security/private-files.js";
import {
  databaseTargetSummary,
  databaseConfigured,
  isTestRuntime,
  query,
  readTransaction,
  transaction
} from "./db/postgres.js";
import { applyQuickFilter, enrichProcess, filterProcesses, QUICK_FILTERS, STATUS } from "./domain/processos.js";
import { recordSecurityEvent } from "./repositories/security-audit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STORE_FILE = fileURLToPath(new URL("../data/store.json", `file://${__dirname}/`));
export const EXPECTED_SCHEMA_MIGRATION = "011_process_multiple_commitments";
export const REQUIRED_DATABASE_TABLES = Object.freeze([
  "app_users",
  "user_sessions",
  "app_settings",
  "app_schema_migrations",
  "app_processes",
  "app_process_observations",
  "app_process_audit",
  "app_suppliers",
  "app_email_history",
  "app_state_revision",
  "app_email_dispatch_claims",
  "auth_rate_limits",
  "app_security_audit"
]);
const STORE_FILE = resolveStoreFilePath();
let writeQueue = Promise.resolve();
let databaseReadyConfirmed = false;
let localStoreRevision = 0;

export async function readStore() {
  if (await requireConfiguredDatabase()) {
    return readDatabaseStore();
  }

  try {
    const directory = dirname(STORE_FILE);
    await ensurePrivateDirectory(directory);
    const { content } = await readRegularFileLimited(STORE_FILE, {
      root: directory,
      mode: 0o600
    });
    const store = JSON.parse(content.toString("utf8"));
    const storedRevision = Number(store.__revision);
    if (Number.isSafeInteger(storedRevision) && storedRevision >= 0) localStoreRevision = Math.max(localStoreRevision, storedRevision);
    store.__revision = localStoreRevision;
    return store;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { ...emptyStore(), __revision: localStoreRevision };
  }
}

export async function readUsersStore() {
  if (!(await requireConfiguredDatabase())) return readStore();
  const users = await query(usersSelectSql());
  return { ...emptyStore(), usuarios: users.rows.map(deserializeUser) };
}

export async function readUserById(userId, options = {}) {
  if (!userId) return null;
  if (!(await requireConfiguredDatabase())) {
    const store = await readStore();
    return store.usuarios.find((user) => user.id === userId) || null;
  }
  const result = await query(`${usersSelectSql({
    includePassword: options.includePassword === true,
    orderBy: false
  })} WHERE id = $1 LIMIT 1`, [userId]);
  return result.rows[0] ? deserializeUser(result.rows[0]) : null;
}

export async function readUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;
  if (!(await requireConfiguredDatabase())) {
    const store = await readStore();
    return store.usuarios.find((user) => normalizeEmail(user.email) === normalizedEmail) || null;
  }
  const result = await query(`${usersSelectSql({ includePassword: true, orderBy: false })} WHERE email = $1 LIMIT 1`, [normalizedEmail]);
  return result.rows[0] ? deserializeUser(result.rows[0]) : null;
}

export async function readSettingsStore() {
  if (!(await requireConfiguredDatabase())) return readStore();
  const [users, settings] = await Promise.all([
    query(usersSelectSql({ includePassword: false })),
    query("SELECT value FROM app_settings WHERE key = 'configuracoes' LIMIT 1")
  ]);
  return {
    ...emptyStore(),
    usuarios: users.rows.map(deserializeUser),
    configuracoes: settings.rows[0]?.value || {}
  };
}

export async function readProcessesStore() {
  if (!(await requireConfiguredDatabase())) return readStore();
  const processes = await query(`
    SELECT data
    FROM app_processes
    ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
  `);
  return { ...emptyStore(), processos: processes.rows.map(deserializeRecord) };
}

export async function readProcessesPage(options = {}) {
  const page = positivePageValue(options.page, 1);
  const limit = positivePageValue(options.limit, 25);
  const filters = options.filters || {};
  const quickFilters = Array.isArray(options.quickFilters) ? options.quickFilters : [];

  if (!(await requireConfiguredDatabase())) {
    const store = await readStore();
    // The PostgreSQL query evaluates deadline filters against the business date.
    // Keep the file fallback equivalent without persisting derived fields.
    const filtered = applyQuickFilter(
      filterProcesses(store.processos || [], filters).map((processo) => enrichProcess(processo)),
      quickFilters
    );
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const resolvedPage = Math.min(page, totalPages);
    const start = (resolvedPage - 1) * limit;
    return {
      data: filtered.slice(start, start + limit),
      total,
      page: resolvedPage,
      limit,
      totalPages
    };
  }

  const { where, values } = processPageWhereClause(filters, quickFilters);
  return readTransaction(async (client) => {
    const totalResult = await client.query(`SELECT count(*)::integer AS total FROM app_processes${where}`, values);
    const total = Number(totalResult.rows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const resolvedPage = Math.min(page, totalPages);
    const offset = (resolvedPage - 1) * limit;
    const pageResult = await client.query(`
      SELECT data
      FROM app_processes${where}
      ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}
    `, [...values, limit, offset]);
    return {
      data: pageResult.rows.map(deserializeRecord),
      total,
      page: resolvedPage,
      limit,
      totalPages
    };
  });
}

export async function readProcessById(processId) {
  const id = String(processId || "");
  if (!id) return null;
  if (!(await requireConfiguredDatabase())) {
    const store = await readStore();
    return (store.processos || []).find((processo) => processo.id === id) || null;
  }
  const result = await query(`
    SELECT data
    FROM app_processes
    WHERE id = $1
    LIMIT 1
  `, [id]);
  return result.rows[0] ? deserializeRecord(result.rows[0]) : null;
}

export async function readSuppliersStore() {
  if (!(await requireConfiguredDatabase())) return readStore();
  const suppliers = await query(`
    SELECT data
    FROM app_suppliers
    ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
  `);
  return { ...emptyStore(), fornecedores: suppliers.rows.map(deserializeRecord) };
}

export async function readAuditStore() {
  if (!(await requireConfiguredDatabase())) return readStore();
  const audit = await query(`
    SELECT data
    FROM app_process_audit
    ORDER BY created_at DESC, id DESC
  `);
  return { ...emptyStore(), auditoria: audit.rows.map(deserializeRecord) };
}

export async function readStoreRevision() {
  if (!(await requireConfiguredDatabase())) return localStoreRevision;
  const result = await query("SELECT revision FROM app_state_revision WHERE id = true LIMIT 1");
  return Number(result.rows[0]?.revision || 0);
}

export async function readProcessesSnapshot() {
  if (!(await requireConfiguredDatabase())) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const revisionBefore = localStoreRevision;
      const store = await readStore();
      if (revisionBefore === localStoreRevision) {
        return { processos: store.processos, revision: revisionBefore };
      }
    }
    const store = await readStore();
    return { processos: store.processos, revision: localStoreRevision };
  }
  return readTransaction(async (client) => {
    const processes = await client.query(`
      SELECT data
      FROM app_processes
      ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
    `);
    const revision = await client.query("SELECT revision FROM app_state_revision WHERE id = true LIMIT 1");
    return {
      processos: processes.rows.map(deserializeRecord),
      revision: Number(revision.rows[0]?.revision || 0)
    };
  });
}

// PostgreSQL keeps process fields in JSONB. Keep these aggregates in the
// database so the dashboard does not need to deserialize every process just
// to calculate its cards and charts. The JSON fallback remains in server.js.
export async function readDashboardAggregates(year) {
  if (!(await requireConfiguredDatabase())) return null;
  const selectedYear = Number.isInteger(Number(year)) ? Number(year) : null;
  const result = await readTransaction(async (client) => client.query(DASHBOARD_AGGREGATES_SQL, [selectedYear]));
  return deserializeDashboardAggregates(result.rows[0]);
}

const DASHBOARD_AGGREGATES_SQL = `
  WITH source AS (
    SELECT
      data,
      COALESCE(NULLIF(data->>'dataEnvioFornecedor', ''), NULLIF(data->>'dataEnvioEmpenho', '')) AS prazo_data,
      COALESCE(NULLIF(data->>'dataLiquidacao', ''), NULLIF(data->>'dataEnvioLiquidacao', '')) AS liquidacao_data,
      NULLIF(data->>'dataPagamento', '') AS pagamento_data,
      COALESCE(data->>'status', '') AS status
    FROM app_processes
    WHERE COALESCE((data->>'inativo')::boolean, false) = false
  ), materiais AS (
    SELECT source.*, COALESCE((
      SELECT CASE
        WHEN bool_or(valor_unitario IS NULL OR quantidade IS NULL) THEN 0::numeric
        ELSE COALESCE(sum(round(round(valor_unitario * 10000) * quantidade / 100)), 0) / 100
      END
      FROM (
        SELECT
          CASE
            WHEN jsonb_typeof(material->'valorUnitario') = 'number' THEN (material->>'valorUnitario')::numeric
            WHEN jsonb_typeof(material->'valorUnitario') = 'boolean' THEN CASE material->>'valorUnitario' WHEN 'true' THEN 1 ELSE 0 END
            WHEN btrim(COALESCE(material->>'valorUnitario', '')) = '' THEN 0::numeric
            WHEN btrim(material->>'valorUnitario') ~ '^[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?$' THEN btrim(material->>'valorUnitario')::numeric
            ELSE NULL
          END AS valor_unitario,
          CASE
            WHEN jsonb_typeof(material->'quantidade') = 'number' THEN (material->>'quantidade')::numeric
            WHEN jsonb_typeof(material->'quantidade') = 'boolean' THEN CASE material->>'quantidade' WHEN 'true' THEN 1 ELSE 0 END
            WHEN btrim(COALESCE(material->>'quantidade', '')) = '' THEN 0::numeric
            WHEN btrim(material->>'quantidade') ~ '^[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?$' THEN btrim(material->>'quantidade')::numeric
            ELSE NULL
          END AS quantidade
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(source.data->'materiais') = 'array'
                 AND jsonb_array_length(source.data->'materiais') > 0 THEN source.data->'materiais'
            ELSE jsonb_build_array(jsonb_build_object(
              'descricao', source.data->'material',
              'valorUnitario', source.data->'valorUnitario',
              'quantidade', source.data->'quantidade'
            ))
          END
        ) AS material
        WHERE btrim(COALESCE(material->>'descricao', '')) <> ''
      ) AS itens
    ), 0::numeric) AS valor_total
    FROM source
  ), processos AS (
    SELECT materiais.*,
      CASE WHEN prazo_data ~ '^\\d{4}-\\d{2}-\\d{2}' THEN substring(prazo_data FROM 1 FOR 4)::integer END AS prazo_ano,
      CASE WHEN prazo_data ~ '^\\d{4}-\\d{2}-\\d{2}' THEN substring(prazo_data FROM 6 FOR 2)::integer END AS prazo_mes,
      CASE WHEN liquidacao_data ~ '^\\d{4}-\\d{2}-\\d{2}' THEN substring(liquidacao_data FROM 1 FOR 4)::integer END AS liquidacao_ano,
      CASE WHEN liquidacao_data ~ '^\\d{4}-\\d{2}-\\d{2}' THEN substring(liquidacao_data FROM 6 FOR 2)::integer END AS liquidacao_mes,
      CASE WHEN pagamento_data ~ '^\\d{4}-\\d{2}-\\d{2}' THEN substring(pagamento_data FROM 1 FOR 4)::integer END AS pagamento_ano,
      CASE WHEN pagamento_data ~ '^\\d{4}-\\d{2}-\\d{2}' THEN substring(pagamento_data FROM 6 FOR 2)::integer END AS pagamento_mes
    FROM materiais
  ), anos AS (
    SELECT DISTINCT ano
    FROM processos
    CROSS JOIN LATERAL unnest(ARRAY[prazo_ano, liquidacao_ano, pagamento_ano]) AS data(ano)
    WHERE ano IS NOT NULL
  ), escopo AS (
    SELECT * FROM processos WHERE prazo_ano = $1
  ), status_por_ano AS (
    SELECT status, count(*)::integer AS quantidade
    FROM escopo
    GROUP BY status
  ), execucao AS (
    SELECT mes, jsonb_build_object(
      'mes', CASE mes
        WHEN 1 THEN 'Jan' WHEN 2 THEN 'Fev' WHEN 3 THEN 'Mar' WHEN 4 THEN 'Abr'
        WHEN 5 THEN 'Mai' WHEN 6 THEN 'Jun' WHEN 7 THEN 'Jul' WHEN 8 THEN 'Ago'
        WHEN 9 THEN 'Set' WHEN 10 THEN 'Out' WHEN 11 THEN 'Nov' WHEN 12 THEN 'Dez'
      END,
      'empenhado', COALESCE((SELECT sum(valor_total) FROM processos WHERE status <> 'Anulado' AND prazo_ano = $1 AND prazo_mes = mes), 0),
      'liquidado', COALESCE((SELECT sum(valor_total) FROM processos WHERE status IN ('Liquidado', 'Pago') AND liquidacao_ano = $1 AND liquidacao_mes = mes), 0),
      'pago', COALESCE((SELECT sum(valor_total) FROM processos WHERE status = 'Pago' AND pagamento_ano = $1 AND pagamento_mes = mes), 0)
    ) AS linha
    FROM generate_series(1, 12) AS meses(mes)
  )
  SELECT
    COALESCE((SELECT jsonb_agg(ano ORDER BY ano DESC) FROM anos), '[]'::jsonb) AS anos,
    jsonb_build_object(
      'processosAtivos', (SELECT count(*)::integer FROM escopo WHERE status <> 'Anulado'),
      'aguardandoEntrega', (SELECT count(*)::integer FROM escopo WHERE status <> 'Anulado' AND (COALESCE(data->>'tipoObjeto', 'material') <> 'servico' OR data->>'acompanhamentoServico' = 'entrega') AND status IN ('Empenho enviado ao fornecedor', 'Aguardando entrega')),
      'atrasados', (SELECT count(*)::integer FROM escopo WHERE status <> 'Anulado' AND (COALESCE(data->>'tipoObjeto', 'material') <> 'servico' OR data->>'acompanhamentoServico' = 'entrega') AND status NOT IN ('Entregue', 'Aguardando envio para liquidacao', 'Enviado para liquidacao', 'Liquidado', 'Pago') AND prazo_data ~ '^\\d{4}-\\d{2}-\\d{2}$' AND to_char(to_date(prazo_data, 'YYYY-MM-DD'), 'YYYY-MM-DD') = prazo_data AND ((now() AT TIME ZONE 'America/Sao_Paulo')::date - prazo_data::date) > 30),
      'enviadosLiquidacao', (SELECT count(*)::integer FROM escopo WHERE status = 'Enviado para liquidacao'),
      'pendentesLiquidacao', (SELECT count(*)::integer FROM escopo WHERE status IN ('Entregue', 'Serviço concluído', 'Aguardando envio para liquidacao', 'Enviado para liquidacao') AND COALESCE(liquidacao_data, '') = ''),
      'valorEmpenhado', COALESCE((SELECT sum(valor_total) FROM escopo WHERE status <> 'Anulado'), 0),
      'valorLiquidado', COALESCE((SELECT sum(valor_total) FROM processos WHERE status IN ('Liquidado', 'Pago') AND liquidacao_ano = $1), 0),
      'valorPago', COALESCE((SELECT sum(valor_total) FROM processos WHERE status = 'Pago' AND pagamento_ano = $1), 0),
      'porStatus', COALESCE((SELECT jsonb_object_agg(status, quantidade) FROM status_por_ano), '{}'::jsonb)
    ) AS metricas,
    COALESCE((SELECT jsonb_agg(linha ORDER BY mes) FROM execucao), '[]'::jsonb) AS execucao_mensal,
    COALESCE((SELECT jsonb_object_agg(status, quantidade) FROM status_por_ano), '{}'::jsonb) AS distribuicao_status
`;

function deserializeDashboardAggregates(row = {}) {
  const statusCounts = row.distribuicao_status || {};
  const metrics = row.metricas || {};
  return {
    anos: (row.anos || []).map(Number).filter(Number.isFinite),
    metrics: {
      processosAtivos: Number(metrics.processosAtivos || 0),
      aguardandoEntrega: Number(metrics.aguardandoEntrega || 0),
      atrasados: Number(metrics.atrasados || 0),
      enviadosLiquidacao: Number(metrics.enviadosLiquidacao || 0),
      pendentesLiquidacao: Number(metrics.pendentesLiquidacao || 0),
      valorEmpenhado: Number(metrics.valorEmpenhado || 0),
      valorLiquidado: Number(metrics.valorLiquidado || 0),
      valorPago: Number(metrics.valorPago || 0),
      porStatus: STATUS
        .map((status) => [status, Number(metrics.porStatus?.[status] || 0)])
        .filter(([, quantidade]) => quantidade > 0)
    },
    charts: {
      execucaoMensal: (row.execucao_mensal || []).map((item) => ({
        mes: String(item.mes || ""),
        empenhado: Number(item.empenhado || 0),
        liquidado: Number(item.liquidado || 0),
        pago: Number(item.pago || 0)
      })),
      distribuicaoStatus: STATUS
        .map((status) => ({ status, quantidade: Number(statusCounts[status] || 0) }))
        .filter((item) => item.quantidade > 0)
    }
  };
}

function usersSelectSql(options = {}) {
  const passwordColumn = options.includePassword === false ? "''::text AS senha_hash" : "senha_hash";
  return `
    SELECT id, nome, email, foto_url, google_sub, origem_cadastro, ${passwordColumn},
           precisa_definir_senha, ativo, role, access_justification, access_requested_at,
           auth_version, criado_em, atualizado_em
    FROM app_users${options.orderBy === false ? "" : "\n    ORDER BY criado_em ASC, id ASC"}
  `;
}

function processPageWhereClause(filters = {}, quickFilters = []) {
  const clauses = ["COALESCE((data->>'inativo')::boolean, false) = false"];
  const values = [];
  const addValue = (value) => {
    values.push(value);
    return `$${values.length}`;
  };
  const status = String(filters.status || "").trim();
  const year = String(filters.ano || "").trim();
  const search = normalizeProcessSearch(filters.q);

  if (status) clauses.push(`data->>'status' = ${addValue(status)}`);
  if (year) {
    clauses.push(`substring(COALESCE(NULLIF(data->>'dataEnvioFornecedor', ''), NULLIF(data->>'dataEnvioEmpenho', '')) FROM 1 FOR 4) = ${addValue(year)}`);
  }
  if (search) {
    const searchValue = addValue(`%${escapeLikePattern(search)}%`);
    clauses.push(`(
      ${normalizedProcessTextSql("data->>'numeroProcesso'")} LIKE ${searchValue} ESCAPE '\\'
      OR ${normalizedProcessTextSql("data->>'numeroEmpenho'")} LIKE ${searchValue} ESCAPE '\\'
      OR ${normalizedProcessTextSql("data->>'numeroNotaFiscal'")} LIKE ${searchValue} ESCAPE '\\'
      OR ${normalizedProcessTextSql("data->>'fornecedor'")} LIKE ${searchValue} ESCAPE '\\'
      OR ${normalizedProcessTextSql("data->>'material'")} LIKE ${searchValue} ESCAPE '\\'
      OR ${normalizedProcessTextSql("data->>'status'")} LIKE ${searchValue} ESCAPE '\\'
      OR ${normalizedProcessTextSql("data->>'criadoPor'")} LIKE ${searchValue} ESCAPE '\\'
      OR ${normalizedProcessTextSql("data->>'criadoPorEmail'")} LIKE ${searchValue} ESCAPE '\\'
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(data->'materiais') = 'array' THEN data->'materiais' ELSE '[]'::jsonb END) AS material
        WHERE ${normalizedProcessTextSql("material->>'descricao'")} LIKE ${searchValue} ESCAPE '\\'
      )
    )`);
  }

  const selected = [...new Set(quickFilters.map((value) => String(value || "").trim()))]
    .filter((value) => QUICK_FILTERS.includes(value));
  if (selected.length) clauses.push(`(${selected.map(processQuickFilterSql).join(" OR ")})`);

  return { where: `\n    WHERE ${clauses.join("\n      AND ")}`, values };
}

function processQuickFilterSql(filter) {
  const status = "data->>'status'";
  const usesDelivery = "(COALESCE(data->>'tipoObjeto', 'material') <> 'servico' OR data->>'acompanhamentoServico' = 'entrega')";
  const deadline = "COALESCE(NULLIF(data->>'dataEnvioFornecedor', ''), NULLIF(data->>'dataEnvioEmpenho', ''))";
  const deliveryReached = "('Entregue', 'Aguardando envio para liquidacao', 'Enviado para liquidacao', 'Liquidado', 'Pago')";
  if (["Em atraso", "Mais de 30 dias"].includes(filter)) {
    return `(${usesDelivery} AND ${deadline} IS NOT NULL AND ${deadline}::date < ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 30) AND ${status} <> 'Anulado' AND ${status} NOT IN ${deliveryReached})`;
  }
  if (filter === "Aguardando entrega") return `(${usesDelivery} AND ${status} IN ('Empenho enviado ao fornecedor', 'Aguardando entrega'))`;
  if (filter === "Pendentes de liquidacao") return `(${status} IN ('Entregue', 'Serviço concluído', 'Aguardando envio para liquidacao', 'Enviado para liquidacao') AND COALESCE(data->>'dataLiquidacao', '') = '')`;
  return `${status} = '${filter.replace(/'/g, "''")}'`;
}

function normalizedProcessTextSql(expression) {
  return `translate(lower(COALESCE(${expression}, '')), 'áàâãäåéèêëíìîïóòôõöúùûüçñ', 'aaaaaaeeeeiiiiooooouuuucn')`;
}

function normalizeProcessSearch(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function escapeLikePattern(value = "") {
  return String(value).replace(/[\\%_]/g, "\\$&");
}

function positivePageValue(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function writeStore(store, options = {}) {
  const preparedStore = prepareStoreForPersistence(store);
  const securityEvents = prepareSecurityEvents(options);
  writeQueue = writeQueue.then(
    () => persistStore(preparedStore, securityEvents),
    () => persistStore(preparedStore, securityEvents)
  );
  return writeQueue;
}

export async function writeProcessRecords(store, options = {}) {
  const preparedStore = prepareStoreForPersistence(store);
  const processIds = new Set((options.processIds || []).map(textId));
  const auditIds = new Set((options.auditIds || []).map(textId));
  if (!processIds.size) throw new TypeError("Informe ao menos um processo para persistir.");
  const processes = preparedStore.processos.filter((record) => processIds.has(record.id));
  const auditEntries = preparedStore.auditoria.filter((record) => auditIds.has(record.id));
  if (processes.length !== processIds.size) throw new Error("Um dos processos selecionados nao existe no estado atual.");
  if (auditEntries.length !== auditIds.size) throw new Error("Um dos eventos de auditoria selecionados nao existe no estado atual.");
  writeQueue = writeQueue.then(
    () => persistProcessRecords(preparedStore, processes, auditEntries),
    () => persistProcessRecords(preparedStore, processes, auditEntries)
  );
  return writeQueue;
}

async function persistProcessRecords(store, processes, auditEntries) {
  if (!(await requireConfiguredDatabase())) {
    await persistStore(store, []);
    return;
  }
  const committedRevision = await transaction(async (client) => {
    const expectedRevision = Number.isInteger(store.__revision) ? store.__revision : null;
    const revisionResult = expectedRevision === null
      ? await client.query("UPDATE app_state_revision SET revision = revision + 1 WHERE id = true RETURNING revision")
      : await client.query(
        "UPDATE app_state_revision SET revision = revision + 1 WHERE id = true AND revision = $1 RETURNING revision",
        [expectedRevision]
      );
    if (!revisionResult.rowCount) {
      const error = new Error("Os dados foram alterados por outro usuario. Atualize a tela e tente novamente.");
      error.statusCode = 409;
      throw error;
    }
    await insertRecords(client, "app_processes", processes, ["criadoEm", "atualizadoEm"]);
    await insertRecords(client, "app_process_audit", auditEntries, ["criadoEm"], {
      processIdKey: "processoId",
      immutable: true
    });
    return Number(revisionResult.rows[0].revision);
  });
  store.__revision = committedRevision;
  localStoreRevision += 1;
}

async function persistStore(store, securityEvents) {
  if (await requireConfiguredDatabase()) {
    await writeDatabaseStore(store, securityEvents);
    localStoreRevision += 1;
    return;
  }

  const expectedRevision = Number.isSafeInteger(store.__revision) ? store.__revision : localStoreRevision;
  if (expectedRevision !== localStoreRevision) {
    const error = new Error("Os dados foram alterados por outro usuario. Atualize a tela e tente novamente.");
    error.statusCode = 409;
    throw error;
  }
  const committedRevision = localStoreRevision + 1;
  store.__revision = committedRevision;
  await atomicWriteStore(store);
  localStoreRevision = committedRevision;
  for (const event of securityEvents) {
    await recordSecurityEvent(event.eventType, event);
  }
}

async function atomicWriteStore(store) {
  const dir = dirname(STORE_FILE);
  const tempPath = join(dir, `.store.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`);
  await ensurePrivateDirectory(dir);

  let handle;
  try {
    handle = await open(
      tempPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, STORE_FILE);
    const storedFile = await openRegularFileNoFollow(STORE_FILE, { root: dir, mode: 0o600 });
    await storedFile.handle.close();

    // Persist the directory entry as well as file contents before reporting a
    // successful atomic replacement.
    const { handle: directoryHandle } = await openDirectoryNoFollow(dir, { mode: 0o700 });
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => null);
    await rm(tempPath, { force: true }).catch(() => null);
    throw error;
  }
}

async function readDatabaseStore() {
  return readTransaction(async (client) => {
    // All collections and the revision now come from the same PostgreSQL
    // snapshot. Mixing pool clients here could return a revision newer than
    // some collections and make a stale full-state write look valid.
    // node-postgres does not support concurrent query() calls on one client.
    // Explicit sequencing keeps every read in this snapshot and is compatible
    // with pg 9, which removes the old implicit queueing behavior.
    const users = await client.query(usersSelectSql());
    const settings = await client.query(`
      SELECT value
      FROM app_settings
      WHERE key = 'configuracoes'
      LIMIT 1
    `);
    const processes = await client.query(`
      SELECT data
      FROM app_processes
      ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
    `);
    const suppliers = await client.query(`
      SELECT data
      FROM app_suppliers
      ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
    `);
    const observations = await client.query(`
      SELECT data
      FROM app_process_observations
      ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
    `);
    const audit = await client.query(`
      SELECT data
      FROM app_process_audit
      ORDER BY created_at DESC, id DESC
    `);
    const emailHistory = await client.query(`
      SELECT data
      FROM app_email_history
      ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
    `);
    const revision = await client.query("SELECT revision FROM app_state_revision WHERE id = true");

    return {
      processos: processes.rows.map(deserializeRecord),
      fornecedores: suppliers.rows.map(deserializeRecord),
      auditoria: audit.rows.map(deserializeRecord),
      observacoes: observations.rows.map(deserializeRecord),
      emailHistorico: emailHistory.rows.map(deserializeRecord),
      usuarios: users.rows.map(deserializeUser),
      configuracoes: settings.rows[0]?.value || {},
      __revision: Number(revision.rows[0]?.revision || 0)
    };
  });
}

async function writeDatabaseStore(store, securityEvents) {
  const committedRevision = await transaction(async (client) => {
    const expectedRevision = Number.isInteger(store.__revision) ? store.__revision : null;
    const revisionResult = expectedRevision === null
      ? await client.query("UPDATE app_state_revision SET revision = revision + 1 WHERE id = true RETURNING revision")
      : await client.query(
        "UPDATE app_state_revision SET revision = revision + 1 WHERE id = true AND revision = $1 RETURNING revision",
        [expectedRevision]
      );
    if (!revisionResult.rowCount) {
      const error = new Error("Os dados foram alterados por outro usuario. Atualize a tela e tente novamente.");
      error.statusCode = 409;
      throw error;
    }
    await upsertUsers(client, store.usuarios || []);
    await upsertSettings(client, store.configuracoes || {});

    await insertRecords(client, "app_processes", store.processos || [], ["criadoEm", "atualizadoEm"]);
    await insertRecords(client, "app_suppliers", store.fornecedores || [], ["criadoEm", "atualizadoEm"]);
    await insertRecords(client, "app_process_observations", store.observacoes || [], ["criadoEm", "atualizadoEm"], {
      processIdKey: "processoId"
    });
    await insertRecords(client, "app_process_audit", store.auditoria || [], ["criadoEm"], {
      processIdKey: "processoId",
      immutable: true
    });
    await insertRecords(client, "app_email_history", store.emailHistorico || [], ["criadoEm", "enviadoEm", "updatedAt"], {
      processIdKey: "processoId",
      dedupeKey: "dedupeKey"
    });
    await deleteMissingRecords(client, "app_process_observations", store.observacoes || []);
    await deleteMissingRecords(client, "app_email_history", store.emailHistorico || []);
    for (const event of securityEvents) {
      await recordSecurityEvent(event.eventType, event, { client });
    }
    return Number(revisionResult.rows[0].revision);
  });
  store.__revision = committedRevision;
}

async function upsertUsers(client, users) {
  if (!users.length) return;
  const rows = users.map((user) => ({
    id: textId(user.id),
    nome: text(user.nome || user.name || user.email || "Usuario"),
    email: normalizeEmail(user.email),
    foto_url: text(user.foto || user.fotoUrl),
    google_sub: nullableText(user.googleSub),
    origem_cadastro: text(user.origemCadastro || "local"),
    senha_hash: text(user.senhaHash),
    precisa_definir_senha: Boolean(user.precisaDefinirSenha),
    auth_version: positiveAuthVersion(user.authVersion),
    ativo: user.ativo !== false,
    role: normalizeRole(user.role, user.email),
    access_justification: text(user.justificativaAcesso),
    access_requested_at: timestamp(user.solicitadoEm || (user.origemCadastro === "solicitacao" ? user.criadoEm : "")),
    criado_em: timestamp(user.criadoEm),
    atualizado_em: timestamp(user.atualizadoEm)
  }));
  await client.query(`
    INSERT INTO app_users (
      id, nome, email, foto_url, google_sub, origem_cadastro, senha_hash,
      precisa_definir_senha, ativo, role, access_justification, access_requested_at, auth_version,
      criado_em, atualizado_em
    )
    SELECT
      x.id, x.nome, x.email, x.foto_url, x.google_sub, x.origem_cadastro, x.senha_hash,
      x.precisa_definir_senha, x.ativo, x.role, x.access_justification,
      x.access_requested_at::timestamptz, x.auth_version,
      COALESCE(x.criado_em::timestamptz, now()),
      COALESCE(x.atualizado_em::timestamptz, now())
    FROM jsonb_to_recordset($1::jsonb) AS x(
      id text, nome text, email text, foto_url text, google_sub text,
      origem_cadastro text, senha_hash text, precisa_definir_senha boolean,
      ativo boolean, role text, access_justification text,
      access_requested_at text, auth_version bigint, criado_em text, atualizado_em text
    )
    WHERE true
    ON CONFLICT (id) DO UPDATE SET
      nome = EXCLUDED.nome,
      email = EXCLUDED.email,
      foto_url = EXCLUDED.foto_url,
      google_sub = EXCLUDED.google_sub,
      origem_cadastro = EXCLUDED.origem_cadastro,
      senha_hash = EXCLUDED.senha_hash,
      precisa_definir_senha = EXCLUDED.precisa_definir_senha,
      ativo = EXCLUDED.ativo,
      role = EXCLUDED.role,
      access_justification = EXCLUDED.access_justification,
      access_requested_at = EXCLUDED.access_requested_at,
      auth_version = EXCLUDED.auth_version,
      atualizado_em = EXCLUDED.atualizado_em
    WHERE app_users.nome IS DISTINCT FROM EXCLUDED.nome
       OR app_users.email IS DISTINCT FROM EXCLUDED.email
       OR app_users.foto_url IS DISTINCT FROM EXCLUDED.foto_url
       OR app_users.google_sub IS DISTINCT FROM EXCLUDED.google_sub
       OR app_users.origem_cadastro IS DISTINCT FROM EXCLUDED.origem_cadastro
       OR app_users.senha_hash IS DISTINCT FROM EXCLUDED.senha_hash
       OR app_users.precisa_definir_senha IS DISTINCT FROM EXCLUDED.precisa_definir_senha
       OR app_users.ativo IS DISTINCT FROM EXCLUDED.ativo
       OR app_users.role IS DISTINCT FROM EXCLUDED.role
       OR app_users.access_justification IS DISTINCT FROM EXCLUDED.access_justification
       OR app_users.access_requested_at IS DISTINCT FROM EXCLUDED.access_requested_at
       OR app_users.auth_version IS DISTINCT FROM EXCLUDED.auth_version
  `, [JSON.stringify(rows)]);
}

async function upsertSettings(client, settings) {
  await client.query(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('configuracoes', $1::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = EXCLUDED.updated_at
    WHERE app_settings.value IS DISTINCT FROM EXCLUDED.value
  `, [JSON.stringify(settings)]);
}

async function insertRecords(client, table, records, timestampKeys = [], options = {}) {
  if (!records.length) return;
  const rows = records.map((record) => ({
    id: textId(record.id),
    data: record,
    created_at: firstTimestamp(record, timestampKeys),
    updated_at: firstTimestamp(record, [
      "atualizadoEm",
      "updatedAt",
      ...timestampKeys.filter((key) => key !== "atualizadoEm")
    ]),
    processo_id: options.processIdKey ? text(record[options.processIdKey]) : null,
    dedupe_key: options.dedupeKey ? nullableText(record[options.dedupeKey]) : null
  }));
  const columns = options.immutable
    ? ["id", "data", "created_at"]
    : ["id", "data", "created_at", "updated_at"];
  const selectColumns = options.immutable
    ? ["x.id", "x.data", "COALESCE(x.created_at::timestamptz, now())"]
    : [
        "x.id",
        "x.data",
        "COALESCE(x.created_at::timestamptz, now())",
        "COALESCE(x.updated_at::timestamptz, now())"
      ];
  if (options.processIdKey) {
    columns.push("processo_id");
    selectColumns.push("x.processo_id");
  }
  if (options.dedupeKey) {
    columns.push("dedupe_key");
    selectColumns.push("x.dedupe_key");
  }
  const conflictClause = options.immutable
    ? "DO NOTHING"
    : `DO UPDATE SET
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at${options.processIdKey ? ",\n       processo_id = EXCLUDED.processo_id" : ""}${options.dedupeKey ? ",\n       dedupe_key = EXCLUDED.dedupe_key" : ""}`;
  const updatePredicate = options.immutable
    ? ""
    : ` WHERE ${table}.data IS DISTINCT FROM EXCLUDED.data${options.processIdKey ? ` OR ${table}.processo_id IS DISTINCT FROM EXCLUDED.processo_id` : ""}${options.dedupeKey ? ` OR ${table}.dedupe_key IS DISTINCT FROM EXCLUDED.dedupe_key` : ""}`;

  await client.query(`
    INSERT INTO ${table} (${columns.join(", ")})
    SELECT ${selectColumns.join(", ")}
    FROM jsonb_to_recordset($1::jsonb) AS x(
      id text, data jsonb, created_at text, updated_at text,
      processo_id text, dedupe_key text
    )
    WHERE true
    ON CONFLICT (id) ${conflictClause}${updatePredicate}
  `, [JSON.stringify(rows)]);
}

async function deleteMissingRecords(client, table, records) {
  const ids = records.map((record) => textId(record.id));
  if (!ids.length) {
    await client.query(`DELETE FROM ${table}`);
    return;
  }
  await client.query(`DELETE FROM ${table} WHERE NOT (id = ANY($1::text[]))`, [ids]);
}

export async function inspectDatabaseSchema(options = {}) {
  const configured = options.databaseConfigured ?? databaseConfigured();
  const cacheable = options.databaseConfigured === undefined && options.query === undefined;
  if (!configured) {
    return {
      configured: false,
      ready: false,
      schema: "public",
      missingObjects: [],
      pendingMigration: null
    };
  }
  if (cacheable && databaseReadyConfirmed) {
    return {
      configured: true,
      ready: true,
      schema: "public",
      missingObjects: [],
      pendingMigration: null
    };
  }

  const executeQuery = options.query || query;
  const result = await executeQuery(`
    SELECT object_name
    FROM unnest($1::text[]) AS required(object_name)
    WHERE to_regclass(format('public.%I', object_name)) IS NULL
    ORDER BY object_name
  `, [REQUIRED_DATABASE_TABLES]);
  const missingObjects = result.rows.map((row) => `public.${row.object_name}`).sort();
  let migrationCurrent = false;

  if (!missingObjects.includes("public.app_schema_migrations")) {
    const migration = await executeQuery(`
      SELECT EXISTS (
        SELECT 1
        FROM public.app_schema_migrations
        WHERE version = $1
      ) AS migration_current
    `, [EXPECTED_SCHEMA_MIGRATION]);
    migrationCurrent = Boolean(migration.rows[0]?.migration_current);
  }

  const inspection = {
    configured: true,
    ready: missingObjects.length === 0 && migrationCurrent,
    schema: "public",
    missingObjects,
    pendingMigration: migrationCurrent ? null : EXPECTED_SCHEMA_MIGRATION
  };
  if (cacheable && inspection.ready) databaseReadyConfirmed = true;
  return inspection;
}

export async function detectStoreBackend() {
  if (await requireConfiguredDatabase()) return "postgres";
  return "json";
}

export async function requireConfiguredDatabase(options = {}) {
  const configured = options.databaseConfigured ?? databaseConfigured();
  if (!configured) return false;
  let inspection;
  try {
    inspection = await inspectDatabaseSchema(options);
  } catch (cause) {
    const error = new Error("PostgreSQL configurado, mas indisponivel ou sem permissao para consultar o schema public. Verifique conectividade, SSL e permissoes.", { cause });
    Object.assign(error, {
      statusCode: 503,
      databaseState: "unavailable",
      databaseTarget: options.databaseTarget || databaseTargetSummary(),
      schema: "public",
      suggestedAction: "Verifique DATABASE_URL, DB_SSL, conectividade e permissoes de leitura no schema public."
    });
    throw error;
  }
  if (!inspection.ready) {
    const details = [];
    if (inspection.missingObjects.length) details.push(`Objetos ausentes: ${inspection.missingObjects.join(", ")}.`);
    if (inspection.pendingMigration) details.push(`Migration pendente: ${inspection.pendingMigration}.`);
    const schemaHistoryCurrent = inspection.missingObjects.length > 0 && !inspection.pendingMigration;
    const resolution = schemaHistoryCurrent
      ? "O historico de migrations esta atual, mas o schema foi alterado ou corrompido; repare-o de forma controlada ou restaure-o de um backup."
      : "Execute npm run db:migrate:production antes de iniciar.";
    const error = new Error(`PostgreSQL conectado, mas o schema esta incompleto. ${details.join(" ")} ${resolution}`);
    Object.assign(error, {
      statusCode: 503,
      databaseState: "schema_incomplete",
      databaseTarget: options.databaseTarget || databaseTargetSummary(),
      schema: inspection.schema,
      missingObjects: inspection.missingObjects,
      pendingMigration: inspection.pendingMigration,
      suggestedAction: schemaHistoryCurrent
        ? "Nao marque migrations manualmente. Repare os objetos ausentes de forma controlada ou restaure um backup compativel."
        : "Execute npm run db:migrate:production e confirme que DATABASE_URL_MIGRATION aponta para o mesmo banco de DATABASE_URL."
    });
    throw error;
  }
  return true;
}

export function resolveStoreFilePath() {
  if (!isTestRuntime()) {
    return process.env.APP_STORE_PATH ? resolve(process.env.APP_STORE_PATH) : DEFAULT_STORE_FILE;
  }
  const testRoot = resolve(
    process.env.TEST_STORAGE_ROOT || join(tmpdir(), "almoxarifado-tests")
  );
  return join(testRoot, String(process.pid), "store.json");
}

export function prepareStoreForPersistence(store, options = {}) {
  if (!store || typeof store !== "object" || Array.isArray(store)) {
    throw new TypeError("O estado a persistir deve ser um objeto.");
  }

  for (const [key, label] of [
    ["processos", "processo"],
    ["fornecedores", "fornecedor"],
    ["auditoria", "auditoria"],
    ["observacoes", "observacao"],
    ["emailHistorico", "historico de e-mail"],
    ["usuarios", "usuario"]
  ]) {
    const records = store[key] ?? [];
    if (!Array.isArray(records)) throw new TypeError(`${key} deve ser uma lista.`);
    ensureRecordIds(records, label);
    store[key] = records;
  }

  const processIds = new Set(store.processos.map((record) => record.id));
  for (const [key, label] of [["auditoria", "auditoria"], ["observacoes", "observacao"]]) {
    for (const record of store[key]) {
      const processId = text(record.processoId);
      if (!processId) {
        throw new Error(`${label} ${record.id} nao possui processoId.`);
      }
      if (!options.allowExternalProcessReferences && !processIds.has(processId)) {
        throw new Error(`${label} ${record.id} referencia processo inexistente ${processId}.`);
      }
    }
  }

  if (!store.configuracoes || typeof store.configuracoes !== "object" || Array.isArray(store.configuracoes)) {
    store.configuracoes = {};
  }
  return store;
}

export function prepareSecurityEvents(options = {}) {
  const input = Array.isArray(options) ? options : (options.securityEvents || []);
  if (!Array.isArray(input)) throw new TypeError("securityEvents deve ser uma lista.");
  if (input.length > 50) throw new RangeError("Uma gravacao aceita no maximo 50 eventos de seguranca.");
  return input.map((event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new TypeError("Evento de seguranca invalido.");
    }
    const eventType = text(event.eventType).slice(0, 100);
    if (!eventType) throw new TypeError("eventType e obrigatorio no evento de seguranca.");
    return {
      eventType,
      actorUserId: nullableText(event.actorUserId),
      actorEmail: normalizeEmail(event.actorEmail),
      targetUserId: nullableText(event.targetUserId),
      metadata: cloneJson(event.metadata || {})
    };
  });
}

function ensureRecordIds(records, label) {
  const ids = new Set();
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new TypeError(`Registro de ${label} invalido.`);
    }
    const id = text(record.id) || crypto.randomUUID();
    if (ids.has(id)) throw new Error(`ID duplicado em ${label}: ${id}.`);
    record.id = id;
    ids.add(id);
  }
}

function deserializeRecord(row = {}) {
  return cloneJson(Object.prototype.hasOwnProperty.call(row, "data") ? row.data : row);
}

function deserializeUser(row = {}) {
  return {
    id: row.id,
    nome: row.nome,
    email: row.email,
    foto: row.foto_url || "",
    googleSub: row.google_sub || "",
    origemCadastro: row.origem_cadastro || "local",
    senhaHash: row.senha_hash || "",
    precisaDefinirSenha: Boolean(row.precisa_definir_senha),
    authVersion: positiveAuthVersion(row.auth_version),
    ativo: row.ativo !== false,
    role: row.role || "",
    justificativaAcesso: row.access_justification || "",
    solicitadoEm: toIsoString(row.access_requested_at),
    criadoEm: toIsoString(row.criado_em),
    atualizadoEm: toIsoString(row.atualizado_em)
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function toIsoString(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function firstTimestamp(record = {}, keys = []) {
  for (const key of keys) {
    const value = record?.[key];
    const normalized = timestamp(value);
    if (normalized) return normalized;
  }
  return null;
}

function emptyStore() {
  return {
    processos: [],
    fornecedores: [],
    auditoria: [],
    observacoes: [],
    emailHistorico: [],
    usuarios: [],
    configuracoes: {},
    __revision: localStoreRevision
  };
}

function text(value = "") {
  return String(value ?? "").trim();
}

function nullableText(value = "") {
  const result = text(value);
  return result || null;
}

function textId(value = "") {
  const result = text(value);
  if (!result) throw new Error("ID obrigatorio ausente durante a persistencia.");
  return result;
}

function normalizeEmail(value = "") {
  return String(value).trim().toLowerCase();
}

function positiveAuthVersion(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function timestamp(value = "") {
  const result = text(value);
  if (!result) return null;
  const parsed = new Date(result);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeRole(role, email = "") {
  const value = String(role || "").trim().toLowerCase();
  if (["admin", "almoxarifado", "auditor"].includes(value)) return value;
  return normalizeEmail(email) === normalizeEmail(process.env.LOCAL_ADMIN_EMAIL || "") ? "admin" : "almoxarifado";
}
