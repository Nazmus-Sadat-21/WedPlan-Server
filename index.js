import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";
import cors from "cors";
import Stripe from "stripe";

const app = express();
const port = process.env.PORT || 8000;

const client = new MongoClient(process.env.MONGO_URI);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.error("MongoDB connection error:", err);
  }
}

const mongoClient = await connectToMongoDB();
const database = mongoClient ? mongoClient.db("WedPlan") : null;

const users = database.collection("user");
const sessions = database.collection("session");
const services = database.collection("services");
const bookings = database.collection("bookings");
const transactions = database.collection("transactions");

const FREE_PLAN_LIMIT = 3;

const categories = [
  "Photography & Videography",
  "Wedding Venues",
  "Decoration & Florist",
  "Catering Services",
  "Makeup & Styling",
  "Wedding Fashion",
];

function isPremium(user) {
  return user?.subscriptionPlan === "premium";
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

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);
app.use(express.json());

// process.env.NEXT_PUBLIC_SERVER_API/users
// process.env.NEXT_PUBLIC_SERVER_API/users:id
// process.env.NEXT_PUBLIC_SERVER_API/services
// process.env.NEXT_PUBLIC_SERVER_API/services:id
// process.env.NEXT_PUBLIC_SERVER_API/users
// process.env.NEXT_PUBLIC_SERVER_API/users
// process.env.NEXT_PUBLIC_SERVER_API/users
// process.env.NEXT_PUBLIC_SERVER_API/users
// process.env.NEXT_PUBLIC_SERVER_API/users
// process.env.NEXT_PUBLIC_SERVER_API/users
// process.env.NEXT_PUBLIC_SERVER_API/users
// process.env.NEXT_PUBLIC_SERVER_API/users
// process.env.NEXT_PUBLIC_SERVER_API/users

app.get("/users", async (req, res) => {
  const cursor = users.find({});
  const result = await cursor.toArray();
  res.send(result);
});

app.get("/users/:id", async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await users.findOne(query);
  res.send(result);
});

app.post("/services", async (req, res) => {
  const service = req.body;
  const result = await services.insertOne(service);
  res.send(result);
});

app.get("/services", async (req, res) => {
  const cursor = services.find({});
  const result = await cursor.toArray();
  res.send(result);
});

app.get("/services/:id", async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await services.findOne(query);
  res.send(result);
});

// Update service (vendor)
app.patch("/services/:id", async (req, res) => {
  const id = req.params.id;
  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid service id." });
  }

  const service = await services.findOne({ _id: new ObjectId(id) });
  if (!service) {
    return res.status(404).send({ message: "Service not found." });
  }

  // ownership check (vendorId will come from the token later)
  if (service.vendorId !== req.body.vendorId) {
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
  if (
    "availability" in updates &&
    !["active", "inactive"].includes(updates.availability)
  ) {
    return res.status(400).send({ message: "Invalid availability." });
  }

  // turning a service back to active must respect the free plan limit
  if (updates.availability === "active" && service.availability !== "active") {
    const vendor = await users.findOne({ _id: new ObjectId(service.vendorId) });
    if (!isPremium(vendor)) {
      const activeCount = await services.countDocuments({
        vendorId: service.vendorId,
        availability: { $in: ["active", true] },
        status: { $ne: "rejected" },
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

//vendor
app.delete("/services/:id", async (req, res) => {
  const id = req.params.id;
  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid service id." });
  }

  const service = await services.findOne({ _id: new ObjectId(id) });
  if (!service) {
    return res.status(404).send({ message: "Service not found." });
  }
  if (service.vendorId !== req.query.vendorId) {
    return res
      .status(403)
      .send({ message: "You can only delete your own services." });
  }

  await services.deleteOne({ _id: service._id });
  res.send({ deletedId: id });
});

app.patch("/services/:id/status", async (req, res) => {
  const id = req.params.id;
  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid service id." });
  }

  const service = await services.findOne({ _id: new ObjectId(id) });
  if (!service) {
    return res.status(404).send({ message: "Service not found." });
  }

  const newStatus = req.body.status;
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

app.delete("/admin/services/:id", async (req, res) => {
  const id = req.params.id;
  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid service id." });
  }

  const result = await services.deleteOne({ _id: new ObjectId(id) });

  if (result.deletedCount === 0) {
    return res.status(404).send({ message: "Service not found." });
  }
  res.send({ deletedId: id });
});

app.patch("/users/:id/block", async (req, res) => {
  const id = req.params.id;
  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid user id." });
  }

  const user = await users.findOne({ _id: new ObjectId(id) });
  if (!user) {
    return res.status(404).send({ message: "User not found." });
  }
  if (user.role === "admin") {
    return res.status(400).send({ message: "Admin cannot be blocked." });
  }

  await users.updateOne({ _id: user._id }, { $set: { isBlocked: true } });
  res.send({ message: "User blocked.", isBlocked: true });
});

// unblock user (admin)
app.patch("/users/:id/unblock", async (req, res) => {
  const id = req.params.id;
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

//booking

app.post("/bookings", async (req, res) => {
  const { serviceId, customerId, eventDate, eventLocation, message } = req.body;

  if (!serviceId || !customerId || !eventDate || !eventLocation) {
    return res
      .status(400)
      .send({ message: "Event date and location are required." });
  }
  if (!ObjectId.isValid(serviceId) || !ObjectId.isValid(customerId)) {
    return res.status(400).send({ message: "Invalid id." });
  }

  // event date can not be in the past
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (isNaN(new Date(eventDate)) || new Date(eventDate) < today) {
    return res
      .status(400)
      .send({ message: "Please select a valid future date." });
  }

  const customer = await users.findOne({ _id: new ObjectId(customerId) });
  if (!customer || customer.role !== "customer") {
    return res
      .status(403)
      .send({ message: "Only customers can book services." });
  }
  if (customer.isBlocked) {
    return res.status(403).send({ message: "Your account is blocked." });
  }

  const service = await services.findOne({ _id: new ObjectId(serviceId) });
  // Legacy services may still store a boolean availability flag.
  const bookableAvailability =
    service?.availability === "active" || service?.availability === true;
  if (!service || service.status !== "approved" || !bookableAvailability) {
    return res
      .status(404)
      .send({ message: "Service is not available for booking." });
  }
  if (service.vendorId === customerId) {
    return res
      .status(400)
      .send({ message: "You cannot book your own service." });
  }

  // no duplicate active request for same service + date
  const duplicate = await bookings.findOne({
    serviceId,
    customerId,
    eventDate,
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
    vendorId: service.vendorId,
    customerId,
    eventDate,
    eventLocation,
    message: message || "",
    status: "pending",
    createdAt: new Date(),
  };

  const result = await bookings.insertOne(booking);
  res.status(201).send(result);
});

app.get("/bookings/customer/:customerId", async (req, res) => {
  const result = await bookings
    .find({ customerId: req.params.customerId })
    .sort({ createdAt: -1 })
    .toArray();
  res.send(await addDetailsToBookings(result));
});

app.patch("/bookings/:id/cancel", async (req, res) => {
  const id = req.params.id;
  const { customerId } = req.body;

  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid booking id." });
  }

  const booking = await bookings.findOne({ _id: new ObjectId(id) });
  if (!booking) {
    return res.status(404).send({ message: "Booking not found." });
  }
  if (booking.customerId !== customerId) {
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
    { $set: { status: "cancelled" } },
  );
  res.send({ message: "Booking cancelled.", status: "cancelled" });
});

app.get("/bookings/vendor/:vendorId", async (req, res) => {
  const result = await bookings
    .find({ vendorId: req.params.vendorId })
    .sort({ createdAt: -1 })
    .toArray();
  res.send(await addDetailsToBookings(result));
});

app.get("/bookings/:id", async (req, res) => {
  const id = req.params.id;
  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid booking id." });
  }

  const booking = await bookings.findOne({ _id: new ObjectId(id) });
  if (!booking) {
    return res.status(404).send({ message: "Booking not found." });
  }

  const [result] = await addDetailsToBookings([booking]);
  res.send(result);
});

app.patch("/bookings/:id/status", async (req, res) => {
  const id = req.params.id;
  const { status, vendorId } = req.body;

  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid booking id." });
  }
  if (!["accepted", "rejected"].includes(status)) {
    return res
      .status(400)
      .send({ message: "Status must be accepted or rejected." });
  }

  const booking = await bookings.findOne({ _id: new ObjectId(id) });
  if (!booking) {
    return res.status(404).send({ message: "Booking not found." });
  }
  if (booking.vendorId !== vendorId) {
    return res
      .status(403)
      .send({ message: "This booking does not belong to you." });
  }
  if (booking.status !== "pending") {
    return res
      .status(400)
      .send({ message: `Booking is already ${booking.status}.` });
  }

  await bookings.updateOne({ _id: booking._id }, { $set: { status } });
  res.send({ message: `Booking ${status}.`, status });
});

/* ---------------------------------------------------------------
   PAYMENT (Stripe) + TRANSACTIONS
---------------------------------------------------------------- */

// vendor clicks "Upgrade to Premium"
app.post("/create-checkout-session", async (req, res) => {
  const { vendorId } = req.body;

  if (!vendorId || !ObjectId.isValid(vendorId)) {
    return res.status(400).send({ message: "Invalid vendor id." });
  }

  const vendor = await users.findOne({ _id: new ObjectId(vendorId) });
  if (!vendor || vendor.role !== "vendor") {
    return res.status(403).send({ message: "Only vendors can upgrade." });
  }
  if (isPremium(vendor)) {
    return res
      .status(400)
      .send({ message: "You are already a Premium vendor." });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer_email: vendor.email,
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: "WedPlan Premium Vendor" },
          unit_amount: 2000, // $20.00
          recurring: { interval: "month" },
        },
        quantity: 1,
      },
    ],
    metadata: { vendorId },
    subscription_data: { metadata: { vendorId } },
    success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.CLIENT_URL}/payment/cancel`,
  });

  res.send({ url: session.url });
});

// payment success page: show the saved transaction (saved by webhook only)
app.get("/transactions/session/:sessionId", async (req, res) => {
  const result = await transactions.findOne({
    stripeSessionId: req.params.sessionId,
  });

  if (!result) {
    return res
      .status(404)
      .send({ message: "Payment is still being confirmed." });
  }
  res.send(result);
});

// vendor cancels subscription (webhook will switch the plan to free)
app.post("/subscription/cancel", async (req, res) => {
  const { vendorId } = req.body;

  const transaction = await transactions.findOne(
    { vendorId, status: "paid" },
    { sort: { createdAt: -1 } },
  );
  if (!transaction || !transaction.stripeSubscriptionId) {
    return res.status(404).send({ message: "No active subscription found." });
  }

  await stripe.subscriptions.cancel(transaction.stripeSubscriptionId);
  res.send({ message: "Subscription cancelled." });
});

// admin: all transactions (read only - no update/delete routes on purpose)
app.get("/transactions", async (req, res) => {
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

// vendor: own transactions
app.get("/transactions/vendor/:vendorId", async (req, res) => {
  const result = await transactions
    .find({ vendorId: req.params.vendorId })
    .sort({ createdAt: -1 })
    .toArray();
  res.send(result);
});

app.get("/", (req, res) => {
  res.send("Welcome to the WedPlan API!");
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}/`);
});

export default app;
