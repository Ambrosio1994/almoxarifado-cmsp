# Inventario estatico de permissoes PostgreSQL de runtime

Data: 2026-09-05
Escopo: codigo versionado; esta analise **nao** abre conexao PostgreSQL, nao
inspeciona ACLs efetivas, nao altera roles e nao executa DDL/DML.

## Separacao obrigatoria de identidades

Ha duas credenciais com responsabilidades diferentes:

| Identidade | Uso | Pode receber DDL/ownership? |
| --- | --- | --- |
| runtime da aplicacao (`DATABASE_URL`; configuracao documentada usa `almoxarifado_app`) | `src/server.js`, `src/storage.js` e repositorios durante requisicoes e manutencao | Nao. Deve permanecer sem atributos administrativos e sem ownership dos objetos do `public`. |
| migracao (`DATABASE_URL_MIGRATION`; a configuracao Neon documentada usa a role proprietaria, `neondb_owner`) | `scripts/db-migrate.js`, antes de iniciar o servidor | Sim, somente durante uma janela controlada. A role precisa ser dona dos objetos que uma migration altera; `ALTER`/`DROP INDEX` nao sao substituidos por um `GRANT` comum. |

`DATABASE_URL_MIGRATION` e selecionada pelo runner quando presente. O runner usa uma
sessao direta, `SET search_path TO public`, `pg_advisory_lock`, uma transacao por
migration e grava a versao aplicada. Portanto, a credencial de migration nao deve
ser reutilizada pela aplicacao para contornar falta de permissao.

## Premissas e limites

- O banco e PostgreSQL 15+; o schema previsto e `public`.
- O inventario vem de `src/storage.js`, `src/repositories/`,
  `src/uploads/{upload-storage,replace-upload-document}.js`,
  `scripts/db-migrate.js`, `db/migrations/*.sql` e do contrato em
  `src/db/schema-contract.js`.
- Ele descreve o que o codigo atual pode executar. Nao prova que todas as rotas
  foram exercitadas em producao nem revela grants por `PUBLIC`, memberships,
  default privileges, RLS, ownership ou objetos adicionais.
- A aplicacao falha no startup se `DATABASE_URL` estiver configurada e nao puder
  consultar o schema/versao esperada; nao e seguro remover a permissao de leitura
  de `app_schema_migrations` como parte de uma reducao de privilegios.

Antes de qualquer mudanca, capture a ACL e memberships atuais por uma conexao de
auditoria autorizada:

```bash
DATABASE_URL_AUDIT='postgresql://...' POSTGRES_RUNTIME_ROLE=almoxarifado_app \
  npm run db:audit-runtime-role
```

O comando acima e somente leitura. Tambem rode o verificador de schema com o owner
esperado antes da janela; a configuracao documentada usa
`DATABASE_SCHEMA_OWNER=neondb_owner npm run db:verify-schema`.

## Superficie de runtime: tabelas, operacoes e colunas

As colunas abaixo sao as referenciadas pelas consultas atuais. `I/U` representa
`INSERT ... ON CONFLICT DO UPDATE`, portanto a role precisa de `INSERT`, dos
`UPDATE` indicados e de `SELECT` nas colunas lidas pelo `WHERE`, `RETURNING` ou
expressoes do conflito. Como o armazenamento historico e de colecoes inteiras,
algumas tabelas precisam de DML amplo; uma divisao por coluna exigiria manter esta
matriz a cada nova consulta.

| Tabela | SELECT (colunas) | INSERT / UPDATE (colunas) | DELETE | Chamadores de runtime |
| --- | --- | --- | --- | --- |
| `app_schema_migrations` | `version` para readiness; o runner tambem lista versoes | nenhum no servidor | nao | `inspectDatabaseSchema`; runner e somente migration |
| `app_users` | `id, nome, email, foto_url, google_sub, origem_cadastro, senha_hash, precisa_definir_senha, ativo, role, access_justification, access_requested_at, auth_version, criado_em, atualizado_em` | I: as mesmas; U: todas exceto `id` e `criado_em` | nao | login/perfil/admin via `readUserBy*`, `readStore` e `writeStore`; sessao le usuario por `id` |
| `user_sessions` | `token_hash, user_id, auth_version, last_activity_at, expires_at, revoked_at` e, no join, `app_users.id/auth_version/ativo` | I: `token_hash, user_id, created_at, last_activity_at, expires_at, auth_version`; U: os mesmos campos da sessao mais `revoked_at` | sim, por expiracao/revogacao retida | `repositories/sessions.js`; manutencao diaria iniciada por `src/server.js` |
| `app_settings` | `key, value` | I/U: `key, value, updated_at` | nao | configuracoes via `storage`; identidade do backend de uploads via `upload-storage` |
| `app_processes` | `id, data, created_at, updated_at`; filtros leem chaves JSONB de `data` (`inativo`, status, datas, numeros, fornecedor, material, criador e materiais) | I: `id, data, created_at, updated_at`; U: `data, updated_at` | nao | listagem/paginacao/dashboard/uploads e mutacoes de processo; substituicao controlada de documento bloqueia a linha com `FOR UPDATE` |
| `app_suppliers` | `id, data, created_at, updated_at` | I: `id, data, created_at, updated_at`; U: `data, updated_at` | nao | fornecedores, `readStore`/`writeStore` |
| `app_process_observations` | `id, processo_id, data, created_at, updated_at` | I: todos; U: `data, processo_id, updated_at` | sim, pela sincronizacao de observacoes ausentes | observacoes de processo via `writeStore` |
| `app_process_audit` | `id, processo_id, data, created_at` | somente I: `id, processo_id, data, created_at` (`ON CONFLICT DO NOTHING`) | **nao** | historico/auditoria via `writeStore`, `writeProcessRecords` e reposicao de documento |
| `app_email_history` | `id, dedupe_key, processo_id, data, created_at, updated_at` | I: todos; U: `data, processo_id, dedupe_key, updated_at` | sim, pela sincronizacao de historico ausente | scheduler de e-mail via `readStore`/`writeStore` |
| `app_state_revision` | `id, revision` (linha `id = true`, inclusive na expressao de incremento) | somente U: `revision = revision + 1`, com `RETURNING revision` | nao | controle otimista e cache de dashboard/uploads; toda escrita de store e reposicao de documento |
| `app_email_dispatch_claims` | `dedupe_key, status, metadata, updated_at` nas clausulas de conflito/`WHERE`; `RETURNING dedupe_key` nas escritas | I: `dedupe_key, status, metadata, claimed_at, updated_at`; U: `status, metadata, claimed_at, updated_at, last_error, sent_at, result` | nao | claim/complete/fail do scheduler em `repositories/email-dispatches.js` |
| `auth_rate_limits` | `rate_key, attempts, window_started_at` | I/U: `rate_key, attempts, window_started_at, updated_at` | sim, ao limpar login bem-sucedido e na manutencao | controle de tentativas de login em `repositories/rate-limits.js` |
| `app_security_audit` | `id, event_type, actor_user_id, actor_email, target_user_id, metadata, created_at` | somente I: todos | **nao** | eventos de autenticacao/administracao e consulta administrativa via `repositories/security-audit.js` |

Observacoes de integridade:

- As constraints/indices impedem algumas violacoes, mas nao substituem a
  autorizacao e validacao no servidor. O runtime deve continuar usando as rotas
  que verificam sessao, role, transicoes e a protecao de `Pago`.
- `app_process_audit` e `app_security_audit` possuem trigger `BEFORE UPDATE OR
  DELETE` que sempre levanta excecao. Nao conceder `UPDATE`/`DELETE` a runtime
  nesses dois objetos preserva tambem o principio de menor privilegio.
- `app_process_observations` e `app_email_history` realmente precisam de
  `DELETE` no codigo atual: `deleteMissingRecords` remove linhas que deixaram de
  existir na colecao persistida. A remocao desse privilegio quebraria edicao de
  observacao e sincronizacao do historico de e-mail.
- A aplicacao cria UUIDs no cliente ou os fornece explicitamente para as linhas
  de runtime. O contrato declara `sequences: []`; nao ha `serial`/`identity` no
  schema e, portanto, nao ha `USAGE`/`SELECT` de sequence a conceder hoje.

## Objetos existentes sem uso DML pela aplicacao em runtime

As tabelas abaixo pertencem ao schema e aparecem no contrato/migrations, mas uma
busca estatica nao encontrou consulta de runtime da aplicacao contra elas. Elas
nao devem receber grant para `almoxarifado_app` apenas por existirem:

> Nota (012): `012_drop_legacy_tables` remove as quatro tabelas abaixo. Depois de
> aplicada, esta secao deixa de se aplicar a elas.

| Objeto | Uso encontrado |
| --- | --- |
| `email_templates` | seed da migration `001_initial_schema`; nenhum leitor/escritor runtime atual |
| `email_template_attachments` | somente definicao de schema/migration no codigo atual |
| `notification_rules` | seed e ajuste de dados nas migrations `001`/`005` |
| `notification_recipients` | somente definicao de schema/migration no codigo atual |

## Funcoes, extensoes, triggers e sequences

| Objeto | Runtime | Proposta de privilegio |
| --- | --- | --- |
| schema `public` | Todas as relacoes de runtime estao nele; `to_regclass` e consultas de readiness precisam resolver objetos | `USAGE` para runtime; sem `CREATE` |
| `public.prevent_process_audit_mutation()` | Funcao de trigger de imutabilidade para as duas tabelas de auditoria; nao ha `SELECT funcao()` no app | Nao conceder `EXECUTE` explicitamente ao runtime sem a auditoria confirmar necessidade. A role nao cria/altera triggers. |
| `pgcrypto.gen_random_uuid()` e `citext` | Extensoes instaladas por migration; UUIDs default existem no schema, embora o runtime forneca IDs nas escritas analisadas | Nenhum grant de extensao/DDL para runtime. Verificar ACL efetiva de funcoes de extensao antes de revogar `PUBLIC`; nao revogar por suposicao. |
| `pg_advisory_lock`, `pg_advisory_unlock`, `hashtext` | Somente `scripts/db-migrate.js` | Credencial de migration, nao runtime. Sao chamadas de funcao builtin; nao criar grant adicional sem necessidade comprovada. |
| sequences em `public` | Nenhuma esperada pelo contrato atual | Nenhum grant. Reavaliar se uma migration futura introduzir `serial`, `identity` ou `nextval`. |

## Proposta de menor privilegio para a role de runtime

Esta e uma matriz-alvo, nao um script para executar sem a captura de ACL atual.
Ela assume que o owner preserva ownership de schema, tabelas, indices, triggers,
funcoes e extensoes, e que nao ha RLS adicional a acomodar.

| Categoria | Grant minimo proposto |
| --- | --- |
| Schema | `USAGE ON SCHEMA public` somente |
| Leitura | `SELECT` em todas as 13 tabelas da matriz de runtime, inclusive `app_schema_migrations` e as tabelas de auditoria |
| Escrita de colecoes | `INSERT, UPDATE` em `app_users`, `app_settings`, `app_processes`, `app_suppliers`, `app_process_observations`, `app_email_history`; `DELETE` somente em `app_process_observations` e `app_email_history` |
| Escrita de suporte | `INSERT, UPDATE, DELETE` em `user_sessions` e `auth_rate_limits`; `UPDATE` em `app_state_revision`; `INSERT, UPDATE` em `app_email_dispatch_claims` |
| Escrita append-only | `INSERT` em `app_process_audit` e `app_security_audit`, sem `UPDATE`/`DELETE` |
| Explicitamente fora | `CREATE` no schema/database, `TEMP` se nao for comprovadamente necessario, ownership, `ALTER`, `DROP`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, `EXECUTE` em funcoes de negocio e todos os grants nas quatro tabelas sem uso runtime |

Uma implementacao por coluna so deve ser feita depois de testes de integracao
contra um clone: `ON CONFLICT DO UPDATE`, `RETURNING`, joins e expressoes JSONB
podem exigir `SELECT` adicional mesmo quando a operacao principal e escrita. A
matriz por tabela acima e o menor conjunto operacional sustentavel pelo codigo
atual; nao usar `GRANT ALL` como atalho.

## Superficie exclusiva de migration (DDL e DML de dados da migration)

O executor em `scripts/db-migrate.js` sempre seleciona e registra versoes em
`public.app_schema_migrations`; cada arquivo tambem pode conter DDL/DML. A role
de migration deve ser a proprietaria ou ter o nivel administrativo exigido pelo
PostgreSQL para os objetos abaixo. Runtime nao deve receber estas capacidades.

| Migration | Acesso requerido pela migration |
| --- | --- |
| `001_initial_schema` | `CREATE EXTENSION pgcrypto/citext` (privilegio de banco/provedor); `CREATE TABLE` para schema migration, usuarios, sessoes, templates, anexos, notificacoes e settings; `CREATE INDEX`; seed `INSERT` em templates, regras e migrations |
| `002_process_data` | `CREATE TABLE` para processos, fornecedores, observacoes, auditoria e historico de e-mail; `CREATE INDEX` |
| `003_state_revision` | `CREATE TABLE app_state_revision`; seed `INSERT` em revisao e migrations |
| `004_integrity_and_audit` | `CREATE INDEX`; `CREATE OR REPLACE FUNCTION prevent_process_audit_mutation`; `DROP TRIGGER IF EXISTS` e `CREATE TRIGGER` em `app_process_audit` |
| `005_notification_deadlines` | `UPDATE notification_rules` e `app_settings` para ajuste de dados existente |
| `006_email_dispatch_claims` / `007_auth_rate_limits` | `CREATE TABLE` e `CREATE INDEX` |
| `008_access_request_metadata` | `ALTER TABLE app_users ADD COLUMN` |
| `009_security_audit` | `CREATE TABLE`, `CREATE INDEX`, `DROP/CREATE TRIGGER` em `app_security_audit` |
| `010_auth_session_version` | `ALTER TABLE app_users` e `user_sessions`; `UPDATE user_sessions ... FROM app_users`; `CREATE INDEX` |
| `011_process_multiple_commitments` | `DROP INDEX app_processes_numero_processo_uidx`, `CREATE INDEX app_processes_numero_processo_idx`, `INSERT` da versao. O `DROP INDEX` exige o owner do indice; um grant de DML para runtime nao resolve `42501 must be owner`. |
| `012_drop_legacy_tables` | `DROP TABLE IF EXISTS` em `email_template_attachments`, `notification_recipients`, `notification_rules`, `email_templates` (filho antes do pai); `INSERT` da versao. Exige o owner das tabelas. |

As migrations atuais sao transacionais; o runner remove o `BEGIN/COMMIT` externo
do arquivo, abre sua propria transacao, usa advisory lock e faz rollback se
falhar. Ainda assim, mudancas futuras podem ter requisitos de lock e
compatibilidade diferentes; nao assuma que grants de DML servem para DDL.

## Ferramentas operacionais, fora do papel de runtime

| Ferramenta | Acesso esperado | Separacao recomendada |
| --- | --- | --- |
| `npm run db:audit-runtime-role` | leitura de `pg_roles`, `pg_auth_members`, `pg_namespace`, `pg_class`, `pg_proc`, `pg_default_acl` e ACLs do `public` | conexao de auditoria autorizada e somente leitura; nao conceder catalogo administrativo ao runtime |
| `npm run db:verify-schema` | leitura de `pg_catalog`, `information_schema`, definicoes de constraints/indices/triggers/funcoes e `app_schema_migrations` | conexao de verificacao somente leitura; o owner esperado e configurado externamente |
| `npm run db:verify-restored` | `SELECT` dos dados/restauração, migrations e referencias | somente banco restaurado e isolado; nao usar producao |
| `npm run backup:production` / `pg_dump` | leitura integral suficiente para dump e metadados | credencial de backup/migration separada; nao ampliar runtime |
| `npm run db:import-store -- --apply --merge` | usa a mesma escrita de colecoes de `writeStore` | executar como operacao controlada, com confirmacao de banco e backup; nao exige DDL |

## Sequencia segura de concessao e rollback

1. Registrar ticket, operador Neon/PITR, backup consistente e restauracao isolada
   validada. O rollback de aplicacao nao desfaz schema automaticamente.
2. Salvar a saida integral do auditor de roles, o owner de `public` e de todos
   os objetos, memberships, default privileges e os comandos de rollback
   derivados desse estado. Nenhum valor de exemplo deve substituir essa captura.
3. Em clone/restauração isolado, aplicar a matriz de runtime a uma role sem
   memberships administrativas; manter ownership em `neondb_owner` (ou owner
   efetivamente auditado). Validar login/logout, limite de login, perfil,
   usuarios, processos/empenhos, fornecedores, observacoes, documentos,
   substituicao de documento, dashboard, auditorias e scheduler de e-mail.
4. Na janela aprovada, o owner concede primeiro o conjunto minimo, testa com
   `DATABASE_URL` da role runtime, e so entao remove grants/memberships
   excedentes em comandos separados e registrados. Nao trocar `DATABASE_URL`
   pela credencial de migration para obter um falso verde.
5. Se um smoke test critico falhar, interromper a revogacao e restaurar **apenas
   o grant/membership exato** capturado antes da janela. Investigar a consulta
   ausente, atualizar este inventario e repetir no clone. Nao usar `GRANT ALL`,
   ownership para runtime ou rollback permanente administrativo.

## Riscos que exigem verificacao antes de aplicar

- ACLs efetivas podem vir de `PUBLIC`, de role herdada ou de default privileges;
  o codigo nao permite inferi-las. A auditoria de catalogo e obrigatoria.
- O inventario nao encontrou RLS nas migrations/contrato. Se existir no banco
  real, politicas e `BYPASSRLS` precisam de revisao separada; runtime nao deve
  receber `BYPASSRLS`.
- O runner de migration requer conexao direta em Neon quando runtime usa pooler;
  essa e tambem uma restricao de advisory lock, nao apenas de ACL.
- `app_process_audit` e `app_security_audit` sao deliberadamente append-only.
  Qualquer pedido de correcao deve usar o fluxo auditado, nao grants de update.
- Uma migration que introduza tabela, coluna usada em consulta, function call ou
  sequence deve atualizar este documento, o contrato de schema e a matriz antes
  de sua implantacao.

## Rastreabilidade no codigo

- Pool, transacoes e selecao de URL: `src/db/postgres.js`.
- Leitura/escrita principal, readiness e controle de revisao:
  `src/storage.js`.
- Sessoes, rate limit, claims de e-mail e auditoria de seguranca:
  `src/repositories/{sessions,rate-limits,email-dispatches,security-audit}.js`.
- Identidade de armazenamento de upload e substituicao transacional de
  documento: `src/uploads/{upload-storage,replace-upload-document}.js`.
- DDL/DML de migration: `db/migrations/001_initial_schema.sql` a
  `011_process_multiple_commitments.sql`; executor: `scripts/db-migrate.js`.
- Contrato que declara triggers append-only e ausencia de sequences:
  `src/db/schema-contract.js`.
