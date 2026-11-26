import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isObject } from './catalog.mjs';
import { taodockClient } from './taodock.mjs';
import { AppError } from './errors.mjs';
import { prepareCopy, reviewBatch } from './review.mjs';

const resources = new Map([
  ['/', ['../public/index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['../public/app.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['../public/styles.css', 'text/css; charset=utf-8']],
  ['/api/demo', ['../examples/demo.json', 'application/json; charset=utf-8']],
]);
const maxBody = 2 * 1024 * 1024;
const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function json(response, status, body) {
  response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function body(request) {
  if (!/^application\/json(?:\s*;|$)/iu.test(request.headers['content-type'] ?? '')) {
    throw new AppError(415, 'Send an application/json request.');
  }
  if (Number(request.headers['content-length']) > maxBody) throw new AppError(413, 'The request is too large.');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBody) {
      request.resume();
      throw new AppError(413, 'The request is too large.');
    }
    chunks.push(chunk);
  }
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (isObject(input)) return input;
  } catch {
    // Invalid JSON uses the same public message as an invalid request shape.
  }
  throw new AppError(400, 'Send a valid JSON object.');
}

export function app({ env = process.env, fetchImpl = fetch } = {}) {
  const taodock = taodockClient(env, fetchImpl);
  const routes = new Map([
    ['/api/review', reviewBatch],
    ['/api/copy', (input) => prepareCopy(input, taodock)],
  ]);
  const server = createServer(async (request, response) => {
    try {
      const port = server.address()?.port;
      const host = request.headers.host;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        throw new AppError(403, 'Open this tool from its local address.');
      }
      const path = request.url;
      if (request.method === 'GET') {
        if (path === '/api/config') return json(response, 200, { taodock: taodock.available });
        if (path === '/api/models' && request.headers['sec-fetch-site'] !== 'cross-site') {
          return json(response, 200, { models: await taodock.models() });
        }
        const resource = resources.get(path);
        if (resource) {
          const [file, type] = resource;
          const content = await readFile(new URL(file, import.meta.url));
          response.writeHead(200, { ...headers, 'Content-Type': type });
          return response.end(content);
        }
      }
      if (request.method === 'POST' && routes.has(path)) {
        const origin = request.headers.origin;
        if (origin && origin !== `http://${host}`) throw new AppError(403, 'The request must come from this tool.');
        const data = await routes.get(path)(await body(request));
        return json(response, 200, data);
      }
      throw new AppError(404, 'This page or action was not found.');
    } catch (error) {
      const publicError = error instanceof AppError;
      json(response, publicError ? error.status : 500, { error: publicError ? error.message : 'The local tool could not complete the request.' });
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8791);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  app().listen(port, '127.0.0.1', () => {
    console.log(`Taodock Shopee Draft Checker is ready at http://127.0.0.1:${port}`);
  });
}
