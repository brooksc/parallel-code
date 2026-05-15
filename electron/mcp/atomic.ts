import { openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'fs';
import { open, rename, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';

/** Write `data` to `filePath` atomically: write to a temp file then rename.
 *  A crash between write and rename leaves a stale .tmp file but never a torn target. */
export function atomicWriteFileSync(
  filePath: string,
  data: string,
  options?: { mode?: number },
): void {
  const tmp = join(dirname(filePath), `.parallel-code-atomic-${randomUUID()}.tmp`);
  let fd = -1;
  try {
    fd = openSync(tmp, 'w', options?.mode);
    writeSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;
    renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/** Async version: write `data` to `filePath` atomically via temp file + rename. */
export async function atomicWriteFile(
  filePath: string,
  data: string,
  options?: { mode?: number },
): Promise<void> {
  const tmp = join(dirname(filePath), `.parallel-code-atomic-${randomUUID()}.tmp`);
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(tmp, 'w', options?.mode);
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    fh = undefined;
    await rename(tmp, filePath);
  } catch (err) {
    if (fh) {
      try {
        await fh.close();
      } catch {
        /* ignore */
      }
    }
    try {
      await unlink(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}
