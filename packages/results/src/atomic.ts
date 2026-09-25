/**
 * Small filesystem primitives shared by run persistence.
 *
 * Kept dependency-free (no schema knowledge) so both `run-store` and its tests
 * can use them, and so a future Bun-specific writer can swap the implementation
 * without touching record contracts.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { type FileHandle, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export interface AtomicWriteOptions {
  /** fsync the file (and its directory) before returning. Default true. */
  fsync?: boolean;
  /** Directory mode for newly created parents; defaults to 0o755. */
  mode?: number;
}

/**
 * Write `data` to `path` atomically: a uniquely named temp file in the same
 * directory is fully written, optionally fsynced, then renamed over the target.
 * Readers never observe a partially written file, and a crash before the
 * rename leaves the previous content intact.
 */
export function atomicWriteFileSync(
  path: string,
  data: string,
  options: AtomicWriteOptions = {},
): void {
  const fsync = options.fsync ?? true;
  const dir = dirname(path);
  mkdirSync(
    dir,
    options.mode === undefined ? { recursive: true } : { recursive: true, mode: options.mode },
  );
  const temp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}-${tempCounter++}`;
  try {
    const fd = openSync(temp, "w");
    try {
      writeSync(fd, data);
      if (fsync) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    if (fsync) fsyncDirectory(dir);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The temp file is best-effort cleanup; the original error is what matters.
    }
    throw error;
  }
}

let tempCounter = 0;

/**
 * Promise-based counterpart of `atomicWriteFileSync`: the write runs on the
 * threadpool and never blocks the event loop. Same temp-file + rename
 * protocol, so readers still never observe a partial file.
 */
export async function atomicWriteFile(
  path: string,
  data: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const fsync = options.fsync ?? true;
  const dir = dirname(path);
  await mkdir(
    dir,
    options.mode === undefined ? { recursive: true } : { recursive: true, mode: options.mode },
  );
  const temp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}-${tempCounter++}`;
  let handle: FileHandle | null = null;
  try {
    handle = await open(temp, "w");
    await handle.writeFile(data);
    if (fsync) await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, path);
    if (fsync) await fsyncDirectoryAsync(dir);
  } catch (error) {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // The original error is what matters.
      }
    }
    try {
      await rm(temp, { force: true });
    } catch {
      // The temp file is best-effort cleanup; the original error is what matters.
    }
    throw error;
  }
}

/** fsync a directory so a rename is durable; tolerated on filesystems that reject it. */
function fsyncDirectory(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Some platforms/filesystems (notably macOS on some volumes) do not allow
    // opening a directory for fsync. The file-level fsync still bounds the
    // window; failing here would make persistence unusable on those volumes.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failures on a best-effort durability step.
      }
    }
  }
}

/** Async counterpart of `fsyncDirectory` with the same best-effort tolerance. */
async function fsyncDirectoryAsync(dir: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
    // See `fsyncDirectory`: unsupported on some volumes, and the file-level
    // fsync still bounds the durability window.
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // Ignore close failures on a best-effort durability step.
      }
    }
  }
}

/** Create a lock file exclusively; returns false when it already exists. */
export function createExclusiveFileSync(path: string, data: string): boolean {
  try {
    const fd = openSync(path, "wx");
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    throw error;
  }
}

/** Read a UTF-8 file, or null when it does not exist. */
export function readFileIfExistsSync(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

export function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/** True when a filesystem entry exists at `path`. */
export function pathExistsSync(path: string): boolean {
  return existsSync(path);
}
