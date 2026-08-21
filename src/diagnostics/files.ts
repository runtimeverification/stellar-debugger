/**
 * Reading the files a launch configuration points at, with a user-facing
 * explanation when one is not readable.
 *
 * A raw `ENOENT: no such file or directory, open '…'` tells the user what the
 * runtime saw, not what they got wrong; these wrappers say which configuration
 * attribute the path came from and, where there is one, how to produce the file.
 *
 * Pure module apart from the read itself (no `vscode` imports).
 */

import { promises as fs } from 'fs';
import { unreadableFile } from './setup';

/** Read a file as bytes, explaining a failure in terms of the config. */
export async function readFileOrExplain(path: string, what: string, hint?: string): Promise<Buffer> {
  try {
    return await fs.readFile(path);
  } catch (e) {
    throw unreadableFile({ what, path, error: e as NodeJS.ErrnoException, hint });
  }
}

/** Read a file as UTF-8 text, explaining a failure in terms of the config. */
export async function readTextOrExplain(path: string, what: string, hint?: string): Promise<string> {
  return (await readFileOrExplain(path, what, hint)).toString('utf8');
}
