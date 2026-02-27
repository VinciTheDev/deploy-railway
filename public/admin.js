const TOKEN_KEY = "evilazio_token";
const logoutButton = document.getElementById("logoutBtn");
const daySelect = document.getElementById("daySelect");
const adminRows = document.getElementById("adminRows");
const adminFeedback = document.getElementById("adminFeedback");
const cancellingBookings = new Set();

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function authHeaders() {
  return {
    Authorization: `Bearer ${getToken()}`,
  };
}

function setFeedback(message, type) {
  adminFeedback.textContent = message;
  adminFeedback.className = `feedback ${type}`;
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

async function loadMe() {
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

  if (data.user.role !== "admin") {
    window.location.href = "/home.html";
    return null;
  }

  return data.user;
}

function renderRows(slots) {
  adminRows.innerHTML = "";

  slots.forEach((slot) => {
    const tr = document.createElement("tr");

    const time = document.createElement("td");
    time.textContent = slot.time;

    const status = document.createElement("td");
    if (slot.status === "available") {
      status.textContent = "Livre";
    } else if (slot.status === "pending_payment") {
      status.textContent = "Pendente";
    } else {
      status.textContent = "Pago";
    }

    const client = document.createElement("td");
    client.textContent = slot.booking ? slot.booking.displayName : "-";

    const service = document.createElement("td");
    service.textContent = slot.booking ? slot.booking.service : "-";

    const duration = document.createElement("td");
    duration.textContent = slot.booking?.durationMinutes
      ? `${slot.booking.durationMinutes} min`
      : "-";

    const phone = document.createElement("td");
    phone.textContent = slot.booking ? slot.booking.phone : "-";

    const actions = document.createElement("td");
    if (slot.booking && ["pending_payment", "confirmed"].includes(slot.status)) {
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "outline-btn";
      cancelBtn.textContent = cancellingBookings.has(slot.booking.id) ? "Cancelando..." : "Cancelar";
      cancelBtn.disabled = cancellingBookings.has(slot.booking.id);
      cancelBtn.addEventListener("click", () => {
        cancelBooking(slot.booking.id).catch(() => {
          setFeedback("Erro de conexao com o servidor.", "error");
        });
      });
      actions.appendChild(cancelBtn);
    } else {
      actions.textContent = "-";
    }

    tr.appendChild(time);
    tr.appendChild(status);
    tr.appendChild(client);
    tr.appendChild(service);
    tr.appendChild(duration);
    tr.appendChild(phone);
    tr.appendChild(actions);

    adminRows.appendChild(tr);
  });
}

async function cancelBooking(bookingId) {
  if (!Number.isInteger(bookingId) || cancellingBookings.has(bookingId)) {
    return;
  }

  cancellingBookings.add(bookingId);
  await loadSchedule();

  const response = await fetch(`/api/admin/bookings/${bookingId}/cancel`, {
    method: "POST",
    headers: authHeaders(),
  });

  const data = await response.json();

  if (!response.ok) {
    cancellingBookings.delete(bookingId);
    await loadSchedule();
    setFeedback(data.message || "Nao foi possivel cancelar agendamento.", "error");
    return;
  }

  cancellingBookings.delete(bookingId);
  await loadSchedule();
  setFeedback(data.message || "Agendamento cancelado.", "success");
}

async function loadSchedule() {
  const day = daySelect.value;

  if (!day) {
    return;
  }

  const response = await fetch(`/api/admin/schedule?day=${encodeURIComponent(day)}`, {
    headers: authHeaders(),
  });

  const data = await response.json();

  if (!response.ok) {
    setFeedback(data.message || "Nao foi possivel carregar planilha.", "error");
    return;
  }

  renderRows(data.slots);
  setFeedback("Planilha atualizada.", "success");
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
  loadSchedule().catch(() => {
    setFeedback("Erro de conexao com o servidor.", "error");
  });
});

(async () => {
  const user = await loadMe();
  if (!user) {
    return;
  }

  buildDayOptions();
  await loadSchedule();
})();
