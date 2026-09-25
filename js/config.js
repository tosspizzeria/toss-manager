// Where this copy of the tool keeps its data, and who may sign in.
//
// The Supabase URL and anon key are safe to publish: the key only identifies
// the project. What protects the data is row level security in schema.sql,
// which refuses anyone who has not signed in with a Google account on the
// domain below. Never put the service_role key here.
//
// Leave url/anonKey blank to fall back to the connection typed into
// Settings on each device (or to "this device only" mode if there is none).

export const SUPABASE = {
  url: 'https://tenlvmamvbhoeeiigjqx.supabase.co',
  anonKey: 'sb_publishable_uzPlTO-4eRvuyJVQRv0jiA_LUxQH4qH',
};

// Google Workspace domain whose accounts may use the tool. schema.sql enforces
// the same rule in the database; this copy is only for friendlier messages.
export const ALLOWED_DOMAIN = 'tosspizzeria.com';
