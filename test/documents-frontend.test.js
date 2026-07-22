import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

describe("Documentos no DOM", () => {
  it("trata erro textual, preserva nome/indice e ignora anexos historicos removidos", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
    installDialogPolyfill(dom.window);
    const restoreGlobals = installDomGlobals(dom.window);
    const uploadRequests = new Map();
    const revokedUrls = [];
    const downloadedNames = [];
    let pickedFile = null;
    let controlledReader = null;
    let readerAborted = false;
    let processDocumentPosts = 0;
    let timeoutAborts = 0;
    let objectUrlSequence = 0;
    let auditRequests = 0;
    let processRequests = 0;

    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const originalAnchorClick = dom.window.HTMLAnchorElement.prototype.click;
    const originalInputClick = dom.window.HTMLInputElement.prototype.click;
    const originalWindowSetTimeout = dom.window.setTimeout.bind(dom.window);
    URL.createObjectURL = () => `blob:document-test-${++objectUrlSequence}`;
    URL.revokeObjectURL = (value) => revokedUrls.push(value);
    dom.window.HTMLAnchorElement.prototype.click = function click() {
      downloadedNames.push(this.download);
    };
    dom.window.HTMLInputElement.prototype.click = function click() {
      if (this.type === "file" && pickedFile) {
        Object.defineProperty(this, "files", { configurable: true, value: [pickedFile] });
        pickedFile = null;
        this.dispatchEvent(new dom.window.Event("change"));
        return;
      }
      return originalInputClick.call(this);
    };
    dom.window.setTimeout = (callback, delay, ...args) => originalWindowSetTimeout(
      callback,
      delay === 30_000 ? 5 : delay,
      ...args
    );

    const process = processFixture();
    const secondProcess = secondProcessFixture();
    globalThis.fetch = async (input, options = {}) => {
      const path = String(input);
      if (path === "/auth/session") return jsonResponse({ email: "teste@example.com", nome: "Teste", role: "almoxarifado" });
      if (path === "/api/meta") return jsonResponse({ status: [], filtrosRapidos: [] });
      if (path === "/api/dashboard") return jsonResponse(dashboardPayload());
      if (path === "/api/processes") {
        processRequests += 1;
        return jsonResponse([process, secondProcess]);
      }
      if (path === "/api/suppliers") return jsonResponse([]);
      if (path === `/api/processes/${process.id}/observations`) return jsonResponse(observationFixture(process));
      if (path === `/api/processes/${secondProcess.id}/observations`) return jsonResponse([]);
      if (path === `/api/processes/${process.id}/audit`) {
        auditRequests += 1;
        return jsonResponse(auditFixture(process));
      }
      if (path === `/api/processes/${secondProcess.id}/audit`) return jsonResponse([]);
      if (path === `/api/processes/${process.id}/documents` && options.method === "POST") {
        processDocumentPosts += 1;
        return jsonResponse(process);
      }
      if (path.startsWith("/uploads/")) {
        uploadRequests.set(path, (uploadRequests.get(path) || 0) + 1);
        if (path.endsWith("/missing.pdf")) {
          return new Response("Arquivo nao encontrado", {
            status: 404,
            headers: { "content-type": "text/plain; charset=utf-8" }
          });
        }
        if (path.endsWith("/current.pdf")) {
          return new Response("%PDF-1.4\n%%EOF", {
            status: 200,
            headers: {
              "content-type": "application/pdf",
              "content-disposition": "attachment; filename=Relatorio.pdf; filename*=UTF-8''Relat%C3%B3rio.pdf"
            }
          });
        }
        if (path.endsWith("/foto.png")) {
          return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
            status: 200,
            headers: { "content-type": "image/png", "content-disposition": "attachment; filename=foto.png" }
          });
        }
        if (path.endsWith("/timeout.pdf")) {
          return new Promise((resolve, reject) => {
            const abort = () => {
              timeoutAborts += 1;
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            };
            if (options.signal?.aborted) abort();
            else options.signal?.addEventListener("abort", abort, { once: true });
          });
        }
        if (path.endsWith("/html.pdf")) {
          return new Response("<!doctype html><title>Erro</title>", {
            status: 200,
            headers: { "content-type": "text/html", "content-disposition": "attachment; filename=html.pdf" }
          });
        }
        if (path.endsWith("/empty.pdf")) {
          return new Response("", {
            status: 200,
            headers: { "content-type": "application/pdf", "content-disposition": "attachment; filename=empty.pdf" }
          });
        }
        throw new Error(`O frontend tentou carregar um caminho historico: ${path}`);
      }
      throw new Error(`Requisicao inesperada no teste: ${path}`);
    };

    try {
      await import(`${new URL("../public/app.js", import.meta.url).href}?documents-test=${Date.now()}`);
      dom.window.document.querySelector('[data-section="processes"]').dispatchEvent(new dom.window.MouseEvent("click", {
        bubbles: true,
        cancelable: true
      }));
      try {
        await waitFor(() => dom.window.document.querySelector("[data-open-process]"));
      } catch {
        assert.fail(`A lista nao carregou (${processRequests} requisicoes): ${dom.window.document.querySelector("#processTable").textContent.trim()} ${dom.window.document.querySelector("#appStatus").textContent.trim()}`);
      }
      dom.window.document.querySelector("[data-open-process]").click();
      await waitFor(() => !dom.window.document.querySelector("#processDetailView").classList.contains("hidden"));
      await waitFor(() => dom.window.document.querySelector("#detailPanel").textContent.includes("Editar dados do processo"));
      await waitFor(() => auditRequests > 0);

      dom.window.document.querySelector('[data-detail-tab="documents"]').click();
      await waitFor(() => dom.window.document.querySelector('[data-open-document="/uploads/p1/missing.pdf"]'));
      assert.equal(dom.window.document.querySelector("#documentPreviewContent").hasAttribute("aria-live"), false);
      assert.equal(dom.window.document.querySelector("#documentPreviewStatus").getAttribute("role"), "status");
      assert.ok(dom.window.document.querySelector('[data-remove-document="complementares:1"]'));
      assert.equal(dom.window.document.querySelector('[data-remove-document="complementares:0"]'), null);

      const missingButton = dom.window.document.querySelector('[data-open-document="/uploads/p1/missing.pdf"]');
      const child = dom.window.document.createElement("span");
      child.textContent = missingButton.textContent;
      missingButton.replaceChildren(child);
      child.click();
      await waitFor(() => dom.window.document.querySelector("#documentPreviewContent").textContent.includes("Arquivo nao encontrado"));
      assert.doesNotMatch(dom.window.document.querySelector("#documentPreviewContent").textContent, /Carregando documento/);
      assert.equal(dom.window.document.querySelector("#documentPreviewDownload").disabled, true);

      dom.window.document.querySelector("#documentPreviewDialog").close();
      dom.window.document.querySelector('[data-open-document="/uploads/p1/timeout.pdf"]').click();
      await waitFor(() => dom.window.document.querySelector("#documentPreviewContent").textContent.includes("demorou demais"));
      assert.equal(timeoutAborts, 1);
      assert.equal(dom.window.document.querySelector("#documentPreviewDownload").disabled, true);

      dom.window.document.querySelector("#documentPreviewDialog").close();
      dom.window.document.querySelector('[data-open-document="/uploads/p1/html.pdf"]').click();
      await waitFor(() => dom.window.document.querySelector("#documentPreviewContent").textContent.includes("formato invalido"));
      assert.equal(dom.window.document.querySelector("#documentPreviewContent iframe"), null);

      dom.window.document.querySelector("#documentPreviewDialog").close();
      dom.window.document.querySelector('[data-open-document="/uploads/p1/empty.pdf"]').click();
      await waitFor(() => dom.window.document.querySelector("#documentPreviewContent").textContent.includes("esta vazio"));

      dom.window.document.querySelector("#documentPreviewDialog").close();
      dom.window.document.querySelector('[data-open-document="/uploads/p1/current.pdf"]').click();
      await waitFor(() => dom.window.document.querySelector("#documentPreviewContent iframe"));
      assert.equal(dom.window.document.querySelector("#documentPreviewDialogTitle").textContent, "Relatório.pdf");
      assert.equal(dom.window.document.querySelector("#documentPreviewDownload").disabled, false);
      const dialogFrame = dom.window.document.querySelector("#documentPreviewContent iframe");
      dialogFrame.dispatchEvent(new dom.window.Event("load"));
      assert.equal(dom.window.document.querySelector("#documentPreviewContent").getAttribute("aria-busy"), "false");
      assert.equal(dom.window.document.querySelector("#documentPreviewStatus").textContent, "");
      dom.window.document.querySelector("#documentPreviewDownload").click();
      assert.equal(downloadedNames.at(-1), "Relatório.pdf");

      const currentRequestsBeforeTimeline = uploadRequests.get("/uploads/p1/current.pdf") || 0;
      dom.window.document.querySelector("#documentPreviewDialog").close();
      dom.window.document.querySelector('[data-detail-tab="timeline"]').click();
      await waitFor(() => dom.window.document.querySelector("#detailPanel").textContent.includes("Observação: Material conferido"));
      const timelineItems = [...dom.window.document.querySelectorAll(".timeline > li")];
      assert.equal(timelineItems.filter((item) => item.textContent.includes("Material conferido")).length, 1);
      const processCreation = timelineItems.find((item) => item.querySelector("strong")?.textContent === "Processo criado");
      assert.ok(processCreation);
      assert.match(processCreation.textContent, /15-06-2026/);
      assert.doesNotMatch(processCreation.textContent, /17-07-2026/);
      assert.doesNotMatch(dom.window.document.querySelector("#detailPanel").textContent, /Inclus[aã]o de observa[cç][aã]o/i);
      assert.match(dom.window.document.querySelector("#detailPanel").textContent, /Nota de empenho anexada/);
      assert.match(dom.window.document.querySelector("#detailPanel").textContent, /Nota fiscal anexada/);
      assert.doesNotMatch(dom.window.document.querySelector("#detailPanel").textContent, /notaEmpenho|notaFiscal|Documento nota (?:de )?empenho anexado|Documento nota fiscal anexado/i);
      await waitFor(() => (uploadRequests.get("/uploads/p1/current.pdf") || 0) > currentRequestsBeforeTimeline);
      await waitFor(() => (uploadRequests.get("/uploads/p1/missing.pdf") || 0) > 1);
      await waitFor(() => (uploadRequests.get("/uploads/p1/foto.png") || 0) > 0);
      assert.equal(uploadRequests.get("/uploads/p1/old.pdf") || 0, 0);
      assert.equal(dom.window.document.querySelectorAll(".timeline-document-preview").length, 4);
      const failedPreview = [...dom.window.document.querySelectorAll(".timeline-document-preview")]
        .find((item) => item.textContent.includes("Arquivo nao encontrado"));
      assert.ok(failedPreview);
      assert.doesNotMatch(failedPreview.textContent, /Carregando previa/);
      const currentRequestsBeforeRetry = uploadRequests.get("/uploads/p1/current.pdf") || 0;
      const photoRequestsBeforeRetry = uploadRequests.get("/uploads/p1/foto.png") || 0;
      const missingRequestsBeforeRetry = uploadRequests.get("/uploads/p1/missing.pdf") || 0;
      failedPreview.querySelector("[data-retry-document-preview]").click();
      await waitFor(() => (uploadRequests.get("/uploads/p1/missing.pdf") || 0) > missingRequestsBeforeRetry);
      assert.equal(uploadRequests.get("/uploads/p1/current.pdf") || 0, currentRequestsBeforeRetry);
      assert.equal(uploadRequests.get("/uploads/p1/foto.png") || 0, photoRequestsBeforeRetry);

      const timelineFrame = dom.window.document.querySelector(".timeline-document-preview iframe");
      timelineFrame.dispatchEvent(new dom.window.Event("load"));
      assert.equal(timelineFrame.getAttribute("aria-busy"), "false");
      const timelineImage = dom.window.document.querySelector(".timeline-document-preview img");
      const revokedBeforeImageError = revokedUrls.length;
      timelineImage.dispatchEvent(new dom.window.Event("error"));
      await waitFor(() => revokedUrls.length > revokedBeforeImageError);
      assert.match(timelineImage.parentElement?.textContent || dom.window.document.body.textContent, /não conseguiu renderizar/);
      assert.ok(revokedUrls.length >= 1, "URLs Blob do dialogo fechado devem ser revogadas");

      dom.window.document.querySelector('[data-detail-tab="observations"]').click();
      await waitFor(() => dom.window.document.querySelector("#detailPanel").textContent.includes("3 observações"));
      const observationsCard = dom.window.document.querySelector("#detailPanel");
      assert.match(observationsCard.textContent, /Observações do processo · 3 observações/);
      assert.match(observationsCard.textContent, /Todas as observações estão listadas abaixo/);
      const addObservation = observationsCard.querySelector("[data-open-notes]");
      assert.equal(addObservation.textContent.trim(), "Adicionar");
      assert.doesNotMatch(observationsCard.textContent, /Abrir observa(?:ção|ções)/i);
      addObservation.click();
      await waitFor(() => dom.window.document.querySelector("#observationsDialog").open);
      assert.equal(dom.window.document.querySelector("#observationsDialogTitle").textContent, "Adicionar observação");
      assert.equal(dom.window.document.activeElement, dom.window.document.querySelector('#observationForm textarea[name="conteudo"]'));
      assert.match(dom.window.document.querySelector('#observationForm textarea[name="conteudo"]').placeholder, /observação.*até 350 caracteres/i);
      dom.window.document.querySelector("#observationsDialog").close();

      dom.window.document.querySelector('[data-detail-tab="documents"]').click();
      globalThis.FileReader = class ControlledFileReader {
        constructor() {
          this.listeners = new Map();
          this.result = null;
          this.error = null;
        }

        addEventListener(type, callback) {
          const callbacks = this.listeners.get(type) || [];
          callbacks.push(callback);
          this.listeners.set(type, callbacks);
        }

        abort() {
          readerAborted = true;
          for (const callback of this.listeners.get("abort") || []) callback();
        }

        readAsDataURL() {
          controlledReader = this;
        }
      };
      pickedFile = new dom.window.File(["%PDF-1.4\n%%EOF"], "substituto.pdf", { type: "application/pdf" });
      dom.window.document.querySelector('[data-attach-document="processoSped"]').click();
      await waitFor(() => controlledReader);
      dom.window.document.querySelector("#backToProcesses").click();
      await waitFor(() => dom.window.document.querySelector('[data-open-process="p2"]'));
      dom.window.document.querySelector('[data-open-process="p2"]').click();
      await waitFor(() => dom.window.document.querySelector("#detailProcessNumber").textContent === "PROC-2");
      assert.equal(readerAborted, true);
      assert.equal(processDocumentPosts, 0);
    } finally {
      URL.createObjectURL = originalCreateObjectUrl;
      URL.revokeObjectURL = originalRevokeObjectUrl;
      dom.window.HTMLAnchorElement.prototype.click = originalAnchorClick;
      dom.window.HTMLInputElement.prototype.click = originalInputClick;
      dom.window.setTimeout = originalWindowSetTimeout;
      restoreGlobals();
      dom.window.close();
    }
  });
});

function processFixture() {
  return {
    id: "p1",
    numeroProcesso: "PROC-1",
    numeroEmpenho: "EMP-1",
    fornecedor: "Fornecedor",
    dataProcesso: "2026-06-15",
    status: "Enviado para SALC",
    materiais: [],
    valorTotal: 0,
    diasDecorridos: 0,
    faixaPrazo: "ok",
    documentos: {
      processoSped: { fileName: "processo.pdf", path: "/uploads/p1/current.pdf", mimeType: "application/pdf" },
      notaEmpenho: { fileName: "empenho.pdf", path: "/uploads/p1/missing.pdf", mimeType: "application/pdf" },
      notaFiscal: { fileName: "timeout.pdf", path: "/uploads/p1/timeout.pdf", mimeType: "application/pdf" },
      complementares: [
        { fileName: "registro-legado-sem-caminho.pdf" },
        { fileName: "foto.png", titulo: "Foto", path: "/uploads/p1/foto.png", mimeType: "image/png" },
        { fileName: "html.pdf", titulo: "Resposta HTML", path: "/uploads/p1/html.pdf", mimeType: "application/pdf" },
        { fileName: "empty.pdf", titulo: "Arquivo vazio", path: "/uploads/p1/empty.pdf", mimeType: "application/pdf" }
      ]
    }
  };
}

function secondProcessFixture() {
  return {
    ...processFixture(),
    id: "p2",
    numeroProcesso: "PROC-2",
    numeroEmpenho: "EMP-2",
    documentos: {}
  };
}

function auditFixture(process) {
  return [
    {
      id: "audit-creation",
      processoId: process.id,
      acao: "Criacao de processo",
      detalhes: "Processo PROC-1 criado.",
      usuario: "Teste",
      criadoEm: "2026-07-17T12:00:00.000Z"
    },
    {
      id: "audit-observation",
      processoId: process.id,
      acao: "Inclusao de observacao",
      detalhes: "Observacao registrada no processo.",
      usuario: "Teste",
      criadoEm: "2026-07-17T11:30:00.000Z"
    },
    {
      id: "audit-missing",
      processoId: process.id,
      acao: "Anexo de documento",
      detalhes: "Documento notaEmpenho anexado.",
      usuario: "Teste",
      criadoEm: "2026-07-17T11:00:00.000Z",
      documento: { fileName: "empenho.pdf", path: "/uploads/p1/missing.pdf", mimeType: "application/pdf" }
    },
    {
      id: "audit-invoice",
      processoId: process.id,
      acao: "Anexo de documento",
      detalhes: "Documento notaFiscal anexado.",
      usuario: "Teste",
      criadoEm: "2026-07-17T10:45:00.000Z",
      documento: { chave: "notaFiscal", fileName: "timeout.pdf", path: "/uploads/p1/timeout.pdf", mimeType: "application/pdf" }
    },
    {
      id: "audit-photo",
      processoId: process.id,
      acao: "Anexo de documento",
      detalhes: "Documento complementares anexado.",
      usuario: "Teste",
      criadoEm: "2026-07-17T10:30:00.000Z",
      documento: { fileName: "foto.png", path: "/uploads/p1/foto.png", mimeType: "image/png" }
    },
    {
      id: "audit-current",
      processoId: process.id,
      acao: "Anexo de documento",
      detalhes: "Documento processoSped anexado.",
      usuario: "Teste",
      criadoEm: "2026-07-17T10:00:00.000Z",
      documento: { fileName: "processo.pdf", path: "/uploads/p1/current.pdf", mimeType: "application/pdf" }
    },
    {
      id: "audit-old",
      processoId: process.id,
      acao: "Anexo de documento",
      detalhes: "Documento processoSped anexado.",
      usuario: "Teste",
      criadoEm: "2026-07-16T10:00:00.000Z",
      documento: { fileName: "antigo.pdf", path: "/uploads/p1/old.pdf", mimeType: "application/pdf" }
    }
  ];
}

function observationFixture(process) {
  return [
    {
      id: "observation-1",
      processoId: process.id,
      conteudo: "Material conferido",
      usuario: "Teste",
      criadoEm: "2026-07-17T11:30:00.000Z"
    },
    {
      id: "observation-2",
      processoId: process.id,
      conteudo: "Conferência registrada",
      usuario: "Teste",
      criadoEm: "2026-07-17T11:20:00.000Z"
    },
    {
      id: "observation-3",
      processoId: process.id,
      conteudo: "Material armazenado",
      usuario: "Teste",
      criadoEm: "2026-07-17T11:10:00.000Z"
    }
  ];
}

function dashboardPayload() {
  return {
    ano: 2026,
    anos: [2026],
    metrics: {},
    charts: { execucaoMensal: [], distribuicaoStatus: [] }
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("A interface nao atingiu o estado esperado dentro do prazo.");
}

function installDialogPolyfill(window) {
  window.HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  window.HTMLDialogElement.prototype.close = function close() {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new window.Event("close"));
  };
}

function installDomGlobals(window) {
  const values = {
    window,
    document: window.document,
    localStorage: window.localStorage,
    location: window.location,
    File: window.File,
    FileReader: window.FileReader,
    alert: () => {},
    confirm: () => true
  };
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(globalThis, key) ? globalThis[key] : undefined);
    globalThis[key] = value;
  }
  previous.set("fetch", globalThis.fetch);
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  };
}
