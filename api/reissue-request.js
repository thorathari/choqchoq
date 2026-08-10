const { requireMethod, requireUser, sendJson } = require("../server/db");
const { requestReissue } = require("../server/game");

module.exports = async function handler(req, res) {
  try {
    if (!requireMethod(req, res, "POST")) return;
    const user = await requireUser(req, res);
    if (!user) return;
    await requestReissue(user);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
};
