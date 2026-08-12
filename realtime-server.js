const http = require("http");
const fs = require("fs");
const path = require("path");

const apiHandler = require("./api/index");
const { getUserById, readSession } = require("./server/db");
const { publicState } = require("./server/game");

const PORT = Number(process.env.PORT || 5174);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const PUBLIC_ROOT = path.resolve(PUBLIC_DIR);
const CLIENT_TICK_MS = 1000;
const KEEPALIVE_MS = 25000;

const clients = new Map();
let broadcastQueued = false;

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function allowedOrigin(origin) {
  const configured = String(process.env.CORS_ORIGIN || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return !!origin && (configured.includes("*") || configured.includes(origin));
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (!allowedOrigin(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Vary", "Origin");
}

function sendNotFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  let filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);

  if (filePath !== PUBLIC_ROOT && !filePath.startsWith(`${PUBLIC_ROOT}${path.sep}`)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, "index.html");
  }

  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml"
  };

  res.writeHead(200, {
    "Content-Type": types[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=60"
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

async function writeClientState(client) {
  const user = await getUserById(client.userId);
  client.res.write(`event: state\ndata: ${JSON.stringify(await publicState(user))}\n\n`);
}

async function broadcastState() {
  const entries = Array.from(clients.entries());
  for (const [id, client] of entries) {
    try {
      await writeClientState(client);
    } catch (error) {
      clients.delete(id);
      try {
        client.res.end();
      } catch {
        // The socket may already be gone.
      }
    }
  }
}

function queueBroadcast() {
  if (broadcastQueued) return;
  broadcastQueued = true;
  setTimeout(async () => {
    broadcastQueued = false;
    if (clients.size) await broadcastState();
  }, 0);
}

async function handleEvents(req, res) {
  const session = readSession(req);
  const user = session?.id ? await getUserById(session.id) : null;
  if (!user) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "로그인이 필요합니다." }));
    return;
  }

  const id = randomId("client");
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  clients.set(id, { res, userId: user.id });
  await writeClientState({ res, userId: user.id });
  req.on("close", () => clients.delete(id));
}

async function handleRequest(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/events") {
    await handleEvents(req, res);
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    const shouldBroadcast = req.method === "POST" && url.pathname !== "/api/presence";
    await apiHandler(req, res);
    if (shouldBroadcast) queueBroadcast();
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendNotFound(res);
    return;
  }

  serveStatic(req, res);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({ error: error.message || "요청을 처리하지 못했습니다." }));
  });
});

setInterval(() => {
  for (const [id, client] of clients) {
    try {
      client.res.write(": ping\n\n");
    } catch {
      clients.delete(id);
    }
  }
}, KEEPALIVE_MS);

setInterval(() => {
  if (clients.size) queueBroadcast();
}, CLIENT_TICK_MS);

server.listen(PORT, () => {
  console.log(`Choqchoq realtime server running at http://localhost:${PORT}`);
});
