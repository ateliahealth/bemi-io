CREATE DATABASE audit;

CREATE TABLE todos (
  id serial PRIMARY KEY,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE todos REPLICA IDENTITY FULL;

CREATE PUBLICATION dbz_publication FOR ALL TABLES;
