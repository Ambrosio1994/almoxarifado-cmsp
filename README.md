# Sistema de Gerenciamento de Processos do Almoxarifado - CMSP

Projeto iniciado a partir do documento `Requisitos_Sistema_Almoxarifado.docx`.

## Como rodar

No Windows desta maquina, voce pode iniciar com:

```powershell
.\run-dev.ps1
```

Se o Node.js estiver instalado normalmente no computador, tambem pode usar:

```bash
npm run dev
```

Depois acesse:

```text
http://localhost:3000
```

## Envio de e-mails

Configure um servidor SMTP transacional ou uma conta Gmail com senha de app:

```text
GMAIL_USER=seu-email@gmail.com
GMAIL_APP_PASSWORD=sua-senha-de-app
EMAIL_FROM_ADDRESS=seu-email@gmail.com
EMAIL_TEST_RECIPIENT=seu-email-de-teste@example.com
```

O destinatario dos oficios e o e-mail cadastrado no fornecedor. Testes manuais sao sempre redirecionados a `EMAIL_TEST_RECIPIENT`, com chave de idempotencia separada da producao. Reservas persistidas no PostgreSQL impedem disparos duplicados entre replicas.

Para SMTP transacional, `SMTP_USER` e usado somente na autenticacao e `EMAIL_FROM_ADDRESS` define o remetente. No Resend, use `SMTP_USER=resend`, a API key em `SMTP_PASS` e um endereço de domínio verificado em `EMAIL_FROM_ADDRESS`.

## Prontidao para producao

Producao oficial: [https://sapgestao.dpdns.org](https://sapgestao.dpdns.org), usando Neon como PostgreSQL persistente.

Itens ja aplicados:

- `.env` protegido por `.gitignore`; use `.env.example` como referencia sem segredos reais.
- Escrita do `data/store.json` serializada e atomica, reduzindo risco de corrupcao no armazenamento local restante.
- Schema PostgreSQL versionado para usuarios, sessoes, processos, auditoria e operacao.
- Importador do `data/store.json` para usuarios e configuracoes, validado em producao.
- Endpoint `/health` com checagem de storage, configuracao de e-mail e scheduler.
- Logs estruturados em JSON para falhas de request e rotina de e-mail.
- Historico de e-mail com reserva distribuida, chave de idempotencia, tentativas, erro e data de envio.
- Retry simples para falhas transientes de SMTP.
- Bootstrap de admin local apenas quando `LOCAL_ADMIN_EMAIL` e `LOCAL_ADMIN_PASSWORD` sao definidos explicitamente; nao ha senha padrao.

Validacoes ja concluidas em 2026-07-08:

- `NODE_ENV=production npm run db:migrate` apontou para o Neon correto e ficou idempotente.
- `NODE_ENV=production npm run db:import-store` gravou o estado completo do aplicativo no Neon.
- `POST /auth/login` em producao retornou `200` com token.
- `GET /auth/session` em producao retornou `200`.
- `GET /api/processes` em producao retornou `200` lendo do Postgres.

Pendencias atuais:

- Substituir Gmail SMTP por provedor transacional ou documentar monitoramento/rotacao da senha de app.
- Definir o provedor definitivo para arquivos e a politica institucional de retencao.
- Instalar/configurar o proxy TLS no host definitivo e cadastrar o monitoramento externo.

## O que este início já cobre

- Consulta pública de processos.
- Dashboard com indicadores principais.
- Cadastro e edição inicial de processos.
- Cadastro por modal a partir do botão **Novo processo**.
- Múltiplos materiais por empenho no mesmo processo.
- Filtros rápidos e pesquisa por processo, empenho, fornecedor, material, ano e status.
- Regras de bloqueio por status:
  - Antes de `Liquidado`: edição permitida para usuário autorizado.
  - `Liquidado`: edição permitida somente para administrador.
  - `Pago`: edição bloqueada permanentemente.
- Registro de auditoria das alterações feitas pela API.
- Observações por processo em ordem cronológica.
- Fornecedores, documentos protegidos, notificacoes SMTP, entregas por material, auditoria e relatorios PDF/Excel/CSV.

## Estrutura

```text
almoxarifado-cmsp/
  data/
    store.json
  docs/
    requisitos-resumidos.md
  db/
    migrations/
  public/
    app.js
    index.html
    styles.css
  src/
    db/
      postgres.js
    domain/
      processos.js
    repositories/
      sessions.js
      email-dispatches.js
      rate-limits.js
      security-audit.js
    server.js
    storage.js
  test/
```

Validacao local:

```bash
npm ci
npm test
npm run check
```

## Implantacao

O Neon e a fonte de verdade PostgreSQL em producao; a aplicacao falha explicitamente se o schema nao estiver pronto. Crie `.env.production` a partir do modelo sem segredos e use o fluxo seguro:

```bash
cp .env.production.example .env.production
chmod 600 .env.production
bash scripts/deploy-production.sh check
npm run deploy:production
```

Use `GET /health/live` para liveness e `GET /health/ready` para readiness. O compose publica a aplicacao apenas em `127.0.0.1`; o exemplo `deploy/Caddyfile.example` termina TLS para `sapgestao.dpdns.org`.

Consulte `docs/deployment-checklist.md` para o checklist completo e `docs/operations.md` para operacao, backup, restauracao e rollback.
