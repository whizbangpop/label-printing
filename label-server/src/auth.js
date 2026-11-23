import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

// Optional defence-in-depth: verify the JWT Cloudflare Access attaches to every request,
// so the app can't be used if someone reaches the container without going through Access.
const TEAM = (process.env.CF_ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const AUDS = (process.env.CF_ACCESS_AUD || '').split(',').map((s) => s.trim()).filter(Boolean);
export const accessVerificationEnabled = Boolean(TEAM && AUDS.length);

const issuer = TEAM ? `https://${TEAM.includes('.') ? TEAM : `${TEAM}.cloudflareaccess.com`}` : null;
const jwks = issuer ? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)) : null;

function tokenFrom(headers) {
  if (headers['cf-access-jwt-assertion']) return headers['cf-access-jwt-assertion'];
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(headers.cookie || '');
  return m ? m[1] : null;
}

/** Returns the verified identity { email, serviceToken } or throws. No-op identity when disabled. */
export async function verifyAccess(headers) {
  if (!accessVerificationEnabled) {
    return { email: headers['cf-access-authenticated-user-email'] || null, verified: false };
  }
  const token = tokenFrom(headers);
  if (!token) throw new Error('missing Cloudflare Access token');
  const { payload } = await jwtVerify(token, jwks, { issuer, audience: AUDS });
  return {
    email: payload.email || null,
    serviceToken: payload.common_name || null,
    verified: true,
  };
}

export function accessMiddleware() {
  return async (req, res, next) => {
    try {
      req.identity = await verifyAccess(req.headers);
      next();
    } catch (err) {
      res.status(403).json({ error: `Forbidden: ${err.message}` });
    }
  };
}

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length || !ab.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
