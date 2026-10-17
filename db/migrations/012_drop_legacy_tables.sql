-- Descontinua tabelas legadas que nao sao acessadas por nenhum SQL da aplicacao.
--
-- As quatro tabelas foram criadas em 001_initial_schema, mas as configuracoes
-- efetivas de e-mail e notificacao vivem no store JSON em app_settings
-- (rotas /api/settings/* chamam writeStore). Nenhum codigo em src/ ou scripts/
-- faz FROM/INTO/UPDATE/JOIN nelas. Ver docs/maintenance-audit.md.
--
-- Requer backup verificado antes de aplicar em producao. A ordem respeita a
-- foreign key email_template_attachments -> email_templates.

BEGIN;

DROP TABLE IF EXISTS email_template_attachments;
DROP TABLE IF EXISTS notification_recipients;
DROP TABLE IF EXISTS notification_rules;
DROP TABLE IF EXISTS email_templates;

INSERT INTO app_schema_migrations (version)
VALUES ('012_drop_legacy_tables')
ON CONFLICT (version) DO NOTHING;

COMMIT;
