const { readJson, requireMethod, requireUser, sendJson } = require("../server/db");
const { STATUSES, syncAfterStatusChange, updateUserStatus } = require("../server/game");

module.exports = async function handler(req, res) {
  try {
    if (!requireMethod(req, res, "POST")) return;
    const current = await requireUser(req, res);
    if (!current) return;

    const body = await readJson(req);
    const targetId = body.userId || current.id;
    const status = String(body.status || "");

    if (!STATUSES.has(status)) throw new Error("알 수 없는 상태입니다.");
    if (targetId !== current.id && current.role !== "admin") throw new Error("다른 사용자의 상태는 관리자만 변경할 수 있습니다.");

    await updateUserStatus(targetId, status);
    await syncAfterStatusChange(targetId, status);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
};
