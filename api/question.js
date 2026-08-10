const { readJson, requireMethod, requireUser, sendJson } = require("../server/db");
const { createQuestion } = require("../server/game");

module.exports = async function handler(req, res) {
  try {
    if (!requireMethod(req, res, "POST")) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readJson(req);
    await createQuestion(user, String(body.category || "").trim(), String(body.answer || "").trim());
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
};
