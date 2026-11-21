-- One-time PostgreSQL setup for the OpenRings Community forum.
--
-- Run this as the "postgres" superuser while connected to the ringqswitch database:
--   pgAdmin:  right-click ringqswitch > Query Tool > paste > Execute (F5)
--   psql:     psql -U postgres -d ringqswitch -f deploy/postgres-setup.sql
--
-- It creates:
--   * a login role "openrings_app" used only by the forum
--   * a schema "community" inside ringqswitch, owned by that role
-- All forum tables are created inside "community" (e.g. community.users), so they
-- never mix with the existing PBX tables in "public".
--
-- CHANGE THE PASSWORD below before running.

CREATE ROLE openrings_app LOGIN PASSWORD 'Change-Me-Strong-Password';

GRANT CONNECT ON DATABASE ringqswitch TO openrings_app;

CREATE SCHEMA IF NOT EXISTS community AUTHORIZATION openrings_app;

-- Always look in the forum schema first for this role.
ALTER ROLE openrings_app IN DATABASE ringqswitch SET search_path = community;

-- Optional: stop the forum role from creating objects in "public".
-- (PostgreSQL 15+ already does this by default.)
REVOKE CREATE ON SCHEMA public FROM openrings_app;
