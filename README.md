# Sistema de Gestão de Processos do Almoxarifado

Aplicação web para centralizar e acompanhar os processos administrativos do almoxarifado, desde o recebimento da Nota de Empenho até a liquidação, o pagamento e o arquivamento.

O sistema reúne processos, fornecedores, materiais, documentos, entregas, observações, notificações e registros de auditoria em uma única interface, com regras de acesso e bloqueio adequadas ao fluxo operacional.

> Produção: [https://sapgestao.dpdns.org](https://sapgestao.dpdns.org)

## Principais recursos

- Dashboard com indicadores operacionais e financeiros.
- Cadastro e acompanhamento de processos administrativos.
- Suporte a múltiplos materiais no mesmo empenho.
- Pesquisa e filtros por processo, empenho, fornecedor, material, ano e status.
- Painel anual com agrupamento pelo ano do empenho.
- Cadastro de fornecedores e histórico de processos relacionados.
- Controle de entregas por material.
- Observações em ordem cronológica.
- Armazenamento protegido de documentos e anexos.
- Geração de relatórios em PDF, Excel e CSV.
- Envio de notificações por e-mail.
- Histórico de envios com idempotência, tentativas e registro de erros.
- Auditoria das alterações realizadas pela API.
- Autenticação por sessão com cookies `HttpOnly`.
- Endpoints de saúde para monitoramento da aplicação.

## Regras do fluxo

Os processos podem ser editados conforme o status atual:

- Antes de **Liquidado**: edição permitida para usuários autorizados.
- Em **Liquidado**: edição permitida somente para administradores.
- Em **Pago**: edição bloqueada permanentemente.

O sistema também registra alterações importantes em trilha de auditoria, preservando o histórico operacional de cada processo.

## Tecnologias

- Node.js 20 ou superior
- JavaScript com ES Modules
- PostgreSQL
- Neon PostgreSQL em produção
- Google Drive via OAuth 2.0 para armazenamento de arquivos
- HTML, CSS e JavaScript no frontend
- Docker e Docker Compose
- Caddy como proxy reverso e terminador TLS
- Testes com `node:test` e `jsdom`

## Estrutura do projeto

```text
almoxarifado-cmsp/
├── data/                  # Dados legados e armazenamento local auxiliar
├── db/
│   └── migrations/       # Migrações versionadas do PostgreSQL
├── deploy/               # Exemplos de configuração de infraestrutura
├── docs/                 # Requisitos, operação e implantação
├── public/               # Interface web
├── scripts/              # Migração, backup, deploy e rotinas administrativas
├── src/
│   ├── db/               # Conexão e acesso ao PostgreSQL
│   ├── domain/           # Regras de negócio
│   ├── repositories/     # Persistência e consultas
│   ├── uploads/          # Backends e validações de armazenamento
│   ├── server.js         # Servidor da aplicação
│   └── storage.js        # Camada de armazenamento
└── test/                 # Testes automatizados
```

## Requisitos

Antes de iniciar, instale:

- Node.js 20+
- npm
- PostgreSQL 14+ ou Docker
- Git

Para recursos opcionais, também será necessário configurar:

- uma conta SMTP para envio de e-mails;
- credenciais OAuth 2.0 do Google, quando o backend de arquivos for o Google Drive.

## Instalação local

Clone o repositório e instale as dependências:

```bash
git clone https://github.com/Ambrosio1994/almoxarifado-cmsp.git
cd almoxarifado-cmsp
npm ci
```

Crie o arquivo de ambiente local:

```bash
cp .env.example .env
```

Revise as variáveis do arquivo `.env` antes de iniciar a aplicação. Nunca versione credenciais ou segredos reais.

### Banco de dados local com Docker

Suba o PostgreSQL:

```bash
npm run db:local:up
```

Aplique as migrações:

```bash
npm run db:migrate
```

### Iniciar em desenvolvimento

```bash
npm run dev
```

No Windows, também é possível usar:

```powershell
.\run-dev.ps1
```

A aplicação ficará disponível em:

```text
http://localhost:3000
```

> Use `npm run dev` no ambiente local. O comando `npm start` é destinado à execução em produção.

## Configuração

As variáveis disponíveis estão documentadas em `.env.example` e `.env.production.example`.

### Administração local

```env
ADMIN_EMAILS=admin@example.com
LOCAL_ADMIN_EMAIL=admin@example.com
LOCAL_ADMIN_PASSWORD=troque-esta-senha
```

Não existe senha administrativa padrão. O bootstrap local só ocorre quando as credenciais são definidas explicitamente.

### PostgreSQL

```env
DATABASE_URL=postgres://usuario:senha@localhost:5432/almoxarifado
DB_SSL=false
DB_POOL_MAX=10
```

Em produção, o PostgreSQL é a fonte de verdade. A aplicação falha de forma explícita quando o schema necessário não está disponível.

### Envio de e-mails

Exemplo com Gmail e senha de app:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
GMAIL_USER=seu-email@gmail.com
GMAIL_APP_PASSWORD=sua-senha-de-app
EMAIL_FROM_ADDRESS=seu-email@gmail.com
EMAIL_FROM_NAME=Almoxarifado
EMAIL_TEST_RECIPIENT=destino-de-teste@example.com
```

O destinatário operacional é obtido do cadastro do fornecedor. Disparos de teste são redirecionados para `EMAIL_TEST_RECIPIENT`.

Para um provedor SMTP transacional, utilize as variáveis `SMTP_USER`, `SMTP_PASS` e `EMAIL_FROM_ADDRESS` conforme a documentação do serviço escolhido.

### Armazenamento de arquivos

#### Armazenamento local

```env
UPLOAD_STORAGE_BACKEND=local
UPLOAD_STORAGE_ROOT=./uploads
```

#### Google Drive

```env
UPLOAD_STORAGE_BACKEND=drive
GOOGLE_DRIVE_FOLDER_ID=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
```

Para gerar o refresh token OAuth:

```bash
npm run google:authorize
```

Para validar a integração:

```bash
npm run google:check
npm run drive:check
```

## Testes e validações

Execute a suíte completa:

```bash
npm test
```

Testes específicos do banco:

```bash
npm run test:db
```

Validação estática dos principais arquivos e scripts:

```bash
npm run check
```

Fluxo recomendado antes de enviar alterações:

```bash
npm ci
npm test
npm run check
```

## Endpoints de saúde

- `GET /health/live`: verifica se o processo da aplicação está ativo.
- `GET /health/ready`: verifica se a aplicação está pronta para receber tráfego.
- `GET /health`: apresenta uma visão consolidada dos componentes essenciais.

## Implantação em produção

Crie o arquivo de configuração de produção:

```bash
cp .env.production.example .env.production
chmod 600 .env.production
```

Valide o ambiente e faça o deploy pelo fluxo seguro:

```bash
bash scripts/deploy-production.sh check
npm run deploy:production
```

Outros comandos úteis:

```bash
npm run validate:production
npm run backup:production
npm run smoke:production
```

O exemplo de implantação publica a aplicação somente em `127.0.0.1` e utiliza o Caddy para TLS e proxy reverso.

Consulte:

- `docs/deployment-checklist.md` para o checklist de implantação;
- `docs/operations.md` para operação, backup, restauração e rollback.

## Rotinas administrativas

### Importação do armazenamento legado

```bash
npm run db:import-store
```

A importação utiliza modo de simulação por padrão e exige confirmações explícitas para alterações em produção.

### Limpeza de arquivos órfãos

Simulação:

```bash
npm run uploads:cleanup:dry-run
```

Aplicação da limpeza:

```bash
npm run uploads:cleanup
```

### Substituição controlada de documentos

```bash
npm run storage:replace-document -- \
  --process-id ID_DO_PROCESSO \
  --document-key notaFiscal \
  --file "/caminho/arquivo.pdf" \
  --technical-user "usuario@example.com" \
  --reason "Motivo da substituição" \
  --dry-run
```

A rotina valida o PDF, calcula checksum, utiliza bloqueio transacional e registra a operação em auditoria.

## Segurança e confiabilidade

Entre as medidas adotadas no projeto estão:

- segredos excluídos do Git por `.gitignore`;
- cookies de sessão `HttpOnly`;
- limites de requisição e upload configuráveis;
- rate limiting no login;
- validação de PDFs enviados;
- escrita atômica no armazenamento local;
- logs estruturados em JSON;
- reservas distribuídas para evitar e-mails duplicados;
- migrações versionadas e idempotentes;
- backup e smoke test no fluxo de produção;
- trilha de auditoria para operações sensíveis.

## Documentação complementar

A pasta `docs/` contém materiais de apoio sobre requisitos, implantação, operação, backup, restauração e decisões técnicas do sistema.

## Status

O sistema está em desenvolvimento ativo e já possui ambiente de produção, persistência PostgreSQL, autenticação, gerenciamento de processos, fornecedores, documentos, relatórios, notificações e auditoria.