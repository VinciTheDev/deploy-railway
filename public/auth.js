const TOKEN_KEY = "evilazio_token";
const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");
const switchButtons = document.querySelectorAll(".switch-btn");
const feedback = document.getElementById("authFeedback");
const loginSubmitBtn = loginForm.querySelector('button[type="submit"]');
const registerSubmitBtn = registerForm.querySelector('button[type="submit"]');
let isSubmittingLogin = false;
let isSubmittingRegister = false;

function setFeedback(message, type) {
  feedback.textContent = message;
  feedback.className = `feedback ${type}`;
}

function toggleForm(target) {
  const isLogin = target === "login";
  loginForm.classList.toggle("hidden", !isLogin);
  registerForm.classList.toggle("hidden", isLogin);

  switchButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.target === target);
  });

  setFeedback("", "");
}

async function checkExistingSession() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    return;
  }

  const response = await fetch("/api/me", {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.ok) {
    window.location.href = "/";
    return;
  }

  localStorage.removeItem(TOKEN_KEY);
}

switchButtons.forEach((button) => {
  button.addEventListener("click", () => {
    toggleForm(button.dataset.target);
  });
});

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isSubmittingRegister) {
    return;
  }

  isSubmittingRegister = true;
  registerSubmitBtn.disabled = true;
  setFeedback("Enviando...", "");

  const payload = Object.fromEntries(new FormData(registerForm).entries());

  try {
    const response = await fetch("/api/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      setFeedback(data.message || "Nao foi possivel registrar.", "error");
      return;
    }

    setFeedback("Conta criada. Faca login.", "success");
    registerForm.reset();
    toggleForm("login");
  } catch (_error) {
    setFeedback("Erro de conexao.", "error");
  } finally {
    isSubmittingRegister = false;
    registerSubmitBtn.disabled = false;
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isSubmittingLogin) {
    return;
  }

  isSubmittingLogin = true;
  loginSubmitBtn.disabled = true;
  setFeedback("Entrando...", "");

  const payload = Object.fromEntries(new FormData(loginForm).entries());

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      setFeedback(data.message || "Nao foi possivel entrar.", "error");
      return;
    }

    localStorage.setItem(TOKEN_KEY, data.token);
    window.location.href = "/";
  } catch (_error) {
    setFeedback("Erro de conexao.", "error");
  } finally {
    isSubmittingLogin = false;
    loginSubmitBtn.disabled = false;
  }
});

const query = new URLSearchParams(window.location.search);
if (query.get("tab") === "register") {
  toggleForm("register");
}

checkExistingSession();
