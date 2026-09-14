// Stand-in for the signed-in user's id, left behind when login/signup was
// removed from BidLens.
//
// The rows this app writes still carry an owner: rfps.owner_id and
// analyses.owner_id are `not null references auth.users(id)`, and item_notes
// records an author. With no session there is no real id to put there, so
// every insert that used to read session.user.id reads this constant instead.
// One copy rather than three literals pasted into index.js, dashboard.js and
// TeamNotes.js, so the value cannot drift between the writers and the readers
// that filter on it.
//
// NOTE: this is a placeholder, not a working owner. The RLS policies on those
// tables compare owner_id against auth.uid(), which is null for the anon key,
// so the writes are rejected at the database until those policies are relaxed
// (or the value below is replaced with a real seeded auth.users row).
const PLACEHOLDER_OWNER_ID = '00000000-0000-0000-0000-000000000000'

module.exports = { PLACEHOLDER_OWNER_ID }
