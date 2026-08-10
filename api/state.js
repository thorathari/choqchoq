const { getUserById, readSession, sendJson } = require("../server/db");
const { publicState } = require("../server/game");

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      sendJson(res, 405, { error: "허용되지 않은 요청입니다." });
      return;
    }

    const session = readSession(req);
    const user = session?.id ? await getUserById(session.id) : null;
    sendJson(res, 200, await publicState(user));
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
};
