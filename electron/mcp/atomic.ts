import { writeFileSync, renameSync, unlinkSync } from 'fs';
import { writeFile, rename, unlink } from 'fs/promises';
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
  try {
    writeFileSync(tmp, data, options);
    renameSync(tmp, filePath);
  } catch (err) {
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
  try {
    await writeFile(tmp, data, options);
    await rename(tmp, filePath);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}
