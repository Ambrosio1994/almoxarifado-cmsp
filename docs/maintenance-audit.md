# Auditoria de manutenção — candidatos a descarte

> Relatório de diagnóstico **e** registro das ações executadas. O diagnóstico
> original não removeu nada; em 17/10 foram executados os passos 1–3
> (assets/exports sem uso, ferramenta de varredura do Drive e migration 012
> preparada — tabelas **não** removidas em produção).
>
> Base revisada: `main` @ `8765e37` (diagnóstico). Origem: etapa final da
> varredura geral iniciada em 31/08/2026 ("arquivos sem uso, código descartável,
> riscos, escalabilidade, banco"). Esta etapa cobre quatro itens que exigem
> diagnóstico antes de qualquer remoção: campos JSONB, assets/código sem uso,
> uploads órfãos e tabelas legadas.

## Resumo

| Item | Situação | Pode remover agora? |
|---|---|---|
| Campos JSONB | Perfil em produção: **0** dos 79 processos usam a forma legada de topo | Ainda não — não é código morto (compatibilidade de API) |
| Assets sem uso | **Removidos** 6 arquivos (~396 KB) + 2 exports mortos (passo 1) | Feito ✔ |
| Código sem uso | `DOCUMENT_LABELS`, `readUsersStore` **removidos** (passo 1) | Feito ✔ |
| Uploads órfãos | Produção é **Drive**: 51 referências, 0 locais. Varredura de Drive **implementada** (passo 2) | Execução depende de OAuth no host de produção |
| Tabelas legadas | Migration `012_drop_legacy_tables` **preparada e validada** em banco de teste | **Não aplicada** — requer backup + confirmação de consumidores externos |

Método: todas as verificações abaixo são de leitura. Comandos reproduzíveis
estão indicados em cada seção.

---

## 1. Campos JSONB

**Colunas `jsonb` existentes em `public` (9):**

| Tabela.coluna | Papel |
|---|---|
| `app_processes.data` | Payload do processo (modelo ativo) |
| `app_suppliers.data` | Payload do fornecedor (modelo ativo) |
| `app_process_observations.data` | Observação (modelo ativo) |
| `app_process_audit.data` | Trilha de auditoria (modelo ativo, append-only) |
| `app_email_history.data` | Histórico de e-mail (modelo ativo) |
| `app_settings.value` | Store JSON legado/settings (modelo ativo) |
| `app_email_dispatch_claims.metadata` | Metadados idempotência (ativo) |
| `app_email_dispatch_claims.result` | Resultado do disparo (ativo) |
| `app_security_audit.metadata` | Metadados de evento de segurança (ativo) |

Reproduzir:

```bash
psql "$DATABASE_URL" -c "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND data_type='jsonb' ORDER BY 1,2"
```

**Conclusão:** as colunas `data` são a própria modelagem de persistência —
não são "campos" removíveis. O que existe de legado são **subcampos dentro de
`app_processes.data`**:

- `material`, `valorUnitario`, `quantidade` — modelo de material único,
  substituído pelo array `materiais`. Ainda são **lidos** para
  compatibilidade por `normalizeMaterials()`/`legacyMaterials()`
  (`src/domain/processos.js`, `src/server.js:4017`), mas o caminho de escrita
  atual (`sanitizeMaterials`, `src/server.js:4016`) já grava apenas `materiais`.
  Ou seja: existem apenas em registros antigos.
- `dataEnvioEmpenho` — **não é campo morto**: continua sendo gravado
  (`src/server.js:4069`) ao lado de `dataEnvioFornecedor` e usado como alias
  (`src/domain/processos.js`, `src/server.js:1421`).

**Perfil em produção (somente leitura, 17/10).** `BEGIN READ ONLY` sobre
`app_processes.data` no banco de produção (Neon):

| Métrica | Valor |
|---|---:|
| Processos (ativos / inativos) | 79 (78 / 1) |
| Com array `materiais` não vazio | 79 |
| Com `material` legado de topo não vazio | 0 |
| Com `valorUnitario` legado | 0 |
| Com `quantidade` legado | 0 |
| Dependem **somente** do legado (sem `materiais`) | 0 |
| Com `dataEnvioEmpenho` | 0 |

Reproduzir (read-only):

```sql
WITH src AS (
  SELECT data,
    CASE WHEN jsonb_typeof(data->'materiais')='array' THEN jsonb_array_length(data->'materiais') ELSE 0 END AS n,
    btrim(COALESCE(data->>'material','')) AS material,
    btrim(COALESCE(data->>'valorUnitario','')) AS vu,
    btrim(COALESCE(data->>'quantidade','')) AS qt
  FROM app_processes
)
SELECT count(*)::int AS total,
       count(*) FILTER (WHERE n > 0)::int AS com_materiais,
       count(*) FILTER (WHERE material <> '')::int AS com_material_legado,
       count(*) FILTER (WHERE n = 0 AND material <> '')::int AS somente_legado,
       count(*) FILTER (WHERE vu <> '')::int AS com_vu_legado,
       count(*) FILTER (WHERE qt <> '')::int AS com_qt_legado
FROM src;
```

**Conclusão do perfil:** nenhum processo em produção usa a forma de topo. O
fallback legado em `DASHBOARD_AGGREGATES_SQL` (`src/storage.js:281-285`) e
`legacyMaterials()` (`src/server.js:4535`) só é exercitado por payloads antigos
de API/cliente, não por dados armazenados. Ainda assim é código de
compatibilidade: a forma de topo pode chegar por uma chamada antiga, então
**não remover sem decisão explícita** de descontinuar o contrato da API.

---

## 2. Assets sem uso

Referências cruzadas em todo o repositório (exceto `node_modules`, `.git`,
`uploads`), incluindo CSS/HTML/JS/testes:

| Arquivo | Bytes | Referências | Situação |
|---|---:|---|---|
| `planet-earth-login.webp` | 172.264 | nenhuma | **candidato** — duplicata byte-a-byte de `login-background.webp` |
| `public/assets/figma/login-background.webp` | 172.264 | nenhuma | **candidato** (o PNG homônimo é o usado) |
| `public/assets/figma/dashboard-background.png` | 59.147 | nenhuma | **candidato** |
| `public/assets/figma/eye.svg` | 777 | nenhuma | **candidato** |
| `public/assets/figma/arrow-left.svg` | 323 | nenhuma | **candidato** |
| `public/assets/figma/switch-track.svg` | 320 | nenhuma | **candidato** |
| `public/assets/figma/eye-off.svg` | 1.143 | só `test/frontend-contract.test.js` | usado apenas em teste |

Total candidato (sem `eye-off.svg`): **405.095 bytes (~396 KB)**.

Reproduzir:

```bash
for a in planet-earth-login.webp public/assets/figma/login-background.webp \
         public/assets/figma/dashboard-background.png public/assets/figma/eye.svg \
         public/assets/figma/arrow-left.svg public/assets/figma/switch-track.svg; do
  echo "$a -> $(grep -rlF -- "$a" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=uploads | tr '\n' ' ')"
done
md5sum planet-earth-login.webp public/assets/figma/login-background.webp   # b952bf50... (idênticos)
```

Observação: `new_favicon.png`, `settings-avatar.png`, `*-background.png`,
`dashboard-overlay.png` e `camera.svg` **estão em uso** — não são candidatos.

---

## 3. Código sem uso

Varredura de todos os exports (`src`, `public`, `scripts`, `test`; 66 arquivos)
contando ocorrências no corpus inteiro. Um símbolo com 1 ocorrência existe
apenas na própria definição:

| Símbolo | Local | Referências |
|---|---|---|
| `DOCUMENT_LABELS` | `src/domain/processos.js:80` | 0 |
| `readUsersStore` | `src/storage.js:70` | 0 |

Reproduzir: ver verificador de exports (mesma lógica do script interno usado
nesta auditoria) — ambos os nomes aparecem com 1 ocorrência total.

Não há arquivos de `src/` órfãos: todos são importados em algum ponto.

Observação (não é código morto, apenas export desnecessário para uso interno):
`getPool` (`src/db/postgres.js`), `totalStoredAttachmentBytes`
(`src/server.js`) e `normalizeBoardText` (`public/kanban-board.js`) são usados
apenas dentro do próprio módulo.

---

## 4. Uploads órfãos

dry-run executado (somente leitura, `applied:false`):

```bash
npm run uploads:cleanup:dry-run -- --expect-backend=postgres
```

Resultado:

```json
{"backend":"postgres","referenced":0,"scanned":114,"orphans":114,
 "missingReferences":0,"protectedByGrace":0,"graceMs":86400000,"applied":false}
```

**Ressalva decisiva:** o banco local está vazio — `app_processes = 0`:

```bash
psql "$DATABASE_URL" -c "SELECT count(*) FROM app_processes"   # 0
```

Logo `referenced:0` e `orphans:114` são **esperados localmente** e **não
indicam órfãos em produção**. Os 114 arquivos são artefatos locais de
dev/teste (`uuid/...`, `*-documento-restaurado.pdf`, `import-167487-...`).

**Revalidação em produção (somente leitura, 17/10).** Conectado ao banco de
produção (Neon), o store tem **79 processos** (1 inativo) e **51 caminhos de
upload referenciados — todos em Google Drive** (`/uploads/drive/<fileId>/...`),
com **0 referências a armazenamento local**. Os 51 caminhos apontam para **51
ids de arquivo distintos** (0 malformados).

```bash
node -e '<consulta read-only a app_processes.data->documentos usando DATABASE_URL de .env.production>'
# Referenciados: 51 | em Drive: 51 | local: 0
```

**Ferramenta de varredura do Drive implementada (passo 2).** O armazenamento de
produção é o **Google Drive**, não o volume local `/data/uploads`. No backend
Drive cada upload vira um arquivo filho direto de `GOOGLE_DRIVE_FOLDER_ID` e o
caminho público embute o próprio id do arquivo
(`/uploads/drive/<fileId>/<nome>`, `src/uploads/upload-storage.js:182`).
Portanto a varredura compara os ids dos filhos da pasta com os ids extraídos
dos caminhos referenciados (documentos + anexos de template de e-mail).

Novo utilitário:

- `scripts/cleanup-orphan-drive-uploads.js` — modo padrão **somente leitura**;
  excluir exige `--apply` + `--confirm-delete-orphans` e, em produção,
  `--confirm-backup`. Exclui o marcador de identidade
  (`.almoxarifado-storage.json`) e aplica carência (`ORPHAN_UPLOAD_GRACE_MS`).
- `listFolderFiles()` em `src/uploads/drive-storage.js` — lista paginada dos
  filhos da pasta.
- scripts npm: `uploads:drive:cleanup:dry-run` e `uploads:drive:cleanup`.

A execução contra o Drive de produção **não foi feita aqui**: o `.env.production`
local não contém as credenciais OAuth do Google (`GOOGLE_CLIENT_ID/SECRET/
REFRESH_TOKEN`). Ela deve rodar no host de produção (ou onde o OAuth estiver
disponível) com `UPLOAD_STORAGE_BACKEND=drive`. O `backup-production.js` arquiva
um diretório/volume **local**, não o Drive — um backup do Drive precisa ser
confirmado por outro meio antes de qualquer `--apply`.

Nada foi removido no Drive nem localmente.

---

## 5. Tabelas legadas

Sem nenhum acesso SQL (`FROM`/`INTO`/`UPDATE`/`JOIN`) em `src/` e `scripts/`;
definidas em `db/migrations/001_initial_schema.sql` e, até esta rodada, listadas
no contrato de drift `src/db/schema-contract.js` (as entradas do contrato foram
removidas por esta mudança):

| Tabela | Uso SQL na aplicação | Linhas (banco local) |
|---|---|---:|
| `email_templates` | 0 | 2 |
| `email_template_attachments` | 0 | 0 |
| `notification_rules` | 0 | 1 |
| `notification_recipients` | 0 | 0 |

As configurações de e-mail/notificação efetivamente usadas ficam no store JSON
em `app_settings` (as rotas `/api/settings/email-templates` e
`/api/settings/notifications` chamam `writeStore`, `src/server.js:1212,1331`).

Reproduzir:

```bash
for t in email_templates email_template_attachments notification_rules notification_recipients; do
  echo "$t -> $(grep -rhoiE "(from|into|update|join)[[:space:]]+$t\b" src scripts --include='*.js' | wc -l)"
done
psql "$DATABASE_URL" -c "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1"
```

**Migration preparada (passo 3), ainda não aplicada.** Criada
`db/migrations/012_drop_legacy_tables.sql` (`DROP TABLE IF EXISTS` na ordem
filho → pai), atualizado o contrato (`src/db/schema-contract.js`: tabelas e
índices removidos, versão `3`, migration `012_drop_legacy_tables` exigida) e
`EXPECTED_SCHEMA_MIGRATION` em `src/storage.js`.

Validada em banco de teste isolado (`almoxarifado_test`): aplica sobre
`001→012`, remove as 4 tabelas mesmo com dados e com a FK
`email_template_attachments → email_templates`, é idempotente, e o verificador
de contrato retorna `valid:true` (13 tabelas).

**Ainda não aplicar em produção.** Como `prestart` (`npm start`) roda
`scripts/db-migrate.js`, o próximo deploy aplicaria a migration automaticamente.
Antes disso é obrigatório: backup verificado; confirmação de que não há
consumidores externos (relatórios/BI/integrações) lendo essas tabelas; e
registro explícito da remoção.

---

## Impacto em banco

**Nenhuma alteração em produção.** As consultas de produção foram somente
leitura (`BEGIN READ ONLY`). A migration `012_drop_legacy_tables` foi validada
apenas em um banco de teste local e descartável (`almoxarifado_test`); o banco
`almoxarifado` de desenvolvimento e o banco de produção permanecem intactos. O
dry-run de uploads não removeu arquivos (`applied:false`).

## Validações desta etapa

| Check | Resultado |
|---|---|
| `npm test` | **298/298** aprovados |
| `npm run check` | OK |
| `npm run test:db` (banco de teste `almoxarifado_test`) | 13/13 aprovados |
| Migration `001→012` em banco novo | aplicada; as 4 tabelas legadas ausentes |
| Migration `012` com dados + FK | remove na ordem correta; idempotente |
| Verificador de contrato na `almoxarifado_test` | `valid:true` (versão 3, 13 tabelas) |
| Perfil JSONB em produção | 79 processos, 0 usam a forma legada |
| Varredura Drive | implementada e coberta por 6 testes (`test/cleanup-orphan-drive-uploads.test.js`) |

## Riscos / limitações

- **Migration 012 não aplicada em produção.** Com `prestart` disparando
  `db-migrate.js`, o próximo deploy a aplicará automaticamente. Não fazer
  deploy sem backup verificado e sem confirmar ausência de consumidores externos.
- **Varredura Drive não executada em produção**: falta OAuth no ambiente local.
  Rodar no host de produção antes de autorizar `--apply`.
- O `backup-production.js` não cobre o Drive; um backup do Drive precisa ser
  confirmado separadamente.
- `eye-off.svg` é usado por teste; remover exigiria ajustar
  `test/frontend-contract.test.js`.

## Passos 1–3 (execução 17/10)

1. **Concluído (passo 1):** removidos os 6 assets sem uso e os 2 exports mortos
   (`DOCUMENT_LABELS`, `readUsersStore`); verificação independente `APPROVED`.
2. **Concluído (passo 2):** implementada a varredura de órfãos do Drive
   (`scripts/cleanup-orphan-drive-uploads.js`, `listFolderFiles`), com dry-run
   padrão e exclusão sob confirmação. Execução contra produção pendente de OAuth.
3. **Concluído (passo 3):** migration `012_drop_legacy_tables` preparada e
   validada em banco de teste; contrato atualizado para a versão 3. Aplicação em
   produção pendente de backup + confirmação de consumidores externos.
4. **Concluído (perfil JSONB):** produção não usa a forma legada; remoção do
   fallback fica condicionada a descontinuar o contrato antigo da API.
