import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatCurrencyInput,
  formatCommitmentNumber,
  isStandardCommitmentNumber,
  normalizeCommitmentSequence,
  parseCurrencyInput,
  parseCommitmentNumber
} from "../public/process-fields.js";

describe("campos do numero de empenho", () => {
  it("monta o numero com ano, prefixo fixo e apenas o sequencial informado", () => {
    assert.equal(formatCommitmentNumber("2026", "10"), "2026NE00010");
    assert.equal(formatCommitmentNumber(2026, "00010"), "2026NE00010");
  });

  it("aceita somente algarismos no sequencial e remove zeros redundantes", () => {
    assert.equal(normalizeCommitmentSequence(" 00a1-2 "), "12");
    assert.equal(normalizeCommitmentSequence("000"), "");
  });

  it("decompoe numeros padronizados para preencher a edicao", () => {
    assert.deepEqual(parseCommitmentNumber("2026ne00010"), { year: "2026", sequence: "10" });
    assert.equal(parseCommitmentNumber("NE 10/2026"), null);
  });

  it("rejeita ano, sequencial e formatos incompletos", () => {
    assert.equal(formatCommitmentNumber("26", "10"), "");
    assert.equal(formatCommitmentNumber("2026", "0"), "");
    assert.equal(isStandardCommitmentNumber("2026NE00010"), true);
    assert.equal(isStandardCommitmentNumber("2026NE0010"), false);
  });
});

describe("campos monetarios do processo", () => {
  it("aceita valores acima de mil nos formatos brasileiro e simples", () => {
    assert.equal(parseCurrencyInput("1.234,56"), 1234.56);
    assert.equal(parseCurrencyInput("1234,56"), 1234.56);
    assert.equal(parseCurrencyInput("1234.56"), 1234.56);
    assert.equal(parseCurrencyInput("1.000"), 1000);
  });

  it("formata valores para edicao em reais", () => {
    assert.equal(formatCurrencyInput(1234.56), "1.234,56");
    assert.ok(Number.isNaN(parseCurrencyInput("valor invalido")));
  });
});
