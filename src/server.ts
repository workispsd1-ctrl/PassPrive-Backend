import dotenv from "dotenv";
import path from "path";

// ✅ load backend/.env explicitly
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import app from "./app";
import { initializeRedisClient, isRedisConfigured } from "./modules/services/redisClient";

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Backend running on ${PORT}`);
  if (isRedisConfigured()) {
    void initializeRedisClient();
  } else {
    console.log("Redis not configured, using in-memory cache and rate limiting");
  }
});
