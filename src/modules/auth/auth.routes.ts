import { Router } from "express";
import { authHandler } from "./auth.auto";
import {saveUserDetails} from '../../controllers/userDetailsController'

const router = Router();

router.post("/login-or-register", authHandler);

export default router;
