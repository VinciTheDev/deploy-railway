# Evilazio Barbershop

Aplicacao Node.js (Express + PostgreSQL) para cadastro, login, agendamentos e pagamento PIX com confirmacao automatica via webhook.

## Requisitos

- Node.js 18+
- PostgreSQL

## Estrutura

- `server.js`: API + regras de negocio
- `public/`: frontend estatico
- `.env.example`: variaveis de ambiente

## Setup local

1. Instale dependencias:
   - `npm install`
2. Crie o arquivo `.env` baseado no `.env.example`.
3. Suba a aplicacao:
   - `npm start`

## Seguranca aplicada

- Headers de seguranca com `helmet`
- Rate limit global e de autenticacao
- Validacao e normalizacao de entradas
- Sessoes com expiracao automatica
- Admin por variavel de ambiente (sem hardcode fixo em producao)

## Pix automatico (Mercado Pago)

Configure no `.env`:

- `PIX_PROVIDER=mercadopago`
- `MERCADO_PAGO_ACCESS_TOKEN=...`
- `MERCADO_PAGO_WEBHOOK_SECRET=...` (recomendado)
- `MERCADO_PAGO_NOTIFICATION_URL=https://seu-dominio.com/api/payments/webhook/mercadopago`
- `MERCADO_PAGO_DEFAULT_PAYER_EMAIL={username}@seu-dominio.com`

Endpoint de webhook:

- `POST /api/payments/webhook/mercadopago`

Fluxo:

1. Sistema cria pagamento PIX via API `/v1/payments` do Mercado Pago.
2. Mercado Pago envia webhook.
3. Backend consulta pagamento oficial no Mercado Pago e confirma booking/plano automaticamente.

## Deploy na Hostinger

1. Crie o banco PostgreSQL e configure variaveis `DATABASE_URL` ou `PG*`.
2. Configure as variaveis do `.env.example` no painel da Hostinger.
3. Publique os arquivos (FTP/Git), sem `node_modules`.
4. No terminal da hospedagem, execute:
   - `npm install --omit=dev`
   - `npm start`
5. Configure o webhook do Mercado Pago para:
   - `https://seu-dominio.com/api/payments/webhook/mercadopago`

## Rotas principais

- `POST /api/register`
- `POST /api/login`
- `POST /api/bookings/create-payment`
- `GET /api/bookings/:bookingId/status`
- `POST /api/plans/create-payment`
- `GET /api/plans/purchases/:purchaseId/status`
- `POST /api/payments/webhook`
- `POST /api/payments/webhook/mercadopago`
