const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const { Pool } = require("pg");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();
const NODE_ENV = String(process.env.NODE_ENV || "development").toLowerCase();
const IS_PRODUCTION = NODE_ENV === "production";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
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
  ssl: IS_PRODUCTION ? { rejectUnauthorized: false } : undefined,
});

const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || "admin")
  .trim()
  .toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "").trim();
const RESET_ADMIN_PASSWORD_ON_BOOT = String(process.env.RESET_ADMIN_PASSWORD_ON_BOOT || "false").toLowerCase() === "true";

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
const SERVICE_PRICES = {
  corte_social: 35,
  corte_tradicional: 35,
  corte_degrade: 40,
  corte_navalhado: 45,
  barba: 20,
  sobrancelha: 15,
  pezinho: 20,
  corte_barba: 55,
  corte_barba_sobrancelha: 65,
  teste_pix_1_centavo: 0.01,
};
const PAYMENT_EXPIRATION_MINUTES = Number.parseInt(process.env.PAYMENT_EXPIRATION_MINUTES || "20", 10);
const PAYMENT_SWEEP_INTERVAL_MS = Number.parseInt(process.env.PAYMENT_SWEEP_INTERVAL_MS || "30000", 10);
const PIX_KEY = "ee96c7d1-b09b-46ad-a324-42ee01713b38";
const PIX_QR_IMAGE_URL = process.env.PIX_QR_IMAGE_URL || "/images/qrcode-pix.png";
const APP_TIMEZONE = process.env.APP_TIMEZONE || "America/Fortaleza";
const PAYMENT_WEBHOOK_TOKEN = process.env.PAYMENT_WEBHOOK_TOKEN || "";
const APP_BASE_URL = String(process.env.APP_BASE_URL || "").replace(/\/+$/, "");
const PIX_PROVIDER = String(process.env.PIX_PROVIDER || "").toLowerCase();
const MERCADO_PAGO_ACCESS_TOKEN = String(process.env.MERCADO_PAGO_ACCESS_TOKEN || "").trim();
const MERCADO_PAGO_WEBHOOK_SECRET = String(process.env.MERCADO_PAGO_WEBHOOK_SECRET || "").trim();
const MERCADO_PAGO_API_BASE_URL = String(process.env.MERCADO_PAGO_API_BASE_URL || "https://api.mercadopago.com").replace(/\/+$/, "");
const MERCADO_PAGO_NOTIFICATION_URL =
  String(process.env.MERCADO_PAGO_NOTIFICATION_URL || "").trim() ||
  (APP_BASE_URL ? `${APP_BASE_URL}/api/payments/webhook/mercadopago` : "");
const MERCADO_PAGO_DEFAULT_PAYER_EMAIL = String(process.env.MERCADO_PAGO_DEFAULT_PAYER_EMAIL || "checkout@evilaziobarbershop.com").trim();
const SESSION_TTL_MS = Number.parseInt(process.env.SESSION_TTL_MS || `${12 * 60 * 60 * 1000}`, 10);
const SESSION_SWEEP_INTERVAL_MS = Number.parseInt(process.env.SESSION_SWEEP_INTERVAL_MS || `${5 * 60 * 1000}`, 10);
const MAX_JSON_BODY_SIZE = process.env.MAX_JSON_BODY_SIZE || "100kb";
const MAX_ACTIVE_SESSIONS = Number.parseInt(process.env.MAX_ACTIVE_SESSIONS || "5000", 10);

const sessions = new Map();

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https://api.qrserver.com", "https://www.mercadopago.com", "https://http2.mlstatic.com"],
        styleSrc: ["'self'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    referrerPolicy: { policy: "no-referrer" },
    hsts: IS_PRODUCTION ? undefined : false,
  })
);

app.use(express.json({ limit: MAX_JSON_BODY_SIZE }));
app.use(express.static(path.join(__dirname, "public")));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Muitas requisicoes. Tente novamente em alguns minutos." },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Muitas tentativas de acesso. Aguarde alguns minutos." },
});

app.use("/api", apiLimiter);

function buildPixPayment(prefix, description, providedPaymentCode = "") {
  const paymentCode = String(providedPaymentCode || "").trim() || `${prefix}${Date.now()}${crypto.randomBytes(3).toString("hex")}`;
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

function getServicePrice(service) {
  const key = normalizeServiceKey(service);
  if (!key) {
    return null;
  }
  const amount = Number(SERVICE_PRICES[key]);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function normalizeUsernameInput(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (!/^[a-z0-9._-]{3,32}$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeDisplayNameInput(value) {
  const normalized = String(value || "").trim().replace(/\s+/g, " ");
  if (normalized.length < 2 || normalized.length > 80) {
    return null;
  }
  return normalized;
}

function normalizePhoneInput(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^\d+\-() ]/g, "")
    .replace(/\s+/g, " ");

  if (normalized.length < 8 || normalized.length > 25) {
    return null;
  }

  return normalized;
}

function getSessionTtlMs() {
  if (!Number.isFinite(SESSION_TTL_MS) || SESSION_TTL_MS < 5 * 60 * 1000) {
    return 12 * 60 * 60 * 1000;
  }
  return SESSION_TTL_MS;
}

function getSessionSweepIntervalMs() {
  if (!Number.isFinite(SESSION_SWEEP_INTERVAL_MS) || SESSION_SWEEP_INTERVAL_MS < 60 * 1000) {
    return 5 * 60 * 1000;
  }
  return SESSION_SWEEP_INTERVAL_MS;
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (!session || !Number.isFinite(session.expiresAt) || session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

function shouldUseMercadoPago() {
  if (PIX_PROVIDER === "mock") {
    return false;
  }
  if (PIX_PROVIDER === "mercadopago") {
    return Boolean(MERCADO_PAGO_ACCESS_TOKEN);
  }
  return Boolean(MERCADO_PAGO_ACCESS_TOKEN);
}

function getMercadoPagoNotificationUrl() {
  return MERCADO_PAGO_NOTIFICATION_URL || "";
}

function toMoneyAmount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Number(parsed.toFixed(2));
}

function buildInternalPaymentCode(prefix) {
  return `${prefix}${Date.now()}${crypto.randomBytes(4).toString("hex")}`;
}

function buildMercadoPagoPayerEmail(user) {
  const username = normalizeUsernameInput(user?.username) || "cliente";
  if (MERCADO_PAGO_DEFAULT_PAYER_EMAIL) {
    return MERCADO_PAGO_DEFAULT_PAYER_EMAIL.replace("{username}", username);
  }
  return `${username}+checkout@evilaziobarbershop.com`;
}

function parseExternalReferenceData(externalReference) {
  const normalized = String(externalReference || "").trim();
  if (!normalized) {
    return { bookingId: null, purchaseId: null, paymentCode: "" };
  }

  const bookingMatch = normalized.match(/^booking_(\d+)_([\w-]+)$/i);
  if (bookingMatch) {
    return {
      bookingId: Number.parseInt(bookingMatch[1], 10),
      purchaseId: null,
      paymentCode: bookingMatch[2],
    };
  }

  const purchaseMatch = normalized.match(/^plan_(\d+)_([\w-]+)$/i);
  if (purchaseMatch) {
    return {
      bookingId: null,
      purchaseId: Number.parseInt(purchaseMatch[1], 10),
      paymentCode: purchaseMatch[2],
    };
  }

  return {
    bookingId: null,
    purchaseId: null,
    paymentCode: normalized,
  };
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
      provider: row.payment_provider || "mock",
      providerPaymentId: row.payment_provider_id || null,
      externalReference: row.payment_external_reference || null,
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

function getMercadoPagoWebhookDataId(req) {
  const queryDataId = req.query?.["data.id"];
  const queryId = req.query?.id;
  const bodyDataId = req.body?.data?.id;
  const bodyId = req.body?.id;

  const parsed = Number.parseInt(String(queryDataId || queryId || bodyDataId || bodyId || ""), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function normalizeMercadoPagoStatus(status) {
  const normalized = String(status || "")
    .toLowerCase()
    .trim();

  if (normalized === "approved") {
    return "paid";
  }

  if (["pending", "in_process", "in_mediation", "authorized"].includes(normalized)) {
    return "pending";
  }

  if (["rejected", "cancelled", "cancelled_by_user", "charged_back", "refunded"].includes(normalized)) {
    return "failed";
  }

  return normalized;
}

function validateMercadoPagoWebhookSignature(req) {
  if (!MERCADO_PAGO_WEBHOOK_SECRET) {
    return true;
  }

  const xSignature = String(req.headers["x-signature"] || "").trim();
  const xRequestId = String(req.headers["x-request-id"] || "").trim();
  const dataId = String(req.query?.["data.id"] || req.body?.data?.id || "").trim();
  if (!xSignature || !xRequestId || !dataId) {
    return false;
  }

  const parts = xSignature
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const ts = parts.find((part) => part.startsWith("ts="))?.slice(3) || "";
  const v1 = parts.find((part) => part.startsWith("v1="))?.slice(3) || "";
  if (!ts || !v1) {
    return false;
  }

  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
  const hmac = crypto.createHmac("sha256", MERCADO_PAGO_WEBHOOK_SECRET).update(manifest).digest("hex");
  const digestBuffer = Buffer.from(hmac);
  const signatureBuffer = Buffer.from(v1);
  if (digestBuffer.length !== signatureBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(digestBuffer, signatureBuffer);
}

async function createMercadoPagoPixPayment({
  amount,
  description,
  externalReference,
  payerEmail,
  metadata,
}) {
  if (!MERCADO_PAGO_ACCESS_TOKEN) {
    throw new Error("MERCADO_PAGO_ACCESS_TOKEN nao configurado.");
  }

  const payload = {
    transaction_amount: amount,
    description,
    payment_method_id: "pix",
    payer: {
      email: payerEmail,
    },
    external_reference: externalReference,
    notification_url: getMercadoPagoNotificationUrl() || undefined,
    metadata: metadata || undefined,
  };

  const idempotencyKey = crypto.randomUUID();
  const response = await fetch(`${MERCADO_PAGO_API_BASE_URL}/v1/payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`,
      "X-Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text();
  let responseBody = {};
  if (bodyText) {
    try {
      responseBody = JSON.parse(bodyText);
    } catch (_error) {
      responseBody = { raw: bodyText };
    }
  }

  if (!response.ok) {
    const detail = responseBody?.message || responseBody?.cause?.[0]?.description || "Erro ao criar pagamento PIX no Mercado Pago.";
    throw new Error(detail);
  }

  const paymentId = responseBody?.id ? String(responseBody.id) : "";
  const txData = responseBody?.point_of_interaction?.transaction_data || {};
  const qrCode = String(txData?.qr_code || "").trim();
  const qrCodeBase64 = String(txData?.qr_code_base64 || "").trim();
  const qrImageUrl = qrCodeBase64 ? `data:image/png;base64,${qrCodeBase64}` : PIX_QR_IMAGE_URL;

  return {
    providerPaymentId: paymentId,
    status: String(responseBody?.status || "").trim().toLowerCase(),
    externalReference: String(responseBody?.external_reference || externalReference || "").trim(),
    qrCode,
    qrImageUrl,
    ticketUrl: String(txData?.ticket_url || "").trim(),
    raw: responseBody,
  };
}

async function getMercadoPagoPaymentById(paymentId) {
  if (!MERCADO_PAGO_ACCESS_TOKEN) {
    throw new Error("MERCADO_PAGO_ACCESS_TOKEN nao configurado.");
  }

  const normalizedId = String(paymentId || "").trim();
  if (!normalizedId) {
    throw new Error("paymentId do Mercado Pago invalido.");
  }

  const response = await fetch(`${MERCADO_PAGO_API_BASE_URL}/v1/payments/${encodeURIComponent(normalizedId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`,
    },
  });

  const bodyText = await response.text();
  let responseBody = {};
  if (bodyText) {
    try {
      responseBody = JSON.parse(bodyText);
    } catch (_error) {
      responseBody = { raw: bodyText };
    }
  }

  if (!response.ok) {
    const detail = responseBody?.message || "Falha ao consultar pagamento no Mercado Pago.";
    throw new Error(detail);
  }

  return responseBody;
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
      payment_provider TEXT,
      payment_provider_id TEXT,
      payment_external_reference TEXT,
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
      payment_provider TEXT,
      payment_provider_id TEXT,
      payment_external_reference TEXT,
      qr_text TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ
    );
  `);

  await query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;");
  await query("ALTER TABLE plan_purchases ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;");
  await query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_provider TEXT;");
  await query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_provider_id TEXT;");
  await query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_external_reference TEXT;");
  await query("ALTER TABLE plan_purchases ADD COLUMN IF NOT EXISTS payment_provider TEXT;");
  await query("ALTER TABLE plan_purchases ADD COLUMN IF NOT EXISTS payment_provider_id TEXT;");
  await query("ALTER TABLE plan_purchases ADD COLUMN IF NOT EXISTS payment_external_reference TEXT;");

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

  await query(`
    CREATE INDEX IF NOT EXISTS idx_bookings_payment_code
    ON bookings(payment_code);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_plan_purchases_payment_code
    ON plan_purchases(payment_code);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_bookings_provider_payment
    ON bookings(payment_provider, payment_provider_id);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_plan_purchases_provider_payment
    ON plan_purchases(payment_provider, payment_provider_id);
  `);
}

async function ensureAdminOnly() {
  const monthKey = getCurrentMonthKey();
  const existingAdminResult = await query(
    "SELECT id FROM users WHERE username = $1 LIMIT 1",
    [ADMIN_USERNAME]
  );
  const existingAdmin = existingAdminResult.rows[0];

  if (!existingAdmin && !ADMIN_PASSWORD) {
    if (IS_PRODUCTION) {
      throw new Error(
        "ADMIN_PASSWORD nao configurada. Defina ADMIN_USERNAME e ADMIN_PASSWORD antes de subir em producao."
      );
    }
    console.warn("ADMIN_PASSWORD nao configurada. Usando senha local padrao somente para desenvolvimento.");
  }

  if (!existingAdmin) {
    const initialPassword = ADMIN_PASSWORD || "001212";
    const adminPasswordHash = await hashPassword(initialPassword);

    await query(
      `
        INSERT INTO users (username, name, phone, role, password_hash, plan_type, preferred_cut, plan_month_key, common_cuts_used)
        VALUES ($1, $2, '', 'admin', $3, 'none', '', $4, 0)
        ON CONFLICT (username)
        DO NOTHING;
      `,
      [ADMIN_USERNAME, "Administrador", adminPasswordHash, monthKey]
    );
    return;
  }

  if (RESET_ADMIN_PASSWORD_ON_BOOT && ADMIN_PASSWORD) {
    const adminPasswordHash = await hashPassword(ADMIN_PASSWORD);
    await query(
      `
        UPDATE users
        SET password_hash = $2,
            updated_at = NOW()
        WHERE username = $1;
      `,
      [ADMIN_USERNAME, adminPasswordHash]
    );
  }
}

function createSession(userId, req) {
  cleanupExpiredSessions();
  if (sessions.size >= MAX_ACTIVE_SESSIONS) {
    // Remove the oldest session when limit is reached to avoid memory growth.
    const oldest = [...sessions.entries()].sort((a, b) => (a[1]?.createdAt || 0) - (b[1]?.createdAt || 0))[0];
    if (oldest?.[0]) {
      sessions.delete(oldest[0]);
    }
  }

  const now = Date.now();
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, {
    userId,
    createdAt: now,
    expiresAt: now + getSessionTtlMs(),
    ip: req.ip,
    userAgent: String(req.headers["user-agent"] || ""),
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
    if (!session || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return res.status(401).json({ message: "Sessao expirada. Faca login novamente." });
    }
    const user = await getUserById(session.userId);

    if (!user) {
      sessions.delete(token);
      return res.status(401).json({ message: "Sessao invalida." });
    }

    session.expiresAt = Date.now() + getSessionTtlMs();
    sessions.set(token, session);
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

async function confirmPlanPurchase(client, purchase, paidAtValue) {
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

  return {
    ok: true,
    type: "plan_purchase",
    id: purchase.id,
    status: "confirmed",
  };
}

async function confirmBooking(client, booking, paidAtValue) {
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

  return {
    ok: true,
    type: "booking",
    id: booking.id,
    status: "confirmed",
  };
}

async function confirmPaymentByReferences(
  client,
  { paymentCode = "", bookingId = null, purchaseId = null, providerPaymentId = "", externalReference = "", paidAtValue = new Date() }
) {
  const paidAt = paidAtValue instanceof Date && !Number.isNaN(paidAtValue.getTime()) ? paidAtValue : new Date();
  const normalizedPaymentCode = String(paymentCode || "").trim();
  const normalizedProviderPaymentId = String(providerPaymentId || "").trim();
  const externalReferenceData = parseExternalReferenceData(externalReference);

  const possiblePurchaseIds = [purchaseId, externalReferenceData.purchaseId].filter(Number.isInteger);
  const possibleBookingIds = [bookingId, externalReferenceData.bookingId].filter(Number.isInteger);
  const possiblePaymentCodes = [normalizedPaymentCode, externalReferenceData.paymentCode].filter(Boolean);

  for (const directPurchaseId of possiblePurchaseIds) {
    const purchaseResult = await client.query(
      `
        SELECT *
        FROM plan_purchases
        WHERE id = $1
          AND status = 'pending_payment'
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1
        FOR UPDATE;
      `,
      [directPurchaseId]
    );
    const purchase = purchaseResult.rows[0];
    if (purchase) {
      return confirmPlanPurchase(client, purchase, paidAt);
    }
  }

  for (const directBookingId of possibleBookingIds) {
    const bookingResult = await client.query(
      `
        SELECT *
        FROM bookings
        WHERE id = $1
          AND status = 'pending_payment'
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1
        FOR UPDATE;
      `,
      [directBookingId]
    );
    const booking = bookingResult.rows[0];
    if (booking) {
      return confirmBooking(client, booking, paidAt);
    }
  }

  if (normalizedProviderPaymentId) {
    const providerPurchaseResult = await client.query(
      `
        SELECT *
        FROM plan_purchases
        WHERE payment_provider_id = $1
          AND status = 'pending_payment'
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE;
      `,
      [normalizedProviderPaymentId]
    );

    const providerPurchase = providerPurchaseResult.rows[0];
    if (providerPurchase) {
      return confirmPlanPurchase(client, providerPurchase, paidAt);
    }

    const providerBookingResult = await client.query(
      `
        SELECT *
        FROM bookings
        WHERE payment_provider_id = $1
          AND status = 'pending_payment'
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE;
      `,
      [normalizedProviderPaymentId]
    );

    const providerBooking = providerBookingResult.rows[0];
    if (providerBooking) {
      return confirmBooking(client, providerBooking, paidAt);
    }
  }

  for (const code of possiblePaymentCodes) {
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
      [code]
    );

    const purchase = purchaseResult.rows[0];
    if (purchase) {
      return confirmPlanPurchase(client, purchase, paidAt);
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
      [code]
    );

    const booking = bookingResult.rows[0];
    if (booking) {
      return confirmBooking(client, booking, paidAt);
    }
  }

  return null;
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    pixProvider: shouldUseMercadoPago() ? "mercadopago" : "mock",
  });
});

app.post(
  "/api/register",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { username, displayName, phone, password } = req.body || {};

    if (!username || !displayName || !phone || !password) {
      return res.status(400).json({ message: "Preencha usuario, nome de exibicao, telefone e senha." });
    }

    if (String(password).length < 6) {
      return res.status(400).json({ message: "A senha deve ter pelo menos 6 caracteres." });
    }
    if (String(password).length > 128) {
      return res.status(400).json({ message: "A senha excede o tamanho maximo permitido." });
    }

    const normalizedUsername = normalizeUsernameInput(username);
    const normalizedDisplayName = normalizeDisplayNameInput(displayName);
    const normalizedPhone = normalizePhoneInput(phone);

    if (!normalizedUsername) {
      return res.status(400).json({
        message: "Usuario invalido. Use 3-32 caracteres com letras minusculas, numeros, ponto, underline ou hifen.",
      });
    }

    if (!normalizedDisplayName) {
      return res.status(400).json({ message: "Nome de exibicao invalido." });
    }

    if (!normalizedPhone) {
      return res.status(400).json({ message: "Telefone invalido." });
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
      [normalizedUsername, normalizedDisplayName, normalizedPhone, passwordHash, getCurrentMonthKey()]
    );

    return res.status(201).json({ message: "Cadastro realizado com sucesso." });
  })
);

app.post(
  "/api/login",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ message: "Informe usuario e senha." });
    }
    if (String(password).length > 128) {
      return res.status(401).json({ message: "Credenciais invalidas." });
    }

    const normalizedUsername = normalizeUsernameInput(username);
    if (!normalizedUsername) {
      return res.status(401).json({ message: "Credenciais invalidas." });
    }

    const user = await getUserByUsername(normalizedUsername);
    if (!user) {
      return res.status(401).json({ message: "Credenciais invalidas." });
    }

    const validPassword = await verifyPassword(String(password), user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ message: "Credenciais invalidas." });
    }

    const token = createSession(user.id, req);

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
    const { displayName, phone, password } = req.body || {};
    const normalizedDisplayName = normalizeDisplayNameInput(displayName);
    const normalizedPhone = normalizePhoneInput(phone);

    if (!normalizedDisplayName) {
      return res.status(400).json({ message: "Nome de exibicao invalido." });
    }

    if (!normalizedPhone) {
      return res.status(400).json({ message: "Telefone invalido." });
    }

    if (password && String(password).length < 6) {
      return res.status(400).json({ message: "A senha deve ter pelo menos 6 caracteres." });
    }
    if (password && String(password).length > 128) {
      return res.status(400).json({ message: "A senha excede o tamanho maximo permitido." });
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
        [normalizedDisplayName, normalizedPhone, passwordHash, req.user.id]
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
        [normalizedDisplayName, normalizedPhone, req.user.id]
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
    const paymentCode = buildInternalPaymentCode("PLAN");
    const payment = buildPixPayment("PLAN", `Plano ${normalizedPlanType.toUpperCase()} Evilazio`, paymentCode);
    const expiresAt = buildPaymentExpiryDate();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const insert = await client.query(
        `
          INSERT INTO plan_purchases (
            user_id, plan_type, preferred_cut, amount, status, pix_key, payment_code, qr_text, expires_at, payment_provider
          )
          VALUES ($1, $2, '', $3, 'pending_payment', $4, $5, $6, $7, $8)
          RETURNING id;
        `,
        [
          req.user.id,
          normalizedPlanType,
          amount,
          payment.pixKey,
          paymentCode,
          payment.qrText,
          expiresAt,
          shouldUseMercadoPago() ? "mercadopago" : "mock",
        ]
      );
      const purchaseId = insert.rows[0].id;

      if (shouldUseMercadoPago()) {
        const externalReference = `plan_${purchaseId}_${paymentCode}`;
        const mercadoPagoPayment = await createMercadoPagoPixPayment({
          amount: toMoneyAmount(amount),
          description: `Plano ${normalizedPlanType.toUpperCase()} Evilazio`,
          externalReference,
          payerEmail: buildMercadoPagoPayerEmail(req.user),
          metadata: {
            purchaseId,
            paymentCode,
            source: "evilazio-barbershop",
          },
        });

        await client.query(
          `
            UPDATE plan_purchases
            SET status = 'pending_payment',
                pix_key = '',
                qr_text = $2,
                payment_provider = 'mercadopago',
                payment_provider_id = $3,
                payment_external_reference = $4
            WHERE id = $1;
          `,
          [
            purchaseId,
            mercadoPagoPayment.qrCode,
            mercadoPagoPayment.providerPaymentId || null,
            mercadoPagoPayment.externalReference,
          ]
        );

        await client.query("COMMIT");
        return res.status(201).json({
          message: "Pagamento PIX do plano gerado no Mercado Pago.",
          purchaseId,
          planType: normalizedPlanType,
          amount,
          payment: {
            provider: "mercadopago",
            pixKey: mercadoPagoPayment.qrCode,
            paymentCode,
            qrText: mercadoPagoPayment.qrCode,
            qrImageUrl: mercadoPagoPayment.qrImageUrl,
            ticketUrl: mercadoPagoPayment.ticketUrl || null,
            expiresAt,
          },
        });
      }

      await client.query("COMMIT");
      return res.status(201).json({
        message: "Pagamento PIX do plano gerado.",
        purchaseId,
        planType: normalizedPlanType,
        amount,
        payment: {
          provider: "mock",
          pixKey: payment.pixKey,
          paymentCode,
          qrText: payment.qrText,
          qrImageUrl: payment.qrImageUrl,
          expiresAt,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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

    const { day, time, service, phone, paymentMethod } = req.body || {};
    const normalizedDay = normalizeDay(day);
    const normalizedService = String(service || "").trim();
    const normalizedPhone = normalizePhoneInput(phone);

    if (!normalizedDay || !isValidDayInCurrentMonth(normalizedDay)) {
      return res.status(400).json({ message: "Escolha um dia valido no mes atual, sem datas passadas." });
    }

    if (!isValidSlotTime(time)) {
      return res.status(400).json({ message: "Horario invalido. Escolha entre 08:00 e 19:00." });
    }

    if (!normalizedService || !normalizedPhone) {
      return res.status(400).json({ message: "Informe servico e telefone." });
    }

    const serviceDuration = getServiceDuration(normalizedService);
    if (!serviceDuration) {
      return res.status(400).json({ message: "Servico invalido para agendamento." });
    }
    const servicePrice = getServicePrice(normalizedService);
    if (!servicePrice) {
      return res.status(400).json({ message: "Servico sem preco configurado." });
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
        const isCutService = CUT_SERVICE_KEYS.has(normalizeServiceKey(normalizedService));
        const isPreferredCut =
          !userPlan.preferredCut || normalizeServiceKey(userPlan.preferredCut) === normalizeServiceKey(normalizedService);
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
            normalizedPhone,
            normalizedService,
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

      const paymentCode = buildInternalPaymentCode("EVLZ");
      const payment = buildPixPayment("EVLZ", "Evilazio Barbershop", paymentCode);
      const expiresAt = buildPaymentExpiryDate();

      const insertPixBooking = await client.query(
        `
          INSERT INTO bookings (
            user_id, username, display_name, phone, service, duration_minutes,
            day, time, status, payment_method, payment_provider, payment_pix_key, payment_code, payment_qr_text, expires_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending_payment', 'pix', $9, $10, $11, $12, $13)
          RETURNING *;
        `,
        [
          req.user.id,
          req.user.username,
            req.user.name || req.user.username,
            normalizedPhone,
          normalizedService,
          serviceDuration,
          normalizedDay,
          String(time),
          shouldUseMercadoPago() ? "mercadopago" : "mock",
          payment.pixKey,
          paymentCode,
          payment.qrText,
          expiresAt,
        ]
      );
      const bookingRow = insertPixBooking.rows[0];

      if (shouldUseMercadoPago()) {
        const externalReference = `booking_${bookingRow.id}_${paymentCode}`;
        const mercadoPagoPayment = await createMercadoPagoPixPayment({
          amount: toMoneyAmount(servicePrice),
          description: `Agendamento ${normalizedService} - Evilazio Barbershop`,
          externalReference,
          payerEmail: buildMercadoPagoPayerEmail(req.user),
          metadata: {
            bookingId: bookingRow.id,
            paymentCode,
            source: "evilazio-barbershop",
          },
        });

        await client.query(
          `
            UPDATE bookings
            SET payment_provider = 'mercadopago',
                payment_provider_id = $2,
                payment_external_reference = $3,
                payment_qr_text = $4,
                payment_pix_key = ''
            WHERE id = $1;
          `,
          [bookingRow.id, mercadoPagoPayment.providerPaymentId || null, mercadoPagoPayment.externalReference, mercadoPagoPayment.qrCode]
        );

        await client.query("COMMIT");
        return res.status(201).json({
          message: "PIX Mercado Pago gerado. O horario sera confirmado automaticamente apos compensacao.",
          bookingId: bookingRow.id,
          durationMinutes: bookingRow.duration_minutes,
          payment: {
            provider: "mercadopago",
            amount: toMoneyAmount(servicePrice),
            pixKey: mercadoPagoPayment.qrCode,
            paymentCode,
            qrText: mercadoPagoPayment.qrCode,
            qrImageUrl: mercadoPagoPayment.qrImageUrl,
            ticketUrl: mercadoPagoPayment.ticketUrl || null,
            expiresAt,
          },
        });
      }

      await client.query("COMMIT");
      const booking = parseBookingRow(bookingRow);

      return res.status(201).json({
        message: "Pagamento PIX gerado. Aguarde confirmacao para liberar o horario como ocupado.",
        bookingId: booking.id,
        durationMinutes: booking.durationMinutes,
        payment: {
          provider: "mock",
          amount: toMoneyAmount(servicePrice),
          pixKey: payment.pixKey,
          paymentCode,
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
    const providerPaymentId = String(
      req.body?.providerPaymentId ||
        req.body?.provider_payment_id ||
        req.body?.paymentId ||
        req.body?.payment_id ||
        req.body?.metadata?.providerPaymentId ||
        req.body?.metadata?.provider_payment_id ||
        ""
    ).trim();
    const externalReference = String(
      req.body?.externalReference || req.body?.external_reference || req.body?.metadata?.externalReference || ""
    ).trim();

    if (
      !paymentCode &&
      !providerPaymentId &&
      !externalReference &&
      !Number.isInteger(bookingId) &&
      !Number.isInteger(purchaseId)
    ) {
      return res.status(400).json({
        message: "Informe paymentCode, providerPaymentId, externalReference, bookingId ou purchaseId no webhook.",
      });
    }

    if (status !== "paid") {
      return res.json({ ok: true, ignored: true, reason: "status_not_paid" });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await expirePendingPayments(client);
      const confirmed = await confirmPaymentByReferences(client, {
        paymentCode,
        bookingId: Number.isInteger(bookingId) ? bookingId : null,
        purchaseId: Number.isInteger(purchaseId) ? purchaseId : null,
        providerPaymentId,
        externalReference,
        paidAtValue,
      });

      await client.query("COMMIT");
      if (confirmed) {
        return res.json(confirmed);
      }
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
  "/api/payments/webhook/mercadopago",
  asyncHandler(async (req, res) => {
    if (!MERCADO_PAGO_ACCESS_TOKEN) {
      return res.status(503).json({ message: "Mercado Pago nao configurado no backend." });
    }

    if (!validateMercadoPagoWebhookSignature(req)) {
      return res.status(401).json({ message: "Assinatura do webhook Mercado Pago invalida." });
    }

    const topic = String(req.query?.topic || req.query?.type || req.body?.type || req.body?.topic || "").toLowerCase().trim();
    if (topic && topic !== "payment") {
      return res.json({ ok: true, ignored: true, reason: "topic_not_payment" });
    }
    const action = String(req.body?.action || "").toLowerCase().trim();
    if (action && !action.startsWith("payment.")) {
      return res.json({ ok: true, ignored: true, reason: "action_not_payment" });
    }

    const webhookPaymentId = getMercadoPagoWebhookDataId(req);
    if (!webhookPaymentId) {
      return res.status(400).json({ message: "Webhook Mercado Pago sem data.id de pagamento." });
    }

    const remotePayment = await getMercadoPagoPaymentById(webhookPaymentId);
    const normalizedStatus = normalizeMercadoPagoStatus(remotePayment?.status);
    if (normalizedStatus !== "paid") {
      return res.json({ ok: true, ignored: true, reason: "payment_not_approved", status: remotePayment?.status || "" });
    }

    const metadata = remotePayment?.metadata || {};
    const metadataBookingId = Number.parseInt(String(metadata?.bookingId || metadata?.booking_id || ""), 10);
    const metadataPurchaseId = Number.parseInt(String(metadata?.purchaseId || metadata?.purchase_id || ""), 10);
    const metadataPaymentCode = String(metadata?.paymentCode || metadata?.payment_code || "").trim();
    const paymentApprovedAt = extractWebhookPaidAt({
      paidAt: remotePayment?.date_approved || remotePayment?.date_last_updated || remotePayment?.date_created,
    });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expirePendingPayments(client);
      const confirmed = await confirmPaymentByReferences(client, {
        paymentCode: metadataPaymentCode,
        bookingId: Number.isInteger(metadataBookingId) ? metadataBookingId : null,
        purchaseId: Number.isInteger(metadataPurchaseId) ? metadataPurchaseId : null,
        providerPaymentId: String(remotePayment?.id || webhookPaymentId),
        externalReference: String(remotePayment?.external_reference || ""),
        paidAtValue: paymentApprovedAt,
      });

      await client.query("COMMIT");
      if (confirmed) {
        return res.json({ ...confirmed, provider: "mercadopago" });
      }

      return res.status(404).json({
        ok: false,
        provider: "mercadopago",
        message: "Pagamento aprovado no Mercado Pago, mas sem reserva pendente correspondente.",
      });
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

app.use((error, _req, res, next) => {
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ message: "Payload muito grande." });
  }
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ message: "JSON invalido na requisicao." });
  }
  return next(error);
});

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

    const sessionSweepTimer = setInterval(() => {
      cleanupExpiredSessions();
    }, getSessionSweepIntervalMs());

    if (typeof sessionSweepTimer.unref === "function") {
      sessionSweepTimer.unref();
    }

    if (!IS_PRODUCTION && !ADMIN_PASSWORD) {
      console.warn("ADMIN_PASSWORD nao definida. Em desenvolvimento, a senha inicial padrao do admin e 001212.");
    }

    if (shouldUseMercadoPago()) {
      console.log("Pagamento PIX ativo com Mercado Pago.");
      if (!getMercadoPagoNotificationUrl()) {
        console.warn("MERCADO_PAGO_NOTIFICATION_URL nao definida. O webhook deve apontar para /api/payments/webhook/mercadopago.");
      }
    } else {
      console.warn("Pagamento PIX em modo mock. Defina MERCADO_PAGO_ACCESS_TOKEN para usar PIX real.");
    }

    app.listen(PORT, () => {
      console.log(`Evilazio Barbershop online em http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Falha ao iniciar aplicacao:", error);
    process.exit(1);
  });
