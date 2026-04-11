import "./env";
import { ensureRedisReady, getRedisStatus } from "./modules/services/redisClient";

import app from "./app";

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Backend running on ${PORT}`);
  void ensureRedisReady()
    .then((ready) => {
      const status = getRedisStatus();
      if (ready) {
        console.log(`[redis] Connected to ${status.label}`);
        return;
      }

      if (!status.configured) {
        console.log("[redis] Not configured, using in-memory fallback");
        return;
      }

      console.warn(`[redis] Unavailable for ${status.label}, using in-memory fallback`);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[redis] Startup check failed, using in-memory fallback", message);
    });
});
