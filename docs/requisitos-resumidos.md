# Requisitos Resumidos

## Atores

- Usuario do Almoxarifado: gerencia processos de aquisicao e recebimento.
- Administrador: gerencia usuarios, permissoes e configuracoes; pode alterar processos liquidado, mas nunca processos pagos.

## Modulos do sistema

- Processos de aquisicao.
- Documentos PDF do processo.
- Fornecedores.
- Dashboard e indicadores.
- Relatorios.
- Templates e historico de e-mails.
- Auditoria e historico de alteracoes.
- Permissoes e solicitacoes de acesso.
- Observacoes e documentos complementares.

## Status previstos

1. Enviado para SALC
2. Empenho enviado ao fornecedor
3. Aguardando entrega
4. Entrega parcial
5. Entregue
6. Aguardando envio para liquidacao
7. Enviado para liquidacao
8. Liquidado
9. Pago

## Regras centrais

- Processos podem ser criados mesmo incompletos.
- Documentos obrigatorios devem ser PDF: Processo SPED, Nota de Empenho e Nota Fiscal.
- A Nota Fiscal so deve ser anexada apos confirmacao de recebimento.
- Processos nao devem ser excluidos fisicamente; devem ser marcados como inativos.
- Apos `Pago`, o processo fica permanentemente bloqueado para edicao.
- Todas as alteracoes devem gerar auditoria imutavel.
- Consultas publicas nao exigem autenticacao.
- Alteracoes exigem usuario autenticado e autorizado.

## Notificacoes

- E-mails internos aos 7, 14, 21 e 31 dias apos emissao do empenho.
- Aos 30 dias, gerar oficio de notificacao ao fornecedor.
- Apos 31 dias, a contagem continua sem novas acoes automaticas previstas.
