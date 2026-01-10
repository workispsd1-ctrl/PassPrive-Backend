import express from "express";
import cors from "cors";
import authRoutes from "./modules/routes/auth";
import userDetailsRoutes from "./modules/routes/userDetails.routes"; 
import HomeHeroOffers from "./modules/routes/homeHeroOffers";
import SpotLight from "./modules/routes/spotLight"
import Restaurants from "./modules/routes/restaurants";
import Stores from "./modules/routes/stores";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Backend running...");
});

app.use("/api/user", userDetailsRoutes);

app.use("/api/auth", authRoutes);

app.use("/api/homeherooffers", HomeHeroOffers);

app.use("/api/spotlight", SpotLight);

app.use("/api/restaurants", Restaurants);

app.use("/api/stores", Stores);

app.use("api/auth", authRoutes);


export default app;
