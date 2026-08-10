const crypto = require("crypto");

const COOKIE_NAME = "choqchoq_session";
const PASSWORD_ITERATIONS = 120000;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_DIGEST = "sha256";

function getEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경변수가 필요합니다.`);
  return value;
}

function getSupabaseConfig() {
  const url = getEnv("SUPABASE_URL").replace(/\/$/, "");
  const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secretKey) throw new Error("SUPABASE_SECRET_KEY 환경변수가 필요합니다.");
  return { url, secretKey };
}

async function supabaseRequest(path, options = {}) {
  const { url, secretKey } = getSupabaseConfig();
  const prefer = options.prefer === undefined ? "return=representation" : options.prefer;
  const headers = {
    apikey: secretKey,
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (prefer) headers.Prefer = prefer;

  const response = await fetch(`${url}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message = typeof data === "object" && data?.message ? data.message : "DB 요청에 실패했습니다.";
    throw new Error(message);
  }

  return data;
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function requireMethod(req, res, method) {
  if (req.method === method) return true;
  res.setHeader("Allow", method);
  sendJson(res, 405, { error: "허용되지 않은 요청입니다." });
  return false;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function parseCookies(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf("=");
      const key = index >= 0 ? part.slice(0, index) : part;
      const value = index >= 0 ? part.slice(index + 1) : "";
      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
}

function sign(value) {
  return crypto.createHmac("sha256", getEnv("SESSION_SECRET")).update(value).digest("base64url");
}

function createSessionToken(user) {
  const payload = Buffer.from(JSON.stringify({
    id: user.id,
    username: user.username,
    role: user.role,
    iat: Date.now()
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readSession(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || sign(payload) !== signature) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function setSessionCookie(res, user) {
  const token = createSessionToken(user);
  const secure = process.env.NODE_ENV === "development" ? "" : "; Secure";
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=604800`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "development" ? "" : "; Secure";
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`);
}

function normalizeUsername(username) {
  return String(username || "").trim();
}

function usernameKey(username) {
  return normalizeUsername(username).toLowerCase();
}

function normalizeNickname(nickname) {
  return String(nickname || "").trim().replace(/\s+/g, " ");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, PASSWORD_ITERATIONS, PASSWORD_KEY_LENGTH, PASSWORD_DIGEST).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const left = Buffer.from(hash, "hex");
  const right = Buffer.from(expectedHash, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    role: user.role,
    status: user.status,
    createdAt: user.created_at
  };
}

async function getUserByUsername(username) {
  const key = encodeURIComponent(usernameKey(username));
  const users = await supabaseRequest(`choq_users?username_key=eq.${key}&select=*&limit=1`, { prefer: "" });
  return users?.[0] || null;
}

async function getUserById(id) {
  if (!id) return null;
  const users = await supabaseRequest(`choq_users?id=eq.${encodeURIComponent(id)}&select=*&limit=1`, { prefer: "" });
  return users?.[0] || null;
}

async function requireUser(req, res) {
  const session = readSession(req);
  if (!session?.id) {
    sendJson(res, 401, { error: "로그인이 필요합니다." });
    return null;
  }

  const user = await getUserById(session.id);
  if (!user) {
    clearSessionCookie(res);
    sendJson(res, 401, { error: "계정을 찾을 수 없습니다." });
    return null;
  }

  return user;
}

async function requireAdmin(req, res) {
  const user = await requireUser(req, res);
  if (!user) return null;
  if (user.role !== "admin") {
    sendJson(res, 403, { error: "관리자 권한이 필요합니다." });
    return null;
  }
  return user;
}

module.exports = {
  clearSessionCookie,
  getUserById,
  getUserByUsername,
  hashPassword,
  normalizeNickname,
  normalizeUsername,
  readJson,
  readSession,
  requireAdmin,
  requireMethod,
  requireUser,
  sanitizeUser,
  sendJson,
  setSessionCookie,
  supabaseRequest,
  usernameKey,
  verifyPassword
};
