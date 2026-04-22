-- v61: Usuarios del panel admin con PIN y permisos por tab.
-- Reemplaza el PIN hardcodeado (ADMIN_PIN = "1234") por gestion dinamica.

CREATE TABLE IF NOT EXISTS admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  nombre text NOT NULL,
  pin text NOT NULL,
  rol text NOT NULL DEFAULT 'custom' CHECK (rol IN ('super_admin','admin','operaciones','viewer','custom')),
  permisos jsonb DEFAULT '[]'::jsonb,
  activo boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_users_pin ON admin_users(pin) WHERE activo = true;

ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_users_all ON admin_users;
CREATE POLICY admin_users_all ON admin_users FOR ALL USING (true) WITH CHECK (true);

-- Seed inicial: super_admin con PIN 1234.
INSERT INTO admin_users (email, nombre, pin, rol, permisos, activo)
VALUES ('velias1070@gmail.com', 'Vicente', '1234', 'super_admin', '[]'::jsonb, true)
ON CONFLICT (email) DO NOTHING;

COMMENT ON COLUMN admin_users.rol IS 'super_admin=todo, admin=todo menos usuarios, operaciones=ops/rec/flex/enviosfull/reposicion/picking, viewer=solo lectura dashboard/inv/mov, custom=permisos manuales';
COMMENT ON COLUMN admin_users.permisos IS 'Array de tab IDs permitidos cuando rol=custom. Ignorado para otros roles.';
