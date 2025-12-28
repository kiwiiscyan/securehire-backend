// src/server.ts
import "dotenv/config";
import express, { Express, Request, NextFunction, Response } from "express";
import cors from "cors";
import crypto from "crypto";
import { limitApiBaseline } from "./middleware/rateLimitBaseline";
import { requireInternalKey } from "./middleware/requireInternalKey";
import mongoose, { connectMongo } from "./config/mongo";
import swaggerUi from "swagger-ui-express";
import swaggerSpec from "./config/swagger";
import issuerRouter from "./routes/issuer";
import recruiterRoutes from "./routes/recruiters";
import proofsRouter from "./routes/proofs";
import trustRouter from "./routes/trust";
import applicationsRouter from "./routes/applications";
import authRouter from "./routes/auth";

import helmet from "helmet";

function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  // Accept upstream ID if provided (useful if you put nginx/Cloudflare later)
  const incoming =
    (req.headers["x-request-id"] as string | undefined) ||
    (req.headers["x-correlation-id"] as string | undefined);

  const id = incoming?.trim() || crypto.randomUUID();

  // Attach to request for logging
  (req as any).id = id;

  // Add response header so frontend can report it
  res.setHeader("x-request-id", id);

  next();
}

export function createApp(routers: {
  jobsRouter: express.Router;
  seekersRouter: express.Router;
}): Express {
  const app = express();

  // 0) Proxy awareness (needed for correct req.ip behind Vercel/NGINX/etc.)
  if (process.env.TRUST_PROXY === "true") {
    app.set("trust proxy", 1);
  }

  // 1) Request correlation id early
  app.use(requestIdMiddleware);

  // 2) Security headers early
  app.use(helmet());

  // 3) CORS early
  app.use(
    cors({
      origin: process.env.CORS_ORIGIN,
      credentials: true,
    })
  );
  app.use(express.json({ limit: "2mb" }));

  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

  // Apply baseline throttling FIRST (reduces load even for bad internal-key requests)
  app.use("/api/v1", limitApiBaseline());

  app.use("/api/v1", requireInternalKey);

  app.use("/api/v1/auth", authRouter);

  app.use("/api/v1/jobs", routers.jobsRouter);
  app.use("/api/v1/seekers", routers.seekersRouter);
  app.use("/api/v1/issuer", issuerRouter);
  app.use("/api/v1/recruiters", recruiterRoutes);
  app.use("/api/v1/proofs", proofsRouter);
  app.use("/api/v1/trust", trustRouter);
  app.use("/api/v1/applications", applicationsRouter);

  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

  return app;
}

export async function startServer() {
  const PORT = Number(process.env.PORT || 4000);

  // 1) connect first
  await connectMongo();

  // 2) import routers after connect
  const { default: jobsRouter } = await import("./routes/jobs");
  const { default: seekersRouter } = await import("./routes/seekers");

  const app = createApp({ jobsRouter, seekersRouter });

  const server = app.listen(PORT, () => {
    console.log(`API listening on http://localhost:${PORT}`);
    console.log(`Swagger UI at http://localhost:${PORT}/api/docs`);
  });

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received. Shutting down...`);
    server.close(async () => {
      await mongoose.connection.close();
      console.log("✅ Server closed. MongoDB disconnected.");
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return app;
}
