import "./env";

import app from "./app";
import { startPosSyncWorker } from "./modules/services/posSyncService";
import { startMembershipReconcileWorker } from "./modules/services/membershipReconcileService";

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Backend running on ${PORT}`);
  startPosSyncWorker();
  startMembershipReconcileWorker();
});
