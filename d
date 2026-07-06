[33mcommit 79e2975d7a6b96c0361541f4706992106528efe8[m[33m ([m[1;36mHEAD[m[33m -> [m[1;32mmain[m[33m, [m[1;31morigin/main[m[33m, [m[1;31morigin/HEAD[m[33m)[m
Author: Ambrosio1994 <sgtambrosio2019@gmail.com>
Date:   Mon Jul 6 16:49:09 2026 -0300

     Painel financeiro:
          - Corrigido para não depender dos filtros da aba Processos.
          - Agora usa os totais globais do dashboard.
    
      - Fornecedores:
          - Busca por nome do fornecedor.
          - Exibição de e-mails, telefones, endereços e observações.
          - Botão para adicionar informações do fornecedor.
          - Histórico de processos por fornecedor.
          - Clique em um processo do histórico abre o detalhe do processo.
          - Botão Voltar retorna para fornecedores mantendo a pesquisa.
    
      - Linha do tempo:
          - Anexos de documentos aparecem com miniatura clicável.
          - Clique na miniatura abre o documento em nova aba.
          - Remoção de documento aparece com bolinha vermelha.
          - Ajuste para evitar miniaturas duplicadas.
    
      - Configurações:
          - Botões passaram a abrir painéis funcionais.
          - Templates de e-mail editáveis.
          - Prazos de notificação editáveis.
          - Lista de status visível.
          - Cadastro/ativação/inativação de responsáveis.
          - Backend para persistir configurações.
    
      - Processos:
          - Validação contra duplicidade de número de processo.
          - Validação contra número de empenho já vinculado a outro processo.
          - Download da lista de processos em Excel, PDF e CSV.
          - Exportação respeita os filtros atuais.
    
      - Documentos:
          - Upload ampliado para PDF, Excel, CSV, Word, texto e imagens comuns.
          - MIME correto ao abrir/baixar documentos.
          - PDF compilado continua usando apenas PDFs.
    
      - Tabela de processos:
          - Coluna Materiais agora trunca descrições longas para não deixar linhas enormes.
          - Texto completo fica no tooltip.

public/app.js
public/index.html
public/styles.css
src/domain/processos.js
src/server.js
src/storage.js
test/processos.test.js
