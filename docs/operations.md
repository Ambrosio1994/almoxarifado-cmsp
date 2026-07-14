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

Os arquivos nao sao mais servidos anonimamente: downloads exigem token Bearer valido. Em mais de uma replica, substitua o volume local por armazenamento de objetos ou filesystem compartilhado.

Revise arquivos orfaos sem remover nada com `npm run uploads:cleanup:dry-run`. Depois de conferir a lista e garantir backup, remova-os com `npm run uploads:cleanup`. Em producao, execute com `NODE_ENV=production`, `DATABASE_URL` e `UPLOAD_STORAGE_ROOT` do mesmo ambiente.

## Release

1. Gere e restaure um backup em staging.
2. Carregue os segredos do ambiente e execute `npm run validate:production`.
3. Execute `npm test`, `npm run check` e o build da imagem.
4. Execute `NODE_ENV=production npm run db:migrate` com `DATABASE_URL_MIGRATION` somente depois que o build passar.
5. Suba a nova imagem e aguarde `/health/ready` retornar `200`.
6. Valide login, consulta, criacao controlada, download autenticado e fila de e-mail.
7. Mantenha a imagem anterior disponivel para rollback da aplicacao. Migracoes devem ser aditivas; nao reverta schema sem um procedimento testado.

O fluxo acima esta automatizado, com gates seguros, em `scripts/deploy-production.sh`. Execute `check` antes da janela e `deploy` para backup, migracao, build, start, readiness e smoke test. O checklist operacional completo fica em `docs/deployment-checklist.md`.

## Backup e restauracao

Inclua sempre o Neon e uploads no mesmo ponto logico de recuperacao. O comando `npm run backup:production` usa a conexao direta de `DATABASE_URL_MIGRATION`, nao imprime credenciais e grava um dump custom com permissao 600. Para restauracao controlada em outro banco:

```bash
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL_RESTORE" almoxarifado.dump
```

O backup deve ser criptografado, ter retencao definida fora do servidor da aplicacao e ser restaurado periodicamente em staging. Para uploads em volume, use snapshot consistente; em storage de objetos, habilite versionamento e lifecycle conforme a politica institucional.

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
