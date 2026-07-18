import http from "node:http";
import { google } from "googleapis";

const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
const redirectUri = "http://localhost:3000/oauth2callback";

if (!clientId || !clientSecret) {
  throw new Error("Configure GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET antes de executar.");
}

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const authorizationUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/drive"]
});

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, redirectUri);
    if (requestUrl.pathname !== "/oauth2callback") {
      response.writeHead(404);
      response.end("Rota não encontrada.");
      return;
    }

    const oauthError = requestUrl.searchParams.get("error");
    if (oauthError) throw new Error(`Autorização recusada: ${oauthError}`);

    const authorizationCode = requestUrl.searchParams.get("code");
    if (!authorizationCode) throw new Error("Código de autorização não recebido.");

    const { tokens } = await oauth2Client.getToken(authorizationCode);
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Autorização concluída. Volte ao terminal.");
    console.log("\nAutorização concluída.");

    if (!tokens.refresh_token) {
      console.error("\nO Google não retornou um refresh token.");
      console.error("Revogue o acesso do aplicativo na sua Conta Google e execute novamente.");
    } else {
      console.log("\nGOOGLE_REFRESH_TOKEN:");
      console.log(tokens.refresh_token);
    }
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Erro ao concluir a autorização.");
    console.error(error instanceof Error ? error.message : "Erro desconhecido ao concluir a autorização.");
  } finally {
    server.close();
  }
});

server.listen(3000, () => {
  console.log("\nAbra esta URL no navegador:\n");
  console.log(authorizationUrl);
  console.log("\nAguardando o retorno em http://localhost:3000/oauth2callback");
});
