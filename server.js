const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");

const app = express();
const PORT = process.env.PORT || 3000;
const scryptAsync = promisify(crypto.scrypt);

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "001212";
let useMemoryUserStore = false;
let memoryUsers = [];

const SLOT_TIMES = Array.from({ length: 12 }, (_, index) => {
  const hour = 8 + index;
  return `${String(hour).padStart(2, "0")}:00`;
});
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
const CUT_SERVICE_KEYS = new Set([
  "corte_social",
  "corte_tradicional",
  "corte_degrade",
  "corte_navalhado",
]);
const COMMON_MONTHLY_FREE_CUTS = 2;
const COMMON_MONTHLY_PRICE = 39.9;
const PLUS_MONTHLY_PRICE = 79.9;

const bookings = [];
const planPurchases = [];
const sessions = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function getCurrentMonthContext() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const today = now.getDate();
  const daysInMonth = new Date(year, month, 0).getDate();

  return {
    year,
    month,
    today,
    daysInMonth,
  };
}

function getCurrentMonthKey() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${month}`;
}

function normalizeDay(day) {
  const parsed = Number.parseInt(day, 10);

  if (!Number.isInteger(parsed)) {
    return null;
  }

  return String(parsed).padStart(2, "0");
}

function isValidDayInCurrentMonth(day) {
  const normalizedDay = normalizeDay(day);

  if (!normalizedDay) {
    return false;
  }

  const dayNumber = Number.parseInt(normalizedDay, 10);
  const context = getCurrentMonthContext();

  return dayNumber >= context.today && dayNumber <= context.daysInMonth;
}

function isValidSlotTime(time) {
  return SLOT_TIMES.includes(String(time || ""));
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

function getBookingStatusForSlot(day, time) {
  return bookings.find(
    (item) => item.day === day && item.time === time && ["pending_payment", "confirmed"].includes(item.status)
  );
}

function buildDaySchedule(day) {
  return SLOT_TIMES.map((time) => {
    const booking = getBookingStatusForSlot(day, time);

    if (!booking) {
      return {
        time,
        status: "available",
      };
    }

    return {
      time,
      status: booking.status,
      booking: {
        id: booking.id,
        displayName: booking.displayName,
        username: booking.username,
        service: booking.service,
        phone: booking.phone,
      },
    };
  });
}

function normalizeUserPlan(user) {
  const monthKey = getCurrentMonthKey();
  const basePlan = user.plan || {};
  const type = ["none", "common", "plus"].includes(basePlan.type) ? basePlan.type : "none";
  const usage = basePlan.usage || {};

  return {
    type,
    preferredCut: basePlan.preferredCut || "",
    usage: {
      monthKey,
      commonCutsUsed: usage.monthKey === monthKey ? Number(usage.commonCutsUsed) || 0 : 0,
    },
    updatedAt: basePlan.updatedAt || new Date().toISOString(),
  };
}

function buildUserPayload(user) {
  const plan = normalizeUserPlan(user);
  return {
    id: user.id,
    name: user.name || "",
    username: user.username || "",
    phone: user.phone || "",
    role: user.role || "user",
    plan: {
      type: plan.type,
      preferredCut: plan.preferredCut || "",
      usage: plan.usage,
    },
  };
}

async function ensureDataStore() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.access(USERS_FILE);
  } catch (error) {
    try {
      await fs.writeFile(USERS_FILE, "[]", "utf8");
    } catch (_writeError) {
      useMemoryUserStore = true;
      memoryUsers = [];
      console.warn("Arquivo de usuarios indisponivel. Aplicacao usara armazenamento em memoria.");
    }
  }
}

async function readUsers() {
  if (useMemoryUserStore) {
    return memoryUsers.map((user) => ({
      ...user,
      plan: normalizeUserPlan(user),
    }));
  }

  try {
    const raw = await fs.readFile(USERS_FILE, "utf8");
    const sanitized = raw.replace(/^\uFEFF/, "").trim();
    const users = JSON.parse(sanitized || "[]");
    return users.map((user) => ({
      ...user,
      plan: normalizeUserPlan(user),
    }));
  } catch (error) {
    useMemoryUserStore = true;
    console.warn("Falha ao ler users.json. Aplicacao alternou para armazenamento em memoria.");
    return memoryUsers.map((user) => ({
      ...user,
      plan: normalizeUserPlan(user),
    }));
  }
}

async function writeUsers(users) {
  if (useMemoryUserStore) {
    memoryUsers = users.map((user) => ({ ...user }));
    return;
  }

  try {
    await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
  } catch (error) {
    useMemoryUserStore = true;
    memoryUsers = users.map((user) => ({ ...user }));
    console.warn("Falha ao gravar users.json. Aplicacao alternou para armazenamento em memoria.");
  }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = await scryptAsync(password, salt, 64);
  return `${salt}:${derivedKey.toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
  const [salt, key] = String(storedHash || "").split(":");

  if (!salt || !key) {
    return false;
  }

  const derivedKey = await scryptAsync(password, salt, 64);
  const keyBuffer = Buffer.from(key, "hex");

  if (keyBuffer.length !== derivedKey.length) {
    return false;
  }

  return crypto.timingSafeEqual(keyBuffer, derivedKey);
}

async function ensureAdminUser() {
  const users = await readUsers();
  const adminIndex = users.findIndex((item) => String(item.username || "").toLowerCase() === ADMIN_USERNAME);
  const adminPasswordHash = await hashPassword(ADMIN_PASSWORD);

  if (adminIndex === -1) {
    const maxId = users.reduce((acc, item) => Math.max(acc, Number(item.id) || 0), 0);
    users.push({
      id: maxId + 1,
      username: ADMIN_USERNAME,
      name: "Administrador",
      role: "admin",
      passwordHash: adminPasswordHash,
      plan: {
        type: "none",
        preferredCut: "",
        usage: {
          monthKey: getCurrentMonthKey(),
          commonCutsUsed: 0,
        },
        updatedAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
    });
  } else {
    users[adminIndex] = {
      ...users[adminIndex],
      username: ADMIN_USERNAME,
      name: users[adminIndex].name || "Administrador",
      role: "admin",
      passwordHash: adminPasswordHash,
      plan: {
        type: "none",
        preferredCut: "",
        usage: {
          monthKey: getCurrentMonthKey(),
          commonCutsUsed: 0,
        },
        updatedAt: new Date().toISOString(),
      },
    };
  }

  await writeUsers(users);
}

function createSession(userId) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, {
    userId,
    createdAt: Date.now(),
  });
  return token;
}

function extractToken(req) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme === "Bearer" && token) {
    return token;
  }

  return null;
}

async function authMiddleware(req, res, next) {
  const token = extractToken(req);

  if (!token || !sessions.has(token)) {
    return res.status(401).json({ message: "Sessao invalida." });
  }

  const session = sessions.get(token);
  const users = await readUsers();
  const user = users.find((item) => item.id === session.userId);

  if (!user) {
    sessions.delete(token);
    return res.status(401).json({ message: "Sessao invalida." });
  }

  req.user = {
    ...buildUserPayload(user),
  };
  req.token = token;

  return next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ message: "Acesso restrito ao admin." });
  }

  return next();
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/register", async (req, res) => {
  try {
    const { username, displayName, phone, password } = req.body;

    if (!username || !displayName || !phone || !password) {
      return res.status(400).json({ message: "Preencha usuario, nome de exibicao, telefone e senha." });
    }

    if (String(password).length < 6) {
      return res.status(400).json({ message: "A senha deve ter pelo menos 6 caracteres." });
    }

    const normalizedPhone = String(phone).trim();
    if (!normalizedPhone) {
      return res.status(400).json({ message: "Telefone obrigatorio." });
    }

    const users = await readUsers();
    const normalizedUsername = String(username).trim().toLowerCase();

    if (normalizedUsername === ADMIN_USERNAME) {
      return res.status(409).json({ message: "Usuario indisponivel." });
    }

    const alreadyExists = users.some(
      (item) => String(item.username || "").toLowerCase() === normalizedUsername
    );

    if (alreadyExists) {
      return res.status(409).json({ message: "Usuario ja cadastrado." });
    }

    const passwordHash = await hashPassword(password);
    const maxId = users.reduce((acc, item) => Math.max(acc, Number(item.id) || 0), 0);

    users.push({
      id: maxId + 1,
      username: normalizedUsername,
      name: String(displayName).trim(),
      phone: normalizedPhone,
      role: "user",
      passwordHash,
      plan: {
        type: "none",
        preferredCut: "",
        usage: {
          monthKey: getCurrentMonthKey(),
          commonCutsUsed: 0,
        },
        updatedAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
    });

    await writeUsers(users);

    return res.status(201).json({ message: "Cadastro realizado com sucesso." });
  } catch (error) {
    console.error("Erro em /api/register:", error);
    return res.status(500).json({ message: "Erro interno ao registrar usuario." });
  }
});

app.get("/api/plans", authMiddleware, async (_req, res) => {
  const plans = {
    common: {
      name: "Plano Comum",
      monthlyPrice: COMMON_MONTHLY_PRICE,
      monthlyFreeCuts: COMMON_MONTHLY_FREE_CUTS,
      coverage: "Cortes de cabelo",
    },
    plus: {
      name: "Plano Plus",
      monthlyPrice: PLUS_MONTHLY_PRICE,
      coverage: "Cabelo, barba, sobrancelha e demais servicos",
    },
  };

  return res.json({
    plans,
    userPlan: _req.user.plan,
  });
});

app.post("/api/plans/create-payment", authMiddleware, async (req, res) => {
  if (req.user.role === "admin") {
    return res.status(400).json({ message: "Admin nao precisa de plano." });
  }

  const { planType } = req.body;
  const normalizedPlanType = String(planType || "").toLowerCase();

  if (!["common", "plus"].includes(normalizedPlanType)) {
    return res.status(400).json({ message: "Plano invalido." });
  }

  const users = await readUsers();
  const userIndex = users.findIndex((item) => item.id === req.user.id);

  if (userIndex === -1) {
    return res.status(404).json({ message: "Usuario nao encontrado." });
  }

  const amount = normalizedPlanType === "plus" ? PLUS_MONTHLY_PRICE : COMMON_MONTHLY_PRICE;
  const pixKey = `${crypto.randomBytes(6).toString("hex")}@pix.evilazio`;
  const paymentCode = `PLAN${Date.now()}${crypto.randomBytes(3).toString("hex")}`;
  const qrText = `PIX|${pixKey}|${paymentCode}|Plano ${normalizedPlanType.toUpperCase()} Evilazio`;

  const purchase = {
    id: planPurchases.length + 1,
    userId: req.user.id,
    planType: normalizedPlanType,
    preferredCut: "",
    amount,
    status: "pending_payment",
    payment: {
      pixKey,
      paymentCode,
      qrText,
      createdAt: new Date().toISOString(),
    },
    createdAt: new Date().toISOString(),
  };

  planPurchases.push(purchase);

  return res.status(201).json({
    message: "Pagamento PIX do plano gerado.",
    purchaseId: purchase.id,
    planType: purchase.planType,
    amount: purchase.amount,
    payment: {
      pixKey,
      paymentCode,
      qrText,
      qrImageUrl: `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(qrText)}`,
    },
  });
});

app.post("/api/plans/confirm-payment", authMiddleware, async (req, res) => {
  if (req.user.role === "admin") {
    return res.status(400).json({ message: "Admin nao precisa de plano." });
  }

  const purchaseId = Number.parseInt(req.body.purchaseId, 10);
  if (!Number.isInteger(purchaseId)) {
    return res.status(400).json({ message: "Compra invalida." });
  }

  const purchase = planPurchases.find(
    (item) => item.id === purchaseId && item.userId === req.user.id && item.status === "pending_payment"
  );

  if (!purchase) {
    return res.status(404).json({ message: "Compra pendente nao encontrada." });
  }

  const users = await readUsers();
  const userIndex = users.findIndex((item) => item.id === req.user.id);

  if (userIndex === -1) {
    return res.status(404).json({ message: "Usuario nao encontrado." });
  }

  users[userIndex].plan = {
    type: purchase.planType,
    preferredCut: purchase.planType === "common" ? purchase.preferredCut : "",
    usage: {
      monthKey: getCurrentMonthKey(),
      commonCutsUsed: 0,
    },
    updatedAt: new Date().toISOString(),
  };

  purchase.status = "confirmed";
  purchase.paidAt = new Date().toISOString();

  await writeUsers(users);

  return res.json({
    message: `Plano ${purchase.planType === "plus" ? "Plus" : "Comum"} ativado com sucesso.`,
    user: buildUserPayload(users[userIndex]),
  });
});

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: "Informe usuario e senha." });
    }

    const users = await readUsers();
    const normalizedUsername = String(username).trim().toLowerCase();
    const user = users.find((item) => String(item.username || "").toLowerCase() === normalizedUsername);

    if (!user) {
      return res.status(401).json({ message: "Credenciais invalidas." });
    }

    const validPassword = await verifyPassword(password, user.passwordHash);
    if (!validPassword) {
      return res.status(401).json({ message: "Credenciais invalidas." });
    }

    const token = createSession(user.id);

    return res.json({
      message: "Login realizado.",
      token,
      user: buildUserPayload(user),
    });
  } catch (error) {
    console.error("Erro em /api/login:", error);
    return res.status(500).json({ message: "Erro interno ao realizar login." });
  }
});

app.post("/api/logout", authMiddleware, (req, res) => {
  sessions.delete(req.token);
  res.json({ message: "Logout realizado." });
});

app.get("/api/me", authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

app.put("/api/profile", authMiddleware, async (req, res) => {
  const { displayName, phone, password } = req.body;

  if (!displayName || !String(displayName).trim()) {
    return res.status(400).json({ message: "Nome de exibicao obrigatorio." });
  }

  if (!phone || !String(phone).trim()) {
    return res.status(400).json({ message: "Telefone obrigatorio." });
  }

  if (password && String(password).length < 6) {
    return res.status(400).json({ message: "A senha deve ter pelo menos 6 caracteres." });
  }

  const users = await readUsers();
  const userIndex = users.findIndex((item) => item.id === req.user.id);

  if (userIndex === -1) {
    return res.status(404).json({ message: "Usuario nao encontrado." });
  }

  users[userIndex].name = String(displayName).trim();
  users[userIndex].phone = String(phone).trim();

  if (password) {
    users[userIndex].passwordHash = await hashPassword(String(password));
  }

  await writeUsers(users);

  return res.json({
    message: "Conta atualizada com sucesso.",
    user: buildUserPayload(users[userIndex]),
  });
});

app.get("/api/schedule/day", authMiddleware, (req, res) => {
  const normalizedDay = normalizeDay(req.query.day);

  if (!isValidDayInCurrentMonth(normalizedDay)) {
    return res.status(400).json({ message: "Dia invalido para este mes." });
  }

  return res.json({
    day: normalizedDay,
    slots: buildDaySchedule(normalizedDay),
  });
});

app.post("/api/bookings/create-payment", authMiddleware, async (req, res) => {
  if (req.user.role === "admin") {
    return res.status(403).json({ message: "Admin nao realiza agendamento." });
  }

  const { day, time, service, phone, paymentMethod } = req.body;
  const normalizedDay = normalizeDay(day);

  if (!normalizedDay || !isValidDayInCurrentMonth(normalizedDay)) {
    return res.status(400).json({ message: "Escolha um dia valido no mes atual, sem datas passadas." });
  }

  if (!isValidSlotTime(time)) {
    return res.status(400).json({ message: "Horario invalido. Escolha entre 08:00 e 19:00." });
  }

  if (!service || !phone) {
    return res.status(400).json({ message: "Informe servico e telefone." });
  }

  const serviceDuration = getServiceDuration(service);
  if (!serviceDuration) {
    return res.status(400).json({ message: "Servico invalido para agendamento." });
  }

  const taken = getBookingStatusForSlot(normalizedDay, time);
  if (taken) {
    return res.status(409).json({ message: "Horario indisponivel para este dia." });
  }

  const booking = {
    id: bookings.length + 1,
    userId: req.user.id,
    username: req.user.username,
    displayName: req.user.name || req.user.username,
    phone: String(phone).trim(),
    service: String(service).trim(),
    durationMinutes: serviceDuration,
    day: normalizedDay,
    time,
    status: "pending_payment",
    payment: {},
    createdAt: new Date().toISOString(),
  };

  const normalizedPaymentMethod = String(paymentMethod || "pix").toLowerCase();

  if (normalizedPaymentMethod === "premium" || normalizedPaymentMethod === "plan") {
    const users = await readUsers();
    const userIndex = users.findIndex((item) => item.id === req.user.id);

    if (userIndex === -1) {
      return res.status(404).json({ message: "Usuario nao encontrado." });
    }

    const userPlan = normalizeUserPlan(users[userIndex]);
    const isCutService = CUT_SERVICE_KEYS.has(normalizeServiceKey(service));
    const isPreferredCut = !userPlan.preferredCut || normalizeServiceKey(userPlan.preferredCut) === normalizeServiceKey(service);
    const canUseCommon = userPlan.type === "common" && isCutService && isPreferredCut &&
      userPlan.usage.commonCutsUsed < COMMON_MONTHLY_FREE_CUTS;
    const canUsePlus = userPlan.type === "plus";

    if (!canUsePlus && !canUseCommon) {
      const commonExhausted = userPlan.type === "common" &&
        isCutService &&
        userPlan.usage.commonCutsUsed >= COMMON_MONTHLY_FREE_CUTS;

      const message = commonExhausted
        ? "Seus cortes do plano comum neste mes acabaram."
        : "Seu plano atual nao cobre este servico. Compre um plano ou faca upgrade para Plus.";

      return res.status(402).json({
        message,
        code: "PLAN_UPGRADE_REQUIRED",
        reason: commonExhausted ? "COMMON_PLAN_EXHAUSTED" : "PLAN_NOT_COVERED",
        allowPixFallback: true,
        redirectTo: "/premium.html",
      });
    }

    if (canUseCommon) {
      userPlan.usage.commonCutsUsed += 1;
      userPlan.updatedAt = new Date().toISOString();
      users[userIndex].plan = userPlan;
      await writeUsers(users);
    }

    booking.status = "confirmed";
    booking.paidAt = new Date().toISOString();
    booking.payment = {
      method: "plan",
      planType: userPlan.type,
      createdAt: booking.paidAt,
    };

    bookings.push(booking);

    return res.status(201).json({
      message: "Agendamento confirmado usando o plano.",
      bookingId: booking.id,
      durationMinutes: booking.durationMinutes,
      booking,
    });
  }

  const pixKey = `${crypto.randomBytes(6).toString("hex")}@pix.evilazio`;
  const paymentCode = `EVLZ${Date.now()}${crypto.randomBytes(3).toString("hex")}`;
  const qrText = `PIX|${pixKey}|${paymentCode}|Evilazio Barbershop`;

  booking.payment = {
    method: "pix",
    pixKey,
    paymentCode,
    qrText,
    createdAt: new Date().toISOString(),
  };

  bookings.push(booking);

  return res.status(201).json({
    message: "Reserva criada. Realize o pagamento para confirmar.",
    bookingId: booking.id,
    durationMinutes: booking.durationMinutes,
    payment: {
      pixKey,
      paymentCode,
      qrText,
      qrImageUrl: `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(qrText)}`,
    },
  });
});

app.post("/api/bookings/confirm-payment", authMiddleware, (req, res) => {
  if (req.user.role === "admin") {
    return res.status(403).json({ message: "Admin nao realiza agendamento." });
  }

  const bookingId = Number.parseInt(req.body.bookingId, 10);

  if (!Number.isInteger(bookingId)) {
    return res.status(400).json({ message: "Booking invalido." });
  }

  const booking = bookings.find(
    (item) => item.id === bookingId && item.userId === req.user.id && item.status === "pending_payment"
  );

  if (!booking) {
    return res.status(404).json({ message: "Reserva pendente nao encontrada." });
  }

  booking.status = "confirmed";
  booking.paidAt = new Date().toISOString();

  return res.json({
    message: "Pagamento confirmado. Agendamento finalizado.",
    booking,
  });
});

app.get("/api/bookings", authMiddleware, (req, res) => {
  if (req.user.role === "admin") {
    return res.json(bookings);
  }

  const ownBookings = bookings.filter((item) => item.userId === req.user.id);
  return res.json(ownBookings);
});

app.post("/api/admin/bookings/:bookingId/cancel", authMiddleware, requireAdmin, (req, res) => {
  const bookingId = Number.parseInt(req.params.bookingId, 10);

  if (!Number.isInteger(bookingId)) {
    return res.status(400).json({ message: "Agendamento invalido." });
  }

  const booking = bookings.find((item) => item.id === bookingId);

  if (!booking) {
    return res.status(404).json({ message: "Agendamento nao encontrado." });
  }

  if (!["pending_payment", "confirmed"].includes(booking.status)) {
    return res.status(409).json({ message: "Somente agendamentos pendentes ou pagos podem ser cancelados." });
  }

  booking.status = "cancelled";
  booking.cancelledAt = new Date().toISOString();
  booking.cancelledBy = req.user.username;

  return res.json({
    message: "Agendamento cancelado com sucesso.",
    booking: {
      id: booking.id,
      day: booking.day,
      time: booking.time,
      status: booking.status,
      cancelledAt: booking.cancelledAt,
    },
  });
});

app.get("/api/admin/schedule", authMiddleware, requireAdmin, (req, res) => {
  const normalizedDay = normalizeDay(req.query.day);

  if (!isValidDayInCurrentMonth(normalizedDay)) {
    return res.status(400).json({ message: "Dia invalido para este mes." });
  }

  const slots = SLOT_TIMES.map((time) => {
    const booking = getBookingStatusForSlot(normalizedDay, time);

    if (!booking) {
      return {
        time,
        status: "available",
      };
    }

    return {
      time,
      status: booking.status,
      booking: {
        id: booking.id,
        displayName: booking.displayName,
        username: booking.username,
        phone: booking.phone,
        service: booking.service,
        durationMinutes: booking.durationMinutes || getServiceDuration(booking.service),
      },
    };
  });

  return res.json({ day: normalizedDay, slots });
});

Promise.resolve()
  .then(ensureDataStore)
  .then(ensureAdminUser)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Evilazio Barbershop online em http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Falha ao iniciar aplicacao:", error);
    process.exit(1);
  });
