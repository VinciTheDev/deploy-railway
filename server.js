const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const scryptAsync = promisify(crypto.scrypt);

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRESQL_URL;
const hasPgParts =
  process.env.PGHOST &&
  process.env.PGPORT &&
  process.env.PGUSER &&
  process.env.PGPASSWORD &&
  process.env.PGDATABASE;

if (!DATABASE_URL && !hasPgParts) {
  throw new Error(
    "Banco nao configurado. Defina DATABASE_URL (ou POSTGRES_URL) ou as variaveis PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE no Railway."
  );
}

const pool = new Pool({
  connectionString: DATABASE_URL || undefined,
  host: process.env.PGHOST || undefined,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
  user: process.env.PGUSER || undefined,
  password: process.env.PGPASSWORD || undefined,
  database: process.env.PGDATABASE || undefined,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
});

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "001212";

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
  teste_pix_1_centavo: 5,
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
const PAYMENT_EXPIRATION_MINUTES = Number.parseInt(process.env.PAYMENT_EXPIRATION_MINUTES || "20", 10);
const PAYMENT_SWEEP_INTERVAL_MS = Number.parseInt(process.env.PAYMENT_SWEEP_INTERVAL_MS || "30000", 10);
const PIX_KEY = "ee96c7d1-b09b-46ad-a324-42ee01713b38";
const PIX_QR_IMAGE_URL = process.env.PIX_QR_IMAGE_URL || "/images/qrcode-pix.png";
const APP_TIMEZONE = process.env.APP_TIMEZONE || "America/Fortaleza";
const PAYMENT_WEBHOOK_TOKEN = process.env.PAYMENT_WEBHOOK_TOKEN || "";

const sessions = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function buildPixPayment(prefix, description) {
  const paymentCode = `${prefix}${Date.now()}${crypto.randomBytes(3).toString("hex")}`;
  const qrText = `PIX|${PIX_KEY}|${paymentCode}|${description}`;
  const qrImageUrl =
    PIX_QR_IMAGE_URL ||
    `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(qrText)}`;

  return {
    pixKey: PIX_KEY,
    paymentCode,
    qrText,
    qrImageUrl,
  };
}

function getCurrentMonthContext() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("pt-BR", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const year = Number(parts.find((item) => item.type === "year")?.value);
  const month = Number(parts.find((item) => item.type === "month")?.value);
  const today = Number(parts.find((item) => item.type === "day")?.value);
  const daysInMonth = new Date(year, month, 0).getDate();

  return { year, month, today, daysInMonth };
}

function getCurrentMonthKey() {
  const { year, month } = getCurrentMonthContext();
  return `${year}-${String(month).padStart(2, "0")}`;
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
  if (normalized === "teste pix (r$0,01)" || normalized === "teste pix 1 centavo") return "teste_pix_1_centavo";

  return "";
}

function getServiceDuration(service) {
  const key = normalizeServiceKey(service);
  return key ? SERVICE_DURATIONS[key] || null : null;
}

function normalizeUserPlan(row) {
  const monthKey = getCurrentMonthKey();
  const type = ["none", "common", "plus"].includes(String(row.plan_type || ""))
    ? String(row.plan_type)
    : "none";
  const commonCutsUsed = row.plan_month_key === monthKey ? Number(row.common_cuts_used) || 0 : 0;

  return {
    type,
    preferredCut: row.preferred_cut || "",
    usage: {
      monthKey,
      commonCutsUsed,
    },
  };
}

function buildUserPayload(row) {
  const plan = normalizeUserPlan(row);
  return {
    id: row.id,
    name: row.name || "",
    username: row.username || "",
    phone: row.phone || "",
    role: row.role || "user",
    plan: {
      type: plan.type,
      preferredCut: plan.preferredCut,
      usage: plan.usage,
    },
  };
}

function parseBookingRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    phone: row.phone,
    service: row.service,
    durationMinutes: row.duration_minutes,
    day: row.day,
    time: row.time,
    status: row.status,
    payment: {
      method: row.payment_method,
      pixKey: row.payment_pix_key,
      paymentCode: row.payment_code,
      qrText: row.payment_qr_text,
      planType: row.payment_plan_type,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    },
    createdAt: row.created_at,
    paidAt: row.paid_at,
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by,
  };
}

function getPaymentExpirationMinutes() {
  if (!Number.isFinite(PAYMENT_EXPIRATION_MINUTES) || PAYMENT_EXPIRATION_MINUTES <= 0) {
    return 20;
  }
  return PAYMENT_EXPIRATION_MINUTES;
}

function buildPaymentExpiryDate() {
  return new Date(Date.now() + getPaymentExpirationMinutes() * 60 * 1000);
}

function getPaymentSweepIntervalMs() {
  if (!Number.isFinite(PAYMENT_SWEEP_INTERVAL_MS) || PAYMENT_SWEEP_INTERVAL_MS < 5000) {
    return 30000;
  }
  return PAYMENT_SWEEP_INTERVAL_MS;
}

function normalizeWebhookStatus(status) {
  const normalized = String(status || "").toLowerCase().trim();
  if (
    [
      "paid",
      "confirmed",
      "approved",
      "succeeded",
      "completed",
      "received",
      "recebido",
      "confirmado",
      "concluido",
      "liquidated",
      "settled",
    ].includes(normalized)
  ) {
    return "paid";
  }
  return normalized;
}

function extractWebhookToken(req) {
  const headerToken = req.headers["x-payment-webhook-token"];
  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const queryToken = String(req.query.token || "").trim();
  const bodyToken = String(req.body?.token || req.body?.webhookToken || "").trim();
  return String(headerToken || bearerToken || queryToken || bodyToken || "").trim();
}

function extractWebhookPaymentCode(body) {
  return String(
    body?.paymentCode ||
      body?.payment_code ||
      body?.externalReference ||
      body?.external_reference ||
      body?.reference ||
      body?.reference_id ||
      body?.txid ||
      body?.transactionId ||
      body?.transaction_id ||
      body?.metadata?.paymentCode ||
      body?.metadata?.payment_code ||
      ""
  ).trim();
}

function extractWebhookPaidAt(body) {
  const value =
    body?.paidAt ||
    body?.paid_at ||
    body?.approvedAt ||
    body?.approved_at ||
    body?.dateApproved ||
    body?.date_approved ||
    body?.data?.paidAt ||
    body?.data?.paid_at ||
    body?.data?.approvedAt ||
    body?.data?.approved_at ||
    null;

  if (!value) {
    return new Date();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function extractWebhookStatus(body) {
  return normalizeWebhookStatus(
    body?.status ||
      body?.paymentStatus ||
      body?.payment_status ||
      body?.event ||
      body?.eventType ||
      body?.event_type ||
      body?.data?.status ||
      body?.data?.paymentStatus ||
      body?.data?.payment_status ||
      ""
  );
}

async function query(text, params = []) {
  return pool.query(text, params);
}

async function getUserById(id) {
  const result = await query("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0] || null;
}

async function getUserByUsername(username) {
  const result = await query("SELECT * FROM users WHERE username = $1", [String(username || "").toLowerCase()]);
  return result.rows[0] || null;
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

async function initDatabase() {
  await query(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user',
      password_hash TEXT NOT NULL,
      plan_type TEXT NOT NULL DEFAULT 'none',
      preferred_cut TEXT NOT NULL DEFAULT '',
      plan_month_key TEXT,
      common_cuts_used INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      service TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL,
      day CHAR(2) NOT NULL,
      time CHAR(5) NOT NULL,
      status TEXT NOT NULL,
      payment_method TEXT,
      payment_pix_key TEXT,
      payment_code TEXT,
      payment_qr_text TEXT,
      payment_plan_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      cancelled_by TEXT
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS plan_purchases (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_type TEXT NOT NULL,
      preferred_cut TEXT NOT NULL DEFAULT '',
      amount NUMERIC(10,2) NOT NULL,
      status TEXT NOT NULL,
      pix_key TEXT,
      payment_code TEXT,
      qr_text TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ
    );
  `);

  await query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;");
  await query("ALTER TABLE plan_purchases ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;");

  await query(
    `
      UPDATE bookings
      SET expires_at = created_at + ($1::text || ' minutes')::interval
      WHERE status = 'pending_payment'
        AND expires_at IS NULL;
    `,
    [getPaymentExpirationMinutes()]
  );

  await query(
    `
      UPDATE plan_purchases
      SET expires_at = created_at + ($1::text || ' minutes')::interval
      WHERE status = 'pending_payment'
        AND expires_at IS NULL;
    `,
    [getPaymentExpirationMinutes()]
  );

  await expirePendingPayments();

  await query(`
    DROP INDEX IF EXISTS idx_bookings_active_slot;
  `);

  // Clean legacy duplicates before recreating the unique active-slot index.
  await query(`
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY day, time
          ORDER BY
            CASE WHEN status = 'confirmed' THEN 0 ELSE 1 END,
            COALESCE(paid_at, created_at) DESC,
            id DESC
        ) AS rn
      FROM bookings
      WHERE status IN ('pending_payment', 'confirmed')
    )
    UPDATE bookings b
    SET
      status = 'cancelled',
      cancelled_at = NOW(),
      cancelled_by = COALESCE(b.cancelled_by, 'system_dedup')
    FROM ranked r
    WHERE b.id = r.id
      AND r.rn > 1;
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_active_slot
    ON bookings(day, time)
    WHERE status IN ('pending_payment', 'confirmed');
  `);
}

async function ensureAdminOnly() {
  const adminPasswordHash = await hashPassword(ADMIN_PASSWORD);
  const monthKey = getCurrentMonthKey();

  await query(
    `
      INSERT INTO users (username, name, phone, role, password_hash, plan_type, preferred_cut, plan_month_key, common_cuts_used)
      VALUES ($1, $2, '', 'admin', $3, 'none', '', $4, 0)
      ON CONFLICT (username)
      DO UPDATE SET
        name = EXCLUDED.name,
        phone = EXCLUDED.phone,
        role = EXCLUDED.role,
        password_hash = EXCLUDED.password_hash,
        plan_type = 'none',
        preferred_cut = '',
        plan_month_key = EXCLUDED.plan_month_key,
        common_cuts_used = 0,
        updated_at = NOW();
    `,
    [ADMIN_USERNAME, "Administrador", adminPasswordHash, monthKey]
  );

  const markerResult = await query(
    "SELECT value FROM app_meta WHERE key = 'admin_only_seed_v1' LIMIT 1"
  );

  if (markerResult.rows.length === 0) {
    await query(
      `
        DELETE FROM bookings
        WHERE user_id IN (SELECT id FROM users WHERE username <> $1);
      `,
      [ADMIN_USERNAME]
    );

    await query(
      `
        DELETE FROM plan_purchases
        WHERE user_id IN (SELECT id FROM users WHERE username <> $1);
      `,
      [ADMIN_USERNAME]
    );

    await query("DELETE FROM users WHERE username <> $1", [ADMIN_USERNAME]);
    await query(
      "INSERT INTO app_meta (key, value) VALUES ('admin_only_seed_v1', $1)",
      [new Date().toISOString()]
    );
  }
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
  try {
    const token = extractToken(req);

    if (!token || !sessions.has(token)) {
      return res.status(401).json({ message: "Sessao invalida." });
    }

    const session = sessions.get(token);
    const user = await getUserById(session.userId);

    if (!user) {
      sessions.delete(token);
      return res.status(401).json({ message: "Sessao invalida." });
    }

    req.user = buildUserPayload(user);
    req.token = token;
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ message: "Acesso restrito ao admin." });
  }
  return next();
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

async function expirePendingPayments(db = pool) {
  await db.query(
    `
      UPDATE bookings
      SET status = 'expired',
          cancelled_at = NOW(),
          cancelled_by = 'system_timeout'
      WHERE status = 'pending_payment'
        AND expires_at IS NOT NULL
        AND expires_at <= NOW();
    `
  );

  await db.query(
    `
      UPDATE plan_purchases
      SET status = 'expired'
      WHERE status = 'pending_payment'
        AND expires_at IS NOT NULL
        AND expires_at <= NOW();
    `
  );
}

async function getBookingStatusForSlot(day, time) {
  await expirePendingPayments();
  const result = await query(
    `
      SELECT *
      FROM bookings
      WHERE day = $1
        AND time = $2
        AND status IN ('pending_payment', 'confirmed')
      LIMIT 1;
    `,
    [day, time]
  );
  return result.rows[0] || null;
}

async function buildDaySchedule(day) {
  await expirePendingPayments();
  const result = await query(
    `
      SELECT *
      FROM bookings
      WHERE day = $1
        AND status IN ('pending_payment', 'confirmed');
    `,
    [day]
  );

  const byTime = new Map(result.rows.map((row) => [row.time, row]));

  return SLOT_TIMES.map((time) => {
    const booking = byTime.get(time);
    if (!booking) {
      return { time, status: "available" };
    }

    return {
      time,
      status: booking.status,
      booking: {
        id: booking.id,
        displayName: booking.display_name,
        username: booking.username,
        service: booking.service,
        phone: booking.phone,
      },
    };
  });
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post(
  "/api/register",
  asyncHandler(async (req, res) => {
    const { username, displayName, phone, password } = req.body;

    if (!username || !displayName || !phone || !password) {
      return res.status(400).json({ message: "Preencha usuario, nome de exibicao, telefone e senha." });
    }

    if (String(password).length < 6) {
      return res.status(400).json({ message: "A senha deve ter pelo menos 6 caracteres." });
    }

    const normalizedUsername = String(username).trim().toLowerCase();
    const normalizedPhone = String(phone).trim();

    if (!normalizedPhone) {
      return res.status(400).json({ message: "Telefone obrigatorio." });
    }

    if (normalizedUsername === ADMIN_USERNAME) {
      return res.status(409).json({ message: "Usuario indisponivel." });
    }

    const existing = await getUserByUsername(normalizedUsername);
    if (existing) {
      return res.status(409).json({ message: "Usuario ja cadastrado." });
    }

    const passwordHash = await hashPassword(String(password));

    await query(
      `
        INSERT INTO users (username, name, phone, role, password_hash, plan_type, preferred_cut, plan_month_key, common_cuts_used)
        VALUES ($1, $2, $3, 'user', $4, 'none', '', $5, 0);
      `,
      [normalizedUsername, String(displayName).trim(), normalizedPhone, passwordHash, getCurrentMonthKey()]
    );

    return res.status(201).json({ message: "Cadastro realizado com sucesso." });
  })
);

app.post(
  "/api/login",
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: "Informe usuario e senha." });
    }

    const user = await getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ message: "Credenciais invalidas." });
    }

    const validPassword = await verifyPassword(String(password), user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ message: "Credenciais invalidas." });
    }

    const token = createSession(user.id);

    return res.json({
      message: "Login realizado.",
      token,
      user: buildUserPayload(user),
    });
  })
);

app.post("/api/logout", authMiddleware, (req, res) => {
  sessions.delete(req.token);
  return res.json({ message: "Logout realizado." });
});

app.get("/api/me", authMiddleware, (req, res) => {
  return res.json({ user: req.user });
});

app.put(
  "/api/profile",
  authMiddleware,
  asyncHandler(async (req, res) => {
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

    if (password) {
      const passwordHash = await hashPassword(String(password));
      await query(
        `
          UPDATE users
          SET name = $1,
              phone = $2,
              password_hash = $3,
              updated_at = NOW()
          WHERE id = $4;
        `,
        [String(displayName).trim(), String(phone).trim(), passwordHash, req.user.id]
      );
    } else {
      await query(
        `
          UPDATE users
          SET name = $1,
              phone = $2,
              updated_at = NOW()
          WHERE id = $3;
        `,
        [String(displayName).trim(), String(phone).trim(), req.user.id]
      );
    }

    const refreshed = await getUserById(req.user.id);
    return res.json({
      message: "Conta atualizada com sucesso.",
      user: buildUserPayload(refreshed),
    });
  })
);

app.get("/api/plans", authMiddleware, asyncHandler(async (req, res) => {
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

  const freshUser = await getUserById(req.user.id);

  return res.json({
    plans,
    userPlan: buildUserPayload(freshUser).plan,
  });
}));

app.post(
  "/api/plans/create-payment",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (req.user.role === "admin") {
      return res.status(400).json({ message: "Admin nao precisa de plano." });
    }

    const normalizedPlanType = String(req.body.planType || "").toLowerCase();
    if (!["common", "plus"].includes(normalizedPlanType)) {
      return res.status(400).json({ message: "Plano invalido." });
    }

    const amount = normalizedPlanType === "plus" ? PLUS_MONTHLY_PRICE : COMMON_MONTHLY_PRICE;
    const payment = buildPixPayment("PLAN", `Plano ${normalizedPlanType.toUpperCase()} Evilazio`);
    const expiresAt = buildPaymentExpiryDate();

    const insert = await query(
      `
        INSERT INTO plan_purchases (
          user_id, plan_type, preferred_cut, amount, status, pix_key, payment_code, qr_text, expires_at
        )
        VALUES ($1, $2, '', $3, 'pending_payment', $4, $5, $6, $7)
        RETURNING id;
      `,
      [req.user.id, normalizedPlanType, amount, payment.pixKey, payment.paymentCode, payment.qrText, expiresAt]
    );
    const purchaseId = insert.rows[0].id;

    return res.status(201).json({
      message: "Pagamento PIX do plano gerado.",
      purchaseId,
      planType: normalizedPlanType,
      amount,
      payment: {
        pixKey: payment.pixKey,
        paymentCode: payment.paymentCode,
        qrText: payment.qrText,
        qrImageUrl: payment.qrImageUrl,
        expiresAt,
      },
    });
  })
);

app.post(
  "/api/plans/confirm-payment",
  authMiddleware,
  asyncHandler(async (req, res) => {
    return res.status(410).json({
      message: "Confirmacao manual desativada. O plano ativa automaticamente quando o PIX for compensado.",
    });
  })
);

app.get(
  "/api/plans/purchases/:purchaseId/status",
  authMiddleware,
  asyncHandler(async (req, res) => {
    await expirePendingPayments();
    const purchaseId = Number.parseInt(req.params.purchaseId, 10);
    if (!Number.isInteger(purchaseId)) {
      return res.status(400).json({ message: "Compra invalida." });
    }

    const result = await query(
      `
        SELECT id, status, plan_type, paid_at, expires_at
        FROM plan_purchases
        WHERE id = $1
          AND user_id = $2
        LIMIT 1;
      `,
      [purchaseId, req.user.id]
    );

    const purchase = result.rows[0];
    if (!purchase) {
      return res.status(404).json({ message: "Compra nao encontrada." });
    }

    return res.json({
      purchaseId: purchase.id,
      status: purchase.status,
      planType: purchase.plan_type,
      paidAt: purchase.paid_at,
      expiresAt: purchase.expires_at,
    });
  })
);

app.get(
  "/api/schedule/day",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const normalizedDay = normalizeDay(req.query.day);

    if (!isValidDayInCurrentMonth(normalizedDay)) {
      return res.status(400).json({ message: "Dia invalido para este mes." });
    }

    const slots = await buildDaySchedule(normalizedDay);
    return res.json({ day: normalizedDay, slots });
  })
);

app.post(
  "/api/bookings/create-payment",
  authMiddleware,
  asyncHandler(async (req, res) => {
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

    const normalizedPaymentMethod = String(paymentMethod || "pix").toLowerCase();
    await expirePendingPayments();
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      if (normalizedPaymentMethod === "premium" || normalizedPaymentMethod === "plan") {
        const userResult = await client.query("SELECT * FROM users WHERE id = $1 FOR UPDATE", [req.user.id]);
        const user = userResult.rows[0];

        if (!user) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Usuario nao encontrado." });
        }

        const userPlan = normalizeUserPlan(user);
        const isCutService = CUT_SERVICE_KEYS.has(normalizeServiceKey(service));
        const isPreferredCut = !userPlan.preferredCut || normalizeServiceKey(userPlan.preferredCut) === normalizeServiceKey(service);
        const canUseCommon =
          userPlan.type === "common" &&
          isCutService &&
          isPreferredCut &&
          userPlan.usage.commonCutsUsed < COMMON_MONTHLY_FREE_CUTS;
        const canUsePlus = userPlan.type === "plus";

        if (!canUsePlus && !canUseCommon) {
          await client.query("ROLLBACK");

          const commonExhausted =
            userPlan.type === "common" && isCutService && userPlan.usage.commonCutsUsed >= COMMON_MONTHLY_FREE_CUTS;

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
          await client.query(
            `
              UPDATE users
              SET common_cuts_used = $1,
                  plan_month_key = $2,
                  updated_at = NOW()
              WHERE id = $3;
            `,
            [userPlan.usage.commonCutsUsed + 1, getCurrentMonthKey(), req.user.id]
          );
        }

        const insertPlanBooking = await client.query(
          `
            INSERT INTO bookings (
              user_id, username, display_name, phone, service, duration_minutes,
              day, time, status, payment_method, payment_plan_type, paid_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confirmed', 'plan', $9, NOW())
            RETURNING *;
          `,
          [
            req.user.id,
            req.user.username,
            req.user.name || req.user.username,
            String(phone).trim(),
            String(service).trim(),
            serviceDuration,
            normalizedDay,
            String(time),
            userPlan.type,
          ]
        );

        await client.query("COMMIT");
        const booking = parseBookingRow(insertPlanBooking.rows[0]);

        return res.status(201).json({
          message: "Agendamento confirmado usando o plano.",
          bookingId: booking.id,
          durationMinutes: booking.durationMinutes,
          booking,
        });
      }

      const payment = buildPixPayment("EVLZ", "Evilazio Barbershop");
      const expiresAt = buildPaymentExpiryDate();

      const insertPixBooking = await client.query(
        `
          INSERT INTO bookings (
            user_id, username, display_name, phone, service, duration_minutes,
            day, time, status, payment_method, payment_pix_key, payment_code, payment_qr_text, expires_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending_payment', 'pix', $9, $10, $11, $12)
          RETURNING *;
        `,
        [
          req.user.id,
          req.user.username,
          req.user.name || req.user.username,
          String(phone).trim(),
          String(service).trim(),
          serviceDuration,
          normalizedDay,
          String(time),
          payment.pixKey,
          payment.paymentCode,
          payment.qrText,
          expiresAt,
        ]
      );

      await client.query("COMMIT");
      const booking = parseBookingRow(insertPixBooking.rows[0]);

      return res.status(201).json({
        message: "Pagamento PIX gerado. Aguarde confirmacao para liberar o horario como ocupado.",
        bookingId: booking.id,
        durationMinutes: booking.durationMinutes,
        payment: {
          pixKey: payment.pixKey,
          paymentCode: payment.paymentCode,
          qrText: payment.qrText,
          qrImageUrl: payment.qrImageUrl,
          expiresAt,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") {
        return res.status(409).json({ message: "Horario indisponivel para este dia." });
      }
      throw error;
    } finally {
      client.release();
    }
  })
);

app.post(
  "/api/bookings/confirm-payment",
  authMiddleware,
  asyncHandler(async (req, res) => {
    return res.status(410).json({
      message: "Confirmacao manual desativada. O agendamento confirma automaticamente apos compensacao PIX.",
    });
  })
);

app.get(
  "/api/bookings/:bookingId/status",
  authMiddleware,
  asyncHandler(async (req, res) => {
    await expirePendingPayments();
    const bookingId = Number.parseInt(req.params.bookingId, 10);
    if (!Number.isInteger(bookingId)) {
      return res.status(400).json({ message: "Agendamento invalido." });
    }

    const result = await query(
      `
        SELECT id, user_id, status, day, time, paid_at, expires_at
        FROM bookings
        WHERE id = $1
        LIMIT 1;
      `,
      [bookingId]
    );

    const booking = result.rows[0];
    if (!booking) {
      return res.status(404).json({ message: "Agendamento nao encontrado." });
    }

    if (req.user.role !== "admin" && booking.user_id !== req.user.id) {
      return res.status(403).json({ message: "Acesso negado." });
    }

    return res.json({
      bookingId: booking.id,
      status: booking.status,
      day: booking.day,
      time: booking.time,
      paidAt: booking.paid_at,
      expiresAt: booking.expires_at,
    });
  })
);

app.get(
  "/api/bookings",
  authMiddleware,
  asyncHandler(async (req, res) => {
    await expirePendingPayments();
    const result = await query(
      req.user.role === "admin"
        ? "SELECT * FROM bookings ORDER BY created_at DESC"
        : "SELECT * FROM bookings WHERE user_id = $1 ORDER BY created_at DESC",
      req.user.role === "admin" ? [] : [req.user.id]
    );

    return res.json(result.rows.map(parseBookingRow));
  })
);

app.post(
  "/api/payments/webhook",
  asyncHandler(async (req, res) => {
    const receivedToken = extractWebhookToken(req);
    if (PAYMENT_WEBHOOK_TOKEN && receivedToken !== PAYMENT_WEBHOOK_TOKEN) {
      return res.status(401).json({ message: "Webhook nao autorizado." });
    }

    const paymentCode = extractWebhookPaymentCode(req.body);
    const status = extractWebhookStatus(req.body);
    const paidAtValue = extractWebhookPaidAt(req.body);
    const bookingId = Number.parseInt(
      req.body?.bookingId || req.body?.booking_id || req.body?.metadata?.bookingId || req.body?.metadata?.booking_id,
      10
    );
    const purchaseId = Number.parseInt(
      req.body?.purchaseId ||
        req.body?.purchase_id ||
        req.body?.planPurchaseId ||
        req.body?.plan_purchase_id ||
        req.body?.metadata?.purchaseId ||
        req.body?.metadata?.purchase_id,
      10
    );

    if (!paymentCode && !Number.isInteger(bookingId) && !Number.isInteger(purchaseId)) {
      return res.status(400).json({
        message: "Informe paymentCode, bookingId ou purchaseId no webhook.",
      });
    }

    if (status !== "paid") {
      return res.json({ ok: true, ignored: true, reason: "status_not_paid" });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await expirePendingPayments(client);

      if (Number.isInteger(purchaseId)) {
        const directPurchaseResult = await client.query(
          `
            SELECT *
            FROM plan_purchases
            WHERE id = $1
              AND status = 'pending_payment'
              AND (expires_at IS NULL OR expires_at > NOW())
            LIMIT 1
            FOR UPDATE;
          `,
          [purchaseId]
        );

        const directPurchase = directPurchaseResult.rows[0];
        if (directPurchase) {
          await client.query(
            `
              UPDATE plan_purchases
              SET status = 'confirmed',
                  paid_at = $2
              WHERE id = $1;
            `,
            [directPurchase.id, paidAtValue]
          );

          await client.query(
            `
              UPDATE users
              SET plan_type = $1,
                  preferred_cut = '',
                  plan_month_key = $2,
                  common_cuts_used = 0,
                  updated_at = NOW()
              WHERE id = $3;
            `,
            [directPurchase.plan_type, getCurrentMonthKey(), directPurchase.user_id]
          );

          await client.query("COMMIT");
          return res.json({
            ok: true,
            type: "plan_purchase",
            id: directPurchase.id,
            status: "confirmed",
          });
        }
      }

      if (Number.isInteger(bookingId)) {
        const directBookingResult = await client.query(
          `
            SELECT *
            FROM bookings
            WHERE id = $1
              AND status = 'pending_payment'
              AND (expires_at IS NULL OR expires_at > NOW())
            LIMIT 1
            FOR UPDATE;
          `,
          [bookingId]
        );

        const directBooking = directBookingResult.rows[0];
        if (directBooking) {
          await client.query(
            `
              UPDATE bookings
              SET status = 'confirmed',
                  paid_at = $2
              WHERE id = $1
                AND status = 'pending_payment'
              RETURNING id;
            `,
            [directBooking.id, paidAtValue]
          );

          await client.query("COMMIT");
          return res.json({
            ok: true,
            type: "booking",
            id: directBooking.id,
            status: "confirmed",
          });
        }
      }

      const purchaseResult = await client.query(
        `
          SELECT *
          FROM plan_purchases
          WHERE payment_code = $1
            AND status = 'pending_payment'
            AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE;
        `,
        [paymentCode]
      );

      const purchase = purchaseResult.rows[0];
      if (purchase) {
        await client.query(
          `
            UPDATE plan_purchases
            SET status = 'confirmed',
                paid_at = $2
            WHERE id = $1;
          `,
          [purchase.id, paidAtValue]
        );

        await client.query(
          `
            UPDATE users
            SET plan_type = $1,
                preferred_cut = '',
                plan_month_key = $2,
                common_cuts_used = 0,
                updated_at = NOW()
            WHERE id = $3;
          `,
          [purchase.plan_type, getCurrentMonthKey(), purchase.user_id]
        );

        await client.query("COMMIT");
        return res.json({
          ok: true,
          type: "plan_purchase",
          id: purchase.id,
          status: "confirmed",
        });
      }

      const bookingResult = await client.query(
        `
          SELECT *
          FROM bookings
          WHERE payment_code = $1
            AND status = 'pending_payment'
            AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE;
        `,
        [paymentCode]
      );

      const booking = bookingResult.rows[0];
      if (booking) {
        await client.query(
          `
            UPDATE bookings
            SET status = 'confirmed',
                paid_at = $2
            WHERE id = $1
              AND status = 'pending_payment'
            RETURNING id;
          `,
          [booking.id, paidAtValue]
        );

        await client.query("COMMIT");
        return res.json({
          ok: true,
          type: "booking",
          id: booking.id,
          status: "confirmed",
        });
      }

      await client.query("COMMIT");
      return res.status(404).json({ ok: false, message: "Pagamento pendente nao encontrado ou expirado." });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  })
);

app.post(
  "/api/admin/bookings/:bookingId/confirm-payment",
  authMiddleware,
  requireAdmin,
  asyncHandler(async (req, res) => {
    return res.status(410).json({
      message: "Confirmacao manual do admin foi desativada. A aprovacao ocorre automaticamente no recebimento do pagamento.",
    });
  })
);

app.get(
  "/api/admin/plan-purchases",
  authMiddleware,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    await expirePendingPayments();
    const result = await query(
      `
        SELECT
          pp.id,
          pp.user_id,
          pp.plan_type,
          pp.amount,
          pp.status,
          pp.created_at,
          pp.paid_at,
          u.username,
          u.name
        FROM plan_purchases pp
        INNER JOIN users u ON u.id = pp.user_id
        WHERE pp.status = 'pending_payment'
        ORDER BY pp.created_at ASC;
      `
    );

    return res.json(result.rows);
  })
);

app.post(
  "/api/admin/plan-purchases/:purchaseId/confirm-payment",
  authMiddleware,
  requireAdmin,
  asyncHandler(async (req, res) => {
    return res.status(410).json({
      message: "Confirmacao manual do admin foi desativada. O plano ativa automaticamente na compensacao PIX.",
    });
  })
);

app.post(
  "/api/admin/bookings/:bookingId/cancel",
  authMiddleware,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const bookingId = Number.parseInt(req.params.bookingId, 10);

    if (!Number.isInteger(bookingId)) {
      return res.status(400).json({ message: "Agendamento invalido." });
    }

    const result = await query(
      `
        UPDATE bookings
        SET status = 'cancelled',
            cancelled_at = NOW(),
            cancelled_by = $2
        WHERE id = $1
          AND status IN ('pending_payment', 'confirmed')
        RETURNING *;
      `,
      [bookingId, req.user.username]
    );

    const booking = result.rows[0];
    if (!booking) {
      return res.status(404).json({ message: "Agendamento nao encontrado ou nao pode ser cancelado." });
    }

    return res.json({
      message: "Agendamento cancelado com sucesso.",
      booking: {
        id: booking.id,
        day: booking.day,
        time: booking.time,
        status: booking.status,
        cancelledAt: booking.cancelled_at,
      },
    });
  })
);

app.get(
  "/api/admin/schedule",
  authMiddleware,
  requireAdmin,
  asyncHandler(async (req, res) => {
    await expirePendingPayments();
    const normalizedDay = normalizeDay(req.query.day);

    if (!isValidDayInCurrentMonth(normalizedDay)) {
      return res.status(400).json({ message: "Dia invalido para este mes." });
    }

    const result = await query(
      `
        SELECT * FROM bookings
        WHERE day = $1
          AND status IN ('pending_payment', 'confirmed');
      `,
      [normalizedDay]
    );

    const byTime = new Map(result.rows.map((row) => [row.time, row]));

    const slots = SLOT_TIMES.map((time) => {
      const booking = byTime.get(time);

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
          displayName: booking.display_name,
          username: booking.username,
          phone: booking.phone,
          service: booking.service,
          durationMinutes: booking.duration_minutes || getServiceDuration(booking.service),
        },
      };
    });

    return res.json({ day: normalizedDay, slots });
  })
);

app.use((error, _req, res, _next) => {
  console.error("Erro interno:", error);
  if (res.headersSent) {
    return;
  }
  res.status(500).json({ message: "Erro interno do servidor." });
});

Promise.resolve()
  .then(initDatabase)
  .then(ensureAdminOnly)
  .then(() => {
    const sweepTimer = setInterval(() => {
      expirePendingPayments().catch((error) => {
        console.error("Falha ao expirar pagamentos pendentes:", error);
      });
    }, getPaymentSweepIntervalMs());

    if (typeof sweepTimer.unref === "function") {
      sweepTimer.unref();
    }

    app.listen(PORT, () => {
      console.log(`Evilazio Barbershop online em http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Falha ao iniciar aplicacao:", error);
    process.exit(1);
  });
