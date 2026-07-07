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
