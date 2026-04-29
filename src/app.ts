import express from "express";
import cors from "cors";
import authRoutes from "./modules/routes/auth";
import adminRoutes from "./modules/routes/admin";
import userDetailsRoutes from "./modules/routes/userDetails.routes";
import HomeHeroOffers from "./modules/routes/homeHeroOffers";
import DineinHomeBanners from "./modules/routes/dineinHomeBanners";
import InYourPassPrive from "./modules/routes/inYourPassPrive";
import MoodCategories from "./modules/routes/moodCategories";
import StoreMoodCategories from "./modules/routes/storeMoodCategories";
import StoreInYourPassPrive from "./modules/routes/storeInYourPassPrive";
import SpotLight from "./modules/routes/spotLight"
import Offers from "./modules/routes/offers";
import RestaurantBookings from "./modules/routes/restaurantBookings";
import StoreServiceBookings, { STORE_SERVICE_BOOKING_ROUTE_ALIASES } from "./modules/routes/storeServiceBookings";
import Restaurants from "./modules/routes/restaurants";
import StoreCatalogue from "./modules/routes/storeCatalogue";
import StoresHomeSections from "./modules/routes/storesHomeSections";
import Stores from "./modules/routes/stores";
import StoresHomeBanners from "./modules/routes/storesHomeBanners";
import corporatesRouter from "./modules/routes/corporates";
import Payments from "./modules/routes/payments";
import PublicMenuPayments from "./modules/routes/publicMenuPayments";
import EditorialCollections from "./modules/routes/editorialCollections";
import Editorials from "./modules/routes/editorials";
import NowTrending from "./modules/routes/nowTrending";
import Analytics from "./modules/routes/analytics";
import { cacheInvalidationMiddleware, responseCacheMiddleware } from "./modules/middleware/responseCache";
import { requestTelemetryMiddleware } from "./modules/middleware/requestTelemetry";
import { rateLimitMiddleware } from "./modules/middleware/rateLimit";

const app = express();
const allowAllCors = String(process.env.CORS_ALLOW_ALL ?? "true").trim().toLowerCase() !== "false";

const allowedOrigins = [
  "http://localhost:3000",
  "https://pass-prive-admin.vercel.app",
  process.env.PUBLIC_BACKEND_BASE_URL,
  process.env.BACKEND_BASE_URL,
  process.env.BACKEND_URL,
  process.env.FRONTEND_URL,
  process.env.MOBILE_WEB_URL,
];

function isAllowedOrigin(origin: string) {
  const normalizedAllowedOrigins = allowedOrigins
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim().replace(/\/+$/, ""));

  const normalizedOrigin = origin.trim().replace(/\/+$/, "");
  if (normalizedAllowedOrigins.includes(normalizedOrigin)) {
    return true;
  }

  if (
    normalizedOrigin.startsWith("http://localhost:") ||
    normalizedOrigin.startsWith("https://localhost:") ||
    normalizedOrigin.startsWith("http://127.0.0.1:") ||
    normalizedOrigin.startsWith("https://127.0.0.1:") ||
    normalizedOrigin.startsWith("capacitor://") ||
    normalizedOrigin.startsWith("ionic://") ||
    normalizedOrigin.startsWith("exp://") ||
    normalizedOrigin.startsWith("http://192.168.") ||
    normalizedOrigin.startsWith("https://192.168.")
  ) {
    return true;
  }

  return false;
}

const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    if (!origin || allowAllCors || isAllowedOrigin(origin)) {
      return callback(null, true);
    }

    console.warn("[CORS] Blocked origin", origin);
    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(rateLimitMiddleware);
app.use(cacheInvalidationMiddleware);
app.use(responseCacheMiddleware);
app.use(requestTelemetryMiddleware);

app.get("/", (req, res) => {
  res.send("Backend running...");
});

app.use("/api/user", userDetailsRoutes);

app.use("/api/auth", authRoutes);
app.use("/api/auth", adminRoutes);

app.use("/api/homeherooffers", HomeHeroOffers);
app.use("/api/dineinhomebanners", DineinHomeBanners);
app.use("/api/inyourpassprive", InYourPassPrive);
app.use("/api/offers", Offers);
app.use("/api/storesinyourpassprive", StoreInYourPassPrive);
app.use("/api/storeinyourpassprive", StoreInYourPassPrive);
app.use("/api/storeshomebanners", StoresHomeBanners);
app.use("/api/moodcategories", MoodCategories);
app.use("/api/storemoodcategories", StoreMoodCategories);

app.use("/api/spotlight", SpotLight);

app.use("/api/restaurant-bookings", RestaurantBookings);
for (const alias of STORE_SERVICE_BOOKING_ROUTE_ALIASES) {
  app.use(alias, StoreServiceBookings);
}
app.use("/api/restaurants", Restaurants);
app.use("/api/restaurant", Restaurants); // Alias

app.use("/api/store-catalogue", StoreCatalogue);
app.use("/api/store-catalog", StoreCatalogue); // Alias for clients using US spelling
app.use("/api/payments", Payments);
app.use("/api/public-menu/payments", PublicMenuPayments);
app.use("/api/editorial-collections", EditorialCollections);
app.use("/api/editorials", Editorials);
app.use("/api/now-trending", NowTrending);
app.use("/api/analytics", Analytics);
app.use("/api/stores-home", StoresHomeSections);
app.use("/api/stores", Stores);
app.use("/api/store", Stores);       // Alias

app.use("/api/corporates", corporatesRouter);
app.use("/api/corporate", corporatesRouter); // Alias

// 404 Catch-all Logger
app.use((req, res) => {
  console.log(`[404] ${req.method} ${req.url}`);
  res.status(404).json({ error: `Route ${req.method} ${req.url} Not Found` });
});


export default app;
