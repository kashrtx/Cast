// The development server.
//
// It serves the files, and it is also the proxy. That second part is the reason you can test NVIDIA
// NIM, OpenRouter and anything else that refuses browser requests on your own machine, without
// deploying to Netlify to find out whether it works.
//
// Opening index.html straight from disk still works for everything else, but it cannot work for those
// providers: a file:// page has no server behind it to forward through, so there is nowhere for the
// request to go. Run this instead and they work.
//
// The rules about what may be forwarded where live in proxy-rules.js, shared with the Netlify
// function, so the two behave the same.

const http = require('http');
const fs = require('fs');
const path = require('path');
const proxy = require('./proxy-rules');

const PROXY_PATH = '/api/proxy';

// Hosts you have added yourself, for self hosting or for a model on your own network. Comma separated.
// A host added this way may be plain http, because that is usually the point of adding one.
const extraHosts = proxy.parseExtraHosts(process.env.CAST_PROXY_EXTRA_HOSTS);

// How long to wait on a provider before giving up, in milliseconds.
const proxyTimeoutMs = Number(process.env.CAST_PROXY_TIMEOUT_MS) || proxy.DEFAULT_TIMEOUT_MS;

const rootDir = __dirname;
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// Reads the whole request body. These are small JSON payloads, so nothing is gained by streaming
// them out as they arrive.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleProxy(req, res) {
  const plan = proxy.planRequest({
    method: req.method, headers: req.headers, url: req.url, extraHosts,
  });

  if (plan.action === 'preflight') {
    res.writeHead(plan.status, plan.headers);
    res.end();
    return;
  }

  if (plan.action === 'refuse') {
    res.writeHead(plan.status, plan.headers);
    res.end(plan.body);
    return;
  }

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const read = await readBody(req);
    if (read.length) body = read;
  }

  const outcome = await proxy.forwardThrough(plan, {
    method: req.method,
    body,
    timeoutMs: proxyTimeoutMs,
  });

  if (!outcome.ok) {
    res.writeHead(outcome.refusal.status, outcome.refusal.headers);
    res.end(outcome.refusal.body);
    return;
  }

  const upstream = outcome.response;

  const responseHeaders = { ...plan.responseHeaders };
  proxy.FORWARD_RESPONSE_HEADERS.forEach((name) => {
    const value = upstream.headers.get(name);
    if (value) responseHeaders[name] = value;
  });

  res.writeHead(upstream.status, responseHeaders);

  // Passed through as it arrives, so a streamed reply stays streamed and text appears in the app as
  // the model writes it rather than all at once at the end.
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
  const pathname = decodeURIComponent(requestUrl.pathname);

  if (pathname === PROXY_PATH) {
    handleProxy(req, res).catch((error) => {
      send(res, 500, `The proxy failed unexpectedly: ${error.message}`);
    });
    return;
  }
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(rootDir, `.${requestedPath}`);

  if (!filePath.startsWith(rootDir)) {
    send(res, 403, 'Forbidden');
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      send(res, 404, 'Not found');
      return;
    }

    const contentType = mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(port, host, () => {
  console.log(`Cast is running at http://${host}:${port}/`);
  console.log(`The proxy is at http://${host}:${port}${PROXY_PATH}, which the app finds on its own.`);
  console.log('Providers that refuse browser requests, such as NVIDIA NIM, work through it.');
});