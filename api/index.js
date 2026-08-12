const {
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
} = require("../server/db");
const {
  STATUSES,
  addChatMessage,
  addHint,
  adminSetHost,
  clearChatMessages,
  createQuestion,
  deleteChatMessage,
  publicState,
  requestReissue,
  reissueSameHost,
  submitChatMessage,
  submitGuess,
  syncAfterStatusChange,
  touchUserPresence,
  transferHostWithPenalty,
  updateUserRole,
  updateUserStatus
} = require("../server/game");

function routePath(req) {
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const queryPath = req.query?.path || url.searchParams.get("path");
  if (Array.isArray(queryPath)) return queryPath.join("/");
  if (queryPath) return String(queryPath).replace(/^\/+/, "");
  return url.pathname.replace(/^\/api\/?/, "").replace(/^index\.js\/?/, "");
}

async function register(req, res) {
  if (!requireMethod(req, res, "POST")) return;

  const body = await readJson(req);
  const username = normalizeUsername(body.username);
  const nickname = normalizeNickname(body.nickname);
  const password = String(body.password || "");
  const passwordConfirm = String(body.passwordConfirm || "");

  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    sendJson(res, 400, { error: "아이디는 영문, 숫자, 밑줄 3~20자로 입력해주세요." });
    return;
  }
  if (nickname.length < 2 || nickname.length > 16) {
    sendJson(res, 400, { error: "닉네임은 2~16자로 입력해주세요." });
    return;
  }
  if (password.length < 4) {
    sendJson(res, 400, { error: "비밀번호는 4자 이상 입력해주세요." });
    return;
  }
  if (password !== passwordConfirm) {
    sendJson(res, 400, { error: "비밀번호 확인이 일치하지 않습니다." });
    return;
  }
  if (await getUserByUsername(username)) {
    sendJson(res, 409, { error: "이미 사용 중인 아이디입니다." });
    return;
  }

  const nicknameRows = await supabaseRequest(`choq_users?nickname=eq.${encodeURIComponent(nickname)}&select=id&limit=1`, { prefer: "" });
  if (nicknameRows.length) {
    sendJson(res, 409, { error: "이미 사용 중인 닉네임입니다." });
    return;
  }

  const users = await supabaseRequest("choq_users?select=id", { prefer: "" });
  const { salt, hash } = hashPassword(password);
  const now = new Date().toISOString();
  const created = await supabaseRequest("choq_users", {
    method: "POST",
    body: {
      username,
      username_key: usernameKey(username),
      nickname,
      password_hash: hash,
      password_salt: salt,
      role: users.length === 0 ? "admin" : "user",
      status: "watching",
      last_login_at: now,
      updated_at: now
    }
  });

  const user = created[0];
  setSessionCookie(res, user);
  sendJson(res, 200, { ok: true, user: sanitizeUser(user) });
}

async function login(req, res) {
  if (!requireMethod(req, res, "POST")) return;
  const { username, password } = await readJson(req);
  const user = await getUserByUsername(username);
  const now = new Date().toISOString();

  if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
    sendJson(res, 401, { error: "아이디 또는 비밀번호가 올바르지 않습니다." });
    return;
  }

  const updated = await supabaseRequest(`choq_users?id=eq.${encodeURIComponent(user.id)}`, {
    method: "PATCH",
    body: {
      status: "watching",
      last_login_at: now,
      updated_at: now
    }
  });
  const loggedInUser = updated[0] || user;
  await syncAfterStatusChange(loggedInUser.id, "watching");
  setSessionCookie(res, loggedInUser);
  sendJson(res, 200, { ok: true, user: sanitizeUser(loggedInUser) });
}

async function sendState(res, userId, extra = {}) {
  const user = await getUserById(userId);
  sendJson(res, 200, { ok: true, ...extra, state: await publicState(user) });
}

module.exports = async function handler(req, res) {
  try {
    const path = routePath(req);

    if (req.method === "GET" && path === "state") {
      const session = readSession(req);
      const user = session?.id ? await getUserById(session.id) : null;
      sendJson(res, 200, await publicState(user));
      return;
    }

    if (path === "register") {
      await register(req, res);
      return;
    }

    if (path === "login") {
      await login(req, res);
      return;
    }

    if (path === "logout") {
      if (!requireMethod(req, res, "POST")) return;
      const session = readSession(req);
      if (session?.id) {
        await updateUserStatus(session.id, "away");
        await syncAfterStatusChange(session.id, "away");
      }
      clearSessionCookie(res);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === "presence") {
      if (!requireMethod(req, res, "POST")) return;
      const user = await requireUser(req, res);
      if (!user) return;
      await touchUserPresence(user.id);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === "status") {
      if (!requireMethod(req, res, "POST")) return;
      const current = await requireUser(req, res);
      if (!current) return;
      const body = await readJson(req);
      const targetId = body.userId || current.id;
      const status = String(body.status || "");
      if (!STATUSES.has(status)) throw new Error("알 수 없는 상태입니다.");
      if (status === "away") throw new Error("부재중은 로그아웃 상태에서만 적용됩니다.");
      if (targetId !== current.id && current.role !== "admin") throw new Error("다른 사용자의 상태는 관리자만 변경할 수 있습니다.");
      await updateUserStatus(targetId, status);
      await syncAfterStatusChange(targetId, status);
      await sendState(res, current.id);
      return;
    }

    if (path === "question") {
      if (!requireMethod(req, res, "POST")) return;
      const user = await requireUser(req, res);
      if (!user) return;
      const body = await readJson(req);
      await createQuestion(user, String(body.category || "").trim(), String(body.answer || "").trim());
      await sendState(res, user.id);
      return;
    }

    if (path === "hint") {
      if (!requireMethod(req, res, "POST")) return;
      const user = await requireUser(req, res);
      if (!user) return;
      const body = await readJson(req);
      await addHint(user, String(body.text || "").trim());
      await sendState(res, user.id);
      return;
    }

    if (path === "chat") {
      if (!requireMethod(req, res, "POST")) return;
      const user = await requireUser(req, res);
      if (!user) return;
      const body = await readJson(req);
      const result = await submitChatMessage(user, body.text);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (path === "guess") {
      if (!requireMethod(req, res, "POST")) return;
      const user = await requireUser(req, res);
      if (!user) return;
      const body = await readJson(req);
      const correct = await submitGuess(user, String(body.answer || "").trim());
      await sendState(res, user.id, { correct });
      return;
    }

    if (path === "transfer") {
      if (!requireMethod(req, res, "POST")) return;
      const user = await requireUser(req, res);
      if (!user) return;
      await transferHostWithPenalty(user);
      await sendState(res, user.id);
      return;
    }

    if (path === "reissue") {
      if (!requireMethod(req, res, "POST")) return;
      const user = await requireUser(req, res);
      if (!user) return;
      await reissueSameHost(user, "출제자가 문제를 리문했습니다.");
      await sendState(res, user.id);
      return;
    }

    if (path === "reissue-request") {
      if (!requireMethod(req, res, "POST")) return;
      const user = await requireUser(req, res);
      if (!user) return;
      await requestReissue(user);
      await sendState(res, user.id);
      return;
    }

    if (path === "admin/host") {
      if (!requireMethod(req, res, "POST")) return;
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const body = await readJson(req);
      await adminSetHost(body.userId);
      await sendState(res, admin.id);
      return;
    }

    if (path === "admin/role") {
      if (!requireMethod(req, res, "POST")) return;
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const body = await readJson(req);
      const role = String(body.role || "");
      if (!["admin", "user"].includes(role)) throw new Error("알 수 없는 권한입니다.");
      if (body.userId === admin.id && role !== "admin") throw new Error("본인의 관리자 권한은 해제할 수 없습니다.");
      await updateUserRole(body.userId, role);
      await sendState(res, admin.id);
      return;
    }

    if (path === "admin/chat/delete") {
      if (!requireMethod(req, res, "POST")) return;
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const body = await readJson(req);
      await deleteChatMessage(body.messageId);
      await sendState(res, admin.id);
      return;
    }

    if (path === "admin/chat/clear") {
      if (!requireMethod(req, res, "POST")) return;
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      await clearChatMessages();
      await sendState(res, admin.id);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "요청을 처리하지 못했습니다." });
  }
};
