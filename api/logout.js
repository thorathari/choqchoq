const { clearSessionCookie, requireMethod, sendJson } = require("../server/db");

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, "POST")) return;
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
};
