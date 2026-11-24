import { createRemoteJWKSet, jwtVerify } from "jose";
import { ObjectId } from "mongodb";


const AUTH_BASE_URL = (
  process.env.BETTER_AUTH_URL || "http://localhost:3000"
).replace(/\/+$/, "");
const ISSUER = AUTH_BASE_URL;
const AUDIENCE = process.env.JWT_AUDIENCE || "wedplan-api";

const JWKS = createRemoteJWKSet(new URL(`${AUTH_BASE_URL}/api/auth/jwks`));


export function createAuth(users) {
  async function attachUser(req, _res, next) {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) return next();

    const token = header.slice("Bearer ".length).trim();
    if (!token) return next();

    try {
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: ISSUER,
        audience: AUDIENCE,
      });

      const subject = payload.sub;
      if (!subject || !ObjectId.isValid(subject)) return next();

      // The database is the source of truth for role and blocked status; the
      // token claims are only used for identification.
      const user = await users.findOne({ _id: new ObjectId(subject) });
      if (user) {
        req.user = user;
        req.userId = String(user._id);
        req.userRole = user.role ?? "customer";
      }
    } catch (error) {
      // Expired/invalid tokens are treated as anonymous. Protected routes then
      // respond with 401 so the client can refresh its token.
      req.authError = error;
    }

    next();
  }

  function requireAuth(req, res, next) {
    if (!req.user) {
      return res
        .status(401)
        .send({ message: "Authentication required. Please sign in again." });
    }
    if (req.user.isBlocked) {
      return res.status(403).send({
        message: "Your account is blocked. Contact support for help.",
        code: "ACCOUNT_BLOCKED",
      });
    }
    next();
  }

  function requireRole(...roles) {
    return (req, res, next) => {
      if (!req.user) {
        return res
          .status(401)
          .send({ message: "Authentication required. Please sign in again." });
      }
      if (req.user.isBlocked) {
        return res.status(403).send({
          message: "Your account is blocked. Contact support for help.",
          code: "ACCOUNT_BLOCKED",
        });
      }
      const role = req.userRole ?? "customer";
      if (!roles.includes(role)) {
        return res.status(403).send({
          message: "You do not have permission to perform this action.",
        });
      }
      next();
    };
  }

  /** Admin or the owner of the resource. */
  function isSelfOrAdmin(req, id) {
    if (!req.user) return false;
    return req.userRole === "admin" || String(id) === req.userId;
  }

  return { attachUser, requireAuth, requireRole, isSelfOrAdmin };
}
