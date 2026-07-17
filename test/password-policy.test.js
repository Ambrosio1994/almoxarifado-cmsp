import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, isValidPassword, verifyPassword } from "../src/security/password-policy.js";

describe("hash de senha", () => {
  it("gera hash compativel e nunca persiste a senha em texto", async () => {
    const password = "Almox@123";
    const hash = await hashPassword(password);
    assert.doesNotMatch(hash, new RegExp(password));
    assert.equal(await verifyPassword(password, hash), true);
    assert.equal(await verifyPassword("Incorreta@123", hash), false);
  });

  it("trata hash ausente ou malformado como credencial invalida", async () => {
    assert.equal(await verifyPassword("Almox@123", ""), false);
    assert.equal(await verifyPassword("Almox@123", "salt:hash"), false);
  });

  it("mantem a politica funcional compartilhada", () => {
    assert.equal(isValidPassword("Almox@123"), true);
    assert.equal(isValidPassword("almox@123"), false);
    assert.equal(isValidPassword("Álmox 12"), false, "espaco isolado nao e caractere especial");
    assert.equal(isValidPassword("Álmox@12"), true, "letras maiusculas Unicode continuam validas");
    assert.equal(isValidPassword(`A1@${"x".repeat(253)}`), true, "aceita exatamente 256 caracteres");
    assert.equal(isValidPassword(`A1@${"x".repeat(254)}`), false, "rejeita acima de 256 caracteres");
  });
});
