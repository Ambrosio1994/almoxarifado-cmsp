# Auditoria de manutenção — candidatos a descarte

> Relatório **somente diagnóstico**. Nenhum arquivo, upload ou tabela foi
> removido. Base revisada: `main` @ `8765e37` (árvore limpa).
>
> Origem: etapa final da varredura geral iniciada em 31/08/2026
> ("arquivos sem uso, código descartável, riscos, escalabilidade, banco").
> Esta etapa cobre quatro itens que exigem diagnóstico antes de qualquer
> remoção: campos JSONB, assets/código sem uso, uploads órfãos e tabelas legadas.

## Resumo

| Item | Situação | Pode remover agora? |
|---|---|---|
| Campos JSONB | Colunas `data` são o modelo ativo; subcampos legados ainda são lidos | **Não** — requer perfil de dados em produção |
| Assets sem uso | 6 arquivos, ~396 KB, sem nenhuma referência (+1 usado só em teste) | Sim, com baixo risco |
| Código sem uso | 2 exports mortos confirmados | Sim, com baixo risco |
| Uploads órfãos | Produção é **Drive**: 51 referências, 0 locais. dry-run local: 114/114 órfãos (dev) | **Não executável** — não há ferramenta de limpeza p/ Drive |
| Tabelas legadas | 4 tabelas sem nenhum acesso SQL | **Não** anexado — requer backup + confirmação de consumidores externos |

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

**Remover os subcampos legados exige perfil de dados em produção**
(quantos registros ainda têm a forma antiga). Como o banco local tem 0
processos, isso não é comprovável aqui. **Não remover.**

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
upload referenciados — todos em Google Drive** (`/uploads/drive/<pasta>/...`),
com **0 referências a armazenamento local**. Distinct Drive folders: 51.

```bash
node -e '<consulta read-only a app_processes.data->documentos usando DATABASE_URL de .env.production>'
# Referenciados: 51 | em Drive: 51 | local: 0
```

**Bloqueio do passo de limpeza em produção.** O armazenamento de produção é o
**Google Drive**, não o volume local `/data/uploads`. O script
`cleanup-orphan-uploads.js` percorre apenas o filesystem local
(`readdir`/`stat`/`rm`) e **não enumera o Drive**; não existe no repositório
nenhuma ferramenta de limpeza de órfãos no Drive. Portanto **a limpeza de
uploads de produção não é executável** com o que existe hoje:

- não há como listar candidatos a órfãos no Drive sem uma varredura nova
  (comparar os itens sob `GOOGLE_DRIVE_FOLDER_ID` com os 51 caminhos
  referenciados), usando `listFilesInFolder`/`listFilesByAppProperty`
  (`src/uploads/drive-storage.js`);
- o `backup-production.js` arquiva um diretório/volume **local**, não o Drive.
- Isso seria uma **funcionalidade nova**, não uma rotina de manutenção.

Nada foi removido no Drive nem localmente.

---

## 5. Tabelas legadas

Sem nenhum acesso SQL (`FROM`/`INTO`/`UPDATE`/`JOIN`) em `src/` e `scripts/`;
presentes apenas em `src/db/schema-contract.js` (contrato de drift):

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

**Não remover ainda.** Descontinuação exige: backup verificado, confirmação de
que não há consumidores externos (relatórios/BI/integrações) lendo essas
tabelas, e migration própria. Elas permanecem no contrato de schema enquanto
existentes (comentário em `src/db/schema-contract.js:21`).

---

## Impacto em banco

Nenhum. Todas as consultas foram somente leitura; nenhuma migration, DML, DDL
nem exclusão foi executada. O dry-run de uploads não removeu arquivos
(`applied:false`, `uploads/` com 115 arquivos antes e depois).

## Validações desta etapa

| Check | Resultado |
|---|---|
| `git status` | árvore limpa |
| Contagem de uploads antes/depois do dry-run | 115 / 115 (intacta) |
| `app_processes` local | 0 (explica `referenced:0`) |
| Tabelas em `public` | 17 (nenhuma tabela extra além do contrato) |

## Riscos / limitações

- **Produção não acessada**: as conclusões sobre JSONB, uploads e tabelas
  legadas dependem de perfil de dados em produção, indisponível aqui.
- A contagem de 51 uploads referenciados em produção vem da varredura de
  01/09 e **não** foi revalidada.
- `eye-off.svg` é usado por teste; remover exigiria ajustar
  `test/frontend-contract.test.js`.

## Próximo passo proposto (condicionado a autorização)

1. **Concluído (passo 1):** removidos os 6 assets sem uso e os 2 exports mortos
   (`DOCUMENT_LABELS`, `readUsersStore`); `npm test` 292/292 e `npm run check`
   aprovados; verificação independente `APPROVED`.
2. **Bloqueado (passo 2):** limpeza de uploads de produção não é executável —
   produção usa Google Drive e não há ferramenta de varredura/limpeza no Drive.
   Opções: (a) construir uma varredura de órfãos no Drive (funcionalidade nova,
   requer revisão); ou (b) nada a fazer no armazenamento de produção.
3. Maior risco: descontinuação das 4 tabelas legadas via migration, após
   confirmar ausência de consumidores externos e backup verificado.
4. JSONB legado: só após instrumentar/perfilar a forma dos registros
   existentes em produção.
