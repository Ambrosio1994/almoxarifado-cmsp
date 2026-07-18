import { spawn } from "node:child_process";

export async function persistedPdfValidationError(filePath, content, options = {}) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content || "");
  if (!buffer.subarray(0, 4).equals(Buffer.from("%PDF"))) return null;
  const result = await runCommand("pdfinfo", [filePath], options.timeoutMs || 10_000);
  if (result === 0) return null;
  if (result < 0) {
    return {
      statusCode: 503,
      message: "O servico de validacao de PDF esta indisponivel. Tente novamente mais tarde."
    };
  }
  return {
    statusCode: 400,
    message: "O PDF esta corrompido ou nao possui uma estrutura renderizavel."
  };
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    let settled = false;
    let forceKill;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKill);
      resolve(code);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      forceKill = setTimeout(() => {
        child.kill("SIGKILL");
        finish(-2);
      }, 1_000);
      forceKill.unref?.();
    }, timeoutMs);
    timeout.unref?.();
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
  });
}
