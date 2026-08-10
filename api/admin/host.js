const { readJson, requireAdmin, requireMethod, sendJson } = require("../../server/db");
const { adminSetHost } = require("../../server/game");

module.exports = async function handler(req, res) {
  try {
    if (!requireMethod(req, res, "POST")) return;
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const body = await readJson(req);
    await adminSetHost(body.userId);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
};
