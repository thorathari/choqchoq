const {
  getUserByUsername,
  readJson,
  requireMethod,
  sanitizeUser,
  sendJson,
  setSessionCookie,
  supabaseRequest,
  verifyPassword
} = require("../server/db");

module.exports = async function handler(req, res) {
  try {
    if (!requireMethod(req, res, "POST")) return;
    const { username, password } = await readJson(req);
    const user = await getUserByUsername(username);

    if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
      sendJson(res, 401, { error: "아이디 또는 비밀번호가 올바르지 않습니다." });
      return;
    }

    const updated = await supabaseRequest(`choq_users?id=eq.${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      body: {
        last_login_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    });
    const loggedInUser = updated[0] || user;
    setSessionCookie(res, loggedInUser);
    sendJson(res, 200, { ok: true, user: sanitizeUser(loggedInUser) });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
};
