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

## Envio de e-mails pelo Gmail

Configure o arquivo `.env` com uma conta Gmail e uma senha de app:

```text
GMAIL_USER=seu-email@gmail.com
GMAIL_APP_PASSWORD=sua-senha-de-app
EMAIL_TEST_RECIPIENT=destino-de-teste@example.com
```

O remetente usa `GMAIL_USER`. O destinatario dos oficios e o e-mail cadastrado no fornecedor do empenho; `EMAIL_TEST_RECIPIENT` fica apenas como referencia de simulacao/configuracao local. A rotina automatica verifica os prazos configurados e evita reenviar o mesmo e-mail no mesmo dia.

## Prontidao para producao

Itens ja aplicados:

- `.env` protegido por `.gitignore`; use `.env.example` como referencia sem segredos reais.
- Escrita do `data/store.json` serializada e atomica, reduzindo risco de corrupcao no armazenamento local restante.
- Schema PostgreSQL aplicado no Neon em `db/migrations/001_initial_schema.sql` para usuarios, sessoes e configuracoes.
- Importador do `data/store.json` para usuarios e configuracoes, validado em producao.
- Endpoint `/health` com checagem de storage, configuracao de e-mail e scheduler.
- Logs estruturados em JSON para falhas de request e rotina de e-mail.
- Historico de e-mail com chave de idempotencia, tentativas, erro e data de envio.
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
- Endurecer sessoes, expirar tokens e ampliar RBAC.
- Revisar a estrategia de retenção/limpeza dos uploads do volume montado.

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
- Estrutura para fornecedores, documentos, notificações reais por Gmail e relatórios.

## Estrutura

```text
almoxarifado-cmsp/
  data/
    store.json
  docs/
    requisitos-resumidos.md
  db/
    migrations/
      001_initial_schema.sql
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
    server.js
    storage.js
  test/
    processos.test.js
```

## Próximos passos recomendados

1. Validar os campos exibidos na tabela de processos.
2. Trocar o armazenamento em JSON por um banco relacional.
3. Implementar autenticação com perfis reais.
4. Implementar anexos PDF com validação de tipo de arquivo.
5. Evoluir historico e acompanhamento visual dos envios de e-mail.
