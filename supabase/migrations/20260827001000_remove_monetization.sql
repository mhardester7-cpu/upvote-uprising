-- Monetization is not part of the public beta. Keep the historical migration
-- above for migration bookkeeping, then remove the dormant paid-entitlement
-- data model from both upgraded and newly created projects.

drop table if exists public.entitlements;
