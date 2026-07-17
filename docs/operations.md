# Operacao

O ambiente oficial usa Neon como PostgreSQL de producao e atende em `https://sapgestao.dpdns.org`. As URLs reais do banco e demais segredos ficam somente em `.env.production` ou no cofre da plataforma.

## Health check

Endpoints recomendados:

- `GET /health/live`: confirma que o processo HTTP responde; use para reinicio automatico.
- `GET /health/ready`: confirma storage e exige PostgreSQL em producao; use para retirar uma instancia do trafego.
- `GET /health`: diagnostico completo legado, incluindo e-mail e scheduler.

O endpoint `GET /health` responde com `200` quando:

- o storage responde;
- o e-mail esta configurado;
- o scheduler de e-mails foi iniciado.

O payload inclui `checks.storageBackend` com o backend ativo:

- `postgres`: a aplicacao esta lendo e gravando no PostgreSQL.
- `json`: backend permitido apenas em desenvolvimento; producao falha ao iniciar.

Use esse campo no monitor externo para detectar regressao de storage.

## Uploads

Em producao, os uploads devem apontar para um volume montado fora da imagem, por exemplo:

```bash
docker run -e UPLOAD_STORAGE_ROOT=/data/uploads -v almox_uploads:/data/uploads ...
```

No Dockerfile, o caminho padrao de runtime esta em `/data/uploads`.

Os arquivos nao sao mais servidos anonimamente: downloads exigem sessao autenticada por cookie `HttpOnly`. O login nao entrega token no corpo; clientes automatizados devem manter o cookie recebido em `Set-Cookie`. O suporte a Bearer existente e apenas de compatibilidade legada e nao constitui um fluxo para novos clientes. Em mais de uma replica, substitua o volume local por armazenamento de objetos ou filesystem compartilhado.

Revise arquivos orfaos sem remover nada com `npm run uploads:cleanup:dry-run`. A ferramenta falha se o backend ativo diferir de `--expect-backend`, e protege arquivos recentes por 24 horas por padrao (`ORPHAN_UPLOAD_GRACE_MS`). Depois de conferir a lista, remova somente com confirmacao explicita. Em producao, use um backup verificado:

```bash
NODE_ENV=production npm run uploads:cleanup -- --expect-backend=postgres --confirm-backup
```

## Release

1. Gere e restaure um backup em staging.
2. Carregue os segredos do ambiente e execute `npm run validate:production`.
3. Execute `npm test`, `npm run check` e o build da imagem. `npm test` usa store/uploads temporarios e ignora URLs de banco de runtime; a integracao PostgreSQL e opt-in com `TEST_DATABASE_URL` apontando para um database separado cujo nome contenha `test`.
4. Execute `NODE_ENV=production npm run db:migrate` com `DATABASE_URL_MIGRATION` somente depois que o build passar.
5. Suba a nova imagem e aguarde `/health/ready` retornar `200`.
6. Valide login, consulta, criacao controlada, download autenticado e fila de e-mail.
7. Mantenha a imagem anterior disponivel para rollback da aplicacao. Migracoes devem ser aditivas; nao reverta schema sem um procedimento testado.

O fluxo acima esta automatizado, com gates seguros, em `scripts/deploy-production.sh`. O deploy pausa a aplicacao, cria o backup consistente **antes** de executar testes ou migracoes, volta a instancia atual e somente depois continua o release. Execute `check` antes da janela e `deploy` para backup, testes isolados, migracao, build, start, readiness e smoke test.

Os limites `AUTH_MAX_BODY_BYTES` e `ADMIN_MAX_BODY_BYTES` reduzem a memoria aceita por rotas de autenticacao e administracao sem upload. `LOGIN_SCRYPT_CONCURRENCY` e `LOGIN_SCRYPT_MAX_QUEUE` limitam o trabalho simultaneo de verificacao de senha. O Painel usa cache curto por revisao, controlado por `DASHBOARD_CACHE_TTL_MS`; alteracoes persistidas invalidam naturalmente a revisao usada pela resposta.

A migracao `010_auth_session_version` adiciona uma versao persistida a usuarios e sessoes. Troca ou redefinicao de senha incrementa essa versao antes da revogacao fisica das sessoes, de modo que tokens antigos deixam de ser aceitos mesmo se a limpeza de sessoes falhar temporariamente.

### Bootstrap administrativo

Uma instalacao nova deve configurar `LOCAL_ADMIN_EMAIL` e uma `LOCAL_ADMIN_PASSWORD` que cumpra a politica de senha. `ADMIN_EMAILS` sozinho nao cria usuario nem senha e, portanto, nao e um mecanismo de bootstrap.

Em um banco restaurado ou ja provisionado, e permitido omitir a credencial de bootstrap somente depois de confirmar que existe ao menos um administrador ativo com hash de senha local:

```sql
SELECT count(*) AS active_local_admins
FROM app_users
WHERE ativo = true
  AND role = 'admin'
  AND senha_hash <> '';
```

Depois de obter resultado maior que zero e testar o login, configure `ADMIN_EMAILS` com os enderecos administrativos e `CONFIRM_EXISTING_ADMIN_PROVISIONED=true`. Essa flag e apenas uma confirmacao operacional: ela nao cria conta, nao redefine senha e nao deve ser usada em banco vazio.

## Backup e restauracao

Inclua sempre o Neon e uploads no mesmo ponto logico de recuperacao. Prefira `bash scripts/deploy-production.sh backup`: ele pausa a aplicacao para impedir mudancas entre o dump e o arquivo de uploads e arma uma recuperacao automatica que tenta reiniciar a instancia anterior se o script sair ou receber sinal durante a pausa. O backup produz um dump custom, um `uploads-*.tar.gz` e um manifesto JSON com tamanho e SHA-256, todos com permissao 600. `pg_restore --list`, `tar -tzf` e uma segunda conferencia dos tamanhos e hashes do manifesto sao executados antes do sucesso ser informado.

Para usar `npm run backup:production` diretamente, a origem de uploads deve ser informada por `BACKUP_UPLOAD_SOURCE` ou `BACKUP_UPLOAD_DOCKER_VOLUME`, e o operador deve declarar `BACKUP_CONSISTENCY=application-stopped` somente depois de realmente interromper os escritores. O volume Docker informado precisa existir: o script executa `docker volume inspect` e falha em caso de nome incorreto, sem permitir que `docker run` crie silenciosamente um volume vazio. O arquivo compactado e criado pelo processo host com permissao 600 a partir da saida do `tar`, evitando arquivos de backup pertencentes a root. `storage-snapshot` e reservado a snapshots coordenados pela infraestrutura. Comandos externos possuem timeout configuravel e a retencao local ocorre apenas depois da verificacao (`BACKUP_RETENTION_COUNT` e `BACKUP_RETENTION_DAYS`).

Para restauracao controlada em outro banco e diretorio vazio:

```bash
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL_RESTORE" almoxarifado.dump
mkdir -p uploads-restaurados
tar -xzf uploads-AAAA-MM-DD.tar.gz -C uploads-restaurados
```

Confira os SHA-256 contra o manifesto antes da restauracao. O backup deve ser criptografado e copiado para armazenamento externo depois de criado; a retencao local nao substitui uma copia externa. Restaure periodicamente banco e uploads em staging e valide uma amostra de download. Para storage de objetos, habilite versionamento e lifecycle conforme a politica institucional.

## Importacao legada

`npm run db:import-store` agora e sempre dry-run. Ele valida a estrutura e identifica IDs ausentes. Antes de aplicar uma fonte sem IDs, gere uma copia persistente com `--output-normalized=store-normalizado.json` (o arquivo e criado com modo 0600 e nunca sobrescrito) e revise-a. A aplicacao aceita apenas merge por ID, preservando colecoes ausentes e rejeitando alteracao de auditoria imutavel. Exemplo de aplicacao em producao, depois de revisar o dry-run e o backup:

```bash
NODE_ENV=production npm run db:import-store -- --apply --merge --confirm-database=NOME_EXATO --confirm-backup
```

Substituicao integral nao e suportada pelo importador. Nunca use a URL de producao para testes; `npm run test:db` exige `TEST_DATABASE_URL` diferente e com `test` no nome do database.

## Rollback

Se readiness falhar após o release, retire a nova instancia do trafego e volte para a imagem anterior. Nao use `git reset`, nao apague tabelas e nao restaure backup sobre producao sem confirmar perda de dados posterior ao backup.

## CI

O workflow de CI executa:

- `npm test`
- checagem de sintaxe dos scripts principais
- `docker build`

## Monitor externo

Configurar o monitor externo contra `https://sapgestao.dpdns.org/health/ready`, o supervisor contra `GET /health/live` e um monitor de diagnostico contra `GET /health`.

Critério prático:

- `200`: sistema saudável o suficiente para operar.
- `503`: falta e-mail, storage ou scheduler.

O compose limita o log `json-file` a cinco arquivos de 10 MB para impedir crescimento sem controle no host. Consultas acima de `DB_SLOW_QUERY_MS` geram evento `postgres_slow_query` com SQL resumido e sem parametros; falhas de conexoes ociosas geram `postgres_pool_error` sem connection string.
