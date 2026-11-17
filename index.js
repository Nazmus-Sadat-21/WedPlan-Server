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



// process.env.NEXT_PUBLIC_SERVER_API/users
// process.env.NEXT_PUBLIC_SERVER_API/users
// process.env.NEXT_PUBLIC_SERVER_API/users
// process.env.NEXT_PUBLIC_SERVER_API/users
// process.env.NEXT_PUBLIC_SERVER_API/users
// process.env.NEXT_PUBLIC_SERVER_API/users
// process.env.NEXT_PUBLIC_SERVER_API/users
// process.env.NEXT_PUBLIC_SERVER_API/users
// process.env.NEXT_PUBLIC_SERVER_API/users
// process.env.NEXT_PUBLIC_SERVER_API/users
// process.env.NEXT_PUBLIC_SERVER_API/users
// process.env.NEXT_PUBLIC_SERVER_API/users


app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
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


app.post("services", async (req, res) => {
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


app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);
app.use(express.json());

















app.get("/", (req, res) => {
  res.send("Welcome to the WedPlan API!");
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}/`);
});

export default app;
