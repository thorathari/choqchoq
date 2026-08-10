let state = null;
let statePollHandle = null;
let authMode = "login";
let rankMode = "day";
let tickHandle = null;
let theme = localStorage.getItem("choqchoq-theme") || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
let isSubmitting = false;

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

function applyStatePayload(payload) {
  if (!payload?.state) return false;
  state = payload.state;
  render();
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
  const shouldRender = options.forceRender || !isEditingForm() || didCriticalGameSurfaceChange(state, nextState);
  state = nextState;
  if (!shouldRender) {
    updateTimers();
    if (state.me) connectEvents();
    return;
  }
  render();
  if (state.me) connectEvents();
}

function didCriticalGameSurfaceChange(previous, next) {
  if (!previous || !next) return true;
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

function connectEvents() {
  if (statePollHandle) return;
  statePollHandle = setInterval(loadState, 800);
}

function disconnectEvents() {
  if (statePollHandle) clearInterval(statePollHandle);
  statePollHandle = null;
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

function formatTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function currentDeadline() {
  if (!state?.game) return null;
  if (state.game.phase === "countdown") return state.game.countdownEndsAt;
  if (state.game.phase === "active") return state.game.lastGuessDeadlineAt || state.game.firstGuessDeadlineAt;
  return null;
}

function render() {
  clearInterval(tickHandle);
  if (!state?.me) {
    renderAuth();
    return;
  }
  renderGame();
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
          <span>초성퀴즈 게임방</span>
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
            <span>초성퀴즈 게임방</span>
          </div>
        </div>
        <div class="userbar">
          <span class="badge ${state.me.role === "admin" ? "admin" : ""}">${escapeHtml(state.me.nickname)}${state.me.role === "admin" ? " 관리자" : ""}</span>
          ${statusButtons(state.me.status, "self-status")}
          <button class="icon-button" data-action="theme" title="테마 전환">${theme === "dark" ? "밝은모드" : "다크모드"}</button>
          <button data-action="logout">로그아웃</button>
        </div>
      </header>
      <div class="layout">
        <section class="main-column">
          ${gamePanel()}
          ${chatPanel()}
          ${activityPanel()}
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
        ${game.lastSystemMessage ? `<div class="message">${escapeHtml(game.lastSystemMessage)}</div>` : ""}
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
  const title = needed > 0 ? `참여 상태 ${count}/2명` : "시작 준비 중";
  const guide = isPlaying
    ? needed > 0
      ? `게임 시작까지 ${needed}명이 더 필요합니다.`
      : "곧 게임이 시작됩니다."
    : "오른쪽 위 상태를 참여로 바꾸면 게임 시작 조건에 포함됩니다.";

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
  if (!isHost) {
    return html`
      <div class="problem">
        <div class="chosung">출제 준비 중</div>
        <p class="muted">출제자가 분류와 정답을 입력하고 있습니다.</p>
      </div>
    `;
  }

  return html`
    <form class="form" data-form="question">
      <div class="grid-2">
        <div class="form-row">
          <label>분류</label>
          <input name="category" placeholder="사물" maxlength="20" required />
        </div>
        <div class="form-row">
          <label>정답</label>
          <input name="answer" placeholder="지우개" maxlength="30" required />
        </div>
      </div>
      <div class="actions">
        <button class="primary" type="submit">문제 내기</button>
        <button class="warning" type="button" data-action="transfer">출제권 양도</button>
      </div>
    </form>
  `;
}

function activeView(isHost) {
  const game = state.game;
  return html`
    <div class="problem">
      <div class="chosung"><span class="category">${escapeHtml(game.category)}</span><span>${escapeHtml(game.chosung)}</span></div>
      ${isHost ? hostTools() : guessTools()}
    </div>
  `;
}

function hostTools() {
  return html`
    <form class="form" data-form="hint">
      <div class="form-row">
        <label>힌트</label>
        <input name="text" maxlength="80" placeholder="자유 힌트" required />
      </div>
      <div class="actions">
        <button class="primary" type="submit">힌트 주기</button>
        <button type="button" data-action="reissue">리문</button>
        <button class="warning" type="button" data-action="transfer">출제권 양도</button>
      </div>
    </form>
  `;
}

function guessTools() {
  const game = state.game;
  const alreadyRequested = game.reissueRequests.includes(state.me.id);
  const reissueDisabled = !game.reissueEnabled || alreadyRequested || state.me.status !== "playing";
  if (!game.canGuess) {
    return html`
      <div class="message ${game.guessBlockedReason ? "danger-text" : ""}">
        ${escapeHtml(game.guessBlockedReason || "현재 상태에서는 정답을 제출할 수 없습니다.")}
      </div>
      <div class="actions">
        <button type="button" data-action="reissue-request" ${reissueDisabled ? "disabled" : ""}>리문요청 ${game.reissueRequestCount}/3</button>
      </div>
    `;
  }

  return html`
    <form class="form" data-form="guess">
      <div class="form-row">
        <label>정답</label>
        <input name="answer" maxlength="40" autocomplete="off" required />
      </div>
      <div class="actions">
        <button class="primary" type="submit">정답 제출</button>
        <button type="button" data-action="reissue-request" ${reissueDisabled ? "disabled" : ""}>리문요청 ${game.reissueRequestCount}/3</button>
      </div>
    </form>
  `;
}

function activityPanel() {
  const hints = state.game.hints || [];
  const guesses = state.game.guesses || [];
  return html`
    <section class="panel">
      <div class="panel-header">
        <h2>힌트와 답변</h2>
      </div>
      <div class="panel-body grid-2">
        <div>
          <h3>힌트</h3>
          ${hints.length ? `<ul class="log-list">${hints.map((hint) => `<li class="log-item">${escapeHtml(hint.text)}</li>`).join("")}</ul>` : `<div class="empty">아직 힌트가 없습니다.</div>`}
        </div>
        <div>
          <h3>답변</h3>
          ${guesses.length ? `<ul class="log-list">${guesses.slice().reverse().map((guess) => `<li class="log-item"><strong>${escapeHtml(guess.nickname)}</strong> ${escapeHtml(guess.answer)}${guess.correct ? " <span class=\"badge playing\">정답</span>" : ""}</li>`).join("")}</ul>` : `<div class="empty">아직 답변이 없습니다.</div>`}
        </div>
      </div>
    </section>
  `;
}

function chatPanel() {
  const messages = state.chatMessages || [];
  return html`
    <section class="panel chat-panel">
      <div class="panel-header">
        <h2>대화</h2>
        <span class="badge">${messages.length}개</span>
      </div>
      <div class="panel-body chat-body">
        <div class="chat-list">
          ${messages.length ? messages.map(chatMessage).join("") : `<div class="empty">아직 대화가 없습니다.</div>`}
        </div>
        <form class="chat-form" data-form="chat">
          <input name="text" maxlength="300" autocomplete="off" placeholder="메시지 입력" required />
          <button class="primary" type="submit">전송</button>
        </form>
      </div>
    </section>
  `;
}

function chatMessage(message) {
  const mine = state.me && message.userId === state.me.id;
  return html`
    <div class="chat-message ${mine ? "mine" : ""}">
      <div class="chat-meta">
        <strong>${escapeHtml(message.nickname)}</strong>
        ${message.role === "admin" ? `<span class="badge admin">관리자</span>` : ""}
      </div>
      <div class="chat-bubble">${escapeHtml(message.text)}</div>
    </div>
  `;
}

function usersPanel() {
  return html`
    <section class="panel">
      <div class="panel-header">
        <h2>참여자 목록</h2>
        <span class="badge playing">${state.game.playerCount}명 참여</span>
      </div>
      <div class="panel-body">
        <ul class="user-list">
          ${state.users.map(userItem).join("")}
        </ul>
      </div>
    </section>
  `;
}

function userItem(user) {
  const isHost = user.id === state.game.hostId;
  const isBan = user.id === state.game.answerBanUserId;
  const canAdmin = state.me.role === "admin";
  return html`
    <li class="user-item">
      <div>
        <div class="user-name">${escapeHtml(user.nickname)}</div>
        <div class="status-line">
          <span class="badge ${user.status}">${statusLabels[user.status]}</span>
          ${isHost ? `<span class="badge host">출제자</span>` : ""}
          ${user.role === "admin" ? `<span class="badge admin">관리자</span>` : ""}
          ${isBan ? `<span class="badge away">제한</span>` : ""}
        </div>
      </div>
      <div class="user-controls">
        ${canAdmin ? statusButtons(user.status, "admin-status", user.id) : ""}
      </div>
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
    <section class="panel">
      <div class="panel-header">
        <h2>관리자</h2>
      </div>
      <div class="panel-body form">
        <form class="admin-grid" data-form="admin-host">
          <select name="userId" required>
            <option value="">출제자 선택</option>
            ${playerOptions}
          </select>
          <button class="primary" type="submit">출제자 변경</button>
        </form>
        <div class="grid-2">
          ${state.users.map((user) => html`
            <div class="user-item">
              <div>
                <div class="user-name">${escapeHtml(user.nickname)}</div>
                <span class="badge ${user.role === "admin" ? "admin" : ""}">${user.role === "admin" ? "관리자" : "일반"}</span>
              </div>
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

function statusButtons(selected, action, userId = "") {
  return html`
    <div class="status-buttons" role="group" aria-label="상태 변경">
      ${Object.entries(statusLabels).map(([value, label]) => `
        <button
          type="button"
          class="status-button ${selected === value ? "active" : ""}"
          data-action="${action}"
          data-status="${value}"
          ${userId ? `data-user-id="${userId}"` : ""}
          ${selected === value ? "disabled" : ""}
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

app.addEventListener("click", async (event) => {
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

app.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const name = form.dataset.form;
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
    if (name === "chat") {
      const result = await api("/api/chat", formData(form));
      form.reset();
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

loadState();
