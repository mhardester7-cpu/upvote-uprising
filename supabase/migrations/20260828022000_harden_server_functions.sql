-- Elevated functions are never browser-callable.
--
-- UPVOTE UPRISING is guest-only, but its Node server still needs to record aggregate
-- play starts. The server uses a protected Supabase secret key, which assumes
-- the `service_role` database role. Browser-facing publishable keys remain
-- limited to reading the single aggregate row.

revoke all on function public.handle_new_user()
  from public, anon, authenticated;

revoke all on function public.record_game_play(uuid)
  from public, anon, authenticated;
grant execute on function public.record_game_play(uuid)
  to service_role;
