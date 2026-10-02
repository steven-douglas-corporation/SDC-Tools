import "server-only";
import { readFile, stat } from "fs/promises";

// Reads a file Paylocity drops into the SFTP folder, refusing one that is still
// arriving: size and mtime must be unchanged across the read, the same guard
// paylocity-workbook.ts uses on the hours file. An upload in progress is
// refused, not half-imported, and the next pass picks it up.
//
// `noun` names the file in messages ("roster file"); `fail` builds the caller's
// own error type, so each step's failures read as its own.
// /* turbopackIgnore */: the path points outside the project; see hiring-workbook.ts.
export async function readStableFile(path: string, noun: string, fail: (message: string) => Error): Promise<Buffer> {
  let before;
  try {
    before = await stat(/* turbopackIgnore: true */ path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw fail(
      code === "ENOENT"
        ? `No ${noun} at ${path}. Check that the Paylocity upload landed and that this server can reach the folder.`
        : `Could not read the ${noun} at ${path}: ${(err as Error).message}`,
    );
  }
  if (!before.isFile()) throw fail(`${path} is not a file.`);
  if (before.size === 0) throw fail(`The ${noun} at ${path} is 0 bytes — the upload is incomplete.`);
  const buf = await readFile(/* turbopackIgnore: true */ path);
  const after = await stat(/* turbopackIgnore: true */ path);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw fail(`The ${noun} changed while it was being read — probably still uploading. Nothing was imported; the next refresh will pick it up.`);
  }
  return buf;
}
