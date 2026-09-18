/**
 * A static file server for the demo and the benchmark. No dependency, and no configuration.
 *
 * Run it directly to serve the repository: `node bench/serve.mjs 5173`.
 * Import `serve` to get a server on a free port, which is what the benchmark does.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.css': 'text/css',
};

/** Serve `root` on `port`. Port 0 picks a free one. Resolves to { server, base }. */
export async function serve(root = process.cwd(), port = 0) {
  const server = createServer(async (req, res) => {
    const rel = normalize(decodeURIComponent(req.url.split('?')[0]));
    // Redirect the root, do not serve it in place. Serving it here would leave the base URL at
    // "/", and every relative path in the demo would then resolve one directory too high.
    if (rel === '/' || rel === '\\') {
      res.writeHead(302, { location: '/demo/index.html' }).end();
      return;
    }
    const path = join(root, rel);
    // A request must not escape the root.
    if (!path.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const body = await readFile(path);
      res.writeHead(200, {
        'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
        'cache-control': 'no-store', // the demo imports a bundle that is rebuilt often
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { base } = await serve(process.cwd(), Number(process.argv[2] ?? 5173));
  console.log(`globedots demo on ${base}`);
}
