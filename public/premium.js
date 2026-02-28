const TOKEN_KEY = "evilazio_token";
const currentPlan = document.getElementById("currentPlan");
const commonDetails = document.getElementById("commonDetails");
const plusDetails = document.getElementById("plusDetails");
const planTypeSelect = document.getElementById("planTypeSelect");
const createPlanPaymentBtn = document.getElementById("createPlanPaymentBtn");
const backBtn = document.getElementById("backBtn");
const feedback = document.getElementById("premiumFeedback");
const planPaymentCard = document.getElementById("planPaymentCard");
const planPaymentFeedback = document.getElementById("planPaymentFeedback");
const planPixQrImage = document.getElementById("planPixQrImage");
const planPixKey = document.getElementById("planPixKey");
const planPixProviderInfo = document.getElementById("planPixProviderInfo");
const copyPlanPixKeyBtn = document.getElementById("copyPlanPixKeyBtn");
const planPixTicketLink = document.getElementById("planPixTicketLink");
const planName = document.getElementById("planName");
const planAmount = document.getElementById("planAmount");

let loadedPlans = null;
let isCreatingPlanPayment = false;
let pendingPurchaseId = null;
let pendingPurchaseExpiresAt = null;
let planRefreshTimer = null;
let planRefreshStopTimer = null;

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

function setPlanPaymentFeedback(message, type) {
  planPaymentFeedback.textContent = message;
  planPaymentFeedback.className = `feedback ${type}`;
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

function formatMoney(value) {
  return `R$ ${Number(value).toFixed(2).replace(".", ",")}`;
}

function stopPlanAutoRefresh() {
  if (planRefreshTimer) {
    clearInterval(planRefreshTimer);
    planRefreshTimer = null;
  }
  if (planRefreshStopTimer) {
    clearTimeout(planRefreshStopTimer);
    planRefreshStopTimer = null;
  }
}

function getPlanRefreshStopMs(expiresAt) {
  const parsed = expiresAt ? new Date(expiresAt).getTime() : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return 120000;
  }
  const remaining = parsed - Date.now();
  return Math.max(5000, Math.min(remaining + 15000, 30 * 60 * 1000));
}

function updateCurrentPlanLabel(plan) {
  if (plan?.type === "plus") {
    currentPlan.textContent = "Plano Plus";
  } else if (plan?.type === "common") {
    const cut = plan.preferredCut ? ` (${plan.preferredCut})` : "";
    currentPlan.textContent = `Plano Comum${cut}`;
  } else {
    currentPlan.textContent = "Sem plano";
  }
}

async function checkPlanPurchaseStatus() {
  if (!pendingPurchaseId) {
    return;
  }

  const response = await fetch(`/api/plans/purchases/${pendingPurchaseId}/status`, {
    headers: authHeaders(),
  });
  const data = await response.json();

  if (!response.ok) {
    return;
  }

  if (data.status === "confirmed") {
    const plansResponse = await fetch("/api/plans", {
      headers: authHeaders(),
    });
    const plansData = await plansResponse.json();
    if (plansResponse.ok) {
      updateCurrentPlanLabel(plansData.userPlan);
    }

    setPlanPaymentFeedback("Pagamento PIX aprovado. Plano ativado com sucesso.", "success");
    pendingPurchaseId = null;
    pendingPurchaseExpiresAt = null;
    stopPlanAutoRefresh();
    return;
  }

  if (data.status === "expired") {
    setPlanPaymentFeedback("Pagamento expirado. Gere um novo PIX para ativar o plano.", "error");
    pendingPurchaseId = null;
    pendingPurchaseExpiresAt = null;
    stopPlanAutoRefresh();
  }
}

function startPlanAutoRefresh() {
  stopPlanAutoRefresh();
  const tick = () => {
    checkPlanPurchaseStatus().catch(() => {});
  };
  tick();
  planRefreshTimer = setInterval(tick, 5000);
  planRefreshStopTimer = setTimeout(() => {
    stopPlanAutoRefresh();
  }, getPlanRefreshStopMs(pendingPurchaseExpiresAt));
}

async function loadPlans() {
  if (!getToken()) {
    window.location.href = "/login.html";
    return;
  }

  const response = await fetch("/api/plans", {
    headers: authHeaders(),
  });

  const data = await response.json();

  if (!response.ok) {
    setFeedback(data.message || "Nao foi possivel carregar planos.", "error");
    return;
  }

  loadedPlans = data.plans;

  updateCurrentPlanLabel(data.userPlan);

  commonDetails.textContent = `Inclui ${data.plans.common.monthlyFreeCuts} cortes de cabelo por mes por ${formatMoney(data.plans.common.monthlyPrice)}.`;
  plusDetails.textContent = `Cobertura completa por ${formatMoney(data.plans.plus.monthlyPrice)}/mes.`;
}

createPlanPaymentBtn.addEventListener("click", async () => {
  if (isCreatingPlanPayment) {
    return;
  }

  const planType = planTypeSelect.value;
  isCreatingPlanPayment = true;
  createPlanPaymentBtn.disabled = true;

  try {
    const response = await fetch("/api/plans/create-payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ planType }),
    });

    const data = await response.json();

    if (!response.ok) {
      setFeedback(data.message || "Nao foi possivel gerar pagamento do plano.", "error");
      return;
    }

    pendingPurchaseId = data.purchaseId || null;
    pendingPurchaseExpiresAt = data.payment?.expiresAt || null;
    planName.textContent = data.planType === "plus" ? "Plano Plus" : "Plano Comum";
    planAmount.textContent = formatMoney(data.amount);
    planPixQrImage.src = data.payment.qrImageUrl;
    planPixKey.textContent = data.payment.pixKey;
    planPixProviderInfo.textContent =
      data.payment?.provider === "mercadopago" ? "Pagamento processado por Mercado Pago." : "Pagamento em modo local.";
    if (data.payment?.ticketUrl) {
      planPixTicketLink.href = data.payment.ticketUrl;
      planPixTicketLink.classList.remove("hidden");
    } else {
      planPixTicketLink.href = "#";
      planPixTicketLink.classList.add("hidden");
    }
    planPaymentCard.classList.remove("hidden");
    setFeedback(data.message, "success");
    setPlanPaymentFeedback("Pagamento em analise. O plano ativa automaticamente apos compensacao PIX.", "");
    startPlanAutoRefresh();
  } catch (_error) {
    setFeedback("Erro de conexao com o servidor.", "error");
  } finally {
    isCreatingPlanPayment = false;
    createPlanPaymentBtn.disabled = false;
  }
});

copyPlanPixKeyBtn.addEventListener("click", () => {
  copyText(planPixKey.textContent.trim())
    .then((ok) => {
      setPlanPaymentFeedback(ok ? "Codigo PIX copiado." : "Nao foi possivel copiar o codigo PIX.", ok ? "success" : "error");
    })
    .catch(() => {
      setPlanPaymentFeedback("Nao foi possivel copiar o codigo PIX.", "error");
    });
});

backBtn.addEventListener("click", () => {
  stopPlanAutoRefresh();
  window.location.href = "/";
});

loadPlans().catch(() => {
  setFeedback("Erro de conexao com o servidor.", "error");
});
