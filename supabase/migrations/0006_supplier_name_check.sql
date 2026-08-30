-- Supplier names embed in bucket object keys; an unconstrained name (slashes,
-- spaces, newlines) breaks the key roundtrip AFTER a successful upload. The
-- key-safe alphabet is enforced where the name is born.
alter table suppliers
  add constraint suppliers_name_key_safe
  check (name ~ '^[a-z0-9][a-z0-9_-]{0,62}$');
