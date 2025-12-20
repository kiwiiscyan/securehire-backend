// src/config/mongo.ts
import mongoose from "mongoose";

export async function connectMongo() {
  const uri = process.env.MONGO_URI;

  if (!uri) {
    // In production, do NOT silently fallback.
    if (process.env.NODE_ENV === "production") {
      throw new Error("MONGO_URI is required in production (Railway).");
    }

    // Dev fallback only
    const devUri = "mongodb://127.0.0.1:27017/securehire";
    await mongoose.connect(devUri);
    console.log(`✅ MongoDB connected (dev fallback): ${devUri}`);
    console.log(`DB name: ${mongoose.connection.name}`);
    return mongoose;
  }

  await mongoose.connect(uri);
  console.log(`✅ MongoDB connected: ${uri}`);
  console.log(`DB name: ${mongoose.connection.name}`);
  return mongoose;
}

export default mongoose;