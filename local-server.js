const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 5173);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, "data", "store.json");

const STATUSES = new Set(["playing", "watching", "away"]);
const SCORE_TYPES = {
  ANSWER_CORRECT: "ANSWER_CORRECT",
  QUESTION_SOLVED: "QUESTION_SOLVED",
  HOST_TRANSFER: "HOST_TRANSFER",
  HOST_TIMEOUT: "HOST_TRANSFER",
  ADMIN_ADJUST: "ADMIN_ADJUST"
};

const HOST_QUESTION_TIMEOUT_MS = 3 * 60 * 1000;

let store = loadStore();
let sessions = new Map();
let clients = new Map();
let timers = {
  startCountdown: null,
  roundDeadline: null,
  hostQuestionDeadline: null
};

function defaultStore() {
  return {
    users: [],
    scoreEvents: [],
    chatMessages: [],
    game: {
      phase: "waiting",
      hostId: null,
      roundId: 0,
      category: "",
      answer: "",
      chosung: "",
      hints: [],
      guesses: [],
      reissueRequests: [],
      countdownEndsAt: null,
      activeStartedAt: null,
      firstGuessDeadlineAt: null,
      lastGuessDeadlineAt: null,
      correctStreakUserId: null,
      correctStreakCount: 0,
      answerBanUserId: null,
      answerBanRoundId: null,
      lastSystemMessage: ""
    }
  };
}

function loadStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return defaultStore();
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return { ...defaultStore(), ...parsed, game: { ...defaultStore().game, ...(parsed.game || {}) } };
  } catch (error) {
    console.error("Failed to load store:", error);
    return defaultStore();
  }
}

function saveStore() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.passwordHash, "hex"));
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header.split(";").filter(Boolean).map((part) => {
      const index = part.indexOf("=");
      return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
    })
  );
}

function getSessionUser(req) {
  const sid = parseCookies(req).sid;
  const userId = sid ? sessions.get(sid) : null;
  return userId ? store.users.find((user) => user.id === userId) || null : null;
}

function sendJson(res, status, payload, cookies = []) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };
  if (cookies.length) headers["Set-Cookie"] = cookies;
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function normalizeAnswer(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function hasOnlyHangulAndSpaces(value) {
  return /^[가-힣\s]+$/.test(String(value || ""));
}

function toChosung(value) {
  const initials = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
  return String(value || "")
    .split("")
    .map((char) => {
      if (char === " ") return " ";
      const code = char.charCodeAt(0);
      if (code < 0xac00 || code > 0xd7a3) return char;
      return initials[Math.floor((code - 0xac00) / 588)];
    })
    .join("");
}

function playingUsers() {
  return store.users.filter((user) => user.status === "playing");
}

function getPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt
  };
}

function addScore(userId, type, points, meta = {}) {
  let nextPoints = points;
  if (points < 0) {
    const currentScore = Math.max(0, rawScoreFor(userId));
    nextPoints = Math.max(points, -currentScore);
  }
  if (nextPoints === 0) return;

  store.scoreEvents.push({
    id: randomId("score"),
    userId,
    type,
    points: nextPoints,
    roundId: store.game.roundId,
    meta,
    createdAt: new Date().toISOString()
  });
}

function rawScoreFor(userId, from = null, to = null) {
  return store.scoreEvents
    .filter((event) => event.userId === userId)
    .filter((event) => (!from || new Date(event.createdAt) >= from) && (!to || new Date(event.createdAt) < to))
    .reduce((sum, event) => sum + event.points, 0);
}

function scoreFor(userId, from = null, to = null) {
  return Math.max(0, rawScoreFor(userId, from, to));
}

function dateRange(kind) {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  if (kind === "week") {
    const day = start.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    start.setDate(start.getDate() + mondayOffset);
  }

  if (kind === "month") {
    start.setDate(1);
  }

  const end = new Date(start);
  if (kind === "day") end.setDate(end.getDate() + 1);
  if (kind === "week") end.setDate(end.getDate() + 7);
  if (kind === "month") end.setMonth(end.getMonth() + 1);
  return { start, end };
}

function rankings(kind) {
  const { start, end } = dateRange(kind);
  return store.users
    .map((user) => ({ userId: user.id, nickname: user.nickname, score: scoreFor(user.id, start, end) }))
    .filter((row) => row.score !== 0)
    .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname, "ko-KR"))
    .slice(0, 20);
}

function scores() {
  return store.users
    .map((user) => ({
      userId: user.id,
      nickname: user.nickname,
      score: scoreFor(user.id)
    }))
    .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname, "ko-KR"));
}

function chooseRandom(candidates) {
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function clearTimer(name) {
  if (timers[name]) clearTimeout(timers[name]);
  timers[name] = null;
}

function setSystemMessage(message) {
  store.game.lastSystemMessage = message;
}

function resetRoundFields() {
  store.game.category = "";
  store.game.answer = "";
  store.game.chosung = "";
  store.game.hints = [];
  store.game.guesses = [];
  store.game.reissueRequests = [];
  store.game.countdownEndsAt = null;
  store.game.activeStartedAt = null;
  store.game.firstGuessDeadlineAt = null;
  store.game.lastGuessDeadlineAt = null;
  store.game.answerBanRoundId = null;
}

function setHost(userId, message) {
  clearTimer("startCountdown");
  clearTimer("roundDeadline");
  clearTimer("hostQuestionDeadline");
  store.game.phase = "hosting";
  store.game.hostId = userId;
  store.game.roundId += 1;
  resetRoundFields();
  store.game.firstGuessDeadlineAt = Date.now() + HOST_QUESTION_TIMEOUT_MS;
  setSystemMessage(message || "새 출제자가 정해졌습니다.");
  saveStore();
  scheduleTimers();
  broadcastState();
}

function returnToWaiting(message) {
  clearTimer("startCountdown");
  clearTimer("roundDeadline");
  clearTimer("hostQuestionDeadline");
  store.game.phase = "waiting";
  store.game.hostId = null;
  resetRoundFields();
  setSystemMessage(message || "참여자가 부족해 대기 중입니다.");
  saveStore();
  broadcastState();
}

function maybeStartGame() {
  const players = playingUsers();
  if (store.game.phase !== "waiting" && players.length < 2) {
    returnToWaiting("참여자가 2명 미만으로 줄어 대기 상태로 돌아갑니다.");
    return;
  }

  if (store.game.phase === "waiting" && players.length >= 2) {
    store.game.phase = "countdown";
    store.game.countdownEndsAt = Date.now() + 3000;
    setSystemMessage("참여자가 2명 이상입니다. 3초 뒤 게임이 시작됩니다.");
    scheduleTimers();
    saveStore();
    broadcastState();
    return;
  }

  if (store.game.phase === "countdown" && players.length < 2) {
    returnToWaiting("참여자가 2명 미만으로 줄어 시작이 취소되었습니다.");
  }
}

function syncAfterStatusChangeLocal(target, status) {
  if (store.game.phase !== "waiting" && playingUsers().length < 2) {
    returnToWaiting("참여자가 2명 미만으로 줄어 대기 상태로 돌아갑니다.");
  } else if (target.id === store.game.hostId && status !== "playing") {
    const nextHost = chooseRandom(nextHostCandidates(target.id));
    if (nextHost) setHost(nextHost.id, "출제자가 참여 상태를 벗어나 출제권이 이동했습니다.");
    else returnToWaiting("출제자가 참여 상태를 벗어나 게임이 대기 상태가 되었습니다.");
  } else {
    maybeStartGame();
    saveStore();
    broadcastState();
  }
}

function handleCountdownComplete() {
  const players = playingUsers();
  if (players.length < 2) {
    returnToWaiting("참여자가 부족해 시작이 취소되었습니다.");
    return;
  }
  const host = chooseRandom(players);
  setHost(host.id, `${host.nickname}님이 첫 출제자입니다.`);
}

function scheduleTimers() {
  clearTimer("startCountdown");
  clearTimer("roundDeadline");
  clearTimer("hostQuestionDeadline");

  if (store.game.phase === "countdown" && store.game.countdownEndsAt) {
    const delay = Math.max(0, store.game.countdownEndsAt - Date.now());
    timers.startCountdown = setTimeout(handleCountdownComplete, delay);
  }

  if (store.game.phase === "active") {
    const deadline = store.game.lastGuessDeadlineAt || store.game.firstGuessDeadlineAt;
    if (deadline) {
      const delay = Math.max(0, deadline - Date.now());
      timers.roundDeadline = setTimeout(handleRoundDeadline, delay);
    }
  }

  if (store.game.phase === "hosting" && store.game.firstGuessDeadlineAt) {
    const delay = Math.max(0, store.game.firstGuessDeadlineAt - Date.now());
    timers.hostQuestionDeadline = setTimeout(handleHostQuestionDeadline, delay);
  }
}

function nextHostCandidates(excludeUserId = null) {
  return playingUsers().filter((user) => user.id !== excludeUserId);
}

function handleRoundDeadline() {
  if (store.game.phase !== "active") return;
  const hostId = store.game.hostId;
  const candidates = nextHostCandidates(hostId);
  if (candidates.length < 1) {
    returnToWaiting("출제권을 넘길 참여자가 없어 대기 상태로 돌아갑니다.");
    return;
  }
  const nextHost = chooseRandom(candidates);
  setHost(nextHost.id, "제한시간 동안 정답이 없어 출제권이 랜덤으로 넘어갔습니다.");
}

function handleHostQuestionDeadline() {
  if (store.game.phase !== "hosting" || !store.game.hostId) return;
  const hostId = store.game.hostId;
  const candidates = nextHostCandidates(hostId);
  addScore(hostId, SCORE_TYPES.HOST_TIMEOUT, -2, { reason: "host_question_timeout" });
  if (candidates.length < 1) {
    returnToWaiting("출제권을 넘길 참여자가 없어 대기 상태로 돌아갑니다.");
    return;
  }
  const nextHost = chooseRandom(candidates);
  setHost(nextHost.id, "출제자가 3분 동안 문제를 내지 않아 -2점 처리되고 출제권이 넘어갔습니다.");
}

function finishRoundWithWinner(winner) {
  const previousHostId = store.game.hostId;
  const previousRoundId = store.game.roundId;
  addScore(winner.id, SCORE_TYPES.ANSWER_CORRECT, 1, { reason: "correct_answer" });
  if (previousHostId) addScore(previousHostId, SCORE_TYPES.QUESTION_SOLVED, 1, { solvedBy: winner.id });

  if (store.game.answerBanRoundId === previousRoundId) {
    store.game.answerBanUserId = null;
    store.game.answerBanRoundId = null;
  }

  const playersCount = playingUsers().length;
  if (store.game.correctStreakUserId === winner.id) {
    store.game.correctStreakCount += 1;
  } else {
    store.game.correctStreakUserId = winner.id;
    store.game.correctStreakCount = 1;
  }

  if (playersCount >= 3 && store.game.correctStreakCount >= 4) {
    store.game.answerBanUserId = winner.id;
  }

  setHost(winner.id, `${winner.nickname}님이 정답을 맞혀 다음 출제자가 되었습니다.`);
}

function reissueSameHost(message) {
  clearTimer("roundDeadline");
  store.game.phase = "hosting";
  store.game.roundId += 1;
  resetRoundFields();
  setSystemMessage(message || "문제가 리문 처리되었습니다. 같은 출제자가 다시 냅니다.");
  saveStore();
  broadcastState();
}

function transferHostWithPenalty(host) {
  const candidates = nextHostCandidates(host.id);
  if (!candidates.length) throw new Error("출제권을 받을 참여자가 없습니다.");
  const nextHost = chooseRandom(candidates);
  addScore(host.id, SCORE_TYPES.HOST_TRANSFER, -3, { to: nextHost.id });
  setHost(nextHost.id, `${host.nickname}님이 출제권을 양도했습니다.`);
}

function publicState(currentUser = null) {
  const host = store.users.find((user) => user.id === store.game.hostId) || null;
  const players = playingUsers();
  const isHost = currentUser && currentUser.id === store.game.hostId;
  const isAdmin = currentUser && currentUser.role === "admin";
  const currentRoundBanApplies = currentUser && store.game.answerBanUserId === currentUser.id && store.game.answerBanRoundId === store.game.roundId;
  const game = {
    ...store.game,
    answer: isHost ? store.game.answer : "",
    host: host ? getPublicUser(host) : null,
    serverNow: Date.now(),
    playerCount: players.length,
    reissueRequestCount: store.game.reissueRequests.length,
    reissueEnabled: players.length > 3,
    canGuess:
      !!currentUser &&
      store.game.phase === "active" &&
      currentUser.status === "playing" &&
      currentUser.id !== store.game.hostId &&
      !currentRoundBanApplies,
    guessBlockedReason: currentRoundBanApplies ? "연속 정답 제한으로 이번 문제는 정답을 제출할 수 없습니다." : ""
  };

  if (!isHost && !isAdmin) {
    game.guesses = store.game.guesses.map((guess) => ({ ...guess, answer: guess.correct ? "정답" : guess.answer }));
  }

  return {
    me: currentUser ? getPublicUser(currentUser) : null,
    users: store.users.map(getPublicUser),
    game,
    scores: scores(),
    rankings: {
      day: rankings("day"),
      week: rankings("week"),
      month: rankings("month")
    },
    recentScoreEvents: store.scoreEvents.slice(-30).reverse(),
    chatMessages: store.chatMessages.slice(-80)
  };
}

function broadcastState() {
  for (const [id, client] of clients) {
    const user = store.users.find((item) => item.id === client.userId) || null;
    try {
      client.res.write(`event: state\ndata: ${JSON.stringify(publicState(user))}\n\n`);
    } catch (error) {
      clients.delete(id);
    }
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = path.join(PUBLIC_DIR, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(PUBLIC_DIR, "index.html");
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };
  res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

function requireUser(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { error: "로그인이 필요합니다." });
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (user.role !== "admin") {
    sendJson(res, 403, { error: "관리자 권한이 필요합니다." });
    return null;
  }
  return user;
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/state") {
      sendJson(res, 200, publicState(getSessionUser(req)));
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      const user = requireUser(req, res);
      if (!user) return;
      const id = randomId("client");
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      });
      clients.set(id, { res, userId: user.id });
      res.write(`event: state\ndata: ${JSON.stringify(publicState(user))}\n\n`);
      req.on("close", () => clients.delete(id));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/register") {
      const body = await readBody(req);
      const username = String(body.username || "").trim();
      const nickname = String(body.nickname || "").trim();
      const password = String(body.password || "");
      const passwordConfirm = String(body.passwordConfirm || "");

      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) throw new Error("아이디는 영문, 숫자, 밑줄 3~20자로 입력해주세요.");
      if (nickname.length < 2 || nickname.length > 16) throw new Error("닉네임은 2~16자로 입력해주세요.");
      if (password.length < 4) throw new Error("비밀번호는 4자 이상 입력해주세요.");
      if (password !== passwordConfirm) throw new Error("비밀번호 확인이 일치하지 않습니다.");
      if (store.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) throw new Error("이미 사용 중인 아이디입니다.");
      if (store.users.some((user) => user.nickname === nickname)) throw new Error("이미 사용 중인 닉네임입니다.");

      const { salt, hash } = hashPassword(password);
      const user = {
        id: randomId("user"),
        username,
        nickname,
        passwordHash: hash,
        salt,
        role: store.users.length === 0 ? "admin" : "user",
        status: "watching",
        createdAt: new Date().toISOString()
      };
      store.users.push(user);
      saveStore();
      const sid = randomId("sid");
      sessions.set(sid, user.id);
      sendJson(res, 200, { ok: true, user: getPublicUser(user) }, [`sid=${encodeURIComponent(sid)}; HttpOnly; Path=/; SameSite=Lax`]);
      broadcastState();
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await readBody(req);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const user = store.users.find((item) => item.username.toLowerCase() === username.toLowerCase());
      if (!user || !verifyPassword(password, user)) throw new Error("아이디 또는 비밀번호가 올바르지 않습니다.");
      user.status = "watching";
      syncAfterStatusChangeLocal(user, "watching");
      const sid = randomId("sid");
      sessions.set(sid, user.id);
      sendJson(res, 200, { ok: true, user: getPublicUser(user) }, [`sid=${encodeURIComponent(sid)}; HttpOnly; Path=/; SameSite=Lax`]);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      const sid = parseCookies(req).sid;
      const user = getSessionUser(req);
      if (sid) sessions.delete(sid);
      if (user) {
        user.status = "away";
        syncAfterStatusChangeLocal(user, "away");
      }
      sendJson(res, 200, { ok: true }, ["sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0"]);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/status") {
      const current = requireUser(req, res);
      if (!current) return;
      const body = await readBody(req);
      const targetId = body.userId || current.id;
      const status = String(body.status || "");
      if (!STATUSES.has(status)) throw new Error("알 수 없는 상태입니다.");
      if (status === "away") throw new Error("부재중은 로그아웃 상태에서만 적용됩니다.");
      if (targetId !== current.id && current.role !== "admin") throw new Error("다른 사용자의 상태는 관리자만 변경할 수 있습니다.");
      const target = store.users.find((user) => user.id === targetId);
      if (!target) throw new Error("사용자를 찾을 수 없습니다.");
      target.status = status;
      syncAfterStatusChangeLocal(target, status);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/question") {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const category = String(body.category || "").trim();
      const answer = String(body.answer || "").trim();
      if (store.game.phase !== "hosting" || store.game.hostId !== user.id) throw new Error("현재 출제자만 문제를 낼 수 있습니다.");
      if (!category || category.length > 20) throw new Error("분류는 1~20자로 입력해주세요.");
      if (!answer || answer.length > 30) throw new Error("정답은 1~30자로 입력해주세요.");
      if (!hasOnlyHangulAndSpaces(answer)) throw new Error("정답은 한글과 띄어쓰기만 입력할 수 있습니다.");

      store.game.phase = "active";
      store.game.category = category;
      store.game.answer = answer;
      store.game.chosung = toChosung(answer);
      store.game.hints = [];
      store.game.guesses = [];
      store.game.reissueRequests = [];
      store.game.activeStartedAt = Date.now();
      store.game.firstGuessDeadlineAt = Date.now() + 3 * 60 * 1000;
      store.game.lastGuessDeadlineAt = null;
      if (store.game.answerBanUserId && store.game.answerBanUserId !== user.id) {
        store.game.answerBanRoundId = store.game.roundId;
      } else {
        store.game.answerBanRoundId = null;
      }
      setSystemMessage(`${user.nickname}님이 문제를 냈습니다.`);
      scheduleTimers();
      saveStore();
      broadcastState();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/hint") {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const text = String(body.text || "").trim();
      if (store.game.phase !== "active" || store.game.hostId !== user.id) throw new Error("현재 출제자만 힌트를 줄 수 있습니다.");
      if (!text || text.length > 80) throw new Error("힌트는 1~80자로 입력해주세요.");
      store.game.hints.push({ id: randomId("hint"), text, createdAt: new Date().toISOString() });
      saveStore();
      broadcastState();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const text = String(body.text || "").trim();
      if (!text) throw new Error("메시지를 입력해주세요.");
      if (text.length > 300) throw new Error("메시지는 300자 이하로 입력해주세요.");
      store.chatMessages.push({
        id: randomId("chat"),
        userId: user.id,
        nickname: user.nickname,
        role: user.role,
        text,
        createdAt: new Date().toISOString()
      });
      store.chatMessages = store.chatMessages.slice(-200);
      const isGuessLike =
        store.game.phase === "active" &&
        user.status === "playing" &&
        user.id !== store.game.hostId &&
        !(store.game.answerBanUserId === user.id && store.game.answerBanRoundId === store.game.roundId) &&
        normalizeAnswer(toChosung(text)) === normalizeAnswer(store.game.chosung);

      if (isGuessLike) {
        const correct = normalizeAnswer(text) === normalizeAnswer(store.game.answer);
        store.game.guesses.push({
          id: randomId("guess"),
          userId: user.id,
          nickname: user.nickname,
          answer: text,
          correct,
          createdAt: new Date().toISOString()
        });
        store.game.lastGuessDeadlineAt = Date.now() + 60 * 1000;
        store.game.firstGuessDeadlineAt = null;
        if (correct) finishRoundWithWinner(user);
        else scheduleTimers();
      }
      saveStore();
      broadcastState();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/guess") {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const answer = String(body.answer || "").trim();
      if (store.game.phase !== "active") throw new Error("진행 중인 문제가 없습니다.");
      if (user.status !== "playing") throw new Error("참여 상태에서만 정답을 제출할 수 있습니다.");
      if (store.game.hostId === user.id) throw new Error("출제자는 정답을 제출할 수 없습니다.");
      if (store.game.answerBanUserId === user.id && store.game.answerBanRoundId === store.game.roundId) {
        throw new Error("연속 정답 제한으로 이번 문제는 정답을 제출할 수 없습니다.");
      }
      if (!answer) throw new Error("정답을 입력해주세요.");

      const correct = normalizeAnswer(answer) === normalizeAnswer(store.game.answer);
      store.game.guesses.push({
        id: randomId("guess"),
        userId: user.id,
        nickname: user.nickname,
        answer,
        correct,
        createdAt: new Date().toISOString()
      });
      store.game.lastGuessDeadlineAt = Date.now() + 60 * 1000;
      store.game.firstGuessDeadlineAt = null;

      if (correct) {
        finishRoundWithWinner(user);
      } else {
        scheduleTimers();
        saveStore();
        broadcastState();
      }
      sendJson(res, 200, { ok: true, correct });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/transfer") {
      const user = requireUser(req, res);
      if (!user) return;
      if (store.game.hostId !== user.id || !["hosting", "active"].includes(store.game.phase)) throw new Error("현재 출제자만 출제권을 양도할 수 있습니다.");
      transferHostWithPenalty(user);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/reissue") {
      const user = requireUser(req, res);
      if (!user) return;
      if (store.game.phase !== "active" || store.game.hostId !== user.id) throw new Error("현재 출제자만 문제를 리문할 수 있습니다.");
      reissueSameHost("출제자가 문제를 리문했습니다.");
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/reissue-request") {
      const user = requireUser(req, res);
      if (!user) return;
      if (store.game.phase !== "active") throw new Error("진행 중인 문제가 없습니다.");
      if (user.status !== "playing" || user.id === store.game.hostId) throw new Error("참여자만 리문요청을 할 수 있습니다.");
      if (playingUsers().length <= 3) throw new Error("참여자가 4명 이상일 때만 리문요청이 가능합니다.");
      if (!store.game.reissueRequests.includes(user.id)) store.game.reissueRequests.push(user.id);
      if (store.game.reissueRequests.length >= 3) {
        reissueSameHost("리문요청 3명이 모여 같은 출제자가 다시 문제를 냅니다.");
      } else {
        saveStore();
        broadcastState();
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/host") {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const target = store.users.find((user) => user.id === body.userId);
      if (!target) throw new Error("사용자를 찾을 수 없습니다.");
      if (target.status !== "playing") throw new Error("참여 상태인 사용자만 출제자로 지정할 수 있습니다.");
      setHost(target.id, `관리자가 ${target.nickname}님을 출제자로 지정했습니다.`);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/role") {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const target = store.users.find((user) => user.id === body.userId);
      const role = String(body.role || "");
      if (!target) throw new Error("사용자를 찾을 수 없습니다.");
      if (!["admin", "user"].includes(role)) throw new Error("알 수 없는 권한입니다.");
      if (target.id === admin.id && role !== "admin") throw new Error("본인의 관리자 권한은 해제할 수 없습니다.");
      target.role = role;
      saveStore();
      broadcastState();
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "요청을 처리하지 못했습니다." });
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/") || req.url === "/events") {
    handleApi(req, res);
    return;
  }
  serveStatic(req, res);
});

scheduleTimers();
server.listen(PORT, () => {
  console.log(`ChoqChoq is running at http://localhost:${PORT}`);
});
