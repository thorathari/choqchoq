const http = require("http");
const fs = require("fs");
const path = require("path");

const {
  clearSessionCookie,
  getUserById,
  getUserByUsername,
  hashPassword,
  normalizeNickname,
  normalizeUsername,
  readJson,
  readSession,
  sendJson,
  setSessionCookie,
  supabaseRequest,
  usernameKey,
  verifyPassword
} = require("./server/db");

const PORT = Number(process.env.PORT || 5174);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const PUBLIC_ROOT = path.resolve(PUBLIC_DIR);
const KEEPALIVE_MS = 25000;
const PRESENCE_TIMEOUT_MS = 30 * 1000;
const PRESENCE_SWEEP_MS = 15000;
const HOST_QUESTION_TIMEOUT_MS = 3 * 60 * 1000;

const STATUSES = new Set(["playing", "watching", "away"]);
const SCORE_TYPES = {
  ANSWER_CORRECT: "ANSWER_CORRECT",
  QUESTION_SOLVED: "QUESTION_SOLVED",
  HOST_TRANSFER: "HOST_TRANSFER",
  HOST_TIMEOUT: "HOST_TRANSFER",
  ADMIN_ADJUST: "ADMIN_ADJUST"
};

const clients = new Map();
let users = [];
let scoreEvents = [];
let chatMessages = [];
let broadcastQueued = false;
let deadlineBroadcastTimer = null;
let initialized = false;

const game = defaultGame();

function defaultGame() {
  return {
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
  };
}

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function toMs(value) {
  return value ? new Date(value).getTime() : null;
}

function normalizeAnswer(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function normalizeChosung(value) {
  return normalizeAnswer(toChosung(value));
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

function memoryUserFromDb(user, status = "away") {
  return {
    ...user,
    status,
    lastSeenAt: status === "away" ? 0 : Date.now()
  };
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    role: user.role,
    status: user.status,
    createdAt: user.created_at || user.createdAt
  };
}

function allowedOrigin(origin) {
  const configured = String(process.env.CORS_ORIGIN || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return !!origin && (configured.includes("*") || configured.includes(origin));
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (!allowedOrigin(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Vary", "Origin");
}

function sendNotFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  let filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);

  if (filePath !== PUBLIC_ROOT && !filePath.startsWith(`${PUBLIC_ROOT}${path.sep}`)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, "index.html");
  }

  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml"
  };

  res.writeHead(200, {
    "Content-Type": types[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=60"
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

async function initMemory() {
  if (initialized) return;
  const [dbUsers, dbScoreEvents] = await Promise.all([
    supabaseRequest("choq_users?select=*&order=created_at.asc", { prefer: "" }),
    supabaseRequest("choq_score_events?select=*&order=created_at.asc&limit=100000", { prefer: "" }).catch(() => [])
  ]);
  users = dbUsers.map((user) => memoryUserFromDb(user, "away"));
  scoreEvents = dbScoreEvents.map((event) => ({
    id: event.id,
    userId: event.user_id,
    type: event.type,
    points: event.points,
    roundId: event.round_id,
    meta: event.meta || {},
    createdAt: event.created_at
  }));
  initialized = true;
}

async function refreshUser(userId) {
  const fresh = await getUserById(userId);
  if (!fresh) return null;
  const existing = users.find((user) => user.id === fresh.id);
  const next = existing
    ? { ...existing, ...fresh, status: existing.status, lastSeenAt: existing.lastSeenAt }
    : memoryUserFromDb(fresh, "away");
  if (existing) users[users.indexOf(existing)] = next;
  else users.push(next);
  return next;
}

async function currentUser(req, { touch = false } = {}) {
  const session = readSession(req);
  if (!session?.id) return null;
  let user = users.find((item) => item.id === session.id) || null;
  if (!user) user = await refreshUser(session.id);
  if (user && touch) touchPresence(user);
  return user;
}

async function requireUser(req, res, options = {}) {
  const user = await currentUser(req, options);
  if (user) return user;
  sendJson(res, 401, { error: "로그인이 필요합니다." });
  return null;
}

async function requireAdmin(req, res) {
  const user = await requireUser(req, res, { touch: true });
  if (!user) return null;
  if (user.role !== "admin") {
    sendJson(res, 403, { error: "관리자 권한이 필요합니다." });
    return null;
  }
  return user;
}

function syncUserStatusToDb(user) {
  supabaseRequest(`choq_users?id=eq.${encodeURIComponent(user.id)}`, {
    method: "PATCH",
    body: {
      status: user.status,
      updated_at: nowIso()
    }
  }).catch((error) => console.error("Failed to persist user status:", error.message));
}

function touchPresence(user) {
  const previous = user.status;
  user.status = user.status === "away" ? "watching" : user.status;
  user.lastSeenAt = Date.now();
  if (previous !== user.status) {
    syncAfterStatusChange(user.id, user.status);
    syncUserStatusToDb(user);
  }
}

function expireStalePresence() {
  const threshold = Date.now() - PRESENCE_TIMEOUT_MS;
  const staleUsers = users.filter((user) => user.status !== "away" && (!user.lastSeenAt || user.lastSeenAt < threshold));
  for (const user of staleUsers) {
    user.status = "away";
    user.lastSeenAt = 0;
    syncAfterStatusChange(user.id, "away");
    syncUserStatusToDb(user);
  }
}

function playingUsers() {
  return users.filter((user) => user.status === "playing");
}

function chooseRandom(candidates) {
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function resetRoundFields() {
  game.category = "";
  game.answer = "";
  game.chosung = "";
  game.hints = [];
  game.guesses = [];
  game.reissueRequests = [];
  game.countdownEndsAt = null;
  game.activeStartedAt = null;
  game.firstGuessDeadlineAt = null;
  game.lastGuessDeadlineAt = null;
  game.answerBanRoundId = null;
}

function setHost(userId, message) {
  game.phase = "hosting";
  game.hostId = userId;
  game.roundId += 1;
  resetRoundFields();
  game.firstGuessDeadlineAt = Date.now() + HOST_QUESTION_TIMEOUT_MS;
  game.lastSystemMessage = message || "새 출제자가 정해졌습니다.";
}

function returnToWaiting(message) {
  game.phase = "waiting";
  game.hostId = null;
  resetRoundFields();
  game.lastSystemMessage = message || "참여자가 부족해 대기 중입니다.";
}

function nextHostCandidates(excludeUserId = null) {
  return playingUsers().filter((user) => user.id !== excludeUserId);
}

function maybeStartGame() {
  const players = playingUsers();
  if (game.phase !== "waiting" && players.length < 2) {
    returnToWaiting("참여자가 2명 미만으로 줄어 대기 상태로 돌아갑니다.");
    return true;
  }

  if (game.phase === "waiting" && players.length >= 2) {
    game.phase = "countdown";
    game.countdownEndsAt = Date.now() + 3000;
    game.lastSystemMessage = "참여자가 2명 이상입니다. 3초 뒤 게임이 시작됩니다.";
    return true;
  }

  if (game.phase === "countdown" && players.length < 2) {
    returnToWaiting("참여자가 2명 미만으로 줄어 시작이 취소되었습니다.");
    return true;
  }

  return false;
}

function advanceGame() {
  let changed = maybeStartGame();
  const players = playingUsers();

  if (game.phase === "countdown" && game.countdownEndsAt && game.countdownEndsAt <= Date.now()) {
    if (players.length < 2) returnToWaiting("참여자가 부족해 시작이 취소되었습니다.");
    else {
      const host = chooseRandom(players);
      setHost(host.id, `${host.nickname}님이 첫 출제자입니다.`);
    }
    changed = true;
  }

  if (game.phase === "active") {
    const deadline = game.lastGuessDeadlineAt || game.firstGuessDeadlineAt;
    if (deadline && deadline <= Date.now()) {
      const nextHost = chooseRandom(nextHostCandidates(game.hostId));
      if (!nextHost) returnToWaiting("출제권을 넘길 참여자가 없어 대기 상태로 돌아갑니다.");
      else setHost(nextHost.id, "제한시간 동안 정답이 없어 출제권이 랜덤으로 넘어갔습니다.");
      changed = true;
    }
  }

  if (game.phase === "hosting" && game.hostId && game.firstGuessDeadlineAt && game.firstGuessDeadlineAt <= Date.now()) {
    const previousHost = users.find((user) => user.id === game.hostId) || null;
    const nextHost = chooseRandom(nextHostCandidates(game.hostId));
    if (previousHost) addScore(previousHost.id, SCORE_TYPES.HOST_TIMEOUT, -2, { reason: "host_question_timeout" });
    if (!nextHost) returnToWaiting("출제권을 넘길 참여자가 없어 대기 상태로 돌아갑니다.");
    else setHost(nextHost.id, "출제자가 3분 동안 문제를 내지 않아 -2점 처리되고 출제권이 넘어갔습니다.");
    changed = true;
  }

  return changed;
}

function syncAfterStatusChange(targetId, status) {
  if (game.phase !== "waiting" && playingUsers().length < 2) {
    returnToWaiting("참여자가 2명 미만으로 줄어 대기 상태로 돌아갑니다.");
  } else if (game.hostId === targetId && status !== "playing") {
    const nextHost = chooseRandom(nextHostCandidates(targetId));
    if (nextHost) setHost(nextHost.id, "출제자가 참여 상태를 벗어나 출제권이 이동했습니다.");
    else returnToWaiting("출제자가 참여 상태를 벗어나 게임이 대기 상태가 되었습니다.");
  } else {
    maybeStartGame();
  }
}

function rawScoreFor(userId, from = null, to = null) {
  return scoreEvents
    .filter((event) => event.userId === userId)
    .filter((event) => (!from || new Date(event.createdAt) >= from) && (!to || new Date(event.createdAt) < to))
    .reduce((sum, event) => sum + event.points, 0);
}

function scoreFor(userId, from = null, to = null) {
  return Math.max(0, rawScoreFor(userId, from, to));
}

function addScore(userId, type, points, meta = {}) {
  let nextPoints = points;
  if (points < 0) {
    const currentScore = Math.max(0, rawScoreFor(userId));
    nextPoints = Math.max(points, -currentScore);
  }
  if (nextPoints === 0) return;

  const event = {
    id: randomId("score"),
    userId,
    type,
    points: nextPoints,
    roundId: game.roundId,
    meta,
    createdAt: nowIso()
  };
  scoreEvents.push(event);

  supabaseRequest("choq_score_events", {
    method: "POST",
    body: {
      user_id: userId,
      type,
      points: nextPoints,
      round_id: game.roundId,
      meta
    }
  }).catch((error) => console.error("Failed to persist score:", error.message));
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

  if (kind === "month") start.setDate(1);

  const end = new Date(start);
  if (kind === "day") end.setDate(end.getDate() + 1);
  if (kind === "week") end.setDate(end.getDate() + 7);
  if (kind === "month") end.setMonth(end.getMonth() + 1);
  return { start, end };
}

function rankings(kind) {
  const { start, end } = dateRange(kind);
  return users
    .map((user) => ({ userId: user.id, nickname: user.nickname, score: scoreFor(user.id, start, end) }))
    .filter((row) => row.score !== 0)
    .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname, "ko-KR"))
    .slice(0, 20);
}

function scores() {
  return users
    .map((user) => ({ userId: user.id, nickname: user.nickname, score: scoreFor(user.id) }))
    .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname, "ko-KR"));
}

function publicState(currentUser = null) {
  expireStalePresence();
  advanceGame();
  if (currentUser) currentUser = users.find((user) => user.id === currentUser.id) || null;

  const host = users.find((user) => user.id === game.hostId) || null;
  const isHost = currentUser && currentUser.id === game.hostId;
  const currentRoundBanApplies = currentUser && game.answerBanUserId === currentUser.id && game.answerBanRoundId === game.roundId;
  const publicGame = {
    ...game,
    answer: isHost ? game.answer : "",
    host: host ? publicUser(host) : null,
    serverNow: Date.now(),
    playerCount: playingUsers().length,
    reissueRequestCount: game.reissueRequests.length,
    reissueEnabled: true,
    canGuess:
      !!currentUser &&
      game.phase === "active" &&
      currentUser.status === "playing" &&
      currentUser.id !== game.hostId &&
      !currentRoundBanApplies,
    guessBlockedReason: currentRoundBanApplies ? "연속 정답 제한으로 이번 문제는 정답을 제출할 수 없습니다." : "",
    guesses: []
  };

  return {
    me: publicUser(currentUser),
    users: users.map(publicUser),
    game: publicGame,
    scores: scores(),
    rankings: {
      day: rankings("day"),
      week: rankings("week"),
      month: rankings("month")
    },
    chatMessages: chatMessages.slice(-80),
    recentScoreEvents: scoreEvents.slice(-30).reverse()
  };
}

function nextDeadlineFromState(state) {
  const publicGame = state?.game;
  if (!publicGame) return null;
  if (publicGame.phase === "countdown") return publicGame.countdownEndsAt;
  if (publicGame.phase === "hosting") return publicGame.firstGuessDeadlineAt;
  if (publicGame.phase === "active") return publicGame.lastGuessDeadlineAt || publicGame.firstGuessDeadlineAt;
  return null;
}

function scheduleDeadlineBroadcast(state) {
  if (deadlineBroadcastTimer) clearTimeout(deadlineBroadcastTimer);
  deadlineBroadcastTimer = null;

  const deadline = nextDeadlineFromState(state);
  if (!deadline || !clients.size) return;

  const delay = Math.max(0, Number(deadline) - Date.now() + 80);
  deadlineBroadcastTimer = setTimeout(() => {
    deadlineBroadcastTimer = null;
    queueBroadcast();
  }, delay);
}

function writeClientState(client) {
  const user = users.find((item) => item.id === client.userId) || null;
  const state = publicState(user);
  client.res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  return state;
}

function broadcastState() {
  const entries = Array.from(clients.entries());
  let scheduleState = null;
  for (const [id, client] of entries) {
    try {
      const state = writeClientState(client);
      if (!scheduleState) scheduleState = state;
    } catch (error) {
      clients.delete(id);
      try {
        client.res.end();
      } catch {
        // The socket may already be gone.
      }
    }
  }
  scheduleDeadlineBroadcast(scheduleState);
}

function queueBroadcast() {
  if (broadcastQueued) return;
  broadcastQueued = true;
  setTimeout(() => {
    broadcastQueued = false;
    if (clients.size) broadcastState();
  }, 0);
}

async function handleEvents(req, res) {
  const user = await requireUser(req, res, { touch: true });
  if (!user) return;

  const id = randomId("client");
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  clients.set(id, { res, userId: user.id });
  const state = writeClientState({ res, userId: user.id });
  scheduleDeadlineBroadcast(state);
  req.on("close", () => {
    clients.delete(id);
    if (!clients.size && deadlineBroadcastTimer) {
      clearTimeout(deadlineBroadcastTimer);
      deadlineBroadcastTimer = null;
    }
  });
}

function addChatMessage(user, text) {
  const message = String(text || "").trim();
  if (!message) throw new Error("메시지를 입력해주세요.");
  if (message.length > 300) throw new Error("메시지는 300자 이하로 입력해주세요.");

  chatMessages.push({
    id: randomId("chat"),
    userId: user.id,
    nickname: user.nickname,
    role: user.role,
    text: message,
    createdAt: nowIso()
  });
  chatMessages = chatMessages.slice(-200);
  return message;
}

function submitGuess(user, answer) {
  advanceGame();
  if (game.phase !== "active") throw new Error("진행 중인 문제가 없습니다.");
  if (user.status !== "playing") throw new Error("참여 상태에서만 정답을 제출할 수 있습니다.");
  if (game.hostId === user.id) throw new Error("출제자는 정답을 제출할 수 없습니다.");
  if (game.answerBanUserId === user.id && game.answerBanRoundId === game.roundId) {
    throw new Error("연속 정답 제한으로 이번 문제는 정답을 제출할 수 없습니다.");
  }
  if (!answer) throw new Error("정답을 입력해주세요.");

  const correct = normalizeAnswer(answer) === normalizeAnswer(game.answer);
  game.guesses.push({
    id: randomId("guess"),
    userId: user.id,
    nickname: user.nickname,
    answer,
    correct,
    createdAt: nowIso()
  });
  game.lastGuessDeadlineAt = Date.now() + 60 * 1000;
  game.firstGuessDeadlineAt = null;

  if (correct) {
    const previousHostId = game.hostId;
    const previousRoundId = game.roundId;
    const correctAnswer = game.answer;
    addScore(user.id, SCORE_TYPES.ANSWER_CORRECT, 1, { reason: "correct_answer" });
    if (previousHostId) addScore(previousHostId, SCORE_TYPES.QUESTION_SOLVED, 1, { solvedBy: user.id });

    if (game.answerBanRoundId === previousRoundId) {
      game.answerBanUserId = null;
      game.answerBanRoundId = null;
    }

    if (game.correctStreakUserId === user.id) game.correctStreakCount += 1;
    else {
      game.correctStreakUserId = user.id;
      game.correctStreakCount = 1;
    }

    if (playingUsers().length >= 3 && game.correctStreakCount >= 4) {
      game.answerBanUserId = user.id;
    }

    setHost(user.id, `${user.nickname}님 정답! 정답은 "${correctAnswer}"입니다. 다음 출제자가 되었습니다.`);
  }

  return correct;
}

function submitChatMessage(user, text) {
  const message = addChatMessage(user, text);
  const isGuessLike =
    game.phase === "active" &&
    user.status === "playing" &&
    user.id !== game.hostId &&
    !(game.answerBanUserId === user.id && game.answerBanRoundId === game.roundId) &&
    normalizeChosung(message) === normalizeAnswer(game.chosung);

  if (!isGuessLike) return { attempted: false, correct: false };
  return { attempted: true, correct: submitGuess(user, message) };
}

async function register(req, res) {
  const body = await readJson(req);
  const username = normalizeUsername(body.username);
  const nickname = normalizeNickname(body.nickname);
  const password = String(body.password || "");
  const passwordConfirm = String(body.passwordConfirm || "");

  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) throw new Error("아이디는 영문, 숫자, 밑줄 3~20자로 입력해주세요.");
  if (nickname.length < 2 || nickname.length > 16) throw new Error("닉네임은 2~16자로 입력해주세요.");
  if (password.length < 4) throw new Error("비밀번호는 4자 이상 입력해주세요.");
  if (password !== passwordConfirm) throw new Error("비밀번호 확인이 일치하지 않습니다.");
  if (await getUserByUsername(username)) throw new Error("이미 사용 중인 아이디입니다.");

  const nicknameRows = await supabaseRequest(`choq_users?nickname=eq.${encodeURIComponent(nickname)}&select=id&limit=1`, { prefer: "" });
  if (nicknameRows.length) throw new Error("이미 사용 중인 닉네임입니다.");

  const existingUsers = await supabaseRequest("choq_users?select=id", { prefer: "" });
  const { salt, hash } = hashPassword(password);
  const now = nowIso();
  const created = await supabaseRequest("choq_users", {
    method: "POST",
    body: {
      username,
      username_key: usernameKey(username),
      nickname,
      password_hash: hash,
      password_salt: salt,
      role: existingUsers.length === 0 ? "admin" : "user",
      status: "watching",
      last_login_at: now,
      updated_at: now
    }
  });

  const user = memoryUserFromDb(created[0], "watching");
  users.push(user);
  setSessionCookie(res, user);
  maybeStartGame();
  sendJson(res, 200, { ok: true, user: publicUser(user) });
}

async function login(req, res) {
  const { username, password } = await readJson(req);
  const dbUser = await getUserByUsername(username);
  if (!dbUser || !verifyPassword(password, dbUser.password_salt, dbUser.password_hash)) {
    throw new Error("아이디 또는 비밀번호가 올바르지 않습니다.");
  }

  let user = users.find((item) => item.id === dbUser.id);
  if (user) {
    Object.assign(user, dbUser);
    user.status = "watching";
    user.lastSeenAt = Date.now();
  } else {
    user = memoryUserFromDb(dbUser, "watching");
    users.push(user);
  }

  supabaseRequest(`choq_users?id=eq.${encodeURIComponent(user.id)}`, {
    method: "PATCH",
    body: {
      status: "watching",
      last_login_at: nowIso(),
      updated_at: nowIso()
    }
  }).catch((error) => console.error("Failed to persist login:", error.message));

  syncAfterStatusChange(user.id, "watching");
  setSessionCookie(res, user);
  sendJson(res, 200, { ok: true, user: publicUser(user) });
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/state") {
    const user = await currentUser(req, { touch: true });
    sendJson(res, 200, publicState(user));
    return true;
  }

  if (req.method !== "POST") return false;

  if (pathname === "/api/register") {
    await register(req, res);
    return true;
  }

  if (pathname === "/api/login") {
    await login(req, res);
    return true;
  }

  if (pathname === "/api/logout") {
    const user = await currentUser(req);
    if (user) {
      user.status = "away";
      user.lastSeenAt = 0;
      syncAfterStatusChange(user.id, "away");
      syncUserStatusToDb(user);
    }
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === "/api/presence") {
    const user = await requireUser(req, res, { touch: true });
    if (!user) return true;
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === "/api/status") {
    const current = await requireUser(req, res, { touch: true });
    if (!current) return true;
    const body = await readJson(req);
    const targetId = body.userId || current.id;
    const status = String(body.status || "");
    if (!STATUSES.has(status)) throw new Error("알 수 없는 상태입니다.");
    if (status === "away") throw new Error("부재중은 로그아웃 상태에서만 적용됩니다.");
    if (targetId !== current.id && current.role !== "admin") throw new Error("다른 사용자의 상태는 관리자만 변경할 수 있습니다.");
    const target = users.find((user) => user.id === targetId);
    if (!target) throw new Error("사용자를 찾을 수 없습니다.");
    if (target.status === "away") throw new Error("부재중인 사용자의 상태는 변경할 수 없습니다.");
    target.status = status;
    target.lastSeenAt = Date.now();
    syncAfterStatusChange(target.id, status);
    syncUserStatusToDb(target);
    sendJson(res, 200, { ok: true, state: publicState(current) });
    return true;
  }

  if (pathname === "/api/question") {
    const user = await requireUser(req, res, { touch: true });
    if (!user) return true;
    const body = await readJson(req);
    const category = String(body.category || "").trim();
    const answer = String(body.answer || "").trim();
    advanceGame();
    if (game.phase !== "hosting" || game.hostId !== user.id) throw new Error("현재 출제자만 문제를 낼 수 있습니다.");
    if (!category || category.length > 20) throw new Error("분류는 1~20자로 입력해주세요.");
    if (!answer || answer.length > 30) throw new Error("정답은 1~30자로 입력해주세요.");
    if (!hasOnlyHangulAndSpaces(answer)) throw new Error("정답은 한글과 띄어쓰기만 입력할 수 있습니다.");
    game.phase = "active";
    game.category = category;
    game.answer = answer;
    game.chosung = toChosung(answer);
    game.hints = [];
    game.guesses = [];
    game.reissueRequests = [];
    game.activeStartedAt = Date.now();
    game.firstGuessDeadlineAt = Date.now() + 3 * 60 * 1000;
    game.lastGuessDeadlineAt = null;
    game.answerBanRoundId = game.answerBanUserId && game.answerBanUserId !== user.id ? game.roundId : null;
    game.lastSystemMessage = `${user.nickname}님이 문제를 냈습니다.`;
    sendJson(res, 200, { ok: true, state: publicState(user) });
    return true;
  }

  if (pathname === "/api/hint") {
    const user = await requireUser(req, res, { touch: true });
    if (!user) return true;
    const body = await readJson(req);
    const text = String(body.text || "").trim();
    if (game.phase !== "active" || game.hostId !== user.id) throw new Error("현재 출제자만 힌트를 줄 수 있습니다.");
    if (!text || text.length > 80) throw new Error("힌트는 1~80자로 입력해주세요.");
    game.hints.push({ id: randomId("hint"), text, createdAt: nowIso() });
    sendJson(res, 200, { ok: true, state: publicState(user) });
    return true;
  }

  if (pathname === "/api/chat") {
    const user = await requireUser(req, res, { touch: true });
    if (!user) return true;
    const body = await readJson(req);
    const result = submitChatMessage(user, body.text);
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (pathname === "/api/guess") {
    const user = await requireUser(req, res, { touch: true });
    if (!user) return true;
    const body = await readJson(req);
    const correct = submitGuess(user, String(body.answer || "").trim());
    sendJson(res, 200, { ok: true, correct, state: publicState(user) });
    return true;
  }

  if (pathname === "/api/transfer") {
    const user = await requireUser(req, res, { touch: true });
    if (!user) return true;
    advanceGame();
    if (game.hostId !== user.id || !["hosting", "active"].includes(game.phase)) throw new Error("현재 출제자만 출제권을 양도할 수 있습니다.");
    const nextHost = chooseRandom(nextHostCandidates(user.id));
    if (!nextHost) throw new Error("출제권을 받을 참여자가 없습니다.");
    addScore(user.id, SCORE_TYPES.HOST_TRANSFER, -3, { to: nextHost.id });
    setHost(nextHost.id, `${user.nickname}님이 출제권을 양도했습니다.`);
    sendJson(res, 200, { ok: true, state: publicState(user) });
    return true;
  }

  if (pathname === "/api/reissue") {
    const user = await requireUser(req, res, { touch: true });
    if (!user) return true;
    if (game.phase !== "active" || game.hostId !== user.id) throw new Error("현재 출제자만 문제를 리문할 수 있습니다.");
    game.phase = "hosting";
    game.roundId += 1;
    resetRoundFields();
    game.lastSystemMessage = "출제자가 문제를 리문했습니다.";
    sendJson(res, 200, { ok: true, state: publicState(user) });
    return true;
  }

  if (pathname === "/api/reissue-request") {
    const user = await requireUser(req, res, { touch: true });
    if (!user) return true;
    if (game.phase !== "active") throw new Error("진행 중인 문제가 없습니다.");
    if (user.status !== "playing" || user.id === game.hostId) throw new Error("참여자만 리문요청을 할 수 있습니다.");
    if (!game.reissueRequests.includes(user.id)) game.reissueRequests.push(user.id);
    if (game.reissueRequests.length >= 3) {
      game.phase = "hosting";
      game.roundId += 1;
      resetRoundFields();
      game.lastSystemMessage = "리문요청 3명이 모여 같은 출제자가 다시 문제를 냅니다.";
    }
    sendJson(res, 200, { ok: true, state: publicState(user) });
    return true;
  }

  if (pathname === "/api/admin/host") {
    const admin = await requireAdmin(req, res);
    if (!admin) return true;
    const body = await readJson(req);
    const target = users.find((user) => user.id === body.userId);
    if (!target) throw new Error("사용자를 찾을 수 없습니다.");
    if (target.status !== "playing") throw new Error("참여 상태인 사용자만 출제자로 지정할 수 있습니다.");
    setHost(target.id, `관리자가 ${target.nickname}님을 출제자로 지정했습니다.`);
    sendJson(res, 200, { ok: true, state: publicState(admin) });
    return true;
  }

  if (pathname === "/api/admin/role") {
    const admin = await requireAdmin(req, res);
    if (!admin) return true;
    const body = await readJson(req);
    const role = String(body.role || "");
    if (!["admin", "user"].includes(role)) throw new Error("알 수 없는 권한입니다.");
    if (body.userId === admin.id && role !== "admin") throw new Error("본인의 관리자 권한은 해제할 수 없습니다.");
    const target = users.find((user) => user.id === body.userId);
    if (!target) throw new Error("사용자를 찾을 수 없습니다.");
    target.role = role;
    await supabaseRequest(`choq_users?id=eq.${encodeURIComponent(target.id)}`, {
      method: "PATCH",
      body: { role, updated_at: nowIso() }
    });
    sendJson(res, 200, { ok: true, state: publicState(admin) });
    return true;
  }

  return false;
}

async function handleRequest(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/events") {
    await handleEvents(req, res);
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    const shouldBroadcast = req.method === "POST" && url.pathname !== "/api/presence";
    const handled = await handleApi(req, res, url.pathname);
    if (handled && shouldBroadcast) queueBroadcast();
    if (!handled) sendNotFound(res);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendNotFound(res);
    return;
  }

  serveStatic(req, res);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    }
    res.end(JSON.stringify({ error: error.message || "요청을 처리하지 못했습니다." }));
  });
});

setInterval(() => {
  for (const [id, client] of clients) {
    try {
      client.res.write(": ping\n\n");
    } catch {
      clients.delete(id);
    }
  }
}, KEEPALIVE_MS);

setInterval(() => {
  expireStalePresence();
  if (clients.size) queueBroadcast();
}, PRESENCE_SWEEP_MS);

initMemory()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Choqchoq memory realtime server running at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize realtime server:", error);
    process.exit(1);
  });
