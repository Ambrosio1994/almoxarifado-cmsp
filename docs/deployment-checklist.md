# Checklist de implantacao em producao

Alvo oficial: `https://sapgestao.dpdns.org`, com PostgreSQL de producao no Neon. Este roteiro nao contem segredos; os valores reais devem existir apenas em `.env.production` no servidor ou no cofre da plataforma.

## Antes da janela

- [ ] Confirmar que o branch e o commit que serao implantados passaram por `npm ci`, `npm test` e `npm run check`.
- [ ] Copiar `.env.production.example` para `.env.production`, substituir todos os marcadores e executar `chmod 600 .env.production`.
- [ ] Manter `DATABASE_URL` com a conexao pooled do Neon para a aplicacao e `DATABASE_URL_MIGRATION` com a conexao direta para migracoes e backup. Se executar a integracao PostgreSQL opcional, usar `TEST_DATABASE_URL` em database separado, descartavel e identificado como teste.
- [ ] Confirmar `DB_SSL=true` e `sslmode=require` ou `sslmode=verify-full` nas duas URLs; manter `channel_binding=require` quando fornecido pelo Neon.
- [ ] Confirmar que a role de runtime tem somente os privilegios necessarios e que a credencial de migracao fica restrita ao operador/CI.
- [ ] Em instalacao nova, configurar `LOCAL_ADMIN_EMAIL` e `LOCAL_ADMIN_PASSWORD`. Em banco existente, confirmar por consulta e teste de login que ha administrador local ativo antes de usar `CONFIRM_EXISTING_ADMIN_PROVISIONED=true`; `ADMIN_EMAILS` sozinho nao cria acesso.
- [ ] Validar SMTP, `EMAIL_FROM_ADDRESS` em dominio verificado, administradores, limites de body/scrypt/cache, `TRUST_PROXY=true` e o volume persistente `almoxarifado_uploads`.
- [ ] Garantir que `.env.production`, dumps, `.deploy/` e certificados privados nao aparecem em `git status` nem no artefato da imagem.

## DNS, firewall e TLS

- [ ] Conferir os registros A e, se usado, AAAA de `sapgestao.dpdns.org` contra os IPs publicos do servidor; remover AAAA incorreto para evitar falhas intermitentes.
- [ ] Liberar publicamente apenas TCP 80/443. A aplicacao deve continuar ligada a `127.0.0.1:3000`; PostgreSQL nao deve ser exposto pelo servidor.
- [ ] Instalar Caddy e copiar `deploy/Caddyfile.example` para a configuracao ativa. O Caddy obtem e renova o certificado TLS automaticamente quando DNS e portas estao corretos.
- [ ] Validar a configuracao (`caddy validate --config /etc/caddy/Caddyfile`) antes de recarregar o proxy.
- [ ] Confirmar HTTPS sem alerta de certificado e redirecionamento de HTTP para HTTPS.

## Backup, migracao e release

- [ ] Instalar Docker com Compose v2. O backup usa `pg_dump` local quando disponível e recorre ao cliente PostgreSQL em container quando necessário.
- [ ] Executar `bash scripts/deploy-production.sh check`.
- [ ] Executar `bash scripts/deploy-production.sh backup`; confirmar que o volume descoberto existe, conferir no manifesto os hashes do dump e do arquivo de uploads e copiar o conjunto criptografado para armazenamento externo.
- [ ] Restaurar o dump e os uploads periodicamente em staging; validar `pg_restore --list`, `tar -tzf` e uma amostra de download.
- [ ] Executar `npm run deploy:production`. O script cria backup consistente, aplica migracoes sob lock exclusivo, valida PostgreSQL contra o volume antes de substituir a aplicacao, preserva a imagem anterior, sobe a nova imagem e aguarda readiness.
- [ ] Confirmar que todas as migracoes aparecem uma unica vez em `app_schema_migrations`.

## Verificacao apos release

- [ ] Confirmar `200` em `/health/live` e `/health/ready`, localmente e por HTTPS; em `/health/ready`, exigir `checks.uploads.ok=true` e `missing=0`.
- [ ] Executar `npm run smoke:production`.
- [ ] Validar login, consulta autenticada, criacao/edicao controlada, download autenticado e envio de e-mail de teste.
- [ ] Conferir logs por `requestId`, erros de banco, falhas SMTP, limites de login e espaco do volume de uploads.
- [ ] Manter monitor externo em `https://sapgestao.dpdns.org/health/ready` e alerta separado para expiração TLS.

## Rollback

- [ ] Se a nova versao falhar, executar `bash scripts/deploy-production.sh rollback`; isso restaura somente a imagem anterior e repete health/smoke.
- [ ] Nao desfazer migracoes automaticamente. As migracoes devem ser aditivas e compativeis com a versao anterior.
- [ ] Restaurar um dump do Neon somente em incidente de dados confirmado, com janela aprovada e avaliacao da perda de transacoes posteriores ao backup.
- [ ] Se o proxy for a causa, restaurar a configuracao anterior do Caddy e validar antes do reload.
- [ ] Registrar commit, horario, imagem, migracoes, backup e resultado do incidente/release.
