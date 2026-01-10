import { Router } from "express";
import { saveUserDetails } from "../../controllers/userDetailsController";

const router = Router();

router.post("/details", saveUserDetails);

export default router;
