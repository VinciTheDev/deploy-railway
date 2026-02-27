const TOKEN_KEY = "evilazio_token";
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
  teste_pix_1_centavo: 5,
};

const btnLogin = document.getElementById("btnLogin");
const btnRegister = document.getElementById("btnRegister");
const btnAccount = document.getElementById("btnAccount");
const btnBooking = document.getElementById("btnBooking");
const btnPremium = document.getElementById("btnPremium");
const btnAdminSchedule = document.getElementById("btnAdminSchedule");
const btnLogout = document.getElementById("btnLogout");
const panelTitle = document.getElementById("panelTitle");
const panelSubtitle = document.getElementById("panelSubtitle");

const bookingSection = document.getElementById("bookingSection");
const serviceSelect = document.getElementById("serviceSelect");
const phoneInput = document.getElementById("phoneInput");
const daySelect = document.getElementById("daySelect");
const paymentMethodSelect = document.getElementById("paymentMethodSelect");
const slotGrid = document.getElementById("slotGrid");
const createPaymentBtn = document.getElementById("createPaymentBtn");
const switchToPixBtn = document.getElementById("switchToPixBtn");
const upgradePlanBtn = document.getElementById("upgradePlanBtn");
const planNotifyModal = document.getElementById("planNotifyModal");
const planNotifyText = document.getElementById("planNotifyText");
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
let currentUser = null;
let slotsRequestId = 0;
let isCreatingPayment = false;

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function authHeaders() {
  return {
    Authorization: `Bearer ${getToken()}`,
  };
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
  if (normalized === "teste pix (r$0,01)" || normalized === "teste pix 1 centavo") return "teste_pix_1_centavo";

  return "";
}

function getServiceDuration(service) {
  const key = normalizeServiceKey(service);
  return key ? SERVICE_DURATIONS[key] || null : null;
}

function setFeedback(message, type) {
  feedback.textContent = message;
  feedback.className = `feedback ${type}`;
}

function hidePlanNotifyModal() {
  planNotifyModal.classList.add("hidden");
}

function showPlanNotifyModal(message) {
  planNotifyText.textContent =
    message ||
    "Seus cortes gratuitos do Plano Comum neste mes acabaram. Escolha voltar para PIX ou aprimorar o plano.";
  planNotifyModal.classList.remove("hidden");
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

function updateServiceDurationInfo() {
  const duration = getServiceDuration(serviceSelect.value);
  serviceDurationInfo.textContent = duration ? `Tempo medio do servico: ${duration} minutos` : "";
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

  if (!day || !currentUser || currentUser.role === "admin") {
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
  const paymentMethod = paymentMethodSelect.value;

  if (!service || !phone || !day || !selectedTime) {
    setFeedback("Selecione servico, telefone, dia e horario.", "error");
    return;
  }

  isCreatingPayment = true;
  createPaymentBtn.disabled = true;

  try {
    const response = await fetch("/api/bookings/create-payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ day, time: selectedTime, service, phone, paymentMethod }),
    });

    const data = await response.json();

    if (!response.ok) {
      if (
        response.status === 402 &&
        paymentMethod === "plan" &&
        data.reason === "COMMON_PLAN_EXHAUSTED"
      ) {
        setFeedback("", "");
        showPlanNotifyModal();
        return;
      }
      hidePlanNotifyModal();
      setFeedback(data.message || "Nao foi possivel criar pagamento.", "error");
      return;
    }

    hidePlanNotifyModal();
    paymentService.textContent = service;
    paymentDuration.textContent = data.durationMinutes ? `${data.durationMinutes} minutos` : "-";

    if (paymentMethod === "plan") {
      paymentCard.classList.add("hidden");
      setFeedback(data.message || "Agendamento confirmado usando o plano.", "success");
      setPaymentFeedback("", "");
      selectedTime = "";
      await loadSlots();
      return;
    }

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

function toggleForLoggedOut() {
  panelTitle.textContent = "Painel inicial";
  panelSubtitle.textContent = "Conheca os servicos e entre para agendar.";
  btnLogin.classList.remove("hidden");
  btnRegister.classList.remove("hidden");
  btnAccount.classList.add("hidden");
  btnBooking.classList.add("hidden");
  btnPremium.classList.add("hidden");
  btnAdminSchedule.classList.add("hidden");
  btnLogout.classList.add("hidden");
  bookingSection.classList.add("hidden");
  paymentCard.classList.add("hidden");
  selectedTime = "";
  hidePlanNotifyModal();
}

function toggleForUser(user) {
  panelTitle.textContent = `Bem-vindo, ${user.name || user.username}`;
  panelSubtitle.textContent = "Escolha o servico, veja sua conta ou finalize um agendamento.";
  btnLogin.classList.add("hidden");
  btnRegister.classList.add("hidden");
  btnAccount.classList.remove("hidden");
  btnBooking.classList.remove("hidden");
  btnPremium.classList.remove("hidden");
  btnAdminSchedule.classList.add("hidden");
  btnLogout.classList.remove("hidden");
  phoneInput.value = user.phone || "";
}

function toggleForAdmin(user) {
  panelTitle.textContent = `Bem-vindo, ${user.name || user.username}`;
  panelSubtitle.textContent = "Acesse edicao de conta ou painel de cortes marcados.";
  btnLogin.classList.add("hidden");
  btnRegister.classList.add("hidden");
  btnAccount.classList.remove("hidden");
  btnBooking.classList.add("hidden");
  btnPremium.classList.add("hidden");
  btnAdminSchedule.classList.remove("hidden");
  btnLogout.classList.remove("hidden");
  bookingSection.classList.add("hidden");
  paymentCard.classList.add("hidden");
}

async function loadSession() {
  const token = getToken();

  if (!token) {
    toggleForLoggedOut();
    return;
  }

  const response = await fetch("/api/me", {
    headers: authHeaders(),
  });

  if (!response.ok) {
    localStorage.removeItem(TOKEN_KEY);
    toggleForLoggedOut();
    return;
  }

  const data = await response.json();
  currentUser = data.user;

  if (currentUser.role === "admin") {
    toggleForAdmin(currentUser);
    return;
  }

  toggleForUser(currentUser);
  buildDayOptions();
  updateServiceDurationInfo();
}

btnLogin.addEventListener("click", () => {
  window.location.href = "/login.html";
});

btnRegister.addEventListener("click", () => {
  window.location.href = "/login.html?tab=register";
});

btnAccount.addEventListener("click", () => {
  window.location.href = "/account.html";
});

btnBooking.addEventListener("click", async () => {
  bookingSection.classList.remove("hidden");
  if (currentUser?.phone) {
    phoneInput.value = currentUser.phone;
  }
  bookingSection.scrollIntoView({ behavior: "smooth", block: "start" });
  await loadSlots();
});

btnPremium.addEventListener("click", () => {
  window.location.href = "/premium.html";
});

btnAdminSchedule.addEventListener("click", () => {
  window.location.href = "/admin.html";
});

btnLogout.addEventListener("click", async () => {
  const token = getToken();

  if (token) {
    await fetch("/api/logout", {
      method: "POST",
      headers: authHeaders(),
    }).catch(() => {});
  }

  localStorage.removeItem(TOKEN_KEY);
  currentUser = null;
  hidePlanNotifyModal();
  toggleForLoggedOut();
});

switchToPixBtn.addEventListener("click", () => {
  paymentMethodSelect.value = "pix";
  hidePlanNotifyModal();
  setFeedback("Forma de pagamento alterada para PIX.", "success");
});

upgradePlanBtn.addEventListener("click", () => {
  window.location.href = "/premium.html";
});

serviceSelect.addEventListener("change", updateServiceDurationInfo);

daySelect.addEventListener("change", async () => {
  selectedTime = "";
  await loadSlots();
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

loadSession().catch(() => {
  toggleForLoggedOut();
});
