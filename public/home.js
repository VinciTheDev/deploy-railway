const TOKEN_KEY = "evilazio_token";
const logoutButton = document.getElementById("logoutBtn");
const welcomeText = document.getElementById("welcomeText");
const serviceSelect = document.getElementById("serviceSelect");
const phoneInput = document.getElementById("phoneInput");
const daySelect = document.getElementById("daySelect");
const slotGrid = document.getElementById("slotGrid");
const createPaymentBtn = document.getElementById("createPaymentBtn");
const serviceDurationInfo = document.getElementById("serviceDurationInfo");
const feedback = document.getElementById("feedback");
const paymentFeedback = document.getElementById("paymentFeedback");
const paymentCard = document.getElementById("paymentCard");
const pixQrImage = document.getElementById("pixQrImage");
const paymentService = document.getElementById("paymentService");
const paymentDuration = document.getElementById("paymentDuration");
const pixKey = document.getElementById("pixKey");
const copyPixKeyBtn = document.getElementById("copyPixKeyBtn");

let selectedTime = "";
let slotsRequestId = 0;
let isCreatingPayment = false;
const SERVICE_DURATIONS = {
  corte_social: 30,
  corte_tradicional: 30,
  corte_degrade: 35,
  corte_navalhado: 40,
  barba: 15,
  sobrancelha: 10,
  pezinho: 20,
  corte_barba: 45,
  corte_barba_sobrancelha: 50,
};

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

function setPaymentFeedback(message, type) {
  paymentFeedback.textContent = message;
  paymentFeedback.className = `feedback ${type}`;
}

async function copyText(text) {
  if (!text) {
    return false;
  }

  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  return copied;
}

function normalizeServiceKey(service) {
  const normalized = String(service || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  if (normalized === "corte social") return "corte_social";
  if (normalized === "corte tradicional") return "corte_tradicional";
  if (normalized === "corte degrade") return "corte_degrade";
  if (normalized === "corte navalhado") return "corte_navalhado";
  if (normalized === "barba") return "barba";
  if (normalized === "sobrancelha") return "sobrancelha";
  if (normalized === "pezinho") return "pezinho";
  if (normalized === "corte + barba") return "corte_barba";
  if (normalized === "corte + barba + sobrancelha") return "corte_barba_sobrancelha";

  return "";
}

function getServiceDuration(service) {
  const key = normalizeServiceKey(service);
  return key ? SERVICE_DURATIONS[key] || null : null;
}

function updateServiceDurationInfo() {
  const service = serviceSelect.value;
  const duration = getServiceDuration(service);

  if (!duration) {
    serviceDurationInfo.textContent = "";
    return;
  }

  serviceDurationInfo.textContent = `Tempo médio do servico: ${duration} minutos`;
}

function buildDayOptions() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const today = now.getDate();
  const lastDay = new Date(year, month, 0).getDate();

  daySelect.innerHTML = "";

  for (let day = today; day <= lastDay; day += 1) {
    const value = String(day).padStart(2, "0");
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    daySelect.appendChild(option);
  }
}

async function loadUser() {
  const token = getToken();

  if (!token) {
    window.location.href = "/";
    return null;
  }

  const response = await fetch("/api/me", {
    headers: authHeaders(),
  });

  if (!response.ok) {
    localStorage.removeItem(TOKEN_KEY);
    window.location.href = "/";
    return null;
  }

  const data = await response.json();

  if (data.user.role === "admin") {
    window.location.href = "/admin.html";
    return null;
  }

  const displayName = data.user.name || data.user.username || "cliente";
  welcomeText.textContent = `Bem-vindo, ${displayName}.`;
  return data.user;
}

function renderSlots(slots) {
  slotGrid.innerHTML = "";

  slots.forEach((slot) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "slot-btn";
    button.dataset.time = slot.time;

    if (slot.status === "available") {
      button.textContent = slot.time;
      button.classList.add("available");
      if (slot.time === selectedTime) {
        button.classList.add("selected");
      }
      button.addEventListener("click", () => {
        selectedTime = slot.time;
        setFeedback(`Horario selecionado: ${slot.time}`, "success");
        loadSlots();
      });
    } else if (slot.status === "pending_payment") {
      button.textContent = `${slot.time} - pendente`;
      button.classList.add("pending");
      button.disabled = true;
    } else {
      button.textContent = `${slot.time} - ocupado`;
      button.classList.add("booked");
      button.disabled = true;
    }

    slotGrid.appendChild(button);
  });
}

async function loadSlots() {
  const day = daySelect.value;

  if (!day) {
    return;
  }
  const requestId = ++slotsRequestId;

  try {
    const response = await fetch(`/api/schedule/day?day=${encodeURIComponent(day)}`, {
      headers: authHeaders(),
    });
    const data = await response.json();

    if (requestId !== slotsRequestId) {
      return;
    }

    if (!response.ok) {
      setFeedback(data.message || "Nao foi possivel carregar horarios.", "error");
      return;
    }

    if (!data.slots.some((slot) => slot.time === selectedTime && slot.status === "available")) {
      selectedTime = "";
    }

    renderSlots(data.slots);
  } catch (_error) {
    if (requestId === slotsRequestId) {
      setFeedback("Erro de conexao ao carregar horarios.", "error");
    }
  }
}

async function createPayment() {
  if (isCreatingPayment) {
    return;
  }

  const day = daySelect.value;
  const service = serviceSelect.value;
  const phone = phoneInput.value.trim();

  if (!service || !phone || !day || !selectedTime) {
    setFeedback("Selecione servico, telefone, dia e horario.", "error");
    return;
  }

  isCreatingPayment = true;
  createPaymentBtn.disabled = true;
  setFeedback("Gerando pagamento PIX...", "");

  try {
    const response = await fetch("/api/bookings/create-payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({
        day,
        time: selectedTime,
        service,
        phone,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      setFeedback(data.message || "Nao foi possivel criar pagamento.", "error");
      return;
    }

    const fallbackDuration = getServiceDuration(service);
    paymentService.textContent = service;
    paymentDuration.textContent = data.durationMinutes
      ? `${data.durationMinutes} minutos`
      : fallbackDuration
        ? `${fallbackDuration} minutos`
        : "-";
    pixQrImage.src = data.payment.qrImageUrl;
    pixKey.textContent = data.payment.pixKey;
    paymentCard.classList.remove("hidden");
    setFeedback(data.message, "success");
    setPaymentFeedback("Pagamento recebido. A confirmacao do agendamento ocorre automaticamente.", "");
    await loadSlots();
  } catch (_error) {
    setFeedback("Erro de conexao com o servidor.", "error");
  } finally {
    isCreatingPayment = false;
    createPaymentBtn.disabled = false;
  }
}

logoutButton.addEventListener("click", async () => {
  const token = getToken();

  if (token) {
    await fetch("/api/logout", {
      method: "POST",
      headers: authHeaders(),
    }).catch(() => {});
  }

  localStorage.removeItem(TOKEN_KEY);
  window.location.href = "/";
});

daySelect.addEventListener("change", () => {
  selectedTime = "";
  loadSlots();
});

serviceSelect.addEventListener("change", () => {
  updateServiceDurationInfo();
});

createPaymentBtn.addEventListener("click", () => {
  createPayment();
});

copyPixKeyBtn.addEventListener("click", () => {
  copyText(pixKey.textContent.trim())
    .then((ok) => {
      setPaymentFeedback(ok ? "Chave PIX copiada." : "Nao foi possivel copiar a chave PIX.", ok ? "success" : "error");
    })
    .catch(() => {
      setPaymentFeedback("Nao foi possivel copiar a chave PIX.", "error");
    });
});

(async () => {
  const user = await loadUser();
  if (!user) {
    return;
  }

  buildDayOptions();
  updateServiceDurationInfo();
  await loadSlots();
})();
