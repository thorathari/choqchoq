let state = null;
let statePollHandle = null;
let presenceHandle = null;
let realtimeSource = null;
let realtimeConnected = false;
let realtimeRetryHandle = null;
let realtimeUnavailableUntil = 0;
let authMode = "login";
let rankMode = "day";
let tickHandle = null;
let theme = localStorage.getItem("choqchoq-theme") || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
let isSubmitting = false;
let forceNextChatScroll = false;
let pendingChatSerial = 0;
let suppressChatFocusUntil = 0;
let isRendering = false;
let chatDraftValue = "";
let chatDraftSelectionStart = null;
let chatDraftSelectionEnd = null;
let chatDraftFocused = false;
let isChatScrolledAway = false;
let chatContextMenu = null;
let chatContextMessageId = "";
const pendingChatMessages = [];
const PRESENCE_INTERVAL_MS = 10000;
const STATE_POLL_INTERVAL_MS = 800;
const REALTIME_RETRY_MS = 10000;

const app = document.querySelector("#app");
const APP_NAME = "촠촠";

const statusLabels = {
  playing: "참여",
  watching: "관전",
  away: "부재중"
};

const phaseLabels = {
  waiting: "대기",
  countdown: "시작 준비",
  hosting: "출제 대기",
  active: "문제 진행"
};

function applyTheme() {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

applyTheme();

async function api(path, body = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw new Error(payload.error || "요청에 실패했습니다.");
  return payload;
}

function getChatScrollSnapshot() {
  const list = document.querySelector(".chat-list");
  if (!list) return null;
  const distanceFromBottom = Math.max(0, list.scrollHeight - list.scrollTop - list.clientHeight);
  return {
    isNearBottom: distanceFromBottom < 80,
    distanceFromBottom
  };
}

function restoreChatScroll(snapshot, forceBottom = false) {
  const list = document.querySelector(".chat-list");
  if (!list) return;
  if (forceBottom || !snapshot || snapshot.isNearBottom) {
    list.scrollTop = list.scrollHeight;
    isChatScrolledAway = false;
    updateChatBottomButton();
    return;
  }
  list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight - snapshot.distanceFromBottom);
  isChatScrolledAway = true;
  updateChatBottomButton();
}

function applyStatePayload(payload, options = {}) {
  if (!payload?.state) return false;
  const previousState = state;
  forceNextChatScroll = !!options.forceChatBottom;
  state = payload.state;
  render();
  if (options.focusChatInput) requestAnimationFrame(focusChatInput);
  scheduleRoleFocus(previousState, state);
  if (state.me) connectEvents();
  return true;
}

function applyStateObject(nextState, options = {}) {
  if (!nextState) return false;
  const previousState = state;
  const shouldRender = options.forceRender || !isEditingForm() || didCriticalGameSurfaceChange(state, nextState);
  forceNextChatScroll = !!options.forceChatBottom;
  state = nextState;
  if (!state.me) disconnectEvents();
  if (!shouldRender) {
    updateTimers();
    if (state.me) connectEvents();
    return false;
  }
  render();
  scheduleRoleFocus(previousState, state);
  if (state.me) connectEvents();
  return true;
}

function isEditingForm() {
  const element = document.activeElement;
  if (!element || !app.contains(element)) return false;
  if (!["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) return false;
  return !!element.closest("form");
}

async function loadState(options = {}) {
  const response = await fetch("/api/state", { cache: "no-store" });
  const nextState = await response.json();
  applyStateObject(nextState, options);
}

function didCriticalGameSurfaceChange(previous, next) {
  if (!previous || !next) return true;
  if (!previous.me && !next.me) return false;
  if (!previous.me || !next.me) return true;
  return (
    previous.me.id !== next.me.id ||
    previous.game.phase !== next.game.phase ||
    previous.game.roundId !== next.game.roundId ||
    previous.game.hostId !== next.game.hostId ||
    previous.me.status !== next.me.status ||
    previous.me.role !== next.me.role
  );
}

function roleFocusTarget(previous, next) {
  if (!previous?.me || !next?.me || document.visibilityState !== "visible") return "";
  if (previous.me.id !== next.me.id) return "";

  const becameHost =
    next.game.phase === "hosting" &&
    next.game.hostId === next.me.id &&
    (
      previous.game.hostId !== next.game.hostId ||
      previous.game.phase !== "hosting" ||
      previous.game.roundId !== next.game.roundId
    );
  if (becameHost) return "question";

  const becameParticipant =
    next.me.status === "playing" &&
    next.game.hostId !== next.me.id &&
    (
      previous.me.status !== "playing" ||
      previous.game.hostId === previous.me.id
    );
  return becameParticipant ? "chat" : "";
}

function scheduleRoleFocus(previous, next) {
  const target = roleFocusTarget(previous, next);
  if (!target) return;
  requestAnimationFrame(() => {
    if (target === "question") focusQuestionCategory();
    if (target === "chat") focusChatInput();
  });
}

function connectEvents() {
  connectRealtimeEvents();
  if (!realtimeConnected && !statePollHandle) statePollHandle = setInterval(loadState, STATE_POLL_INTERVAL_MS);
  if (!presenceHandle) {
    sendPresence();
    presenceHandle = setInterval(sendPresence, PRESENCE_INTERVAL_MS);
  }
}

function disconnectEvents() {
  if (statePollHandle) clearInterval(statePollHandle);
  if (presenceHandle) clearInterval(presenceHandle);
  if (realtimeRetryHandle) clearTimeout(realtimeRetryHandle);
  if (realtimeSource) realtimeSource.close();
  statePollHandle = null;
  presenceHandle = null;
  realtimeRetryHandle = null;
  realtimeSource = null;
  realtimeConnected = false;
}

function connectRealtimeEvents() {
  if (!window.EventSource || realtimeSource || Date.now() < realtimeUnavailableUntil) return;

  const source = new EventSource("/events", { withCredentials: true });
  realtimeSource = source;

  source.addEventListener("open", () => {
    realtimeConnected = true;
    if (statePollHandle) clearInterval(statePollHandle);
    statePollHandle = null;
  });

  source.addEventListener("state", (event) => {
    try {
      applyStateObject(JSON.parse(event.data));
    } catch {
      source.close();
      if (realtimeSource === source) realtimeSource = null;
      realtimeConnected = false;
      if (state?.me && !statePollHandle) statePollHandle = setInterval(loadState, STATE_POLL_INTERVAL_MS);
    }
  });

  source.onerror = () => {
    source.close();
    if (realtimeSource === source) realtimeSource = null;
    realtimeConnected = false;
    realtimeUnavailableUntil = Date.now() + REALTIME_RETRY_MS;
    if (state?.me && !statePollHandle) statePollHandle = setInterval(loadState, STATE_POLL_INTERVAL_MS);
    if (state?.me && !realtimeRetryHandle) {
      realtimeRetryHandle = setTimeout(() => {
        realtimeRetryHandle = null;
        connectRealtimeEvents();
      }, REALTIME_RETRY_MS);
    }
  };
}

async function sendPresence() {
  if (!state?.me || document.visibilityState !== "visible") return;
  try {
    await api("/api/presence");
  } catch {
    // Presence should never interrupt the game UI.
  }
}

function html(strings, ...values) {
  return strings.reduce((acc, part, index) => acc + part + (values[index] ?? ""), "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function adminCrown() {
  return `<span class="admin-crown" title="관리자" aria-label="관리자">👑</span>`;
}

function formatTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function currentDeadline() {
  if (!state?.game) return null;
  if (state.game.phase === "countdown") return state.game.countdownEndsAt;
  if (state.game.phase === "hosting") return state.game.firstGuessDeadlineAt;
  if (state.game.phase === "active") return state.game.lastGuessDeadlineAt || state.game.firstGuessDeadlineAt;
  return null;
}

function render() {
  const chatSnapshot = getChatScrollSnapshot();
  const chatDraft = getChatDraft();
  const shouldForceChatBottom = forceNextChatScroll;
  forceNextChatScroll = false;
  clearInterval(tickHandle);
  if (!state?.me) {
    renderAuth();
    return;
  }
  isRendering = true;
  try {
    renderGame();
  } finally {
    isRendering = false;
  }
  requestAnimationFrame(() => {
    restoreChatScroll(chatSnapshot, shouldForceChatBottom);
    restoreChatDraft(chatDraft);
  });
  if (currentDeadline()) {
    tickHandle = setInterval(updateTimers, 500);
    updateTimers();
  }
}

function renderAuth() {
  app.innerHTML = html`
    <section class="auth-wrap">
      <div class="auth-title brand">
        <div class="app-mark">ㅊ</div>
        <div>
          <h1>${APP_NAME}</h1>
          <span>ㅊㅅㅋㅈㄱㄱㄱㄱ</span>
        </div>
      </div>
      <div class="panel">
        <div class="panel-body form">
          <div class="tabs">
            <button class="${authMode === "login" ? "active" : ""}" data-auth-mode="login">로그인</button>
            <button class="${authMode === "register" ? "active" : ""}" data-auth-mode="register">회원가입</button>
          </div>
          ${authMode === "login" ? loginForm() : registerForm()}
        </div>
      </div>
    </section>
  `;
}

function loginForm() {
  return html`
    <form class="form" data-form="login">
      <div class="form-row">
        <label>아이디</label>
        <input name="username" autocomplete="username" required />
      </div>
      <div class="form-row">
        <label>비밀번호</label>
        <input name="password" type="password" autocomplete="current-password" required />
      </div>
      <button class="primary" type="submit">로그인</button>
    </form>
  `;
}

function registerForm() {
  return html`
    <form class="form" data-form="register">
      <div class="form-row">
        <label>아이디</label>
        <input name="username" autocomplete="username" required />
      </div>
      <div class="form-row">
        <label>닉네임</label>
        <input name="nickname" required />
      </div>
      <div class="form-row">
        <label>비밀번호</label>
        <input name="password" type="password" autocomplete="new-password" required />
      </div>
      <div class="form-row">
        <label>비밀번호 확인</label>
        <input name="passwordConfirm" type="password" autocomplete="new-password" required />
      </div>
      <button class="primary" type="submit">회원가입</button>
    </form>
  `;
}

function renderGame() {
  app.innerHTML = html`
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="app-mark">ㅊ</div>
          <div>
            <h1>${APP_NAME}</h1>
            <span>ㅊㅅㅋㅈㄱㄱㄱㄱ</span>
          </div>
        </div>
        <div class="userbar">
          <button class="theme-toggle" data-action="theme" title="${theme === "dark" ? "밝은 모드" : "다크 모드"}" aria-label="${theme === "dark" ? "밝은 모드로 전환" : "다크 모드로 전환"}">
            <span aria-hidden="true">${theme === "dark" ? "☀" : "☾"}</span>
          </button>
          <span class="top-nickname ${state.me.role === "admin" ? "admin" : ""}">${escapeHtml(state.me.nickname)}${state.me.role === "admin" ? " 관리자" : ""}</span>
          <button class="logout-button" data-action="logout">로그아웃</button>
        </div>
      </header>
      <div class="layout">
        <section class="main-column">
          ${gamePanel()}
          ${chatPanel()}
        </section>
        <aside class="side-column">
          ${usersPanel()}
          ${scorePanel()}
          ${rankingPanel()}
          ${state.me.role === "admin" ? adminPanel() : ""}
        </aside>
      </div>
    </div>
  `;
}

function gamePanel() {
  const game = state.game;
  const isHost = state.me.id === game.hostId;
  return html`
    <section class="panel hero-panel">
      <div class="panel-header">
        <h2>라운드</h2>
        <div class="status-line">
          <span class="badge">${phaseLabels[game.phase]}</span>
          ${game.host ? `<span class="badge host">출제자 ${escapeHtml(game.host.nickname)}</span>` : ""}
          ${currentDeadline() ? `<span class="badge timer" data-timer="${currentDeadline()}">--:--</span>` : ""}
        </div>
      </div>
      <div class="panel-body hero-body">
        ${game.phase === "waiting" ? waitingView() : ""}
        ${game.phase === "countdown" ? countdownView() : ""}
        ${game.phase === "hosting" ? hostingView(isHost) : ""}
        ${game.phase === "active" ? activeView(isHost) : ""}
      </div>
    </section>
  `;
}

function waitingView() {
  const count = state.game.playerCount;
  const needed = Math.max(0, 2 - count);
  const isPlaying = state.me.status === "playing";
  const title = needed > 0 ? "참여 대기중" : "시작 준비 중";
  const guide = isPlaying
    ? needed > 0
      ? `게임 시작까지 ${needed}명이 더 필요합니다.`
      : "곧 게임이 시작됩니다."
    : "참여자 목록의 내 행에서 참여로 바꾸면 게임 시작 조건에 포함됩니다.";

  return html`
    <div class="problem">
      <div class="chosung">${title}</div>
      <p class="muted">${guide}</p>
    </div>
  `;
}

function countdownView() {
  return html`
    <div class="problem">
      <div class="chosung countdown-number"><span data-timer="${state.game.countdownEndsAt}">00:03</span></div>
      <p class="muted">참여자가 2명 미만으로 줄면 시작이 취소됩니다.</p>
    </div>
  `;
}

function hostingView(isHost) {
  const reveal = answerRevealInfo();
  if (!isHost) {
    return html`
      <div class="problem">
        ${reveal ? roundAnswerReveal(reveal) : `<div class="chosung">출제 준비 중</div>`}
        <p class="muted">${reveal ? reveal.guide : "출제자가 분류와 정답을 입력하고 있습니다."}</p>
      </div>
    `;
  }

  return html`
    <form class="form" data-form="question">
      ${reveal ? roundAnswerReveal(reveal) : ""}
      <div class="question-grid">
        <div class="form-row">
          <label>주제</label>
          <input name="category" placeholder="사물" maxlength="20" required />
        </div>
        <div class="form-row">
          <label>정답</label>
          <div class="answer-submit-row">
            <input name="answer" placeholder="지우개" maxlength="30" required />
            <button class="primary" type="submit">문제 내기</button>
          </div>
        </div>
      </div>
      <div class="round-transfer-row">
        <button class="small-button warning" type="button" data-action="transfer">출제권 양도</button>
      </div>
    </form>
  `;
}

function answerRevealInfo() {
  const text = state.game.lastSystemMessage || "";
  const match = text.match(/^(.+?)님 정답! 정답은 "(.+)"입니다\. 다음 출제자가 되었습니다\.$/);
  if (!match) return null;
  return {
    winner: match[1],
    answer: match[2],
    guide: `${match[1]}님이 정답을 맞혀 출제자가 되었습니다.`
  };
}

function roundAnswerReveal(reveal) {
  return html`
    <div class="chosung answer-reveal">
      <span class="category">정답</span>
      <span>${escapeHtml(reveal.answer)}</span>
    </div>
    <p class="muted round-result">${escapeHtml(reveal.guide)}</p>
  `;
}

function activeView(isHost) {
  const game = state.game;
  return html`
    <div class="problem">
      <div class="chosung"><span class="category">${escapeHtml(game.category)}</span><span>${escapeHtml(game.chosung)}</span></div>
      ${isHost ? hostTools() : guessTools()}
      ${roundHints()}
    </div>
  `;
}

function hostTools() {
  const game = state.game;
  return html`
    <form class="form compact-host-tools" data-form="hint">
      <div class="hint-submit-row">
        <div class="form-row">
          <label>힌트</label>
          <input name="text" maxlength="80" placeholder="자유 힌트" required />
        </div>
        <button class="primary small-button" type="submit">힌트 주기</button>
      </div>
      <div class="actions host-secondary-actions">
        <span class="badge reissue-count">리문요청 ${game.reissueRequestCount}/3</span>
        <button class="small-button" type="button" data-action="reissue">리문</button>
        <button class="small-button warning" type="button" data-action="transfer">출제권 양도</button>
      </div>
    </form>
  `;
}

function guessTools() {
  const game = state.game;
  const alreadyRequested = game.reissueRequests.includes(state.me.id);
  const reissueDisabled = alreadyRequested || state.me.status !== "playing";
  const reissueButton = html`
    <div class="actions participant-round-actions">
      <span class="badge reissue-count">요청 ${game.reissueRequestCount}/3</span>
      <button class="small-button" type="button" data-action="reissue-request" ${reissueDisabled ? "disabled" : ""}>${alreadyRequested ? "요청 완료" : "리문요청"}</button>
    </div>
  `;

  if (!game.canGuess) {
    return html`
      <div class="message ${game.guessBlockedReason ? "danger-text" : ""}">
        ${escapeHtml(game.guessBlockedReason || "현재 상태에서는 정답을 제출할 수 없습니다.")}
      </div>
      ${reissueButton}
    `;
  }

  return html`
    <div class="message">채팅에 초성이 맞는 단어를 입력하면 답변으로 제출됩니다.</div>
    ${reissueButton}
  `;
}

function roundHints() {
  const hints = state.game.hints || [];
  if (!hints.length) return "";
  return html`
    <div class="round-hints">
      <span class="round-hints-label">힌트</span>
      <div class="round-hints-list">
        ${hints.map((hint) => `<span>${escapeHtml(hint.text)}</span>`).join("")}
      </div>
    </div>
  `;
}

function chatPanel() {
  const serverMessages = state.chatMessages || [];
  const visiblePendingMessages = pendingChatMessages.filter((pending) => !serverMessages.some((message) => (
    message.userId === pending.userId &&
    message.text === pending.text &&
    Math.abs(new Date(message.createdAt || 0).getTime() - pending.createdAtMs) < 15000
  )));
  const messages = [
    ...serverMessages,
    ...visiblePendingMessages
  ];
  const placeholder = state.game.canGuess ? "대화 또는 정답 입력" : "메시지 입력";
  return html`
    <section class="panel chat-panel">
      <div class="panel-header">
        <h2>대화</h2>
      </div>
      <div class="panel-body chat-body">
        <div class="chat-list">
          ${messages.length ? messages.map(chatMessage).join("") : `<div class="empty">아직 대화가 없습니다.</div>`}
        </div>
        <button class="scroll-bottom-button ${isChatScrolledAway ? "visible" : ""}" type="button" data-action="chat-bottom" aria-label="맨 아래로 이동">↓</button>
        <form class="chat-form" data-form="chat">
          <input name="text" maxlength="300" autocomplete="off" placeholder="${placeholder}" required />
          <button class="primary" type="submit">전송</button>
        </form>
      </div>
    </section>
  `;
}

function chatMessage(message) {
  const mine = state.me && message.userId === state.me.id;
  const meta = html`
    ${mine ? "" : `<strong>${escapeHtml(message.nickname)}</strong>`}
    ${message.role === "admin" ? adminCrown() : ""}
    ${message.pending ? `<span class="sending-dot">전송 중</span>` : ""}
  `;
  const showMeta = meta.trim().length > 0;
  return html`
    <div class="chat-message ${mine ? "mine" : ""} ${message.pending ? "pending" : ""}" ${!message.pending && message.id ? `data-message-id="${escapeHtml(message.id)}"` : ""}>
      ${showMeta ? `<div class="chat-meta ${mine ? "mine-meta" : ""}">${meta}</div>` : ""}
      <div class="chat-bubble-row ${mine ? "mine" : ""}">
        <div class="chat-bubble">${escapeHtml(message.text)}</div>
      </div>
    </div>
  `;
}

function usersPanel() {
  const users = state.users
    .slice()
    .sort((a, b) => {
      const aOnline = a.status === "away" ? 1 : 0;
      const bOnline = b.status === "away" ? 1 : 0;
      return aOnline - bOnline || a.nickname.localeCompare(b.nickname, "ko-KR");
    });
  return html`
    <section class="panel">
      <div class="panel-header">
        <h2>참여자 목록</h2>
        <span class="badge playing">${state.game.playerCount}명 참여</span>
      </div>
      <div class="panel-body users-body">
        <ul class="user-list">
          ${users.map(userItem).join("")}
        </ul>
      </div>
    </section>
  `;
}

function userItem(user) {
  const isHost = user.id === state.game.hostId;
  const isBan = user.id === state.game.answerBanUserId;
  const isMe = user.id === state.me.id;
  const canAdmin = state.me.role === "admin";
  const controls = canAdmin
    ? statusButtons(user.status, "admin-status", user.id, { disabled: user.status === "away" })
    : isMe
      ? statusButtons(user.status, "self-status")
      : "";
  return html`
    <li class="user-item">
      <div class="user-main">
        <div class="user-line">
          <span class="user-name">${escapeHtml(user.nickname)}</span>
          <div class="user-badges">
            <span class="badge ${user.status}">${statusLabels[user.status]}</span>
            ${isHost ? `<span class="badge host">출제자</span>` : ""}
            ${user.role === "admin" ? `<span class="badge admin">관리자</span>` : ""}
            ${isBan ? `<span class="badge away">제한</span>` : ""}
          </div>
        </div>
      </div>
      ${controls ? `<div class="user-controls">${controls}</div>` : ""}
    </li>
  `;
}

function scorePanel() {
  const rows = state.scores.slice(0, 8);
  return html`
    <section class="panel">
      <div class="panel-header">
        <h2>점수판</h2>
      </div>
      <div class="panel-body">
        ${rows.length ? `<ol class="score-list">${rows.map((row, index) => scoreRow(row, index)).join("")}</ol>` : `<div class="empty">점수 기록이 없습니다.</div>`}
      </div>
    </section>
  `;
}

function rankingPanel() {
  const rows = state.rankings[rankMode] || [];
  return html`
    <section class="panel">
      <div class="panel-header">
        <h2>랭킹</h2>
      </div>
      <div class="panel-body form">
        <div class="rank-tabs">
          <button class="${rankMode === "day" ? "active" : ""}" data-rank="day">일일</button>
          <button class="${rankMode === "week" ? "active" : ""}" data-rank="week">주간</button>
          <button class="${rankMode === "month" ? "active" : ""}" data-rank="month">월간</button>
        </div>
        ${rows.length ? `<ol class="score-list">${rows.map((row, index) => scoreRow(row, index)).join("")}</ol>` : `<div class="empty">해당 기간 점수 기록이 없습니다.</div>`}
      </div>
    </section>
  `;
}

function scoreRow(row, index) {
  return html`
    <li class="score-item">
      <span class="score-name">${index + 1}. ${escapeHtml(row.nickname)}</span>
      <strong>${row.score}</strong>
    </li>
  `;
}

function adminPanel() {
  const playerOptions = state.users
    .filter((user) => user.status === "playing")
    .map((user) => `<option value="${user.id}">${escapeHtml(user.nickname)}</option>`)
    .join("");
  return html`
    <section class="panel admin-panel">
      <div class="panel-header">
        <h2>관리자</h2>
      </div>
      <div class="panel-body admin-body">
        <form class="admin-host-row" data-form="admin-host">
          <select name="userId" required>
            <option value="">출제자 선택</option>
            ${playerOptions}
          </select>
          <button class="primary" type="submit">출제자 변경</button>
        </form>
        <div class="admin-role-list">
          ${state.users.map((user) => html`
            <div class="admin-role-row">
              <span class="admin-role-name">${escapeHtml(user.nickname)}</span>
              <span class="badge ${user.role === "admin" ? "admin" : ""}">${user.role === "admin" ? "관리자" : "일반"}</span>
              <select data-action="admin-role" data-user-id="${user.id}">
                <option value="user" ${user.role === "user" ? "selected" : ""}>일반</option>
                <option value="admin" ${user.role === "admin" ? "selected" : ""}>관리자</option>
              </select>
            </div>
          `).join("")}
        </div>
      </div>
    </section>
  `;
}

function statusOptions(selected) {
  return Object.entries(statusLabels)
    .map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`)
    .join("");
}

function statusButtons(selected, action, userId = "", options = {}) {
  const entries = Object.entries(statusLabels).filter(([value]) => value !== "away");
  return html`
    <div class="status-buttons" role="group" aria-label="상태 변경">
      ${entries.map(([value, label]) => `
        <button
          type="button"
          class="status-button ${selected === value ? "active" : ""}"
          data-action="${action}"
          data-status="${value}"
          ${userId ? `data-user-id="${userId}"` : ""}
          ${selected === value || options.disabled ? "disabled" : ""}
        >${label}</button>
      `).join("")}
    </div>
  `;
}

function updateTimers() {
  document.querySelectorAll("[data-timer]").forEach((node) => {
    const deadline = Number(node.dataset.timer);
    node.textContent = formatTime(deadline - Date.now());
  });
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function focusChatInput() {
  if (Date.now() < suppressChatFocusUntil) return;
  const input = document.querySelector('.chat-form input[name="text"]');
  if (input) {
    chatDraftFocused = true;
    input.focus({ preventScroll: true });
  }
}

function focusQuestionCategory() {
  const input = document.querySelector('.form[data-form="question"] input[name="category"]');
  if (input) input.focus({ preventScroll: true });
}

function getChatDraft() {
  const input = document.querySelector('.chat-form input[name="text"]');
  if (input) syncChatDraftFromInput(input);
  if (!chatDraftValue && !chatDraftFocused) return null;
  return {
    value: chatDraftValue,
    selectionStart: chatDraftSelectionStart,
    selectionEnd: chatDraftSelectionEnd,
    shouldFocus: chatDraftFocused
  };
}

function syncChatDraftFromInput(input) {
  chatDraftValue = input.value;
  chatDraftSelectionStart = input.selectionStart;
  chatDraftSelectionEnd = input.selectionEnd;
}

function restoreChatDraft(draft) {
  if (!draft) return;
  const input = document.querySelector('.chat-form input[name="text"]');
  if (!input) return;
  input.value = draft.value;
  if (draft.shouldFocus && Date.now() >= suppressChatFocusUntil) input.focus({ preventScroll: true });
  if (document.activeElement === input && draft.selectionStart !== null && draft.selectionEnd !== null) {
    input.setSelectionRange(draft.selectionStart, draft.selectionEnd);
  }
}

function addPendingChatMessage(text) {
  const message = {
    id: `pending-${Date.now()}-${++pendingChatSerial}`,
    userId: state.me.id,
    nickname: state.me.nickname,
    role: state.me.role,
    text,
    createdAtMs: Date.now(),
    pending: true
  };
  pendingChatMessages.push(message);
  forceNextChatScroll = true;
  render();
  requestAnimationFrame(focusChatInput);
  return message.id;
}

function removePendingChatMessage(id) {
  const index = pendingChatMessages.findIndex((message) => message.id === id);
  if (index >= 0) pendingChatMessages.splice(index, 1);
}

function confirmPendingChatMessage(id, message) {
  const index = pendingChatMessages.findIndex((item) => item.id === id);
  if (index < 0) return false;
  pendingChatMessages[index] = {
    id: message.id || id,
    userId: message.userId,
    nickname: message.nickname,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
    createdAtMs: new Date(message.createdAt || Date.now()).getTime(),
    pending: false
  };
  return true;
}

function updateChatBottomButton() {
  const button = document.querySelector(".scroll-bottom-button");
  if (button) button.classList.toggle("visible", isChatScrolledAway);
}

function scrollChatToBottom() {
  const list = document.querySelector(".chat-list");
  if (!list) return;
  list.scrollTop = list.scrollHeight;
  isChatScrolledAway = false;
  updateChatBottomButton();
}

function ensureChatContextMenu() {
  if (chatContextMenu) return chatContextMenu;
  chatContextMenu = document.createElement("div");
  chatContextMenu.className = "chat-context-menu";
  chatContextMenu.hidden = true;
  document.body.appendChild(chatContextMenu);
  return chatContextMenu;
}

function hideChatContextMenu() {
  if (!chatContextMenu) return;
  chatContextMenu.hidden = true;
  chatContextMessageId = "";
}

function showChatContextMenu(event, type, messageId = "") {
  if (state?.me?.role !== "admin") return;
  event.preventDefault();
  const menu = ensureChatContextMenu();
  chatContextMessageId = messageId;
  menu.innerHTML = type === "message"
    ? `<button type="button" data-chat-menu-action="delete">대화 삭제</button>`
    : `<button type="button" data-chat-menu-action="clear">대화 초기화</button>`;
  menu.hidden = false;

  const padding = 8;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(event.clientX, window.innerWidth - rect.width - padding);
  const top = Math.min(event.clientY, window.innerHeight - rect.height - padding);
  menu.style.left = `${Math.max(padding, left)}px`;
  menu.style.top = `${Math.max(padding, top)}px`;
}

async function deleteChatMessageFromMenu() {
  if (!chatContextMessageId) return;
  if (!confirm("이 메시지를 삭제할까요?")) return;
  applyStatePayload(await api("/api/admin/chat/delete", { messageId: chatContextMessageId }), { forceChatBottom: false });
}

async function clearChatMessagesFromMenu() {
  if (!confirm("모든 대화를 초기화할까요?")) return;
  pendingChatMessages.length = 0;
  applyStatePayload(await api("/api/admin/chat/clear"), { forceChatBottom: true });
}

app.addEventListener("click", async (event) => {
  hideChatContextMenu();
  const modeButton = event.target.closest("[data-auth-mode]");
  if (modeButton) {
    authMode = modeButton.dataset.authMode;
    render();
    return;
  }

  const rankButton = event.target.closest("[data-rank]");
  if (rankButton) {
    rankMode = rankButton.dataset.rank;
    render();
    return;
  }

  const action = event.target.closest("[data-action]")?.dataset.action;
  const actionTarget = event.target.closest("[data-action]");
  try {
    if (action === "logout") {
      await api("/api/logout");
      disconnectEvents();
      pendingChatMessages.length = 0;
      state = null;
      await loadState();
    }
    if (action === "theme") {
      theme = theme === "dark" ? "light" : "dark";
      localStorage.setItem("choqchoq-theme", theme);
      applyTheme();
      render();
    }
    if (action === "transfer") {
      if (confirm("출제권을 양도하면 3점 감점됩니다. 계속하시겠습니까?")) applyStatePayload(await api("/api/transfer"));
    }
    if (action === "reissue") {
      applyStatePayload(await api("/api/reissue"));
    }
    if (action === "reissue-request") {
      applyStatePayload(await api("/api/reissue-request"));
    }
    if (action === "chat-bottom") {
      scrollChatToBottom();
    }
    if (action === "self-status") {
      applyStatePayload(await api("/api/status", { status: actionTarget.dataset.status }));
    }
    if (action === "admin-status") {
      applyStatePayload(await api("/api/status", { userId: actionTarget.dataset.userId, status: actionTarget.dataset.status }));
    }
  } catch (error) {
    alert(error.message);
  }
});

document.addEventListener("contextmenu", (event) => {
  if (state?.me?.role !== "admin") return;
  const bubble = event.target.closest?.(".chat-bubble");
  const message = bubble?.closest?.(".chat-message[data-message-id]");
  if (bubble && message) {
    showChatContextMenu(event, "message", message.dataset.messageId);
    return;
  }

  const chatList = event.target.closest?.(".chat-list");
  if (chatList) {
    showChatContextMenu(event, "chat");
  }
});

document.addEventListener("click", async (event) => {
  const menuAction = event.target.closest?.("[data-chat-menu-action]")?.dataset.chatMenuAction;
  if (!menuAction) {
    if (!event.target.closest?.(".chat-context-menu")) hideChatContextMenu();
    return;
  }

  try {
    if (menuAction === "delete") await deleteChatMessageFromMenu();
    if (menuAction === "clear") await clearChatMessagesFromMenu();
  } catch (error) {
    alert(error.message);
  } finally {
    hideChatContextMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideChatContextMenu();
});

window.addEventListener("resize", hideChatContextMenu);
window.addEventListener("scroll", hideChatContextMenu, true);

app.addEventListener("change", async (event) => {
  const target = event.target;
  const action = target.dataset.action;
  try {
    if (action === "admin-role") {
      applyStatePayload(await api("/api/admin/role", { userId: target.dataset.userId, role: target.value }));
    }
  } catch (error) {
    alert(error.message);
    render();
  }
});

app.addEventListener("focusin", (event) => {
  if (event.target.closest?.(".chat-form")) {
    chatDraftFocused = true;
    suppressChatFocusUntil = 0;
    syncChatDraftFromInput(event.target);
  }
});

app.addEventListener("focusout", (event) => {
  if (event.target.closest?.(".chat-form")) {
    chatDraftFocused = false;
    syncChatDraftFromInput(event.target);
  }
  if (!isRendering && event.target.closest?.(".chat-form")) {
    suppressChatFocusUntil = Math.max(suppressChatFocusUntil, Date.now() + 800);
  }
});

app.addEventListener("input", (event) => {
  if (event.target.closest?.(".chat-form")) syncChatDraftFromInput(event.target);
});

app.addEventListener("scroll", (event) => {
  if (!event.target.classList?.contains("chat-list")) return;
  const list = event.target;
  const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
  isChatScrolledAway = distanceFromBottom >= 80;
  updateChatBottomButton();
}, true);

app.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const name = form.dataset.form;
  if (name === "chat") {
    const data = formData(form);
    const text = String(data.text || "").trim();
    if (!text) return;
    form.reset();
    chatDraftValue = "";
    chatDraftSelectionStart = null;
    chatDraftSelectionEnd = null;
    chatDraftFocused = true;
    const pendingId = addPendingChatMessage(text);
    try {
      const result = await api("/api/chat", { text });
      if (result.state) {
        removePendingChatMessage(pendingId);
        applyStatePayload(result, { forceChatBottom: true, focusChatInput: true });
      } else if (result.message) {
        confirmPendingChatMessage(pendingId, result.message);
        render();
        requestAnimationFrame(focusChatInput);
      } else if (!realtimeConnected) {
        loadState({ forceChatBottom: true })
          .catch(() => {})
          .finally(() => {
            removePendingChatMessage(pendingId);
            render();
            requestAnimationFrame(focusChatInput);
          });
      } else {
        setTimeout(() => {
          removePendingChatMessage(pendingId);
          render();
          requestAnimationFrame(focusChatInput);
        }, 1800);
      }
    } catch (error) {
      removePendingChatMessage(pendingId);
      render();
      requestAnimationFrame(focusChatInput);
      alert(error.message);
    }
    return;
  }

  if (isSubmitting) return;
  isSubmitting = true;
  try {
    if (name === "login") {
      await api("/api/login", formData(form));
      await loadState();
    }
    if (name === "register") {
      await api("/api/register", formData(form));
      await loadState();
    }
    if (name === "question") {
      applyStatePayload(await api("/api/question", formData(form)));
    }
    if (name === "hint") {
      const result = await api("/api/hint", formData(form));
      form.reset();
      applyStatePayload(result);
    }
    if (name === "guess") {
      const result = await api("/api/guess", formData(form));
      if (!result.correct) form.reset();
      applyStatePayload(result);
    }
    if (name === "admin-host") {
      applyStatePayload(await api("/api/admin/host", formData(form)));
    }
  } catch (error) {
    alert(error.message);
  } finally {
    isSubmitting = false;
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    sendPresence();
    loadState({ forceRender: true });
  }
});

loadState();
