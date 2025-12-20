// src/config/mongo.ts
import mongoose from "mongoose";

export async function connectMongo() {
  const uri = process.env.MONGO_URI || "mongodb://localhost:27017/securehire";
  await mongoose.connect(uri);
  console.log(`✅ MongoDB connected: ${uri}`);
  console.log(`DB name: ${mongoose.connection.name}`);
  return mongoose;
}

export default mongoose;