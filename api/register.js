const {
  getUserByUsername,
  hashPassword,
  normalizeNickname,
  normalizeUsername,
  readJson,
  requireMethod,
  sanitizeUser,
  sendJson,
  setSessionCookie,
  supabaseRequest,
  usernameKey
} = require("../server/db");

module.exports = async function handler(req, res) {
  try {
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
        last_login_at: new Date().toISOString()
      }
    });

    const user = created[0];
    setSessionCookie(res, user);
    sendJson(res, 200, { ok: true, user: sanitizeUser(user) });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
};
