/// <reference types="node" />
// Dev-only route backing the "Dev — Downloads" dropdown. Given a vectorstock id it
// locates assets/downloads/vectorstock_<id>.zip, extracts the first .svg entry, and
// returns it. { svg: null } means the archive held no SVG — the client shows "No SVG".
//
// Unzipping is done in JS with fflate (no system `unzip` dependency), so this works
// anywhere Node can run. The reference directive above pulls in Node's fs/path types,
// which the react-native tsconfig condition otherwise shadows for these server files.
import { readFile } from 'fs/promises';
import path from 'path';
import { unzipSync, strFromU8 } from 'fflate';

// Only digits — the id is interpolated into a filesystem path, so anything else is
// rejected before it gets near disk.
const ID_RE = /^\d+$/;

export async function GET(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!ID_RE.test(id)) {
    return Response.json({ error: { message: 'Invalid or missing id' } }, { status: 400 });
  }

  const zipPath = path.join(process.cwd(), 'assets', 'downloads', `vectorstock_${id}.zip`);

  try {
    const buf = await readFile(zipPath);
    // fflate wants a plain Uint8Array; a Node Buffer is one, but slice to be explicit.
    const entries = unzipSync(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));

    const svgName = Object.keys(entries).find((n) => n.toLowerCase().endsWith('.svg'));
    if (!svgName) {
      return Response.json({ svg: null });
    }

    const svg = strFromU8(entries[svgName]);
    return Response.json({ svg });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to read archive';
    // A missing zip surfaces here as an ENOENT from readFile.
    return Response.json({ error: { message } }, { status: 500 });
  }
}
