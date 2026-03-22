import express from "express";
import cors from "cors";
import authRoutes from "./modules/routes/auth";
import adminRoutes from "./modules/routes/admin";
import userDetailsRoutes from "./modules/routes/userDetails.routes";
import HomeHeroOffers from "./modules/routes/homeHeroOffers";
import DineinHomeBanners from "./modules/routes/dineinHomeBanners";
import MoodCategories from "./modules/routes/moodCategories";
import StoreMoodCategories from "./modules/routes/storeMoodCategories";
import SpotLight from "./modules/routes/spotLight"
import Restaurants from "./modules/routes/restaurants";
import Stores from "./modules/routes/stores";
import StoresHomeBanners from "./modules/routes/storesHomeBanners";
import corporatesRouter from "./modules/routes/corporates";

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

app.get("/", (req, res) => {
  res.send("Backend running...");
});

app.use("/api/user", userDetailsRoutes);

app.use("/api/auth", authRoutes);
app.use("/api/auth", adminRoutes);

app.use("/api/homeherooffers", HomeHeroOffers);
app.use("/api/dineinhomebanners", DineinHomeBanners);
app.use("/api/storeshomebanners", StoresHomeBanners);
app.use("/api/moodcategories", MoodCategories);
app.use("/api/storemoodcategories", StoreMoodCategories);

app.use("/api/spotlight", SpotLight);

app.use("/api/restaurants", Restaurants);
app.use("/api/restaurant", Restaurants); // Alias

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
