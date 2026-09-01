# Seguranca da role e recuperacao do PostgreSQL

Este runbook prepara uma reducao controlada de privilegios. Ele nao altera
roles, ownership, schema ou dados automaticamente.

## Responsaveis e evidencia

Preencha e mantenha junto ao ticket de mudanca:

| Item | Registro obrigatorio |
| --- | --- |
| Responsavel pelo Neon/PITR | Nome e contato do operador autorizado |
| Retencao PITR | Confirmar no painel Neon, com captura/data; nao inferir pelo plano |
| Ultimo backup consistente | Caminho do manifesto, SHA-256 e horario |
| Ultimo restore testado | Data, ambiente isolado, operador e resultado de `db:verify-restored` |
| RTO acordado | Tempo maximo de recuperacao aprovado pelo responsavel |

O backup local nao substitui PITR, backup externo criptografado nem um teste de
restauracao. Antes de qualquer revogacao, confirme PITR/backup e que um restore
isolado recente foi validado.

## Auditoria somente leitura

Com a URL da role que pode ler os catalogos, execute:

```bash
DATABASE_URL_AUDIT='postgresql://...' POSTGRES_RUNTIME_ROLE=almoxarifado_app \
  npm run db:audit-runtime-role
```

O comando usa transacao `REPEATABLE READ READ ONLY`, nao escreve no banco e nao
imprime a URL. Ele lista atributos, memberships, ownership, permissoes de
schema/tabelas/sequences/funcoes e default privileges. Exit code `2` indica
privilegio administrativo ou membership sensivel; isso e evidencia para revisao,
nao uma revogacao automatica.

## Restore isolado

1. Valide hashes do manifesto e restaure dump e uploads em uma branch/database
   isolada, nunca no alvo de producao.
2. Configure `RESTORE_DATABASE_URL` para esse banco e `RESTORE_UPLOAD_ROOT`
   para os uploads restaurados.
3. Compare as contagens esperadas do backup quando disponiveis.

```bash
RESTORE_DATABASE_URL='postgresql://...' \
RESTORE_DATABASE_CONFIRMATION=isolated-restored \
RESTORE_UPLOAD_ROOT=/caminho/uploads-restaurados \
RESTORE_EXPECTED_PROCESSES=79 \
npm run db:verify-restored
```

O verificador recusa host+porta+database iguais a `DATABASE_URL` ou
`DATABASE_URL_MIGRATION`; usa transacao somente leitura; confere migrations,
processos, itens, usuarios, auditorias, referencias orfas e uploads referidos.
Registre a saida sem segredos e a data do teste na tabela acima.

## Mudanca controlada da role

Somente `neondb_owner`, em janela aprovada, pode executar esta etapa. Mantenha
`DATABASE_URL` apontando para `almoxarifado_app` e reserve
`DATABASE_URL_MIGRATION` para `neondb_owner`; nunca promova a conexao normal da
aplicacao para resolver falha de permissao.

1. Salve a auditoria de privilegios e o estado atual das memberships.
2. Mapeie cada permissao efetivamente usada no relatorio e conceda apenas as
   permissoes minimas explicitas: `USAGE` no schema, DML por tabela, `USAGE`
   de sequence e `EXECUTE` somente em funcoes usadas. Nao use `GRANT ALL`.
3. Rode os smoke tests de login/logout, processos, fornecedores, documentos,
   auditoria, e-mail, scheduler, dashboard, relatorios e health checks ainda
   **antes** da revogacao.
4. Remova a membership administrativa e, em comandos separados e registrados,
   aplique `NOCREATEROLE`, `NOCREATEDB`, `NOREPLICATION` e `NOBYPASSRLS`.
5. Repita os smoke tests usando exclusivamente `almoxarifado_app` e arquive o
   relatorio de auditoria sem alertas administrativos.

Nao altere ownership de objetos de `neondb_owner`, nao execute DDL pela role de
runtime e nao altere dados como teste.

## Rollback de privilegios

Antes da etapa 4, o operador deve salvar comandos exatos de rollback baseados no
estado capturado pelo auditor (atributos e membership anteriores). Se um smoke
test critico falhar, interrompa a janela, restaure apenas a permissao especifica
necessaria pelo owner e investigue. Nao use grants administrativos amplos como
rollback permanente; corrija o mapa de privilegios, repita o teste em ambiente
isolado e agende nova janela.

## Permissoes locais

Verifique sem alterar arquivos:

```bash
npm run permissions:local
```

Depois de conferir os caminhos do checkout, aplique somente `.env`,
`.env.production`, `data/` e `data/store.json`:

```bash
npm run permissions:local -- --apply
```

Em plataformas sem permissoes POSIX, o comando informa que a verificacao nao e
aplicavel e nao altera arquivos. Docker, CI e Render continuam responsaveis por
seus proprios volumes e segredos.
