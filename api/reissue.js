const { requireMethod, requireUser, sendJson } = require("../server/db");
const { reissueSameHost } = require("../server/game");

module.exports = async function handler(req, res) {
  try {
    if (!requireMethod(req, res, "POST")) return;
    const user = await requireUser(req, res);
    if (!user) return;
    await reissueSameHost(user, "출제자가 문제를 리문했습니다.");
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
};
