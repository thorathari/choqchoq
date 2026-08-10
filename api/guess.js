const { readJson, requireMethod, requireUser, sendJson } = require("../server/db");
const { submitGuess } = require("../server/game");

module.exports = async function handler(req, res) {
  try {
    if (!requireMethod(req, res, "POST")) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readJson(req);
    const correct = await submitGuess(user, String(body.answer || "").trim());
    sendJson(res, 200, { ok: true, correct });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
};
