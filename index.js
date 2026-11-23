import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";
import cors from "cors";
import Stripe from "stripe";

import { createAuth } from "./auth.js";

const app = express();
const port = process.env.PORT || 8000;

/* --------------------------------------------------------------------------
   Async error safety (Express 4)
   Express 4 does not forward rejected promises from async handlers to the
   error middleware, so a DB error would leave the request hanging. This wraps
   every route handler so rejections reach the error handler. It is harmless on
   Express 5, which does this natively.
--------------------------------------------------------------------------- */
const wrapHandler = (fn) =>
  typeof fn === "function" && fn.length < 4
    ? (req, res, next) => {
        try {
          const result = fn(req, res, next);
          if (result && typeof result.catch === "function") result.catch(next);
        } catch (err) {
          next(err);
        }
      }
    : fn;

for (const method of ["get", "post", "patch", "delete"]) {
  const original = app[method].bind(app);
  app[method] = (path, ...handlers) => {
    // app.get("setting") with one argument is Express's settings getter.
    if (handlers.length === 0) return original(path);
    return original(path, ...handlers.map(wrapHandler));
  };
}

/* --------------------------------------------------------------------------
   MongoDB + Stripe setup
--------------------------------------------------------------------------- */
if (!process.env.MONGO_URI) {
  throw new Error(
    "MONGO_URI is not set. Add it to your environment variables.",
  );
}

const client = new MongoClient(process.env.MONGO_URI, {
  // Fail predictably instead of hanging a request for the default 30 seconds.
  serverSelectionTimeoutMS: 10_000,
  connectTimeoutMS: 10_000,
});

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, {
      // Fail fast: a slow Stripe API must not leave the success page waiting.
      timeout: 10000,
      maxNetworkRetries: 1,
    })
  : null;

// Collection handles don't need an open connection to be created, so they are
// always valid objects (never null) and the driver connects on demand.
const database = client.db("WedPlan");
const users = database.collection("user");
const sessions = database.collection("session");
const services = database.collection("services");
const bookings = database.collection("bookings");
const transactions = database.collection("transactions");

/**
 * Connect once and share the promise. If the attempt fails, the cached promise
 * is cleared so the next request retries instead of staying broken forever.
 */
let connecting = null;
export function connectToMongoDB() {
  if (!connecting) {
    connecting = client
      .connect()
      .then(() => {
        console.log("You successfully connected to MongoDB!");
        return client;
      })
      .catch((err) => {
        connecting = null; // allow a retry on the next request
        throw err;
      });
  }
  return connecting;
}

// Warm up at startup, but never block or crash if it fails.
connectToMongoDB().catch((err) =>
  console.error("Initial MongoDB connection failed:", err?.message ?? err),
);

const { attachUser, requireAuth, requireRole, isSelfOrAdmin } =
  createAuth(users);

const FREE_PLAN_LIMIT = 3;

const categories = [
  "Photography & Videography",
  "Wedding Venues",
  "Decoration & Florist",
  "Catering Services",
  "Makeup & Styling",
  "Wedding Fashion",
];

/** Premium only counts while the paid year is still valid. */
function isPremium(user) {
  if (!user || user.subscriptionPlan !== "premium") return false;
  if (!user.subscriptionExpiresAt) return true;

  const expiresAt = new Date(user.subscriptionExpiresAt);
  if (Number.isNaN(expiresAt.getTime())) return false;
  return expiresAt.getTime() > Date.now();
}

/** Convert a list of ids into unique ObjectIds, ignoring anything invalid. */
function uniqueObjectIds(values) {
  const ids = new Set(
    values
      .filter((value) => value && ObjectId.isValid(value))
      .map((value) => String(value)),
  );
  return [...ids].map((value) => new ObjectId(value));
}

/** Minimal vendor fields that are safe to expose on the admin ledger. */
function publicVendor(vendor) {
  if (!vendor) return null;
  return {
    _id: vendor._id,
    name: vendor.name ?? null,
    email: vendor.email ?? null,
    image: vendor.image ?? null,
    businessName: vendor.businessName ?? null,
  };
}

/** Map documents by string id so enriched records can join without N+1 queries. */
async function getMap(collection, ids) {
  const uniqueIds = uniqueObjectIds(ids);
  if (uniqueIds.length === 0) return {};

  const docs = await collection.find({ _id: { $in: uniqueIds } }).toArray();
  return Object.fromEntries(docs.map((doc) => [String(doc._id), doc]));
}

/**
 * Enrich booking documents with the service, vendor and customer details the
 * dashboards need, so the client can render a booking in one request.
 */
async function addDetailsToBookings(bookingList) {
  if (!Array.isArray(bookingList) || bookingList.length === 0) return [];

  const serviceIds = uniqueObjectIds(
    bookingList.map((booking) => booking.serviceId),
  );
  const vendorIds = uniqueObjectIds(
    bookingList.map((booking) => booking.vendorId),
  );
  const customerIds = uniqueObjectIds(
    bookingList.map((booking) => booking.customerId),
  );

  const [serviceDocs, vendorDocs, customerDocs] = await Promise.all([
    serviceIds.length
      ? services.find({ _id: { $in: serviceIds } }).toArray()
      : [],
    vendorIds.length ? users.find({ _id: { $in: vendorIds } }).toArray() : [],
    customerIds.length
      ? users.find({ _id: { $in: customerIds } }).toArray()
      : [],
  ]);

  const serviceMap = new Map(
    serviceDocs.map((service) => [String(service._id), service]),
  );
  const vendorMap = new Map(
    vendorDocs.map((vendor) => [String(vendor._id), vendor]),
  );
  const customerMap = new Map(
    customerDocs.map((customer) => [String(customer._id), customer]),
  );

  return bookingList.map((booking) => {
    const service = serviceMap.get(String(booking.serviceId)) ?? null;
    const vendor = vendorMap.get(String(booking.vendorId)) ?? null;
    const customer = customerMap.get(String(booking.customerId)) ?? null;

    return {
      ...booking,
      service,
      vendor: vendor
        ? {
            _id: vendor._id,
            name: vendor.name ?? null,
            email: vendor.email ?? null,
            image: vendor.image ?? null,
            businessName: vendor.businessName ?? null,
          }
        : null,
      customer: customer
        ? {
            _id: customer._id,
            name: customer.name ?? null,
            email: customer.email ?? null,
            image: customer.image ?? null,
          }
        : null,
    };
  });
}

/**
 * Persist a paid Stripe checkout session and activate Premium for its vendor.
 * Used by the signed webhook and by the success-page reconciliation fallback.
 * Callers must pass a session whose payment_status is already verified as paid.
 */
async function recordPaidCheckoutSession(session) {
  if (!session || session.payment_status !== "paid") return null;

  const existing = await transactions.findOne({ stripeSessionId: session.id });
  if (existing) return existing;

  const vendorId = session.metadata?.vendorId;
  if (!vendorId || !ObjectId.isValid(vendorId)) {
    console.error(
      `Paid checkout session ${session.id} is missing a valid vendorId.`,
    );
    return null;
  }

  const transaction = {
    vendorId,
    plan: "premium",
    amount: (session.amount_total ?? 0) / 100,
    currency: session.currency ?? "usd",
    stripeSessionId: session.id,
    stripeSubscriptionId: session.subscription ?? null,
    status: "paid",
    createdAt: new Date(),
  };

  await transactions.insertOne(transaction);

  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);

  await users.updateOne(
    { _id: new ObjectId(vendorId) },
    { $set: { subscriptionPlan: "premium", subscriptionExpiresAt: expiresAt } },
  );

  return transaction;
}

/** Turn Premium off (expired, cancelled or refunded subscription). */
async function downgradeVendor(vendorId) {
  if (!vendorId || !ObjectId.isValid(vendorId)) return;
  await users.updateOne(
    { _id: new ObjectId(vendorId) },
    {
      $set: {
        subscriptionPlan: "free",
        subscriptionExpiresAt: null,
      },
    },
  );
}

/** Public client origin used for CORS and Stripe redirect URLs. */
const clientUrl = (process.env.CLIENT_URL || "http://localhost:3000")
  .split(",")[0]
  .trim()
  .replace(/\/+$/, "");

const allowedOrigins = new Set(
  (process.env.CLIENT_URL || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean),
);

app.use(
  cors({
    origin(origin, callback) {
      // Server-to-server calls and same-origin requests omit the Origin header.
      if (!origin) return callback(null, true);

      if (allowedOrigins.has(origin.replace(/\/+$/, ""))) {
        return callback(null, true);
      }

      // Returning an error here would produce a 500; simply omitting the CORS
      // headers lets the browser block the request with a clear CORS error.
      console.warn(`Blocked CORS origin: ${origin}`);
      return callback(null, false);
    },
    credentials: true,
  }),
);

/**
 * Make sure MongoDB is connected before any route runs. If the connection
 * failed earlier, this retries it on the next request, so the API recovers on
 * its own after an outage. If it still can't connect, answer with an
 * actionable 503 instead of a generic 500.
 */
app.use(async (_req, res, next) => {
  try {
    await connectToMongoDB();
    return next();
  } catch (err) {
    console.error("MongoDB unavailable:", err?.message ?? err);
    return res.status(503).send({
      message:
        "WedPlan is temporarily unavailable while it reconnects to the database. Please try again in a moment.",
      code: "DATABASE_UNAVAILABLE",
    });
  }
});

/* --------------------------------------------------------------------------
   Stripe webhook — must be registered before express.json() so the raw body
   is available for signature verification.
--------------------------------------------------------------------------- */
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripe || !webhookSecret) {
      console.error(
        "Stripe is not fully configured: STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required.",
      );
      return res.status(503).send("Webhook is not configured.");
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        webhookSecret,
      );
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        // One-time Premium payment completed -> save transaction + activate.
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded": {
          const session = event.data.object;
          if (session.payment_status === "paid") {
            await recordPaidCheckoutSession(session);
          }
          break;
        }
        // A checkout that was abandoned or expired never activates Premium.
        case "checkout.session.expired": {
          console.log(`Checkout session ${event.data.object.id} expired.`);
          break;
        }
        // If Premium is ever sold as a recurring subscription, handle the end
        // of that subscription and failed renewals.
        case "customer.subscription.deleted": {
          const subscription = event.data.object;
          await downgradeVendor(subscription.metadata?.vendorId);
          break;
        }
        case "invoice.payment_failed": {
          const invoice = event.data.object;
          if (invoice.subscription) {
            await downgradeVendor(invoice.metadata?.vendorId);
          }
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.error(`Failed to process Stripe event ${event.type}:`, err);
      return res.status(500).send("Webhook handler failed.");
    }

    res.send({ received: true });
  },
);

app.use(express.json({ limit: "1mb" }));

// Identify the caller from a Better Auth JWT when one is present. Routes decide
// whether authentication is required.
app.use(attachUser);

/* --------------------------------------------------------------------------
   Users
--------------------------------------------------------------------------- */

// Admin: list every platform user.
app.get("/users", requireRole("admin"), async (req, res) => {
  const result = await users.find({}).toArray();
  res.send(result);
});

// Admin or the user themself.
app.get("/users/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid user id." });
  }
  if (!isSelfOrAdmin(req, id)) {
    return res
      .status(403)
      .send({ message: "You can only view your own profile." });
  }

  const user = await users.findOne({ _id: new ObjectId(id) });
  if (!user) return res.status(404).send({ message: "User not found." });
  res.send(user);
});

// Public vendor card: only non-sensitive fields, never the email/plan.
app.get("/vendors/:id", async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid vendor id." });
  }

  const vendor = await users.findOne({ _id: new ObjectId(id), role: "vendor" });
  if (!vendor) return res.status(404).send({ message: "Vendor not found." });

  res.send({
    _id: vendor._id,
    name: vendor.name ?? null,
    image: vendor.image ?? null,
    businessName: vendor.businessName ?? null,
    role: "vendor",
  });
});

app.patch("/users/profile/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid user id." });
  }
  if (!isSelfOrAdmin(req, id)) {
    return res
      .status(403)
      .send({ message: "You can only update your own profile." });
  }

  const updates = {};
  if ("name" in req.body) {
    const name = String(req.body.name ?? "").trim();
    if (name.length < 2) {
      return res
        .status(400)
        .send({ message: "Name must be at least 2 characters." });
    }
    updates.name = name;
  }
  if ("image" in req.body) {
    updates.image =
      typeof req.body.image === "string" && req.body.image.trim() !== ""
        ? req.body.image.trim()
        : null;
  }
  if ("businessName" in req.body && req.userRole === "vendor") {
    updates.businessName = String(req.body.businessName ?? "").trim();
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).send({ message: "No valid fields to update." });
  }

  const result = await users.findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: updates },
    { returnDocument: "after" },
  );
  res.send(result);
});

app.patch("/users/:id/block", requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid user id." });
  }

  const user = await users.findOne({ _id: new ObjectId(id) });
  if (!user) return res.status(404).send({ message: "User not found." });
  if (user.role === "admin") {
    return res.status(400).send({ message: "Admin cannot be blocked." });
  }

  await users.updateOne({ _id: user._id }, { $set: { isBlocked: true } });
  res.send({ message: "User blocked.", isBlocked: true });
});

app.patch("/users/:id/unblock", requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid user id." });
  }

  const result = await users.updateOne(
    { _id: new ObjectId(id) },
    { $set: { isBlocked: false } },
  );

  if (result.matchedCount === 0) {
    return res.status(404).send({ message: "User not found." });
  }
  res.send({ message: "User unblocked.", isBlocked: false });
});

/* --------------------------------------------------------------------------
   Services
--------------------------------------------------------------------------- */

function isPublicServiceDocument(service) {
  const availability =
    service?.availability === "active" || service?.availability === true;
  return Boolean(service) && service.status === "approved" && availability;
}

// Public catalogue: approved + active only.
app.get("/services", async (req, res) => {
  const result = await services
    .find({
      status: "approved",
      availability: { $in: ["active", true] },
      createdAt: { $exists: true },
    })
    .sort({ createdAt: -1 })
    .toArray();
  res.send(result);
});

// Vendor: every service they own, including pending/rejected ones.
app.get("/vendor/services", requireRole("vendor"), async (req, res) => {
  const result = await services
    .find({ vendorId: req.userId })
    .sort({ createdAt: -1 })
    .toArray();
  res.send(result);
});

// Admin: every service on the platform.
app.get("/admin/services", requireRole("admin"), async (req, res) => {
  const result = await services.find({}).sort({ createdAt: -1 }).toArray();
  res.send(result);
});

app.post("/services", requireRole("vendor"), async (req, res) => {
  const { serviceName, category, description, price, location, images } =
    req.body ?? {};

  const name = String(serviceName ?? "").trim();
  const place = String(location ?? "").trim();

  if (name.length < 3) {
    return res
      .status(400)
      .send({ message: "Service name must be at least 3 characters." });
  }
  if (!categories.includes(category)) {
    return res.status(400).send({ message: "Invalid category." });
  }
  if (!place) {
    return res.status(400).send({ message: "Location is required." });
  }
  if (price === undefined || isNaN(price) || Number(price) <= 0) {
    return res
      .status(400)
      .send({ message: "Price must be a positive number." });
  }

  const imageList = Array.isArray(images)
    ? images.filter((image) => typeof image === "string" && image.trim() !== "")
    : [];

  const vendor = req.user;
  if (!isPremium(vendor)) {
    const activeCount = await services.countDocuments({
      vendorId: req.userId,
      availability: { $in: ["active", true] },
      status: { $ne: "rejected" },
    });
    if (activeCount >= FREE_PLAN_LIMIT) {
      return res.status(403).send({
        message: "Free plan allows only 3 active services. Upgrade to Premium.",
      });
    }
  }

  const service = {
    vendorId: req.userId,
    serviceName: name,
    category,
    description: String(description ?? "").trim(),
    price: Number(price),
    location: place,
    images: imageList,
    // New listings are private until an admin approves them.
    status: "pending",
    availability: "active",
    createdAt: new Date(),
  };

  const result = await services.insertOne(service);
  res.status(201).send({ insertedId: result.insertedId, ...service });
});

// Public for approved listings; the owner and admins can also read their own
// pending/rejected listings.
app.get("/services/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid service id." });
  }

  const service = await services.findOne({ _id: new ObjectId(id) });
  if (!service) return res.status(404).send({ message: "Service not found." });

  const isOwner = Boolean(req.user) && String(service.vendorId) === req.userId;
  const isAdmin = req.userRole === "admin";

  if (!isPublicServiceDocument(service) && !isOwner && !isAdmin) {
    return res.status(404).send({ message: "Service not found." });
  }

  res.send(service);
});

app.patch("/services/:id", requireRole("vendor"), async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid service id." });
  }

  const service = await services.findOne({ _id: new ObjectId(id) });
  if (!service) return res.status(404).send({ message: "Service not found." });

  if (String(service.vendorId) !== req.userId) {
    return res
      .status(403)
      .send({ message: "You can only update your own services." });
  }

  const allowedFields = [
    "serviceName",
    "category",
    "description",
    "price",
    "location",
    "images",
    "availability",
  ];
  const updates = {};
  for (const field of allowedFields) {
    if (field in req.body) updates[field] = req.body[field];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).send({ message: "No valid fields to update." });
  }
  if ("serviceName" in updates) {
    const name = String(updates.serviceName ?? "").trim();
    if (name.length < 3) {
      return res
        .status(400)
        .send({ message: "Service name must be at least 3 characters." });
    }
    updates.serviceName = name;
  }
  if ("category" in updates && !categories.includes(updates.category)) {
    return res.status(400).send({ message: "Invalid category." });
  }
  if ("price" in updates) {
    if (isNaN(updates.price) || Number(updates.price) <= 0) {
      return res
        .status(400)
        .send({ message: "Price must be a positive number." });
    }
    updates.price = Number(updates.price);
  }
  if ("location" in updates) {
    updates.location = String(updates.location ?? "").trim();
    if (!updates.location) {
      return res.status(400).send({ message: "Location is required." });
    }
  }
  if ("images" in updates) {
    updates.images = Array.isArray(updates.images)
      ? updates.images.filter(
          (image) => typeof image === "string" && image.trim() !== "",
        )
      : [];
  }
  if (
    "availability" in updates &&
    !["active", "inactive"].includes(updates.availability)
  ) {
    return res.status(400).send({ message: "Invalid availability." });
  }

  // Turning a service back to active must respect the free plan limit.
  if (updates.availability === "active" && service.availability !== "active") {
    if (!isPremium(req.user)) {
      const activeCount = await services.countDocuments({
        vendorId: req.userId,
        availability: { $in: ["active", true] },
        status: { $ne: "rejected" },
        _id: { $ne: service._id },
      });
      if (activeCount >= FREE_PLAN_LIMIT) {
        return res.status(403).send({
          message:
            "Free plan allows only 3 active services. Upgrade to Premium.",
        });
      }
    }
  }

  const result = await services.findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: updates },
    { returnDocument: "after" },
  );
  res.send(result);
});

app.delete("/services/:id", requireRole("vendor"), async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid service id." });
  }

  const service = await services.findOne({ _id: new ObjectId(id) });
  if (!service) return res.status(404).send({ message: "Service not found." });

  if (String(service.vendorId) !== req.userId) {
    return res
      .status(403)
      .send({ message: "You can only delete your own services." });
  }

  await services.deleteOne({ _id: service._id });
  res.send({ deletedId: id });
});

// Admin moderation: approve / reject / send back to pending.
app.patch("/services/:id/status", requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid service id." });
  }

  const service = await services.findOne({ _id: new ObjectId(id) });
  if (!service) return res.status(404).send({ message: "Service not found." });

  const newStatus = req.body?.status;
  if (!["pending", "approved", "rejected"].includes(newStatus)) {
    return res.status(400).send({ message: "Invalid status." });
  }

  const result = await services.findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: { status: newStatus } },
    { returnDocument: "after" },
  );
  res.send(result);
});

app.delete("/admin/services/:id", requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid service id." });
  }

  const result = await services.deleteOne({ _id: new ObjectId(id) });

  if (result.deletedCount === 0) {
    return res.status(404).send({ message: "Service not found." });
  }
  res.send({ deletedId: id });
});

/* --------------------------------------------------------------------------
   Bookings
--------------------------------------------------------------------------- */

app.post("/bookings", requireRole("customer"), async (req, res) => {
  const { serviceId, eventDate, eventLocation, message } = req.body ?? {};

  if (!serviceId || !eventDate || !eventLocation) {
    return res
      .status(400)
      .send({ message: "Event date and location are required." });
  }
  if (!ObjectId.isValid(serviceId)) {
    return res.status(400).send({ message: "Invalid service id." });
  }

  const parsedDate = new Date(eventDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate < today) {
    return res
      .status(400)
      .send({ message: "Please select a valid future date." });
  }
  const normalizedDate = parsedDate.toISOString().slice(0, 10);

  const service = await services.findOne({ _id: new ObjectId(serviceId) });
  if (!service || !isPublicServiceDocument(service)) {
    return res
      .status(404)
      .send({ message: "Service is not available for booking." });
  }

  // A vendor can never book their own listing.
  if (String(service.vendorId) === req.userId) {
    return res
      .status(400)
      .send({ message: "You cannot book your own service." });
  }

  // No duplicate active request for the same service and event date.
  const duplicate = await bookings.findOne({
    serviceId,
    customerId: req.userId,
    eventDate: normalizedDate,
    status: { $in: ["pending", "accepted"] },
  });
  if (duplicate) {
    return res.status(409).send({
      message:
        "You already have an active request for this service on this date.",
    });
  }

  const booking = {
    serviceId,
    vendorId: String(service.vendorId),
    customerId: req.userId,
    eventDate: normalizedDate,
    eventLocation: String(eventLocation).trim(),
    message: typeof message === "string" ? message.trim() : "",
    status: "pending",
    createdAt: new Date(),
  };

  const result = await bookings.insertOne(booking);
  res.status(201).send({ insertedId: result.insertedId, ...booking });
});

// Customer: their own active requests. Cancelled requests are hidden.
app.get("/bookings/customer/:customerId", requireAuth, async (req, res) => {
  const { customerId } = req.params;
  if (!ObjectId.isValid(customerId)) {
    return res.status(400).send({ message: "Invalid customer id." });
  }
  if (!isSelfOrAdmin(req, customerId)) {
    return res
      .status(403)
      .send({ message: "You can only view your own bookings." });
  }

  const result = await bookings
    .find({ customerId, status: { $ne: "cancelled" } })
    .sort({ createdAt: -1 })
    .toArray();
  res.send(await addDetailsToBookings(result));
});

// Vendor: every request addressed to them.
app.get("/bookings/vendor/:vendorId", requireAuth, async (req, res) => {
  const { vendorId } = req.params;
  if (!ObjectId.isValid(vendorId)) {
    return res.status(400).send({ message: "Invalid vendor id." });
  }
  if (!isSelfOrAdmin(req, vendorId)) {
    return res
      .status(403)
      .send({ message: "You can only view your own booking requests." });
  }

  const result = await bookings
    .find({ vendorId })
    .sort({ createdAt: -1 })
    .toArray();
  res.send(await addDetailsToBookings(result));
});

// A single booking is visible only to its customer, its vendor, or an admin.
app.get("/bookings/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid booking id." });
  }

  const booking = await bookings.findOne({ _id: new ObjectId(id) });
  if (!booking) return res.status(404).send({ message: "Booking not found." });

  const allowed =
    req.userRole === "admin" ||
    String(booking.customerId) === req.userId ||
    String(booking.vendorId) === req.userId;

  if (!allowed) {
    return res
      .status(403)
      .send({ message: "This booking does not belong to you." });
  }

  const [result] = await addDetailsToBookings([booking]);
  res.send(result);
});

// Customer cancels their own pending request.
app.patch("/bookings/:id/cancel", requireRole("customer"), async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid booking id." });
  }

  const booking = await bookings.findOne({ _id: new ObjectId(id) });
  if (!booking) return res.status(404).send({ message: "Booking not found." });

  if (String(booking.customerId) !== req.userId) {
    return res
      .status(403)
      .send({ message: "This booking does not belong to you." });
  }
  if (booking.status !== "pending") {
    return res
      .status(400)
      .send({ message: `A ${booking.status} booking cannot be cancelled.` });
  }

  await bookings.updateOne(
    { _id: booking._id },
    { $set: { status: "cancelled", cancelledAt: new Date() } },
  );
  res.send({ message: "Booking cancelled.", status: "cancelled" });
});

// Vendor accepts or rejects a pending request. No re-processing is allowed.
app.patch("/bookings/:id/status", requireRole("vendor"), async (req, res) => {
  const { id } = req.params;
  const { status } = req.body ?? {};

  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid booking id." });
  }
  if (!["accepted", "rejected"].includes(status)) {
    return res
      .status(400)
      .send({ message: "Status must be accepted or rejected." });
  }

  const booking = await bookings.findOne({ _id: new ObjectId(id) });
  if (!booking) return res.status(404).send({ message: "Booking not found." });

  if (String(booking.vendorId) !== req.userId) {
    return res
      .status(403)
      .send({ message: "This booking does not belong to you." });
  }
  if (booking.status !== "pending") {
    return res
      .status(400)
      .send({ message: `Booking is already ${booking.status}.` });
  }

  await bookings.updateOne(
    { _id: booking._id },
    { $set: { status, processedAt: new Date() } },
  );
  res.send({ message: `Booking ${status}.`, status });
});

/* ---------------------------------------------------------------
   PAYMENT (Stripe) + TRANSACTIONS
--------------------------------------------------------------- */

// Vendor clicks "Upgrade to Premium". The vendor is taken from the JWT, so a
// caller can never start a checkout for somebody else.
app.post(
  "/create-checkout-session",
  requireRole("vendor"),
  async (req, res) => {
    const vendor = req.user;

    if (isPremium(vendor)) {
      return res
        .status(400)
        .send({ message: "You are already a Premium vendor." });
    }

    if (!stripe) {
      return res.status(503).send({
        message:
          "Payments are temporarily unavailable. Please try again in a moment.",
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: vendor.email,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "WedPlan Premium Vendor" },
            unit_amount: 2900, // $29.00 for one year
          },
          quantity: 1,
        },
      ],
      metadata: { vendorId: req.userId },
      success_url: `${clientUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/payment/cancel`,
    });

    res.send({ url: session.url });
  },
);

// Payment success page: return the saved transaction. The webhook is the
// primary writer; this route reconciles directly with Stripe if it is missing.
// Only the vendor who owns the checkout session can read it.
app.get("/transactions/session/:sessionId", requireAuth, async (req, res) => {
  const { sessionId } = req.params;

  let result = await transactions.findOne({ stripeSessionId: sessionId });

  if (result && !isSelfOrAdmin(req, result.vendorId)) {
    return res
      .status(403)
      .send({ message: "This payment does not belong to you." });
  }

  if (!result) {
    // Reconciliation fallback: verify the session directly with Stripe. This
    // never trusts the browser redirect — only Stripe's paid status can
    // create the transaction and activate Premium.
    if (!stripe) {
      return res.status(503).send({
        message:
          "Payment confirmation is temporarily unavailable. Please refresh in a moment.",
      });
    }
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (
        session.metadata?.vendorId &&
        session.metadata.vendorId !== req.userId &&
        req.userRole !== "admin"
      ) {
        return res
          .status(403)
          .send({ message: "This payment does not belong to you." });
      }
      result = await recordPaidCheckoutSession(session);
    } catch (err) {
      console.error("Stripe session verification failed:", err.message);
    }
  }

  if (!result) {
    return res
      .status(404)
      .send({ message: "Payment is still being confirmed." });
  }
  res.send(result);
});

// Vendor cancels Premium. One-time purchases have no Stripe subscription to
// cancel, so the plan is downgraded immediately and the ledger is updated.
app.post("/subscription/cancel", requireRole("vendor"), async (req, res) => {
  const vendorId = req.userId;

  const transaction = await transactions.findOne(
    { vendorId, status: "paid" },
    { sort: { createdAt: -1 } },
  );

  if (transaction?.stripeSubscriptionId && stripe) {
    await stripe.subscriptions.cancel(transaction.stripeSubscriptionId);
  }

  if (transaction) {
    await transactions.updateOne(
      { _id: transaction._id },
      { $set: { status: "cancelled", cancelledAt: new Date() } },
    );
  }

  await downgradeVendor(vendorId);
  res.send({ message: "Subscription cancelled." });
});

// Admin: all transactions (read only - no update/delete routes on purpose).
app.get("/transactions", requireRole("admin"), async (req, res) => {
  const result = await transactions.find({}).sort({ createdAt: -1 }).toArray();
  const vendorMap = await getMap(
    users,
    result.map((t) => t.vendorId),
  );

  const data = result.map((t) => ({
    ...t,
    vendor: publicVendor(vendorMap[t.vendorId]),
    vendorEmail: vendorMap[t.vendorId]?.email,
  }));
  res.send(data);
});

// Vendor: their own transactions (admins can inspect any vendor).
app.get("/transactions/vendor/:vendorId", requireAuth, async (req, res) => {
  const { vendorId } = req.params;
  if (!ObjectId.isValid(vendorId)) {
    return res.status(400).send({ message: "Invalid vendor id." });
  }
  if (!isSelfOrAdmin(req, vendorId)) {
    return res
      .status(403)
      .send({ message: "You can only view your own transactions." });
  }

  const result = await transactions
    .find({ vendorId })
    .sort({ createdAt: -1 })
    .toArray();
  res.send(result);
});

app.get("/", (req, res) => {
  res.send("Welcome to the WedPlan API!");
});

// Never leak stack traces to clients.
app.use((err, _req, res, _next) => {
  console.error("Unhandled API error:", err);
  if (res.headersSent) return;
  res.status(500).send({ message: "Something went wrong. Please try again." });
});

app.listen(port, () => {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.warn(
      "STRIPE_SECRET_KEY is not set. The application will not be able to interact with the Stripe API.",
    );
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn(
      "STRIPE_WEBHOOK_SECRET is not set. Stripe webhooks will be rejected.",
    );
  }
  if (!process.env.BETTER_AUTH_URL) {
    console.warn(
      "BETTER_AUTH_URL is not set. Falling back to http://localhost:3000 for JWT verification.",
    );
  }
  console.log(`Server is running at http://localhost:${port}/`);
});




export default app;