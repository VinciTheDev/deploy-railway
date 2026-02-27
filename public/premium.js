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
const copyPlanPixKeyBtn = document.getElementById("copyPlanPixKeyBtn");
const planName = document.getElementById("planName");
const planAmount = document.getElementById("planAmount");

let loadedPlans = null;
let isCreatingPlanPayment = false;

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

    planName.textContent = data.planType === "plus" ? "Plano Plus" : "Plano Comum";
    planAmount.textContent = formatMoney(data.amount);
    planPixQrImage.src = data.payment.qrImageUrl;
    planPixKey.textContent = data.payment.pixKey;
    planPaymentCard.classList.remove("hidden");
    setFeedback(data.message, "success");
    setPlanPaymentFeedback("Pagamento recebido. A ativacao do plano ocorre automaticamente.", "");
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
      setPlanPaymentFeedback(ok ? "Chave PIX copiada." : "Nao foi possivel copiar a chave PIX.", ok ? "success" : "error");
    })
    .catch(() => {
      setPlanPaymentFeedback("Nao foi possivel copiar a chave PIX.", "error");
    });
});

backBtn.addEventListener("click", () => {
  window.location.href = "/";
});

loadPlans().catch(() => {
  setFeedback("Erro de conexao com o servidor.", "error");
});
