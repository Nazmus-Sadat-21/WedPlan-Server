<div align="center">

# ⚙️ WedPlan — Wedding Planning Platform (Server API)

**RESTful Express.js & MongoDB backend powering role-based authorization, vendor service moderation, booking workflows, and Stripe webhook subscriptions.**

[![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Express.js](https://img.shields.io/badge/Express.js-REST_API-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com/)
[![MongoDB](https://img.shields.io/badge/MongoDB-Atlas-47A248?style=for-the-badge&logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![Better Auth](https://img.shields.io/badge/Better_Auth-Session_%26_JWT-10B981?style=for-the-badge)](https://www.better-auth.com/)
[![Stripe](https://img.shields.io/badge/Stripe-Webhooks_%26_Checkout-635BFF?style=for-the-badge&logo=stripe&logoColor=white)](https://stripe.com/)

[🌐 **Live Client App**](https://your-wedplan-client.vercel.app) • [🎨 **Client Repository**](https://github.com/Nazmus-Sadat-21/wedplan-client) • [🚀 **Live API Base URL**](https://your-wedplan-server.vercel.app)

</div>

---

## ✨ Overview

The **WedPlan Server** is a secure Express.js and MongoDB backend designed for the WedPlan wedding marketplace. It handles authentication sessions and JWT verification, enforces server-side Role-Based Access Control (`admin`, `vendor`, `customer`), blocks suspended users, validates resource ownership, enforces free-tier vendor limits (max 3 active services), and processes **Stripe Checkout** sessions alongside signature-verified **Stripe Webhooks**.

---

## 🔗 Quick Links

| Resource | Link |
| :--- | :--- |
| **Live Production API** | `https://your-wedplan-server.vercel.app` *(Replace with your deployed API URL)* |
| **Live Client Website** | `https://your-wedplan-client.vercel.app` |
| **Server GitHub Repository** | `https://github.com/Nazmus-Sadat-21/wedplan-server` |
| **Client GitHub Repository** | `https://github.com/Nazmus-Sadat-21/wedplan-client` |

---

## 🛡️ Core Architecture & Security

- **JWT & Session Authentication:** Verifies bearer tokens and Better Auth sessions via dedicated middleware, rejecting invalid or expired tokens with `401 Unauthorized`.
- **Role-Based Access Control (RBAC):** Dedicated `verifyAdmin`, `verifyVendor`, and `verifyCustomer` middlewares return `403 Forbidden` when unauthorized roles attempt restricted actions.
- **Blocked User Enforcement:** Middleware checks `isBlocked` status on protected routes and prevents suspended users from creating bookings, services, or checkout sessions.
- **Resource Ownership Verification:** Ensures vendors can only modify/delete their own services and bookings, and customers can only cancel their own `Pending` bookings.
- **Stripe Webhook Security:** Premium vendor status (`subscriptionPlan: "premium"`) is activated **only** after verifying the `stripe-signature` header on `checkout.session.completed` webhook events—never solely from frontend redirects.
- **Free Tier Quota Enforcement:** Automatically restricts `free` plan vendors to a maximum of **3 active services** unless upgraded to `premium`.

---

## 🗄️ MongoDB Collections Schema

In addition to Better Auth's internal authentication collections, WedPlan uses four structured collections:

| Collection | Key Fields | Purpose |
| :--- | :--- | :--- |
| **`users`** | `name`, `email`, `image`, `role`, `isBlocked`, `businessName`, `subscriptionPlan`, `subscriptionExpiresAt` | Stores user accounts, roles, block status, and vendor subscription tiers. |
| **`services`** | `vendorId`, `serviceName`, `category`, `description`, `price`, `location`, `images`, `availability`, `status`, `createdAt` | Wedding service listings (`pending`, `approved`, `rejected`). |
| **`bookings`** | `serviceId`, `vendorId`, `customerId`, `eventDate`, `eventLocation`, `message`, `status`, `createdAt` | Customer booking inquiries (`Pending`, `Accepted`, `Rejected`, `Cancelled`). |
| **`transactions`** | `vendorId`, `plan`, `amount`, `currency`, `stripeSessionId`, `stripeSubscriptionId`, `status`, `createdAt` | Immutable audit records of Stripe subscription payments. |

---

## 📡 API Endpoints Reference

### 👤 Users & Profile
| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/users` | Admin | Retrieve all registered users with search/role filtering |
| `PATCH` | `/users/profile/:id` | Authenticated | Update own editable profile fields (`name`, `image`, `businessName`) |
| `PATCH` | `/users/:id/block` | Admin | Block or unblock a user account (`isBlocked`) |

### 💐 Wedding Services
| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/services` | Public / Role-aware | Fetch services (public receives `approved` & `active` listings; supports search, category, location & price sorting) |
| `GET` | `/services/:id` | Authenticated | Fetch single service details |
| `POST` | `/services` | Vendor | Create a new service (`status: "pending"`, enforces 3-service limit for free vendors) |
| `PATCH` | `/services/:id` | Vendor (Owner) | Update service details or toggle availability |
| `DELETE` | `/services/:id` | Vendor (Owner) | Delete vendor's own service |
| `PATCH` | `/services/:id/status` | Admin | Approve, reject, or re-queue a service |
| `DELETE` | `/admin/services/:id` | Admin | Permanently delete any inappropriate service |

### 📅 Bookings
| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/bookings/customer` | Customer | List logged-in customer's booking requests |
| `GET` | `/bookings/vendor` | Vendor | List booking requests for the vendor's services |
| `POST` | `/bookings` | Customer | Submit a new booking request (prevents duplicate active bookings on same service + date) |
| `PATCH` | `/bookings/:id/status` | Vendor (Owner) | Accept or Reject a `Pending` booking request |
| `PATCH` | `/bookings/:id/cancel` | Customer (Owner) | Cancel a `Pending` booking request |

### 💳 Stripe Subscriptions & Transactions
| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/payments/create-checkout-session` | Vendor | Create a Stripe Checkout session for the Premium Plan |
| `POST` | `/payments/webhook` | Stripe Signature | Verify webhook signature, log transaction, and activate vendor `premium` plan |
| `GET` | `/transactions` | Admin | View all platform payment transactions (read-only) |

---

## ⚙️ Environment Variables

Create a `.env` file in the root of the server repository:

```env
# Server Configuration
PORT=5000
NODE_ENV=development
CLIENT_URL=http://localhost:3000

# MongoDB Connection
MONGODB_URI=mongodb+srv://<username>:<password>@cluster0.mongodb.net/wedplan?retryWrites=true&w=majority

# Better Auth & JWT Security
BETTER_AUTH_SECRET=your_super_secret_random_string_here
BETTER_AUTH_URL=http://localhost:5000
JWT_SECRET=your_jwt_signing_secret_key

# Google OAuth Credentials
GOOGLE_CLIENT_ID=your_google_oauth_client_id
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret

# Stripe Payment & Webhook Keys
STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key
STRIPE_WEBHOOK_SECRET=whsec_your_stripe_webhook_signing_secret
STRIPE_PREMIUM_PRICE_ID=price_your_stripe_premium_price_id
```

> **Important:** Make sure the Stripe webhook route (`/payments/webhook`) uses `express.raw({ type: "application/json" })` before `express.json()` so signature verification succeeds.

---

## 💻 Local Installation & Setup

### 1. Prerequisites
- **Node.js** `v18.18+` or `v20+`
- **MongoDB Atlas** URI or local MongoDB instance
- **Stripe CLI** (optional, for testing webhooks locally)

### 2. Clone & Install
```bash
git clone [https://github.com/Nazmus-Sadat-21/wedplan-server.git](https://github.com/Nazmus-Sadat-21/wedplan-server.git)
cd wedplan-server
npm install
```

### 3. Configure Environment
```bash
cp .env.example .env
# Add your MONGODB_URI, JWT_SECRET, BETTER_AUTH_SECRET, Google OAuth, and Stripe keys
```

### 4. Start the Server
```bash
# Development mode (with nodemon / watch)
npm run dev

# Production mode
npm start
```
The API will be available at [http://localhost:5000](http://localhost:5000).

### 5. Forward Stripe Webhooks Locally (Optional)
```bash
stripe listen --forward-to localhost:5000/payments/webhook
```