import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";
import cors from "cors";

const app = express();
const port = process.env.PORT || 8000;

const client = new MongoClient(process.env.MONGO_URI);

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


app.get('/users', async (req, res) => {
    const cursor = users.find({});
    const result = await cursor.toArray();
    res.send(result);
})


app.get('/users/:id', async (req, res) => {
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
    return res.status(403).send({ message: "You can only update your own services." });
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
      return res.status(400).send({ message: "Price must be a positive number." });
    }
    updates.price = Number(updates.price);
  }
  if ("availability" in updates && !["active", "inactive"].includes(updates.availability)) {
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
          message: "Free plan allows only 3 active services. Upgrade to Premium.",
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
    return res.status(403).send({ message: "You can only delete your own services." });
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
    return res.status(400).send({ message: "Event date and location are required." });
  }
  if (!ObjectId.isValid(serviceId) || !ObjectId.isValid(customerId)) {
    return res.status(400).send({ message: "Invalid id." });
  }

  // event date can not be in the past
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (isNaN(new Date(eventDate)) || new Date(eventDate) < today) {
    return res.status(400).send({ message: "Please select a valid future date." });
  }

  const customer = await users.findOne({ _id: new ObjectId(customerId) });
  if (!customer || customer.role !== "customer") {
    return res.status(403).send({ message: "Only customers can book services." });
  }
  if (customer.isBlocked) {
    return res.status(403).send({ message: "Your account is blocked." });
  }

  const service = await services.findOne({ _id: new ObjectId(serviceId) });
  if (!service || service.status !== "approved" || service.availability !== "active") {
    return res.status(404).send({ message: "Service is not available for booking." });
  }
  if (service.vendorId === customerId) {
    return res.status(400).send({ message: "You cannot book your own service." });
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
      message: "You already have an active request for this service on this date.",
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









app.get("/", (req, res) => {
  res.send("Welcome to the WedPlan API!");
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}/`);
});

export default app;