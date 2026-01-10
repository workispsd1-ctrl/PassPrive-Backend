import dotenv from "dotenv";
import path from "path";

// ✅ load backend/.env explicitly
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import app from "./app";

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Backend running on ${PORT}`));
