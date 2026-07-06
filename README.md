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
- Estrutura inicial para fornecedores, documentos, notificações e relatórios.

## Estrutura

```text
almoxarifado-cmsp/
  data/
    store.json
  docs/
    requisitos-resumidos.md
  public/
    app.js
    index.html
    styles.css
  src/
    domain/
      processos.js
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
5. Implementar rotina diária de notificações e geração do ofício de 30 dias.
