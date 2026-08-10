const { requireMethod, requireUser, sendJson } = require("../server/db");
const { transferHostWithPenalty } = require("../server/game");

module.exports = async function handler(req, res) {
  try {
    if (!requireMethod(req, res, "POST")) return;
    const user = await requireUser(req, res);
    if (!user) return;
    await transferHostWithPenalty(user);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
};
