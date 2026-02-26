const TOKEN_KEY = "evilazio_token";
const currentPlan = document.getElementById("currentPlan");
const commonDetails = document.getElementById("commonDetails");
const plusDetails = document.getElementById("plusDetails");
const planTypeSelect = document.getElementById("planTypeSelect");
const createPlanPaymentBtn = document.getElementById("createPlanPaymentBtn");
const confirmPlanPaymentBtn = document.getElementById("confirmPlanPaymentBtn");
const backBtn = document.getElementById("backBtn");
const feedback = document.getElementById("premiumFeedback");
const planPaymentCard = document.getElementById("planPaymentCard");
const planPaymentFeedback = document.getElementById("planPaymentFeedback");
const planPixQrImage = document.getElementById("planPixQrImage");
const planPixKey = document.getElementById("planPixKey");
const planPixCode = document.getElementById("planPixCode");
const planName = document.getElementById("planName");
const planAmount = document.getElementById("planAmount");

let pendingPurchaseId = null;
let loadedPlans = null;
let isCreatingPlanPayment = false;
let isConfirmingPlanPayment = false;

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

function formatMoney(value) {
  return `R$ ${Number(value).toFixed(2).replace(".", ",")}`;
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

  if (data.userPlan?.type === "plus") {
    currentPlan.textContent = "Plano Plus";
  } else if (data.userPlan?.type === "common") {
    const cut = data.userPlan.preferredCut ? ` (${data.userPlan.preferredCut})` : "";
    currentPlan.textContent = `Plano Comum${cut}`;
  } else {
    currentPlan.textContent = "Sem plano";
  }

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

    pendingPurchaseId = data.purchaseId;
    planName.textContent = data.planType === "plus" ? "Plano Plus" : "Plano Comum";
    planAmount.textContent = formatMoney(data.amount);
    planPixQrImage.src = data.payment.qrImageUrl;
    planPixKey.textContent = data.payment.pixKey;
    planPixCode.textContent = data.payment.paymentCode;
    planPaymentCard.classList.remove("hidden");
    setFeedback(data.message, "success");
    setPlanPaymentFeedback("Aguardando confirmacao de pagamento.", "");
  } catch (_error) {
    setFeedback("Erro de conexao com o servidor.", "error");
  } finally {
    isCreatingPlanPayment = false;
    createPlanPaymentBtn.disabled = false;
  }
});

confirmPlanPaymentBtn.addEventListener("click", async () => {
  if (isConfirmingPlanPayment) {
    return;
  }

  if (!pendingPurchaseId) {
    setPlanPaymentFeedback("Nao ha compra pendente para confirmar.", "error");
    return;
  }
  isConfirmingPlanPayment = true;
  confirmPlanPaymentBtn.disabled = true;

  try {
    const response = await fetch("/api/plans/confirm-payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ purchaseId: pendingPurchaseId }),
    });

    const data = await response.json();

    if (!response.ok) {
      setPlanPaymentFeedback(data.message || "Nao foi possivel confirmar o plano.", "error");
      return;
    }

    pendingPurchaseId = null;
    setPlanPaymentFeedback(data.message, "success");
    if (data.user?.plan?.type === "plus") {
      currentPlan.textContent = "Plano Plus";
    } else if (data.user?.plan?.type === "common") {
      const cut = data.user.plan.preferredCut ? ` (${data.user.plan.preferredCut})` : "";
      currentPlan.textContent = `Plano Comum${cut}`;
    }
  } catch (_error) {
    setPlanPaymentFeedback("Erro de conexao com o servidor.", "error");
  } finally {
    isConfirmingPlanPayment = false;
    confirmPlanPaymentBtn.disabled = false;
  }
});

backBtn.addEventListener("click", () => {
  window.location.href = "/";
});

loadPlans().catch(() => {
  setFeedback("Erro de conexao com o servidor.", "error");
});
