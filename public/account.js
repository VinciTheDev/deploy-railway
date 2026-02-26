const TOKEN_KEY = "evilazio_token";
const form = document.getElementById("accountForm");
const usernameInput = document.getElementById("usernameInput");
const displayNameInput = document.getElementById("displayNameInput");
const phoneInput = document.getElementById("phoneInput");
const passwordInput = document.getElementById("passwordInput");
const feedback = document.getElementById("accountFeedback");
const backBtn = document.getElementById("backBtn");
const buyPlusBtn = document.getElementById("buyPlusBtn");
const planInfo = document.getElementById("planInfo");

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function authHeaders() {
  return {
    Authorization: `Bearer ${getToken()}`,
  };
}

function setFeedback(message, type) {
  feedback.textContent = message;
  feedback.className = `feedback ${type}`;
}

async function loadMe() {
  const token = getToken();

  if (!token) {
    window.location.href = "/login.html";
    return null;
  }

  const response = await fetch("/api/me", {
    headers: authHeaders(),
  });

  if (!response.ok) {
    localStorage.removeItem(TOKEN_KEY);
    window.location.href = "/login.html";
    return null;
  }

  const data = await response.json();
  usernameInput.value = data.user.username || "";
  displayNameInput.value = data.user.name || "";
  phoneInput.value = data.user.phone || "";
  if (data.user.plan?.type === "plus") {
    planInfo.textContent = "Plano Plus";
  } else if (data.user.plan?.type === "common") {
    const cut = data.user.plan?.preferredCut ? ` (${data.user.plan.preferredCut})` : "";
    planInfo.textContent = `Plano Comum${cut}`;
  } else {
    planInfo.textContent = "Sem plano";
  }

  return data.user;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = {
    displayName: displayNameInput.value.trim(),
    phone: phoneInput.value.trim(),
  };

  const newPassword = passwordInput.value.trim();
  if (newPassword) {
    payload.password = newPassword;
  }

  const response = await fetch("/api/profile", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    setFeedback(data.message || "Nao foi possivel atualizar conta.", "error");
    return;
  }

  passwordInput.value = "";
  setFeedback("Conta atualizada com sucesso.", "success");
});

backBtn.addEventListener("click", () => {
  window.location.href = "/";
});

buyPlusBtn.addEventListener("click", () => {
  window.location.href = "/premium.html";
});

loadMe().catch(() => {
  setFeedback("Erro de conexao com o servidor.", "error");
});
