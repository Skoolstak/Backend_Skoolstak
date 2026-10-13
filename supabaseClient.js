const { createClient } = require('@supabase/supabase-js');

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY, // service role — full access, server-side only
  noSession
);

// Sign-ins must never run on the shared service client: supabase-js would keep the
// user's session and start sending that user's JWT (RLS applies) for every later request.
const signInWithPassword = (credentials) =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, noSession)
    .auth.signInWithPassword(credentials);

module.exports = supabase;
module.exports.signInWithPassword = signInWithPassword;
