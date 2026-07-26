import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DETAIL_TAB_PATHS,
  SECTION_PATHS,
  isAppRoutePath,
  isSpaNavigationPath,
  parseAppRoute,
  processPath,
  sectionPath
} from "../public/app-routes.js";

describe("rotas da aplicacao", () => {
  it("mapeia todas as secoes para URLs canonicas", () => {
    assert.deepEqual(SECTION_PATHS, {
      dashboard: "/graficos",
      processes: "/empenhos",
      board: "/quadro",
      suppliers: "/fornecedores",
      settings: "/configuracoes",
      audit: "/auditoria",
      users: "/usuarios"
    });

    for (const [section, path] of Object.entries(SECTION_PATHS)) {
      assert.equal(sectionPath(section), path);
      assert.deepEqual(parseAppRoute(path), {
        kind: "section",
        section,
        canonicalPath: path
      });
    }
    assert.equal(sectionPath("desconhecida"), "/graficos");
  });

  it("mapeia todas as abas de um empenho e codifica o identificador", () => {
    assert.deepEqual(DETAIL_TAB_PATHS, {
      general: "dados-gerais",
      documents: "documentos",
      timeline: "linha-do-tempo",
      deliveries: "entregas",
      observations: "observacoes",
      emails: "emails"
    });

    for (const [tab, slug] of Object.entries(DETAIL_TAB_PATHS)) {
      const path = processPath("processo 42", tab);
      assert.equal(path, `/empenhos/processo%2042/${slug}`);
      assert.deepEqual(parseAppRoute(path), {
        kind: "process",
        section: "processes",
        processId: "processo 42",
        tab,
        canonicalPath: path
      });
    }
  });

  it("canonicaliza raiz, barra final, consulta e detalhe sem aba", () => {
    assert.deepEqual(parseAppRoute("/"), { kind: "root", canonicalPath: "/" });
    assert.deepEqual(parseAppRoute("quadro/?origem=menu#cartao"), {
      kind: "section",
      section: "board",
      canonicalPath: "/quadro"
    });
    assert.deepEqual(parseAppRoute("/empenhos/p1"), {
      kind: "process",
      section: "processes",
      processId: "p1",
      tab: "general",
      canonicalPath: "/empenhos/p1/dados-gerais"
    });
    assert.deepEqual(parseAppRoute("/empenhos/p1/documentos/"), {
      kind: "process",
      section: "processes",
      processId: "p1",
      tab: "documents",
      canonicalPath: "/empenhos/p1/documentos"
    });
    assert.equal(processPath(" p1 ", "aba-inexistente"), "/empenhos/p1/dados-gerais");
  });

  it("rejeita rotas e identificadores de empenho invalidos", () => {
    for (const path of [
      "/pagina-inexistente",
      "/empenhos/p1/aba-inexistente",
      "/empenhos/p1/documentos/excesso",
      "/empenhos/%20/documentos",
      "/empenhos/%2F/documentos",
      "/empenhos/%00/documentos",
      "/empenhos/%E0%A4%A/documentos"
    ]) {
      assert.equal(parseAppRoute(path).kind, "not-found", path);
      assert.equal(isAppRoutePath(path), false, path);
    }

    for (const processId of [undefined, null, "", "   ", "p/1", "p\u00001", "p\n1"]) {
      assert.equal(processPath(processId, "documents"), "/empenhos", String(processId));
    }
  });

  it("distingue caminhos validos usados pelo fallback da SPA", () => {
    for (const path of [
      "/",
      ...Object.values(SECTION_PATHS),
      "/empenhos/p1",
      ...Object.values(DETAIL_TAB_PATHS).map((slug) => `/empenhos/p1/${slug}`)
    ]) {
      assert.equal(isAppRoutePath(path), true, path);
      assert.equal(isSpaNavigationPath(path), true, path);
    }

    assert.equal(isSpaNavigationPath("/pagina-inexistente"), true);
    assert.equal(isSpaNavigationPath("/qualquer/caminho/sem-extensao"), true);
    assert.equal(isSpaNavigationPath("/asset-inexistente.js"), false);
    assert.equal(isSpaNavigationPath("/assets/arquivo.css"), false);
  });
});
