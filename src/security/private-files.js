import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, parse, relative, resolve, sep } from "node:path";

const DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_DIRECTORY || 0);
const READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const CREATE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;

export class UnsafeFilePathError extends Error {
  constructor(message = "O caminho de arquivo nao e seguro.") {
    super(message);
    this.name = "UnsafeFilePathError";
    this.code = "UNSAFE_FILE_PATH";
  }
}

export class FileSizeLimitError extends Error {
  constructor(limit) {
    super(`O arquivo excede o limite de ${limit} bytes.`);
    this.name = "FileSizeLimitError";
    this.code = "FILE_SIZE_LIMIT";
    this.limit = limit;
  }
}

export async function ensurePrivateDirectory(directory, options = {}) {
  const target = resolve(directory);
  const root = resolve(options.root || target);
  assertContained(root, target);

  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertNoSymbolicLinks(parse(root).root, root);
  await hardenDirectory(root);

  const pathParts = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const part of pathParts) {
    current = resolve(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await hardenDirectory(current);
  }
  return target;
}

export async function openDirectoryNoFollow(directory, options = {}) {
  const target = resolve(directory);
  const root = resolve(options.root || target);
  await assertNoSymbolicLinks(root, target);
  const handle = await open(target, DIRECTORY_FLAGS);
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) throw new UnsafeFilePathError("O caminho privado nao e um diretorio.");
    if (options.mode !== undefined && options.mode !== null) await handle.chmod(options.mode);
    return { handle, metadata };
  } catch (error) {
    await handle.close().catch(() => null);
    throw error;
  }
}

export async function hardenPrivateTree(rootDirectory) {
  const root = await ensurePrivateDirectory(rootDirectory);
  await hardenTreeDirectory(root, root);
}

export async function openRegularFileNoFollow(filePath, options = {}) {
  const target = resolve(filePath);
  const root = resolve(options.root || dirname(target));
  await assertNoSymbolicLinks(root, target);

  const handle = await open(target, READ_FLAGS);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new UnsafeFilePathError("O caminho nao aponta para um arquivo regular.");
    if (options.mode !== undefined && options.mode !== null) await handle.chmod(options.mode);
    return { handle, metadata };
  } catch (error) {
    await handle.close().catch(() => null);
    throw error;
  }
}

export async function privateFileMetadata(filePath, options = {}) {
  const opened = await openRegularFileNoFollow(filePath, options);
  try {
    return opened.metadata;
  } finally {
    await opened.handle.close();
  }
}

export async function readRegularFileLimited(filePath, options = {}) {
  const maximumBytes = normalizeMaximumBytes(options.maximumBytes);
  const opened = await openRegularFileNoFollow(filePath, options);
  try {
    if (!Number.isSafeInteger(opened.metadata.size) || opened.metadata.size > maximumBytes) {
      throw new FileSizeLimitError(maximumBytes);
    }
    const content = Buffer.alloc(opened.metadata.size);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await opened.handle.read(content, offset, content.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return {
      content: offset === content.length ? content : content.subarray(0, offset),
      metadata: opened.metadata
    };
  } finally {
    await opened.handle.close();
  }
}

export async function createPrivateFile(filePath, content, options = {}) {
  const target = resolve(filePath);
  const root = resolve(options.root || dirname(target));
  await ensurePrivateDirectory(dirname(target), { root });
  assertContained(root, target);

  const handle = await open(target, CREATE_FLAGS, options.mode || 0o600);
  try {
    await handle.writeFile(content);
    if (options.sync === true) await handle.sync();
    await handle.chmod(options.mode || 0o600);
  } finally {
    await handle.close();
  }
  return target;
}

export async function assertNoSymbolicLinks(rootDirectory, targetPath) {
  const root = resolve(rootDirectory);
  const target = resolve(targetPath);
  assertContained(root, target);

  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new UnsafeFilePathError("A raiz de arquivos nao e um diretorio real.");
  }

  const parts = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new UnsafeFilePathError("Links simbolicos nao sao aceitos no armazenamento privado.");
    }
    if (index < parts.length - 1 && !metadata.isDirectory()) {
      throw new UnsafeFilePathError("Um componente do caminho nao e diretorio.");
    }
  }
}

async function hardenTreeDirectory(directory, root) {
  await hardenDirectory(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    assertContained(root, entryPath);
    const metadata = await lstat(entryPath);
    if (metadata.isSymbolicLink()) {
      throw new UnsafeFilePathError(`Link simbolico encontrado no armazenamento privado: ${entry.name}`);
    }
    if (metadata.isDirectory()) {
      await hardenTreeDirectory(entryPath, root);
      continue;
    }
    if (!metadata.isFile()) {
      throw new UnsafeFilePathError(`Arquivo especial encontrado no armazenamento privado: ${entry.name}`);
    }
    const opened = await openRegularFileNoFollow(entryPath, { root, mode: 0o600 });
    await opened.handle.close();
  }
}

async function hardenDirectory(directory) {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new UnsafeFilePathError("Diretorios privados nao podem ser links simbolicos.");
  }
  const opened = await openDirectoryNoFollow(directory, { mode: 0o700 });
  await opened.handle.close();
}

function assertContained(root, target) {
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !pathFromRoot.startsWith(sep))) {
    return;
  }
  throw new UnsafeFilePathError("O caminho esta fora da raiz permitida.");
}

function normalizeMaximumBytes(value) {
  if (value === undefined) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("maximumBytes deve ser um inteiro nao negativo.");
  return value;
}
