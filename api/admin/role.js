const { readJson, requireAdmin, requireMethod, sendJson } = require("../../server/db");
const { updateUserRole } = require("../../server/game");

module.exports = async function handler(req, res) {
  try {
    if (!requireMethod(req, res, "POST")) return;
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const body = await readJson(req);
    const role = String(body.role || "");
    if (!["admin", "user"].includes(role)) throw new Error("알 수 없는 권한입니다.");
    if (body.userId === admin.id && role !== "admin") throw new Error("본인의 관리자 권한은 해제할 수 없습니다.");
    await updateUserRole(body.userId, role);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
};
