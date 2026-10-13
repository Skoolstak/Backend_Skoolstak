const { createClient } = require('@supabase/supabase-js');
const serviceSupabase = require('../supabaseClient'); // service-role — bypasses RLS
const crypto = require('crypto');

// Short-lived cache of verified tokens so each API call doesn't hit Supabase twice.
const CACHE_TTL_MS = 30 * 1000;
const authCache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authCache) if (v.exp < now) authCache.delete(k);
}, 60 * 1000).unref();
/**
 * Verifies the Supabase JWT from the Authorization header.
 * Attaches req.user (auth user) and req.profile (user_profiles row) to the request.
 */
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header.' });
  }

  const token = authHeader.split(' ')[1];
  const cacheKey = crypto.createHash('sha256').update(token || '').digest('hex');
  const hit = authCache.get(cacheKey);
  if (hit && hit.exp > Date.now()) {
    req.user = hit.user; req.profile = hit.profile; req.schoolId = hit.profile.school_id; req.role = hit.profile.role;
    return next();
  }

  // Validate the JWT using a per-request anon client (does NOT go through RLS)
  const anonClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );

  const { data: { user }, error } = await anonClient.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }

  // Use the service-role client to fetch the profile — bypasses RLS entirely,
  // which avoids any circular-dependency issues on the user_profiles policies.
  const { data: profile, error: profileError } = await serviceSupabase
    .from('user_profiles')
    .select('*')
    .eq('auth_user_id', user.id)
    .single();

  if (profileError || !profile) {
    return res.status(403).json({ error: 'User profile not found.' });
  }

  authCache.set(cacheKey, { user, profile, exp: Date.now() + CACHE_TTL_MS });
  req.user     = user;
  req.profile  = profile;
  req.schoolId = profile.school_id;
  req.role     = profile.role;

  next();
}

/**
 * Factory: restrict a route to specific roles.
 * Usage: router.get('/path', requireRole('school_admin', 'super_admin'), handler)
 * Uses rest params so any number of allowed roles can be passed as arguments.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.role)) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    next();
  };
}

module.exports = { authMiddleware, requireRole };
