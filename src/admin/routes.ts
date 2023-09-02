import express, { Router } from "express";
import { authorize } from "./auth";
import { HttpError } from "../shared/errors";
import { injectLocals } from "../shared/inject-locals";
import { withSession } from "../shared/with-session";
import { injectCsrfToken, checkCsrfToken } from "../shared/inject-csrf";
import { loginRouter } from "./login";
import { usersApiRouter as apiRouter } from "./api/users";
import { usersWebRouter as webRouter } from "./web/users";

const adminRouter = Router();

adminRouter.use(
  express.json({ limit: "20mb" }),
  express.urlencoded({ extended: true, limit: "20mb" })
);
adminRouter.use(withSession);
adminRouter.use(injectCsrfToken);

adminRouter.use("/users", authorize({ via: "header" }), apiRouter);

adminRouter.use(checkCsrfToken);
adminRouter.use(injectLocals);
adminRouter.use("/", loginRouter);
adminRouter.use("/manage", authorize({ via: "cookie" }), webRouter);

adminRouter.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    const data: any = { message: err.message, stack: err.stack };
    if (err instanceof HttpError) {
      data.status = err.status;
      return res.status(err.status).render("admin_error", data);
    } else if (err.name === "ForbiddenError") {
      data.status = 403;
      if (err.message === "invalid csrf token") {
        data.message =
          "Invalid CSRF token; try refreshing the previous page before submitting again.";
      }
      return res.status(403).render("admin_error", { ...data, flash: null });
    }
    res.status(500).json({ error: data });
  }
);

export { adminRouter };
