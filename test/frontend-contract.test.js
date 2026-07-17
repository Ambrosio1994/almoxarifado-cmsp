import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isValidPasswordInput,
  PASSWORD_POLICY_MESSAGE
} from "../public/password-fields.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const passwordComponent = readFileSync(new URL("../public/password-fields.js", import.meta.url), "utf8");

describe("contrato visual e de navegacao", () => {
  it("exibe e-mail e senha juntos no formulario inicial", () => {
    const loginForm = html.match(/<form id="loginForm"[\s\S]*?<\/form>/)?.[0] || "";
    assert.match(loginForm, /name="email"[^>]*type="email"/);
    assert.match(loginForm, /name="senha"[^>]*type="password"/);
    assert.match(loginForm, />Entrar<\/button>/);
  });

  it("abre no Painel sem carregar a lista completa de processos no boot", () => {
    const boot = app.slice(app.indexOf("async function boot()"), app.indexOf("async function loadDashboardData"));
    assert.match(boot, /api\("\/api\/meta"\)/);
    assert.match(boot, /loadDashboardData\(\)/);
    assert.match(boot, /openSection\("dashboard"\)/);
    assert.doesNotMatch(boot, /\/api\/processes/);
    const processView = html.match(/<section[^>]*id="processListView"[^>]*>/)?.[0] || "";
    assert.match(processView, /class="[^"]*hidden[^"]*"/);
    assert.match(html, /id="dashboardView"/);
  });

  it("mantem Usuarios e permissoes separado de Templates", () => {
    assert.match(html, /data-section="users"[^>]*>[^<]*<span[^>]*>[\s\S]*?Usuarios e permissoes<\/a>/);
    assert.match(html, /data-section="settings"[^>]*>[^<]*<span[^>]*>[\s\S]*?Templates<\/a>/);
    assert.match(html, /id="usersView"/);
    assert.match(html, /id="settingsView"/);
  });

  it("preserva os campos, limites e rotulos de aceite", () => {
    assert.match(html, /id="newProcessButton">\+ Novo<\/button>/);
    assert.doesNotMatch(html, /id="newProcessButton">\+ Novo processo<\/button>/);
    assert.match(html, /name="numeroProcesso" maxlength="20"/);
    assert.match(html, /name="numeroEmpenho" maxlength="20"/);
    assert.match(html, /name="fornecedor" maxlength="100"/);
    assert.match(html, /name="dataProcesso"[\s\S]*?placeholder="DD-MM-AAAA"[\s\S]*?maxlength="10"/);
    assert.match(html, /name="conteudo"[^>]*minlength="1"[^>]*maxlength="350"/);
  });

  it("usa dialog acessivel para entregas e nao usa prompt nativo", () => {
    assert.match(html, /<dialog id="deliveryDialog"[^>]*aria-labelledby="deliveryDialogTitle"[^>]*aria-describedby="deliveryDialogDescription"/);
    assert.match(html, /id="deliveryForm"/);
    assert.doesNotMatch(app, /\bprompt\s*\(/);
  });

  it("mantem os indicadores do Painel densos em tablets e legiveis no celular", () => {
    const tabletRules = styles.slice(styles.indexOf("@media (max-width: 980px)"), styles.indexOf("@media (prefers-reduced-motion"));
    const mobileRules = styles.slice(styles.indexOf("@media (max-width: 640px)"));
    assert.doesNotMatch(tabletRules, /\.dashboard-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
    assert.match(mobileRules, /\.dashboard-grid\s*\{\s*grid-template-columns:\s*1fr 1fr/);
    assert.match(mobileRules, /\.dashboard-year\s*\{[\s\S]*?width:\s*100%/);
    assert.match(mobileRules, /\.chart-row > \.bar-track\s*\{[\s\S]*?grid-column:\s*1 \/ -1/);
  });
});

describe("componente de senha", () => {
  it("implementa o olho dentro do campo com estados acessiveis", () => {
    assert.match(passwordComponent, /className = "password-input-wrap"/);
    assert.match(passwordComponent, /className = "password-toggle"/);
    assert.match(passwordComponent, /type = passwordVisible \? "text" : "password"/);
    assert.match(passwordComponent, /"aria-label"/);
    assert.match(passwordComponent, /"aria-pressed"/);
    assert.doesNotMatch(html, />\s*Mostrar\s*<\/button>/);
  });

  it("aplica a mesma politica de 8 a 256 caracteres", () => {
    assert.equal(isValidPasswordInput("Senha@12"), true);
    assert.equal(isValidPasswordInput("Álmox@12"), true);
    assert.equal(isValidPasswordInput("Ab@123"), false);
    assert.equal(isValidPasswordInput("senha@12"), false);
    assert.equal(isValidPasswordInput("Senha@xx"), false);
    assert.equal(isValidPasswordInput("Senha 12"), false);
    assert.equal(isValidPasswordInput(`A1@${"a".repeat(253)}`), true);
    assert.equal(isValidPasswordInput(`A1@${"a".repeat(254)}`), false);
    assert.match(PASSWORD_POLICY_MESSAGE, /8 e 256/);
  });
});
