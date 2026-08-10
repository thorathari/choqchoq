const { readJson, requireMethod, requireUser, sendJson } = require("../server/db");
const { addHint } = require("../server/game");

module.exports = async function handler(req, res) {
  try {
    if (!requireMethod(req, res, "POST")) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readJson(req);
    await addHint(user, String(body.text || "").trim());
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
};
