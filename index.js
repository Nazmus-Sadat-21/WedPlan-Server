import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";
import cors from "cors";

const app = express();
const port = process.env.PORT || 8000;

app.use(cors({
  origin: true, 
  credentials: true,
}));
app.use(express.json());



app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}/`);
});

export default app;