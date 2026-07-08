# Banco de dados

Este diretorio inicia a migracao do armazenamento atual em `data/store.json` para PostgreSQL.

## Alvo

- Banco: PostgreSQL 15+
- Extensoes usadas: `pgcrypto` e `citext`
- Primeira migracao: `db/migrations/001_initial_schema.sql`

## Ambiente local com Docker

Decisao: o ambiente local usa Docker. A escolha evita instalar PostgreSQL diretamente no sistema operacional, deixa o banco isolado em volume proprio e facilita recriar tudo do zero quando houver erro de configuracao. A instalacao nativa fica como alternativa para testes rapidos, mas nao e a recomendacao do projeto.

Configurado em: 2026-07-08

Versao validada localmente:

```text
PostgreSQL 15.18
```

O container publica a porta somente em localhost:

```text
127.0.0.1:5432->5432/tcp
```

Nunca exponha o banco local em `0.0.0.0`.

### Certificados locais de desenvolvimento

Gere uma CA e um certificado de servidor exclusivos para desenvolvimento:

```bash
mkdir -p certs
openssl genrsa -out certs/local-dev-ca.key 4096
openssl req -x509 -new -nodes -key certs/local-dev-ca.key -sha256 -days 365 \
  -subj '/CN=Almoxarifado CMSP Local Dev CA' \
  -out certs/local-dev-ca.crt
openssl genrsa -out certs/local-dev-server.key 2048
openssl req -new -key certs/local-dev-server.key \
  -subj '/CN=localhost' \
  -out certs/local-dev-server.csr \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
openssl x509 -req -in certs/local-dev-server.csr \
  -CA certs/local-dev-ca.crt \
  -CAkey certs/local-dev-ca.key \
  -CAcreateserial \
  -out certs/local-dev-server.crt \
  -days 365 \
  -sha256 \
  -copy_extensions copy
chmod 600 certs/local-dev-ca.key certs/local-dev-server.key
```

Esses arquivos ficam fora do Git. Nunca use certificados de producao no ambiente local.

### Variaveis locais

Copie `.env.example` para `.env` se ainda nao existir e preencha senhas fortes, unicas e locais:

```text
LOCAL_POSTGRES_ADMIN_PASSWORD=<senha-forte-admin-local>
LOCAL_POSTGRES_APP_PASSWORD=<senha-forte-app-local>
DATABASE_URL=postgres://almoxarifado_app:<senha-url-encoded>@localhost:5432/almoxarifado_cmsp
DB_SSL=true
DB_CA_CERT_PATH=./certs/local-dev-ca.crt
DB_POOL_MIN=0
DB_POOL_MAX=4
DB_CONNECTION_TIMEOUT_MS=3000
DB_IDLE_TIMEOUT_MS=10000
DB_QUERY_TIMEOUT_MS=10000
DB_STATEMENT_TIMEOUT_MS=10000
```

`LOCAL_POSTGRES_ADMIN_PASSWORD` e `LOCAL_POSTGRES_APP_PASSWORD` sao usados apenas no ambiente local e nao devem ser versionados. Guarde as senhas em um local seguro.

### Subir o PostgreSQL local

```bash
npm run db:local:up
```

Verifique a saude do container:

```bash
docker compose ps
```

Resultado esperado:

```text
almoxarifado-cmsp-postgres ... Up ... (healthy) ... 127.0.0.1:5432->5432/tcp
```

### Criar banco e usuario da aplicacao

Conecte como usuario administrador do container e crie o banco dedicado e a role de aplicacao. A aplicacao deve usar `almoxarifado_app`, nunca o usuario `postgres`.

```sql
CREATE ROLE almoxarifado_app
  WITH LOGIN PASSWORD '<senha-forte-app-local>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE;

CREATE DATABASE almoxarifado_cmsp OWNER almoxarifado_app;
```

Se a role ou o banco ja existirem, atualize a senha da role e confirme o owner do banco:

```sql
ALTER ROLE almoxarifado_app
  WITH LOGIN PASSWORD '<senha-forte-app-local>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE;

ALTER DATABASE almoxarifado_cmsp OWNER TO almoxarifado_app;
```

Extensoes exigidas pelo schema:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
```

Verificacoes recomendadas:

```sql
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole
FROM pg_roles
WHERE rolname = 'almoxarifado_app';

SELECT extname
FROM pg_extension
WHERE extname IN ('pgcrypto', 'citext')
ORDER BY extname;
```

Resultado esperado para a role:

```text
almoxarifado_app | f | f | f
```

### Rodar migracoes locais

Com o Postgres local ativo e `.env` preenchido:

```bash
npm run db:migrate
```

O comando usa o cliente `pg` do Node.js e a mesma configuracao TLS da aplicacao (`DB_SSL=true`, `DB_CA_CERT_PATH` e `rejectUnauthorized=true`).

Rode uma segunda vez para confirmar idempotencia:

```bash
npm run db:migrate
```

Resultado esperado na segunda execucao:

```text
Ignorando 001_initial_schema.sql: ja aplicada.
Migracoes aplicadas com sucesso.
```

Tabelas esperadas:

```text
app_schema_migrations
app_settings
app_users
email_template_attachments
email_templates
notification_recipients
notification_rules
user_sessions
```

Importe os dados locais do JSON, quando necessario:

```bash
npm run db:import-store
```

### Validacoes executadas em 2026-07-08

- Container saudavel com PostgreSQL 15.18 e SSL ligado.
- Porta publicada apenas em `127.0.0.1:5432`.
- Usuario `almoxarifado_app` sem `rolsuper`, `rolcreatedb` ou `rolcreaterole`.
- Extensoes `citext` e `pgcrypto` habilitadas.
- Conexao Node.js com TLS validado pela CA local retornou `ssl=true`.
- CA incorreta falhou com erro de certificado (`SELF_SIGNED_CERT_IN_CHAIN`).
- Pool com `max=1` falhou de forma controlada em 500 ms ao tentar obter conexao extra.
- Query lenta `SELECT pg_sleep(2)` foi cancelada por timeout em cerca de 500 ms.
- Com o banco parado, a aplicacao respondeu erro generico sem vazar detalhe interno.
- Apos religar o banco, o login voltou a funcionar.

## Banco existente ou producao

Para um banco ja existente, configure o ambiente real e rode `npm run db:migrate:production` ou `NODE_ENV=production npm run db:migrate`. O carregamento de `.env.production` acontece no proprio processo, mas so depois que `NODE_ENV=production` ja esta definido antes do start.

Regras confirmadas no codigo:

- `src/db/postgres.js` e `scripts/db-migrate.js` carregam `.env.production` quando `NODE_ENV=production`; caso contrario, usam `.env`.
- O loader nao sobrescreve variaveis que ja existam no ambiente.
- `db:migrate` usa `DATABASE_URL_MIGRATION` quando ela estiver presente; senao cai em `DATABASE_URL`.
- `db:import-store` usa `DATABASE_URL` porque ele grava os dados da aplicacao, nao o destino da migracao inicial.

Para o Neon validado neste projeto:

- `DATABASE_URL` aponta para o usuario de runtime da aplicacao.
- `DATABASE_URL_MIGRATION` aponta para `neondb_owner`, em conexao direta.
- As duas strings usam `sslmode=verify-full` e `channel_binding=require`.

## SSL/TLS em producao

Em producao, a aplicacao exige `DB_SSL=true`. Quando SSL esta habilitado, `DB_CA_CERT_PATH` e opcional: use-o apenas se o provedor exigir uma CA especifica ou se voce quiser fixar a cadeia de confianca localmente. Se a `DATABASE_URL` ja usa `sslmode=verify-full`, a validacao de hostname e cadeia fica a cargo do proprio `pg`.

Passos recomendados:

1. Identifique o provedor do PostgreSQL em uso (RDS, Supabase, Neon, servidor proprio, etc.).
2. Baixe o certificado CA publico/generico na documentacao ou painel do provedor.
3. Salve o arquivo em um caminho seguro, por exemplo `certs/ca.crt`, se o provedor exigir CA manual.
4. Configure `DB_CA_CERT_PATH=./certs/ca.crt` ou um caminho absoluto equivalente no `.env` real do ambiente, quando aplicavel.
5. Teste primeiro em staging. Se o certificado ou o hostname estiverem incorretos, a conexao deve falhar.

Arquivos `certs/*.crt`, `certs/*.pem` e `certs/*.cer` ficam fora do Git por padrao porque podem ser especificos do ambiente. Se o certificado for publico e generico conforme a politica do provedor, ele pode ser versionado intencionalmente com `git add -f`.

As migracoes tambem respeitam essa configuracao: com `DB_SSL=true`, o script `npm run db:migrate` usa a mesma `DATABASE_URL` ou `DATABASE_URL_MIGRATION` e herda a validacao TLS definida na connection string. Se `DB_CA_CERT_PATH` estiver presente, ele continua sendo usado.

O runner consulta `SELECT version FROM app_schema_migrations` antes de aplicar os arquivos SQL e ignora migracoes ja registradas. A tabela pode nao existir em um banco novo; nesse caso, todas as migracoes versionadas sao consideradas pendentes.

Perguntas pendentes para a administracao da infraestrutura:

- Qual e o provedor do PostgreSQL de producao?
- O certificado CA e publico/generico do provedor ou especifico do ambiente?
- Quem tem acesso ao `DATABASE_URL` de producao e onde esse segredo e gerenciado?

## Pool e timeouts

O pool PostgreSQL usa limites explicitos para evitar conexoes indefinidas:

```text
DB_POOL_MIN=0
DB_POOL_MAX=10
DB_CONNECTION_TIMEOUT_MS=5000
DB_IDLE_TIMEOUT_MS=30000
DB_QUERY_TIMEOUT_MS=30000
DB_STATEMENT_TIMEOUT_MS=30000
```

Ajuste `DB_POOL_MAX` considerando o limite total de conexoes do banco dividido pelo numero maximo de instancias simultaneas da aplicacao, reservando margem para migracoes, manutencao e acessos administrativos. `DB_QUERY_TIMEOUT_MS` e `DB_STATEMENT_TIMEOUT_MS` limitam queries travadas; `DB_IDLE_TIMEOUT_MS` fecha conexoes ociosas do pool.

Decisao atual: `DB_POOL_MIN=0` fica como padrao porque o ambiente de producao ainda nao foi confirmado como trafego constante; se houver trafego continuo, use `DB_POOL_MIN=2` para reduzir latencia de conexao a frio.

## Como importar o JSON atual

Depois de aplicar as migracoes:

```bash
npm run db:import-store
```

Esse comando le `data/store.json` e grava no PostgreSQL o estado inteiro do aplicativo: usuarios, configuracoes, processos, fornecedores, observacoes, auditoria e historico de e-mails. Quando o schema novo existe, o Postgres vira a fonte de verdade.

Validacao real executada em 2026-07-08:

- `NODE_ENV=production npm run db:import-store` foi executado contra o Neon.
- O log do import mostrou apenas `NODE_ENV`, `source`, `user`, `host`, `database` e `sslmode`.
- A migration `002_process_data.sql` criou `app_processes`, `app_suppliers`, `app_process_observations`, `app_process_audit` e `app_email_history`.
- O import gravou o estado completo do aplicativo no banco.
- `NODE_ENV=production` com a app apontando para o Neon retornou `200` em `POST /auth/login`, `GET /auth/session` e `GET /api/processes`.

## Modelo inicial

O schema separa os principais objetos que hoje ficam dentro do JSON:

- `app_users`: usuarios locais/Google e perfil de acesso.
- `user_sessions`: base para substituir sessoes em memoria.
- `email_templates` e `email_template_attachments`: templates e anexos de e-mail.
- `notification_rules` e `notification_recipients`: regras e responsaveis por notificacao.
- `app_settings`: configuracoes futuras em JSONB quando nao justificarem tabela propria.

## Proximas etapas

1. Persistir uploads em storage externo quando as rotas de processo forem ampliadas.
2. Adicionar testes de integracao para login, logout e renovacao de sessao.
3. Evoluir o schema de processos se novos campos estruturados passarem a justificar tabelas proprias.
