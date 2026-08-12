const {
  sanitizeUser,
  supabaseRequest
} = require("./db");

const STATUSES = new Set(["playing", "watching", "away"]);
const SCORE_TYPES = {
  ANSWER_CORRECT: "ANSWER_CORRECT",
  QUESTION_SOLVED: "QUESTION_SOLVED",
  HOST_TRANSFER: "HOST_TRANSFER",
  HOST_TIMEOUT: "HOST_TRANSFER",
  ADMIN_ADJUST: "ADMIN_ADJUST"
};

const HOST_QUESTION_TIMEOUT_MS = 3 * 60 * 1000;
const PRESENCE_TIMEOUT_MS = 30 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function toMs(value) {
  return value ? new Date(value).getTime() : null;
}

function fromMs(value) {
  return value ? new Date(value).toISOString() : null;
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

function chooseRandom(candidates) {
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function dbGameToGame(row) {
  return {
    phase: row.phase,
    hostId: row.host_id,
    roundId: row.round_id,
    category: row.category || "",
    answer: row.answer || "",
    chosung: row.chosung || "",
    hints: row.hints || [],
    guesses: row.guesses || [],
    reissueRequests: row.reissue_requests || [],
    timeExtensionRequests: [],
    countdownEndsAt: toMs(row.countdown_ends_at),
    activeStartedAt: toMs(row.active_started_at),
    firstGuessDeadlineAt: toMs(row.first_guess_deadline_at),
    lastGuessDeadlineAt: toMs(row.last_guess_deadline_at),
    correctStreakUserId: row.correct_streak_user_id,
    correctStreakCount: row.correct_streak_count || 0,
    answerBanUserId: row.answer_ban_user_id,
    answerBanRoundId: row.answer_ban_round_id,
    lastSystemMessage: row.last_system_message || ""
  };
}

function gameToDbPatch(game) {
  return {
    phase: game.phase,
    host_id: game.hostId,
    round_id: game.roundId,
    category: game.category,
    answer: game.answer,
    chosung: game.chosung,
    hints: game.hints,
    guesses: game.guesses,
    reissue_requests: game.reissueRequests,
    countdown_ends_at: fromMs(game.countdownEndsAt),
    active_started_at: fromMs(game.activeStartedAt),
    first_guess_deadline_at: fromMs(game.firstGuessDeadlineAt),
    last_guess_deadline_at: fromMs(game.lastGuessDeadlineAt),
    correct_streak_user_id: game.correctStreakUserId,
    correct_streak_count: game.correctStreakCount,
    answer_ban_user_id: game.answerBanUserId,
    answer_ban_round_id: game.answerBanRoundId,
    last_system_message: game.lastSystemMessage,
    updated_at: nowIso()
  };
}

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
    timeExtensionRequests: [],
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

async function getUsers() {
  return supabaseRequest("choq_users?select=*&order=created_at.asc", { prefer: "" });
}

async function getScoreEvents() {
  return supabaseRequest("choq_score_events?select=*&order=created_at.asc&limit=100000", { prefer: "" });
}

async function getChatMessages() {
  const rows = await supabaseRequest("choq_chat_messages?select=*,choq_users(nickname,role)&order=created_at.desc&limit=80", { prefer: "" });
  return rows
    .slice()
    .reverse()
    .map((message) => ({
      id: message.id,
      userId: message.user_id,
      nickname: message.choq_users?.nickname || "알 수 없음",
      role: message.choq_users?.role || "user",
      text: message.message,
      createdAt: message.created_at
    }));
}

async function getGame() {
  const rows = await supabaseRequest("choq_game_state?id=eq.1&select=*&limit=1", { prefer: "" });
  if (rows?.[0]) return dbGameToGame(rows[0]);

  await supabaseRequest("choq_game_state", {
    method: "POST",
    body: {
      id: 1,
      ...gameToDbPatch(defaultGame())
    }
  });
  return defaultGame();
}

async function saveGame(game) {
  const rows = await supabaseRequest("choq_game_state?id=eq.1", {
    method: "PATCH",
    body: gameToDbPatch(game)
  });
  return dbGameToGame(rows[0]);
}

function rawScoreFor(events, userId, from = null, to = null) {
  return events
    .filter((event) => event.user_id === userId)
    .filter((event) => (!from || new Date(event.created_at) >= from) && (!to || new Date(event.created_at) < to))
    .reduce((sum, event) => sum + event.points, 0);
}

async function addScore(userId, type, points, roundId, meta = {}) {
  let nextPoints = points;
  if (points < 0) {
    const currentScore = Math.max(0, rawScoreFor(await getScoreEvents(), userId));
    nextPoints = Math.max(points, -currentScore);
  }
  if (nextPoints === 0) return;

  await supabaseRequest("choq_score_events", {
    method: "POST",
    body: {
      user_id: userId,
      type,
      points: nextPoints,
      round_id: roundId,
      meta
    }
  });
}

function playingUsers(users) {
  return users.filter((user) => user.status === "playing");
}

function resetRoundFields(game) {
  game.category = "";
  game.answer = "";
  game.chosung = "";
  game.hints = [];
  game.guesses = [];
  game.reissueRequests = [];
  game.timeExtensionRequests = [];
  game.countdownEndsAt = null;
  game.activeStartedAt = null;
  game.firstGuessDeadlineAt = null;
  game.lastGuessDeadlineAt = null;
  game.answerBanRoundId = null;
}

function setHost(game, userId, message) {
  game.phase = "hosting";
  game.hostId = userId;
  game.roundId += 1;
  resetRoundFields(game);
  game.firstGuessDeadlineAt = Date.now() + HOST_QUESTION_TIMEOUT_MS;
  game.lastSystemMessage = message || "새 출제자가 정해졌습니다.";
}

function returnToWaiting(game, message) {
  game.phase = "waiting";
  game.hostId = null;
  resetRoundFields(game);
  game.lastSystemMessage = message || "참여자가 부족해 대기 중입니다.";
}

function nextHostCandidates(users, excludeUserId = null) {
  return playingUsers(users).filter((user) => user.id !== excludeUserId);
}

function maybeStartGame(game, users) {
  const players = playingUsers(users);
  if (game.phase !== "waiting" && players.length < 2) {
    returnToWaiting(game, "참여자가 2명 미만으로 줄어 대기 상태로 돌아갑니다.");
    return true;
  }

  if (game.phase === "waiting" && players.length >= 2) {
    game.phase = "countdown";
    game.countdownEndsAt = Date.now() + 3000;
    game.lastSystemMessage = "참여자가 2명 이상입니다. 3초 뒤 게임이 시작됩니다.";
    return true;
  }

  if (game.phase === "countdown" && players.length < 2) {
    returnToWaiting(game, "참여자가 2명 미만으로 줄어 시작이 취소되었습니다.");
    return true;
  }

  return false;
}

async function advanceGame(game, users) {
  let changed = maybeStartGame(game, users);
  const players = playingUsers(users);

  if (game.phase === "countdown" && game.countdownEndsAt && game.countdownEndsAt <= Date.now()) {
    if (players.length < 2) {
      returnToWaiting(game, "참여자가 부족해 시작이 취소되었습니다.");
    } else {
      const host = chooseRandom(players);
      setHost(game, host.id, `${host.nickname}님이 첫 출제자입니다.`);
    }
    changed = true;
  }

  if (game.phase === "active") {
    const deadline = game.lastGuessDeadlineAt || game.firstGuessDeadlineAt;
    if (deadline && deadline <= Date.now()) {
      const missedAnswer = game.answer;
      const candidates = nextHostCandidates(users, game.hostId);
      if (!candidates.length) {
        returnToWaiting(game, `아무도 정답을 맞히지 못했습니다. 정답은 "${missedAnswer}"입니다. 참여자가 부족해 대기 상태로 돌아갑니다.`);
      } else {
        const nextHost = chooseRandom(candidates);
        setHost(game, nextHost.id, `아무도 정답을 맞히지 못했습니다. 정답은 "${missedAnswer}"입니다. 출제권이 랜덤으로 넘어갔습니다.`);
      }
      changed = true;
    }
  }

  if (game.phase === "hosting" && game.hostId && game.firstGuessDeadlineAt && game.firstGuessDeadlineAt <= Date.now()) {
    const previousHost = users.find((user) => user.id === game.hostId) || null;
    const candidates = nextHostCandidates(users, game.hostId);
    if (previousHost) {
      await addScore(previousHost.id, SCORE_TYPES.HOST_TIMEOUT, -2, game.roundId, { reason: "host_question_timeout" });
    }
    if (!candidates.length) {
      returnToWaiting(game, "출제권을 넘길 참여자가 없어 대기 상태로 돌아갑니다.");
    } else {
      const nextHost = chooseRandom(candidates);
      setHost(game, nextHost.id, "출제자가 3분 동안 문제를 내지 않아 -2점 처리되고 출제권이 넘어갔습니다.");
    }
    changed = true;
  }

  return changed;
}

async function getFreshContext(currentUser = null) {
  await expireStalePresence();
  const users = await getUsers();
  const freshCurrentUser = currentUser ? users.find((user) => user.id === currentUser.id) || null : null;
  let game = await getGame();
  if (await advanceGame(game, users)) {
    game = await saveGame(game);
  }
  return { users, game, currentUser: freshCurrentUser };
}

function scoreFor(events, userId, from = null, to = null) {
  return Math.max(0, rawScoreFor(events, userId, from, to));
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

function rankings(kind, users, events) {
  const { start, end } = dateRange(kind);
  return users
    .map((user) => ({ userId: user.id, nickname: user.nickname, score: scoreFor(events, user.id, start, end) }))
    .filter((row) => row.score !== 0)
    .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname, "ko-KR"))
    .slice(0, 20);
}

async function publicState(currentUser = null) {
  const context = await getFreshContext(currentUser);
  const { users, game } = context;
  currentUser = context.currentUser;
  const [events, chatMessages] = await Promise.all([getScoreEvents(), getChatMessages()]);
  const host = users.find((user) => user.id === game.hostId) || null;
  const players = playingUsers(users);
  const extensionParticipants = players.filter((user) => user.id !== game.hostId);
  const isHost = currentUser && currentUser.id === game.hostId;
  const currentRoundBanApplies = currentUser && game.answerBanUserId === currentUser.id && game.answerBanRoundId === game.roundId;
  const publicGame = {
    ...game,
    answer: isHost ? game.answer : "",
    host: host ? sanitizeUser(host) : null,
    serverNow: Date.now(),
    playerCount: players.length,
    reissueRequestCount: game.reissueRequests.length,
    timeExtensionRequests: game.timeExtensionRequests || [],
    timeExtensionRequestCount: (game.timeExtensionRequests || []).length,
    timeExtensionRequestTarget: Math.max(1, Math.min(3, extensionParticipants.length)),
    reissueEnabled: true,
    canGuess:
      !!currentUser &&
      game.phase === "active" &&
      currentUser.status === "playing" &&
      currentUser.id !== game.hostId &&
      !currentRoundBanApplies,
    guessBlockedReason: currentRoundBanApplies ? "연속 정답 제한으로 이번 문제는 정답을 제출할 수 없습니다." : ""
  };

  publicGame.guesses = [];

  return {
    me: sanitizeUser(currentUser),
    users: users.map(sanitizeUser),
    game: publicGame,
    scores: users
      .map((user) => ({ userId: user.id, nickname: user.nickname, score: scoreFor(events, user.id) }))
      .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname, "ko-KR")),
    rankings: {
      day: rankings("day", users, events),
      week: rankings("week", users, events),
      month: rankings("month", users, events)
    },
    chatMessages,
    recentScoreEvents: events.slice(-30).reverse()
  };
}

async function addChatMessage(user, text) {
  const message = String(text || "").trim();
  if (!message) throw new Error("메시지를 입력해주세요.");
  if (message.length > 300) throw new Error("메시지는 300자 이하로 입력해주세요.");

  const rows = await supabaseRequest("choq_chat_messages", {
    method: "POST",
    body: {
      user_id: user.id,
      message
    }
  });
  const created = rows?.[0] || {};
  return {
    id: created.id || `chat_${Date.now()}`,
    userId: user.id,
    nickname: user.nickname,
    role: user.role,
    text: message,
    createdAt: created.created_at || nowIso()
  };
}

async function submitChatMessage(user, text) {
  const chatMessage = await addChatMessage(user, text);

  const game = await getGame();
  const isGuessLike =
    game.phase === "active" &&
    user.status === "playing" &&
    user.id !== game.hostId &&
    !(game.answerBanUserId === user.id && game.answerBanRoundId === game.roundId) &&
    normalizeChosung(chatMessage.text) === normalizeAnswer(game.chosung);

  if (!isGuessLike) return { attempted: false, correct: false, message: chatMessage };

  const correct = await submitGuess(user, chatMessage.text);
  return { attempted: true, correct, message: chatMessage };
}

async function deleteChatMessage(messageId) {
  if (!messageId) throw new Error("삭제할 메시지를 선택해주세요.");
  await supabaseRequest(`choq_chat_messages?id=eq.${encodeURIComponent(messageId)}`, {
    method: "DELETE",
    prefer: ""
  });
}

async function clearChatMessages() {
  await supabaseRequest("choq_chat_messages?id=gte.0", {
    method: "DELETE",
    prefer: ""
  });
}

async function updateUserStatus(targetId, status) {
  const rows = await supabaseRequest(`choq_users?id=eq.${encodeURIComponent(targetId)}`, {
    method: "PATCH",
    body: {
      status,
      updated_at: nowIso()
    }
  });
  return rows[0] || null;
}

async function touchUserPresence(targetId) {
  const users = await supabaseRequest(`choq_users?id=eq.${encodeURIComponent(targetId)}&select=id,status&limit=1`, { prefer: "" });
  const user = users?.[0] || null;
  if (!user) return null;

  const status = user.status === "away" ? "watching" : user.status;
  const rows = await supabaseRequest(`choq_users?id=eq.${encodeURIComponent(targetId)}`, {
    method: "PATCH",
    body: {
      status,
      updated_at: nowIso()
    }
  });

  if (user.status !== status) await syncAfterStatusChange(targetId, status);
  return rows[0] || null;
}

async function expireStalePresence() {
  const threshold = Date.now() - PRESENCE_TIMEOUT_MS;
  const users = await getUsers();
  const staleUsers = users.filter((user) => {
    if (user.status === "away") return false;
    const seenAt = toMs(user.updated_at);
    return !seenAt || seenAt < threshold;
  });

  for (const user of staleUsers) {
    await updateUserStatus(user.id, "away");
    await syncAfterStatusChange(user.id, "away");
  }
}

async function updateUserRole(targetId, role) {
  const rows = await supabaseRequest(`choq_users?id=eq.${encodeURIComponent(targetId)}`, {
    method: "PATCH",
    body: {
      role,
      updated_at: nowIso()
    }
  });
  return rows[0] || null;
}

async function syncAfterStatusChange(targetId, status) {
  const users = await getUsers();
  let game = await getGame();
  const players = playingUsers(users);

  if (game.phase !== "waiting" && players.length < 2) {
    returnToWaiting(game, "참여자가 2명 미만으로 줄어 대기 상태로 돌아갑니다.");
  } else if (game.hostId === targetId && status !== "playing") {
    const nextHost = chooseRandom(nextHostCandidates(users, targetId));
    if (nextHost) setHost(game, nextHost.id, "출제자가 참여 상태를 벗어나 출제권이 이동했습니다.");
    else returnToWaiting(game, "출제자가 참여 상태를 벗어나 게임이 대기 상태가 되었습니다.");
  } else {
    maybeStartGame(game, users);
  }

  await saveGame(game);
}

async function createQuestion(user, category, answer) {
  let game = await getGame();
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
  game.timeExtensionRequests = [];
  game.activeStartedAt = Date.now();
  game.firstGuessDeadlineAt = Date.now() + 3 * 60 * 1000;
  game.lastGuessDeadlineAt = null;
  game.answerBanRoundId = game.answerBanUserId && game.answerBanUserId !== user.id ? game.roundId : null;
  game.lastSystemMessage = `${user.nickname}님이 문제를 냈습니다.`;
  await saveGame(game);
}

async function addHint(user, text) {
  const game = await getGame();
  if (game.phase !== "active" || game.hostId !== user.id) throw new Error("현재 출제자만 힌트를 줄 수 있습니다.");
  if (!text || text.length > 80) throw new Error("힌트는 1~80자로 입력해주세요.");
  game.hints.push({ id: cryptoId("hint"), text, createdAt: nowIso() });
  await saveGame(game);
}

function cryptoId(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

async function submitGuess(user, answer) {
  const users = await getUsers();
  let game = await getGame();
  if (await advanceGame(game, users)) {
    game = await saveGame(game);
  }
  if (game.phase !== "active") throw new Error("진행 중인 문제가 없습니다.");
  if (user.status !== "playing") throw new Error("참여 상태에서만 정답을 제출할 수 있습니다.");
  if (game.hostId === user.id) throw new Error("출제자는 정답을 제출할 수 없습니다.");
  if (game.answerBanUserId === user.id && game.answerBanRoundId === game.roundId) {
    throw new Error("연속 정답 제한으로 이번 문제는 정답을 제출할 수 없습니다.");
  }
  if (!answer) throw new Error("정답을 입력해주세요.");

  const correct = normalizeAnswer(answer) === normalizeAnswer(game.answer);
  game.guesses.push({
    id: cryptoId("guess"),
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
    await addScore(user.id, SCORE_TYPES.ANSWER_CORRECT, 1, game.roundId, { reason: "correct_answer" });
    if (previousHostId) await addScore(previousHostId, SCORE_TYPES.QUESTION_SOLVED, 1, game.roundId, { solvedBy: user.id });

    if (game.answerBanRoundId === previousRoundId) {
      game.answerBanUserId = null;
      game.answerBanRoundId = null;
    }

    const playersCount = playingUsers(users).length;
    if (game.correctStreakUserId === user.id) game.correctStreakCount += 1;
    else {
      game.correctStreakUserId = user.id;
      game.correctStreakCount = 1;
    }

    if (playersCount >= 3 && game.correctStreakCount >= 4) {
      game.answerBanUserId = user.id;
    }

    setHost(game, user.id, `${user.nickname}님 정답! 정답은 "${correctAnswer}"입니다. 다음 출제자가 되었습니다.`);
  }

  await saveGame(game);
  return correct;
}

async function transferHostWithPenalty(user) {
  const users = await getUsers();
  const game = await getGame();
  if (game.hostId !== user.id || !["hosting", "active"].includes(game.phase)) throw new Error("현재 출제자만 출제권을 양도할 수 있습니다.");
  const candidates = nextHostCandidates(users, user.id);
  if (!candidates.length) throw new Error("출제권을 받을 참여자가 없습니다.");
  const nextHost = chooseRandom(candidates);
  await addScore(user.id, SCORE_TYPES.HOST_TRANSFER, -3, game.roundId, { to: nextHost.id });
  setHost(game, nextHost.id, `${user.nickname}님이 출제권을 양도했습니다.`);
  await saveGame(game);
}

async function reissueSameHost(user, message) {
  const game = await getGame();
  if (game.phase !== "active" || game.hostId !== user.id) throw new Error("현재 출제자만 문제를 리문할 수 있습니다.");
  game.phase = "hosting";
  game.roundId += 1;
  resetRoundFields(game);
  game.lastSystemMessage = message || "문제가 리문 처리되었습니다. 같은 출제자가 다시 냅니다.";
  await saveGame(game);
}

async function requestReissue(user) {
  const users = await getUsers();
  const game = await getGame();
  if (game.phase !== "active") throw new Error("진행 중인 문제가 없습니다.");
  if (user.status !== "playing" || user.id === game.hostId) throw new Error("참여자만 리문요청을 할 수 있습니다.");
  if (!game.reissueRequests.includes(user.id)) game.reissueRequests.push(user.id);

  if (game.reissueRequests.length >= 3) {
    game.phase = "hosting";
    game.roundId += 1;
    resetRoundFields(game);
    game.lastSystemMessage = "리문요청 3명이 모여 같은 출제자가 다시 문제를 냅니다.";
  }

  await saveGame(game);
}

async function adminSetHost(userId) {
  const users = await getUsers();
  const target = users.find((user) => user.id === userId);
  if (!target) throw new Error("사용자를 찾을 수 없습니다.");
  if (target.status !== "playing") throw new Error("참여 상태인 사용자만 출제자로 지정할 수 있습니다.");
  const game = await getGame();
  setHost(game, target.id, `관리자가 ${target.nickname}님을 출제자로 지정했습니다.`);
  await saveGame(game);
}

module.exports = {
  STATUSES,
  addChatMessage,
  adminSetHost,
  createQuestion,
  clearChatMessages,
  deleteChatMessage,
  addHint,
  publicState,
  requestReissue,
  reissueSameHost,
  submitChatMessage,
  submitGuess,
  syncAfterStatusChange,
  touchUserPresence,
  transferHostWithPenalty,
  updateUserRole,
  updateUserStatus
};
