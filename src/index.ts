import { configEnv } from "./config/env";
import { startServer } from './server';

configEnv();

startServer().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});