# Operacao

## Health check

O endpoint `GET /health` responde com `200` quando:

- o storage responde;
- o e-mail esta configurado;
- o scheduler de e-mails foi iniciado.

O payload inclui `checks.storageBackend` com o backend ativo:

- `postgres`: a aplicacao esta lendo e gravando no PostgreSQL.
- `json`: a aplicacao caiu no fallback local.

Use esse campo no monitor externo para detectar regressao de storage.

## Uploads

Em producao, os uploads devem apontar para um volume montado fora da imagem, por exemplo:

```bash
docker run -e UPLOAD_STORAGE_ROOT=/data/uploads -v almox_uploads:/data/uploads ...
```

No Dockerfile, o caminho padrao de runtime esta em `/data/uploads`.

## CI

O workflow de CI executa:

- `npm test`
- checagem de sintaxe dos scripts principais
- `docker build`

## Monitor externo

Configurar um monitor HTTP simples contra `GET /health` e alertar em `503`.

Critério prático:

- `200`: sistema saudável o suficiente para operar.
- `503`: falta e-mail, storage ou scheduler.
