-- Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
-- modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
CREATE DATABASE audit;

CREATE TABLE todos (
  id serial PRIMARY KEY,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE todos REPLICA IDENTITY FULL;

CREATE PUBLICATION dbz_publication FOR ALL TABLES;
