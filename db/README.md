# Banco de dados

Este diretorio inicia a migracao do armazenamento atual em `data/store.json` para PostgreSQL.

## Alvo

- Banco: PostgreSQL 15+
- Extensoes usadas: `pgcrypto` e `citext`
- Primeira migracao: `db/migrations/001_initial_schema.sql`

## Como aplicar localmente

Com um banco ja criado:

```bash
npm run db:migrate
```

Exemplo de URL local:

```text
postgres://almoxarifado:almoxarifado@localhost:5432/almoxarifado_cmsp
```

O comando usa `DATABASE_URL` do ambiente ou do arquivo `.env` e requer o binario `psql` instalado.

## SSL/TLS em producao

Em producao, a aplicacao exige `DB_SSL=true`. Quando SSL esta habilitado, tambem e obrigatorio informar `DB_CA_CERT_PATH` apontando para o certificado CA usado para validar o certificado do servidor PostgreSQL.

Passos recomendados:

1. Identifique o provedor do PostgreSQL em uso (RDS, Supabase, Neon, servidor proprio, etc.).
2. Baixe o certificado CA publico/generico na documentacao ou painel do provedor.
3. Salve o arquivo em um caminho seguro, por exemplo `certs/ca.crt`.
4. Configure `DB_CA_CERT_PATH=./certs/ca.crt` ou um caminho absoluto equivalente no `.env` real do ambiente.
5. Teste primeiro em staging. Se o certificado estiver incorreto, a conexao deve falhar.

Arquivos `certs/*.crt`, `certs/*.pem` e `certs/*.cer` ficam fora do Git por padrao porque podem ser especificos do ambiente. Se o certificado for publico e generico conforme a politica do provedor, ele pode ser versionado intencionalmente com `git add -f`.

As migracoes tambem respeitam essa configuracao: com `DB_SSL=true`, o script `npm run db:migrate` executa `psql` com `PGSSLMODE=verify-full` e `PGSSLROOTCERT` apontando para `DB_CA_CERT_PATH`.

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

Esse comando le `data/store.json` e grava no PostgreSQL apenas os dados de usuario e configuracao. Os dados de processo continuam fora do banco neste estagio.

## Modelo inicial

O schema separa os principais objetos que hoje ficam dentro do JSON:

- `app_users`: usuarios locais/Google e perfil de acesso.
- `user_sessions`: base para substituir sessoes em memoria.
- `email_templates` e `email_template_attachments`: templates e anexos de e-mail.
- `notification_rules` e `notification_recipients`: regras e responsaveis por notificacao.
- `app_settings`: configuracoes futuras em JSONB quando nao justificarem tabela propria.

## Proximas etapas

1. Persistir sessoes em `user_sessions`.
2. Adicionar testes de integracao para login, logout e renovacao de sessao.
3. Mover uploads para storage externo quando as rotas de processo forem migradas.
